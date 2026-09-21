// ─────────────────────────────────────────────────────────────────────────────
// socket.events.ts
// Registers all Socket.IO event handlers for a single connected socket.
// ─────────────────────────────────────────────────────────────────────────────

import { Server as SocketIOServer, Socket } from 'socket.io';
import { z } from 'zod';
import { logger } from '../app/utils/logger';
import prisma from '../app/config/prisma';
import { RideService } from '../app/modules/ride/ride.service';
import { MessageService } from '../app/modules/message/message.service';
import { cleanupRateLimitEntry } from './socket.server';
import {
  isManagerReady,
  registerUser,
  unregisterUser,
  updateDriverLocation,
  setDriverOnRide,
  joinRideRoom,
  leaveRideRoom,
  emitToRideRoom,
  emitToPassenger,
  emitToDriver,
  broadcastToNearbyDrivers,
  broadcastOnlineUsers,
  passengerRoom,
  driverRoom,
} from './socket.manager';
import {
  AcceptRidePayload,
  ApplyPromoPayload,
  ArrivedPickupPayload,
  CancelRidePayload,
  CompleteRidePayload,
  DriverOnlinePayload,
  JoinRideRoomPayload,
  RequestRidePayload,
  SocketAck,
  SocketEvents,
  StartRidePayload,
  UpdateLocationPayload,
} from './socket.types';

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const RideIdSchema = z.object({ rideId: z.string().min(1) });

const ConfirmDropoffSchema = z.object({
  rideId: z.string().min(1),
  deliveryProofImage: z.string().min(1).optional(),
});

const CancelRideSchema = z.object({
  rideId: z.string().min(1),
  reason: z.string().min(1).max(500),
  details: z.string().max(1_000).optional(),
});

const ApplyPromoSchema = z.object({
  rideId: z.string().min(1),
  promoCode: z.string().min(1).max(50),
});

const DriverOnlineSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  rideId: z.string().optional(),
});

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

type AckFn = ((result: SocketAck) => void) | undefined;

function sendAck(fn: AckFn, result: SocketAck): void {
  if (typeof fn === 'function') fn(result);
}

function validate<T>(schema: z.ZodSchema<T>, payload: unknown, ackFn: AckFn): T | null {
  const result = schema.safeParse(payload);
  if (!result.success) {
    sendAck(ackFn, {
      success: false,
      error: result.error.errors[0]?.message ?? 'Invalid payload',
      code: 400,
    });
    return null;
  }
  return result.data;
}

// ─── Main registration function ───────────────────────────────────────────────

