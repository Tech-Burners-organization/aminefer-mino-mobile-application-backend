
import { MessageSenderRole } from '@prisma/client';
import httpStatus from 'http-status';
import AppError from '../../error/AppError';
import prisma from '../../config/prisma';
import { sendNotificationByFcmToken } from '../../utils/sentNotificationByFcmToken';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────

export interface SendMessagePayload {
  rideId:     string;
  senderId:   string;
  senderRole: 'passenger' | 'driver';
  message:    string;
}

const sendMessage = async (payload: SendMessagePayload) => {
  const ride = await prisma.ride.findUnique({
    where:  { id: payload.rideId },
    select: { passengerId: true, driverId: true, status: true },
  });
  if (!ride) throw new AppError(httpStatus.NOT_FOUND, 'Ride not found');

  if (ride.status === 'COMPLETED' || ride.status === 'CANCELLED') {
    throw new AppError(httpStatus.BAD_REQUEST, 'Cannot send messages on a completed or cancelled ride');
  }

  let receiverId: string;

  if (payload.senderRole === 'passenger') {
    if (ride.passengerId !== payload.senderId) {
      throw new AppError(httpStatus.FORBIDDEN, 'You are not the passenger of this ride');
    }
    if (!ride.driverId) throw new AppError(httpStatus.BAD_REQUEST, 'No driver assigned to this ride yet');

    const driverProfile = await prisma.driverProfile.findUnique({
      where:  { id: ride.driverId },
      select: { userId: true },
    });
    if (!driverProfile) throw new AppError(httpStatus.NOT_FOUND, 'Driver not found');
    receiverId = driverProfile.userId;

  } else {
    if (!ride.driverId) throw new AppError(httpStatus.BAD_REQUEST, 'No driver assigned to this ride yet');

    const driverProfile = await prisma.driverProfile.findFirst({
      where:  { userId: payload.senderId },
      select: { id: true },
    });
    if (!driverProfile || driverProfile.id !== ride.driverId) {
      throw new AppError(httpStatus.FORBIDDEN, 'You are not the driver of this ride');
    }
    receiverId = ride.passengerId;
  }

  const saved = await prisma.message.create({
    data: {
      rideId:     payload.rideId,
      senderId:   payload.senderId,
      receiverId,
      senderRole: payload.senderRole as MessageSenderRole,
      message:    payload.message,
    },
    include: { sender: { select: { name: true, profileImage: true } } },
  });

  const senderName = saved.sender?.name ?? (payload.senderRole === 'driver' ? 'Your driver' : 'Your passenger');
  const notificationBody = payload.message.length > 100
    ? `${payload.message.slice(0, 100)}...`
    : payload.message;

  sendNotificationByFcmToken(
    receiverId,
    notificationBody,
    `New message from ${senderName}`,
  ).catch((err) => logger.warn('sendMessage: FCM to receiver failed:', err));

  return saved;
};

// ─────────────────────────────────────────────────────────────────────────────

const getRideMessages = async (rideId: string, requesterId: string) => {
  const ride = await prisma.ride.findUnique({
    where:  { id: rideId },
    select: { passengerId: true, driverId: true },
  });
  if (!ride) throw new AppError(httpStatus.NOT_FOUND, 'Ride not found');

  const isPassenger = ride.passengerId === requesterId;
  let isDriver = false;

  if (!isPassenger && ride.driverId) {
    const driverProfile = await prisma.driverProfile.findFirst({
      where:  { userId: requesterId },
      select: { id: true },
    });
    isDriver = !!driverProfile && driverProfile.id === ride.driverId;
  }

  if (!isPassenger && !isDriver) {
    throw new AppError(httpStatus.FORBIDDEN, 'You are not a participant of this ride');
  }

  await prisma.message.updateMany({
    where: { rideId, receiverId: requesterId, isRead: false, isDeleted: false },
    data:  { isRead: true },
  });

  const msgs = await prisma.message.findMany({
    where:   { rideId, isDeleted: false },
    orderBy: { createdAt: 'asc' },
    select:  { id: true, rideId: true, senderId: true, senderRole: true, message: true, createdAt: true },
  });

  return msgs.map((m) => ({
    _id:        m.id,
    rideId:     m.rideId,
    senderId:   m.senderId,
    senderRole: m.senderRole,
    message:    m.message,
    createdAt:  m.createdAt,
  }));
};

// ─────────────────────────────────────────────────────────────────────────────

const getUnreadCount = async (rideId: string, userId: string): Promise<number> => {
  return prisma.message.count({ where: { rideId, receiverId: userId, isRead: false, isDeleted: false } });
};

// ─────────────────────────────────────────────────────────────────────────────

export const MessageService = {
  sendMessage,
  getRideMessages,
  getUnreadCount,
};
