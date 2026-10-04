
// ─────────────────────────────────────────────────────────────────────────────
// socket.manager.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Server as SocketIOServer } from 'socket.io';
import { VehicleType } from '@prisma/client';
import prisma from '../app/config/prisma';
import { logger } from '../app/utils/logger';
import { getDistanceKm } from '../app/modules/ride/ride.utils';
import { IOnlineDriverEntry, IOnlineUserEntry, RideRequestedPayload, SocketEvents } from './socket.types';

// ─── Module-level state ───────────────────────────────────────────────────────

let _io: SocketIOServer | null = null;

const onlineUsers   = new Map<string, IOnlineUserEntry>();
const onlineDrivers = new Map<string, IOnlineDriverEntry>();

// rideId → driver profile IDs that received the ride request
const rideNotifiedDrivers = new Map<string, string[]>();

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function initManager(io: SocketIOServer): void {
  _io = io;
  logger.info('Socket manager initialized');
}

export function isManagerReady(): boolean {
  return _io !== null;
}

// ─── Room name helpers ────────────────────────────────────────────────────────

export const passengerRoom = (userId: string)          => `passenger:${userId}`;
export const driverRoom    = (driverProfileId: string) => `driver:${driverProfileId}`;
export const rideRoom      = (rideId: string)          => `ride:${rideId}`;

// ─── User / Driver registration ───────────────────────────────────────────────

export function registerUser(user: {
  socketId:        string;
  userId:          string;
  role:            string;
  driverProfileId?: string;
  vehicleTypes?:   string[];
}): void {
  const base: IOnlineUserEntry = {
    socketId:    user.socketId,
    userId:      user.userId,
    role:        user.role,
    connectedAt: new Date(),
    lastSeen:    new Date(),
  };
  onlineUsers.set(user.userId, base);

  if (user.role === 'driver' && user.driverProfileId) {
    onlineDrivers.set(user.driverProfileId, {
      ...base,
      driverProfileId: user.driverProfileId,
      vehicleTypes:    user.vehicleTypes,
      isOnRide:        false,
    });
  }
}

export function unregisterUser(userId: string, driverProfileId?: string): void {
  onlineUsers.delete(userId);

  if (driverProfileId) {
    onlineDrivers.delete(driverProfileId);
    return;
  }

  for (const [key, val] of onlineDrivers.entries()) {
    if (val.userId === userId) {
      onlineDrivers.delete(key);
      break;
    }
  }
}

export function updateUserLastSeen(userId: string): void {
  const entry = onlineUsers.get(userId);
  if (entry) entry.lastSeen = new Date();
}

export function updateDriverLocation(driverProfileId: string, coordinates: [number, number]): void {
  const entry = onlineDrivers.get(driverProfileId);
  if (entry) {
    entry.location = coordinates;
    entry.lastSeen = new Date();
  }
}