export function registerSocketEvents(socket: Socket, _io: SocketIOServer): void {
  if (!isManagerReady()) {
    logger.error('registerSocketEvents called before socket manager was initialized');
    socket.disconnect(true);
    return;
  }

  if (!socket.user) {
    socket.disconnect(true);
    return;
  }

  const { _id: userId, role, driverProfileId, name } = socket.user;

  // ── On-connect setup ──────────────────────────────────────────────────────

  registerUser({ socketId: socket.id, userId, role, driverProfileId });

  socket.join(passengerRoom(userId));

  if (role === 'driver' && driverProfileId) {
    socket.join(driverRoom(driverProfileId));
  }

  broadcastOnlineUsers();

  // Send this user's current unread notification count on connect
  prisma.notification.count({ where: { receiverId: userId, isRead: false } })
    .then((unreadCount) => {
      socket.emit(SocketEvents.NOTIFICATION, {
        statusCode: 200,
        success:    true,
        unreadCount,
        timestamp:  new Date(),
      });
    })
    .catch((err) => logger.error('Failed to fetch unread notification count on connect:', err));

  logger.info(`[CONNECT] ${name} (${role}) socket=${socket.id}`);

  // ── Legacy manual registration (backward compat) ──────────────────────────

  socket.on(SocketEvents.USER_CONNECTED, ({ userId: uid }: { userId: string }) => {
    logger.info(`Legacy userConnected event from user ${uid}`);
  });

  // ── Room management ────────────────────────────────────────────────────────

  socket.on(SocketEvents.JOIN_RIDE_ROOM, (payload: JoinRideRoomPayload, ackFn?: AckFn) => {
    const data = validate(RideIdSchema, payload, ackFn);
    if (!data) return;

    joinRideRoom(socket.id, data.rideId);
    sendAck(ackFn, { success: true, data: { rideId: data.rideId } });
  });

  socket.on(SocketEvents.LEAVE_RIDE_ROOM, (payload: JoinRideRoomPayload, ackFn?: AckFn) => {
    const data = validate(RideIdSchema, payload, ackFn);
    if (!data) return;

    leaveRideRoom(socket.id, data.rideId);
    sendAck(ackFn, { success: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PASSENGER EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * request_ride
   * Passenger confirms a ride already created via HTTP API.
   */
  socket.on(
    SocketEvents.REQUEST_RIDE,
    async (payload: RequestRidePayload, ackFn?: AckFn) => {
      try {
        if (role !== 'passenger') {
          return sendAck(ackFn, { success: false, error: 'Only passengers can request rides', code: 403 });
        }

        const data = validate(RideIdSchema, payload, ackFn);
        if (!data) return;

        const ride = await prisma.ride.findUnique({
          where: { id: data.rideId,isDeleted: false },
          include: { passenger: { select: { id: true, name: true } } },
        });

        if (!ride) {
          return sendAck(ackFn, { success: false, error: 'Ride not found', code: 404 });
        }

        if (ride.passengerId !== userId) {
          return sendAck(ackFn, { success: false, error: 'Unauthorized', code: 403 });
        }

        joinRideRoom(socket.id, data.rideId);

        await broadcastToNearbyDrivers(
          [ride.pickupLng ?? 0, ride.pickupLat ?? 0],
          SocketEvents.RIDE_REQUESTED,
          {
            rideId:          ride.id,
            passengerId:     userId,
            passengerName:   ride.passenger?.name ?? name,
            vehicleCategory: ride.vehicleCategory,
            serviceType:     ride.serviceType,
            pickupLocation: {
              address:     ride.pickupAddress,
              coordinates: [ride.pickupLng ?? 0, ride.pickupLat ?? 0],
            },
            dropoffLocation: {
              address:     ride.dropoffAddress,
              coordinates: [ride.dropoffLng ?? 0, ride.dropoffLat ?? 0],
            },
            estimatedFare: ride.estimatedFare,
            totalFare:     ride.totalFare,
            distanceKm:    ride.distanceKm,
            scheduledAt:   ride.scheduledAt,
          },
        );

        sendAck(ackFn, { success: true, data: { rideId: data.rideId } });
      } catch (err: any) {
        logger.error(`[${SocketEvents.REQUEST_RIDE}] error:`, err);
        sendAck(ackFn, { success: false, error: 'Failed to broadcast ride request', code: 500 });
      }
    },
  );

  /**
   * cancel_ride
   * Passenger or driver cancels an active ride.
   */
  socket.on(
    SocketEvents.CANCEL_RIDE,
    async (payload: CancelRidePayload, ackFn?: AckFn) => {
      try {

        if (role !== 'passenger' && role !== 'driver') {
          return sendAck(ackFn, { success: false, error: 'Unauthorized', code: 403 });
        }

        const data = validate(CancelRideSchema, payload, ackFn);
        if (!data) return;

        const cancelledBy = role === 'passenger' ? 'PASSENGER' : 'DRIVER';
        await RideService.cancelRide(data.rideId, cancelledBy, data.reason, data.details);

        sendAck(ackFn, { success: true, data: { rideId: data.rideId, status: 'CANCELLED' } });
      } catch (err: any) {
        logger.error(`[${SocketEvents.CANCEL_RIDE}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to cancel ride', code: 500 });
      }
    },
  );

  /**
   * apply_promo
   */
  socket.on(
    SocketEvents.APPLY_PROMO,
    async (payload: ApplyPromoPayload, ackFn?: AckFn) => {
      try {
        if (role !== 'passenger') {
          return sendAck(ackFn, { success: false, error: 'Only passengers can apply promo codes', code: 403 });
        }

        const data = validate(ApplyPromoSchema, payload, ackFn);
        if (!data) return;

        const result = await RideService.applyPromoToRide(data.rideId, data.promoCode);
        sendAck(ackFn, { success: true, data: result });
      } catch (err: any) {
        logger.error(`[${SocketEvents.APPLY_PROMO}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to apply promo', code: 500 });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // DRIVER EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * driver:goOnline
   */
  socket.on(
    SocketEvents.DRIVER_GO_ONLINE,
    async (payload: DriverOnlinePayload, ackFn?: AckFn) => {
      try {
        if (role !== 'driver' || !driverProfileId) {
          return sendAck(ackFn, { success: false, error: 'Only drivers can use this event', code: 403 });
        }

        const data = validate(DriverOnlineSchema, payload, ackFn);
        if (!data) return;

        const driver = await prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
        if (!driver) {
          return sendAck(ackFn, { success: false, error: 'Driver profile not found', code: 404 });
        }

        if (driver.approvalStatus !== 'verified') {
          return sendAck(ackFn, { success: false, error: 'Only verified drivers can go online', code: 403 });
        }

        const updated = await prisma.driverProfile.update({
          where: { id: driverProfileId },
          data:  { isOnline: true, currentLat: data.lat, currentLng: data.lng },
          select: { isOnline: true, currentLat: true, currentLng: true, vehicleTypes: true },
        });

        registerUser({ socketId: socket.id, userId, role, driverProfileId, vehicleTypes: updated.vehicleTypes });
        updateDriverLocation(driverProfileId, [data.lng, data.lat]);

        socket.emit(SocketEvents.DRIVER_STATUS_UPDATED, {
          success: true,
          message: 'You are now online',
          data: { isOnline: true, currentLocation: { lat: updated.currentLat, lng: updated.currentLng } },
        });

        sendAck(ackFn, { success: true, data: { isOnline: true } });
        logger.info(`[DRIVER ONLINE] userId=${userId} lat=${data.lat} lng=${data.lng}`);
      } catch (err: any) {
        logger.error(`[${SocketEvents.DRIVER_GO_ONLINE}] error:`, err);
        socket.emit(SocketEvents.DRIVER_ERROR, { message: 'Failed to go online' });
        sendAck(ackFn, { success: false, error: 'Failed to go online', code: 500 });
      }
    },
  );

  /**
   * driver:goOffline
   */
  socket.on(SocketEvents.DRIVER_GO_OFFLINE, async (_payload: object, ackFn?: AckFn) => {
    try {
      if (role !== 'driver' || !driverProfileId) {
        return sendAck(ackFn, { success: false, error: 'Only drivers can use this event', code: 403 });
      }

      await prisma.driverProfile.update({
        where: { id: driverProfileId },
        data:  { isOnline: false },
      });

      unregisterUser(userId, driverProfileId);

      socket.emit(SocketEvents.DRIVER_STATUS_UPDATED, {
        success: true,
        message: 'You are now offline',
        data: { isOnline: false },
      });

      sendAck(ackFn, { success: true, data: { isOnline: false } });
      logger.info(`[DRIVER OFFLINE] userId=${userId}`);
    } catch (err: any) {
      logger.error(`[${SocketEvents.DRIVER_GO_OFFLINE}] error:`, err);
      socket.emit(SocketEvents.DRIVER_ERROR, { message: 'Failed to go offline' });
      sendAck(ackFn, { success: false, error: 'Failed to go offline', code: 500 });
    }
  });

  /**
   * accept_ride
   */
  socket.on(
    SocketEvents.ACCEPT_RIDE,
    async (payload: AcceptRidePayload, ackFn?: AckFn) => {
      try {
        if (role !== 'driver' || !driverProfileId) {
          return sendAck(ackFn, { success: false, error: 'Only drivers can accept rides', code: 403 });
        }

        const data = validate(RideIdSchema, payload, ackFn);
        if (!data) return;

        await RideService.driverAcceptRide(data.rideId, driverProfileId);

        joinRideRoom(socket.id, data.rideId);
        setDriverOnRide(driverProfileId, true);

        sendAck(ackFn, { success: true, data: { rideId: data.rideId, status: 'ACCEPTED' } });
        logger.info(`[ACCEPT RIDE] driver=${userId} ride=${data.rideId}`);
      } catch (err: any) {
        logger.error(`[${SocketEvents.ACCEPT_RIDE}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to accept ride', code: 500 });
      }
    },
  );

  /**
   * arrived_pickup
   */
  socket.on(
    SocketEvents.ARRIVED_PICKUP,
    async (payload: ArrivedPickupPayload, ackFn?: AckFn) => {

      console.log("=================== Arrived pick up ==========>>> ", SocketEvents.ARRIVED_PICKUP, payload)
      try {
        if (role !== 'driver' || !driverProfileId) {
          return sendAck(ackFn, { success: false, error: 'Only drivers can use this event', code: 403 });
        }

        const data = validate(RideIdSchema, payload, ackFn);
        if (!data) return;

        await RideService.arrivedPickup(data.rideId, driverProfileId);

        sendAck(ackFn, { success: true, data: { rideId: data.rideId, status: 'ARRIVED_PICKUP' } });
        logger.info(`[ARRIVED PICKUP] driver=${userId} ride=${data.rideId}`);
      } catch (err: any) {
        logger.error(`[${SocketEvents.ARRIVED_PICKUP}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to mark arrival at pickup', code: 500 });
      }
    },
  );

  /**
   * start_ride
   */
  socket.on(
    SocketEvents.START_RIDE,
    async (payload: StartRidePayload, ackFn?: AckFn) => {

      try {
        if (role !== 'driver') {
          return sendAck(ackFn, { success: false, error: 'Only drivers can start rides', code: 403 });
        }

        const data = validate(RideIdSchema, payload, ackFn);
        if (!data) return;

        await RideService.updateRideStatus(data.rideId, 'ONGOING');

        sendAck(ackFn, { success: true, data: { rideId: data.rideId, status: 'ONGOING' } });
        logger.info(`[START RIDE] driver=${userId} ride=${data.rideId}`);
      } catch (err: any) {
        logger.error(`[${SocketEvents.START_RIDE}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to start ride', code: 500 });
      }
    },
  );

  /**
   * complete_ride
   */
  socket.on(
    SocketEvents.COMPLETE_RIDE,
    async (payload: CompleteRidePayload, ackFn?: AckFn) => {
      try {
        if (role !== 'driver') {
          return sendAck(ackFn, { success: false, error: 'Only drivers can complete rides', code: 403 });
        }

        const data = validate(RideIdSchema, payload, ackFn);
        if (!data) return;

        await RideService.updateRideStatus(data.rideId, 'COMPLETED');

        if (driverProfileId) setDriverOnRide(driverProfileId, false);

        sendAck(ackFn, { success: true, data: { rideId: data.rideId, status: 'COMPLETED' } });
        logger.info(`[COMPLETE RIDE] driver=${userId} ride=${data.rideId}`);
      } catch (err: any) {
        logger.error(`[${SocketEvents.COMPLETE_RIDE}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to complete ride', code: 500 });
      }
    },
  );

  /**
   * driver:updateLocation
   */
  socket.on(
    SocketEvents.UPDATE_LOCATION,
    async (payload: UpdateLocationPayload, ackFn?: AckFn) => {
      try {
        if (role !== 'driver' || !driverProfileId) {
          return sendAck(ackFn, { success: false, error: 'Only drivers can update location', code: 403 });
        }

        const data = validate(LocationSchema, payload, ackFn);
        if (!data) return;

        const driverCheck = await prisma.driverProfile.findFirst({
          where:  { id: driverProfileId, isOnline: true },
          select: { id: true },
        });

        if (!driverCheck) {
          return sendAck(ackFn, { success: false, error: 'Driver not found or not online', code: 404 });
        }

        await prisma.driverProfile.update({
          where: { id: driverProfileId },
          data:  { currentLat: data.lat, currentLng: data.lng },
        });

        updateDriverLocation(driverProfileId, [data.lng, data.lat]);

        socket.emit(SocketEvents.DRIVER_LOCATION_ACK, {
          success: true,
          data: { currentLocation: { lat: data.lat, lng: data.lng } },
        });

        if (data.rideId) {
          const locationPayload = {
            driverProfileId,
            rideId:      data.rideId,
            coordinates: [data.lng, data.lat] as [number, number],
            updatedAt:   new Date(),
          };

          emitToRideRoom(data.rideId, SocketEvents.DRIVER_LOCATION_UPDATED, locationPayload);

          const rideRow = await prisma.ride.findUnique({
            where:  { id: data.rideId, isDeleted: false },
            select: { passengerId: true },
          });
          if (rideRow?.passengerId) {
            emitToPassenger(rideRow.passengerId, SocketEvents.DRIVER_LOCATION_UPDATED, locationPayload);
          }
        }

        sendAck(ackFn, { success: true });
      } catch (err: any) {
        logger.error(`[${SocketEvents.UPDATE_LOCATION}] error:`, err);
        socket.emit(SocketEvents.DRIVER_ERROR, { message: 'Failed to update location' });
        sendAck(ackFn, { success: false, error: 'Failed to update location', code: 500 });
      }
    },
  );

  /**
   * end_ride
   */
  socket.on(
    SocketEvents.END_RIDE,
    async (payload: unknown, ackFn?: AckFn) => {
      try {
        if (role !== 'driver' || !driverProfileId) {
          return sendAck(ackFn, { success: false, error: 'Only drivers can end rides', code: 403 });
        }

        const EndRideSchema = z.object({
          rideId: z.string().min(1),
          address: z.string().min(1),
          coordinates: z.tuple([z.number(), z.number()]),
        });

        const data = validate(EndRideSchema, payload, ackFn);
        if (!data) return;

        const dropoffLocation = {
          address: data.address,
          lng: data.coordinates[0],
          lat: data.coordinates[1],
        };

        await RideService.endRide(data.rideId, driverProfileId, dropoffLocation);

        sendAck(ackFn, { success: true, data: { rideId: data.rideId, status: 'END_RIDE' } });
        logger.info(`[END RIDE] driver=${userId} ride=${data.rideId}`);
      } catch (err: any) {
        logger.error(`[${SocketEvents.END_RIDE}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to end ride', code: 500 });
      }
    },
  );

  /**
   * arrived_dropoff
   */
  socket.on(
    SocketEvents.ARRIVED_DROPOFF,
    async (payload: unknown, ackFn?: AckFn) => {

      console.log("Arrived dropped ==>> hitted", payload)
      try {
        if (role !== 'driver' || !driverProfileId) {
          return sendAck(ackFn, { success: false, error: 'Only drivers can use this event', code: 403 });
        }

        const ArrivedDropoffSchema = z.object({
          rideId: z.string().min(1),
          address: z.string().min(1),
          coordinates: z.tuple([z.number(), z.number()]),
        });

        const data = validate(ArrivedDropoffSchema, payload, ackFn);
        if (!data) return;

        const dropoffLocation = {
          address: data.address,
          lng: data.coordinates[0],
          lat: data.coordinates[1],
        };

        await RideService.arrivedDropoff(data.rideId, driverProfileId, dropoffLocation);

        sendAck(ackFn, { success: true, data: { rideId: data.rideId, status: 'ARRIVED_DROPOFF' } });
        logger.info(`[ARRIVED DROPOFF] driver=${userId} ride=${data.rideId}`);
      } catch (err: any) {
        logger.error(`[${SocketEvents.ARRIVED_DROPOFF}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to arrive at dropoff', code: 500 });
      }
    },
  );

  /**
   * confirm_dropoff
   */
  socket.on(
    SocketEvents.CONFIRM_DROPOFF,
    async (payload: unknown, ackFn?: AckFn) => {

      console.log("confirm dropoff hitted =>>> ", payload)
      try {
        if (role !== 'driver' || !driverProfileId) {
          return sendAck(ackFn, { success: false, error: 'Only drivers can confirm dropoff', code: 403 });
        }

        const data = validate(ConfirmDropoffSchema, payload, ackFn);
        if (!data) return;

        const ride = await prisma.ride.findUnique({
          where:   { id: data.rideId, isDeleted: false },
          include: { passenger: { select: { name: true, profileImage: true } } },
        });


        if (!ride) return sendAck(ackFn, { success: false, error: 'Ride not found', code: 404 });

        await RideService.confirmDropoff(data.rideId, driverProfileId, data.deliveryProofImage);

        sendAck(ackFn, {
          success: true,
          data: {
            rideId: ride.id,
            status: 'CONFIRM_DROPOFF',
            data: {
              rideId:          ride.id,
              status:          'CONFIRM_DROPOFF',
              pickupLocation:  { address: ride.pickupAddress,  coordinates: [ride.pickupLng  ?? 0, ride.pickupLat  ?? 0] },
              dropoffLocation: { address: ride.dropoffAddress, coordinates: [ride.dropoffLng ?? 0, ride.dropoffLat ?? 0] },
              distanceKm:      ride.distanceKm,
              durationMin:     ride.durationMin,
              estimatedFare:   ride.estimatedFare,
              baseFare: ride.baseFare ?? 0,
              bookingFee: ride.bookingFee ?? 0,
              distanceFare: ride.distanceFare ?? 0,
              surchargeFare: ride.surchargeFare ?? 0,
              governmentTax: ride.governmentTax ?? 0,
              waitingCharge: ride.waitingCharge ?? 0,
              waitingTime: ride.waitingTime ?? 0,
              tip: ride.tip ?? 0,

              
              totalFare:       ride.totalFare       ?? 0,
              driverEarning:   ride.driverEarning   ?? 0,
              adminCommission: ride.adminCommission  ?? 0,
              promoDiscount:   ride.promoDiscount    ?? 0,
              paymentMethod:   ride.paymentMethod,
              paymentCardId: ride.paymentCardId ?? null,
              cardBrand:     ride.cardBrand ?? null,
              cardLast4:     ride.cardLast4 ?? null,
              deliveryProofImage: data.deliveryProofImage ?? ride.deliveryProofImage ?? null,
              changedAt:       new Date(),
              serviceType:     ride.serviceType,
              pickupType:      ride.pickupType,
            },
          },
        });

        logger.info(`[CONFIRM DROPOFF] driver=${userId} ride=${data.rideId}`);
      } catch (err: any) {
        logger.error(`[${SocketEvents.CONFIRM_DROPOFF}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to confirm dropoff', code: 500 });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CHAT EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  socket.on(
    SocketEvents.SEND_MESSAGE,
    async (payload: unknown, ackFn?: AckFn) => {
      try {
        if (role !== 'passenger' && role !== 'driver') {
          return sendAck(ackFn, { success: false, error: 'Unauthorized', code: 403 });
        }

        const SendMessageSchema = z.object({
          rideId:     z.string().min(1),
          message:    z.string().min(1).max(1000),
          receiverId: z.string().optional(),
        });

        const data = validate(SendMessageSchema, payload, ackFn);
        if (!data) return;

        const saved = await MessageService.sendMessage({
          rideId:     data.rideId,
          senderId:   userId,
          senderRole: role as 'passenger' | 'driver',
          message:    data.message,
        });

        const messagePayload = {
          id:         saved.id,
          rideId:     data.rideId,
          senderId:   userId,
          senderRole: role,
          message:    data.message,
          createdAt:  saved.createdAt,
        };

        const receiverId = (saved as any).receiverId as string | undefined;

        if (receiverId) {
          if (role === 'passenger') {
            emitToDriver(data.receiverId ?? receiverId, SocketEvents.MESSAGE_RECEIVED, messagePayload);
          } else {
            emitToPassenger(receiverId, SocketEvents.MESSAGE_RECEIVED, messagePayload);
          }
        }

        sendAck(ackFn, { success: true, data: messagePayload });
      } catch (err: any) {
        logger.error(`[${SocketEvents.SEND_MESSAGE}] error:`, err);
        sendAck(ackFn, { success: false, error: err.message ?? 'Failed to send message', code: 500 });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // NOTIFICATION EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * readNotification
   * Mark all of this user's unread notifications as read.
   */
  socket.on(SocketEvents.READ_NOTIFICATION, () => {
    if (!userId) return;

    // Fire-and-forget: mark as read asynchronously
    prisma.notification.updateMany({
      where: { receiverId: userId, isRead: false },
      data:  { isRead: true },
    }).catch((err) => logger.error('Error updating notifications:', err));

    // Immediately emit unread count (0)
    socket.emit(SocketEvents.NOTIFICATION, {
      statusCode:  200,
      success:     true,
      unreadCount: 0,
      timestamp:   new Date(),
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISCONNECT
  // ─────────────────────────────────────────────────────────────────────────

  socket.on('disconnect', async (reason) => {
    logger.info(`[DISCONNECT] ${name} (${role}) socket=${socket.id} reason=${reason}`);

    unregisterUser(userId, driverProfileId);

    if (role === 'driver' && driverProfileId) {
      // await prisma.driverProfile.update({
      //   where: { id: driverProfileId },
      //   data:  { isOnline: false },
      // }).catch((err) => logger.error('Auto-offline on disconnect failed:', err));
      logger.info(`[AUTO OFFLINE] driver=${userId}`);
      
    }

    cleanupRateLimitEntry(socket.id);
    broadcastOnlineUsers();
  });
}