export function setDriverOnRide(driverProfileId: string, isOnRide: boolean): void {
  const entry = onlineDrivers.get(driverProfileId);
  if (entry) entry.isOnRide = isOnRide;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const isUserOnline   = (userId: string)          => onlineUsers.has(userId);
export const isDriverOnline = (driverProfileId: string) => onlineDrivers.has(driverProfileId);

export const getOnlineUserEntry   = (userId: string)          => onlineUsers.get(userId);
export const getOnlineDriverEntry = (driverProfileId: string) => onlineDrivers.get(driverProfileId);
export const getOnlineDriverProfileIds = ()                    => Array.from(onlineDrivers.keys());

export function getOnlineUsersSnapshot(): Array<{ userId: string; role: string }> {
  return Array.from(onlineUsers.values()).map((u) => ({ userId: u.userId, role: u.role }));
}

// ─── Room management ──────────────────────────────────────────────────────────

export function joinRideRoom(socketId: string, rideId: string): void {
  _io?.sockets.sockets.get(socketId)?.join(rideRoom(rideId));
}

export function leaveRideRoom(socketId: string, rideId: string): void {
  _io?.sockets.sockets.get(socketId)?.leave(rideRoom(rideId));
}

// ─── Emit helpers ─────────────────────────────────────────────────────────────

function hasRoomSockets(room: string): boolean {
  const sockets = _io?.sockets.adapter.rooms.get(room);
  return sockets !== undefined && sockets.size > 0;
}

export function emitToPassenger(passengerId: string, event: string, data: unknown): boolean {
  if (!_io) return false;
  const room = passengerRoom(passengerId);
  if (hasRoomSockets(room)) { _io.to(room).emit(event, data); return true; }
  const entry = onlineUsers.get(passengerId);
  if (entry) { _io.to(entry.socketId).emit(event, data); return true; }
  logger.warn(`emitToPassenger: passenger ${passengerId} is offline`);
  return false;
}

export function emitToDriver(driverProfileId: string, event: string, data: unknown): boolean {
  if (!_io) return false;
  const room = driverRoom(driverProfileId);
  if (hasRoomSockets(room)) { _io.to(room).emit(event, data); return true; }
  const entry = onlineDrivers.get(driverProfileId);
  if (entry) { _io.to(entry.socketId).emit(event, data); return true; }
  logger.warn(`emitToDriver: driver ${driverProfileId} is offline`);
  return false;
}

export function emitToRideRoom(rideId: string, event: string, data: unknown): void {
  _io?.to(rideRoom(rideId)).emit(event, data);
}

/**
 * Emit to any connected user by their User ID, regardless of role (passenger
 * or driver). Every socket joins its own passengerRoom(userId) on connect —
 * this is that same delivery path under a role-agnostic name, for callers
 * (like message unread counts) that don't know or care which role the
 * recipient is.
 */
export function emitToUser(userId: string, event: string, data: unknown): boolean {
  if (!_io) return false;
  const room = passengerRoom(userId);
  if (hasRoomSockets(room)) { _io.to(room).emit(event, data); return true; }
  const entry = onlineUsers.get(userId);
  if (entry) { _io.to(entry.socketId).emit(event, data); return true; }
  logger.warn(`emitToUser: user ${userId} is offline`);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function broadcastToNearbyDrivers(
  _pickupCoordinates: [number, number],
  event: string,
  data: unknown,
  _maxDistanceMeters = 5_000,
): Promise<string[]> {
  if (!_io) return [];

  const onlineIds = getOnlineDriverProfileIds();
  if (onlineIds.length === 0) return [];

  const nearbyDrivers = await prisma.driverProfile.findMany({
    where:  { id: { in: onlineIds }, isOnline: true, isOnRide: false, approvalStatus: 'verified' },
    select: { id: true },
  });

  const notified: string[] = [];
  for (const driver of nearbyDrivers) {
    if (emitToDriver(driver.id, event, data)) notified.push(driver.id);
  }

  logger.info(`broadcastToNearbyDrivers: notified ${notified.length}/${nearbyDrivers.length} drivers`);
  return notified;
}

// ─────────────────────────────────────────────────────────────────────────────

const VEHICLE_SPEED_KMH: Record<string, number> = {
  MINO_GO:      40,
  MINO_COMFORT: 40,
  MINO_XL:      35,
  MINO_MOTO:    45,
};

export async function broadcastRideRequestToNearbyDrivers(
  pickupCoordinates: [number, number],
  basePayload: Omit<RideRequestedPayload, 'distanceToPickupKm' | 'estimatedArrivalMin'>,
  _maxDistanceMeters = 5_000,
): Promise<string[]> {
  if (!_io) return [];



  const onlineIds = getOnlineDriverProfileIds();

  console.log("online ids =>>>>> ", onlineIds);

  if (onlineIds.length === 0) return [];

  const nearbyDrivers = await prisma.driverProfile.findMany({
    where: {
      id:             { in: onlineIds },
      isOnline:       true,
      isOnRide:       false,
      approvalStatus: 'verified',
      driverType:     basePayload.vehicleCategory === 'MINO_MOTO' ? 'motorcycle' : 'car',
      // Only notify drivers admin has actually assigned this vehicle category to.
      vehicleTypes:   { has: basePayload.vehicleCategory as VehicleType },
    },
    select: { id: true },
  });

  console.log("nearby drivers =>>>>> ", nearbyDrivers)

  const [pickupLng, pickupLat] = pickupCoordinates;

  const notified: string[] = [];

  for (const driver of nearbyDrivers) {
    const entry = onlineDrivers.get(driver.id);
    

    let distanceToPickupKm = 2;
    if (entry?.location) {
      const [driverLng, driverLat] = entry.location;
      distanceToPickupKm = parseFloat(
        getDistanceKm(pickupLat, pickupLng, driverLat, driverLng).toFixed(2),
      );
    }

    const speed               = VEHICLE_SPEED_KMH[basePayload.vehicleCategory] ?? 40;
    const estimatedArrivalMin = Math.ceil((distanceToPickupKm / speed) * 60);


    const payload: RideRequestedPayload = { ...basePayload, distanceToPickupKm, estimatedArrivalMin };

    if (emitToDriver(driver.id, SocketEvents.RIDE_REQUESTED, payload)) {
      notified.push(driver.id);
    }
  }

  logger.info(`broadcastRideRequestToNearbyDrivers: notified ${notified.length}/${nearbyDrivers.length} drivers`);

  if (notified.length > 0) {
    rideNotifiedDrivers.set(basePayload.rideId, notified);
  }

  return notified;
}

export function notifyRideTaken(rideId: string, acceptingDriverId: string): void {
  const notified = rideNotifiedDrivers.get(rideId);
  if (!notified) return;

  const rideTakenPayload = {
    rideId,
    message: 'This ride has been accepted by another driver.',
  };

  for (const driverId of notified) {
    if (driverId !== acceptingDriverId) {
      emitToDriver(driverId, SocketEvents.RIDE_TAKEN, rideTakenPayload);
    }
  }

  rideNotifiedDrivers.delete(rideId);
  logger.info(`notifyRideTaken: ride ${rideId} — notified ${notified.length - 1} other drivers`);
}

export function broadcastOnlineUsers(): void {
  _io?.emit(SocketEvents.ONLINE_USERS, getOnlineUsersSnapshot());
}
