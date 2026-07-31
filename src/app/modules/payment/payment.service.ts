
import httpStatus from 'http-status';
import Stripe from 'stripe';
import AppError from '../../error/AppError';
import config from '../../config';
import stripeClient from '../../utils/stripe';
import { logger } from '../../utils/logger';
import { IPayment, TPaymentMethod } from './payment.interface';
import prisma from '../../config/prisma';
import {
  isManagerReady,
  emitToRideRoom,
  emitToDriver,
  emitToPassenger,
  setDriverOnRide,
} from '../../../socket/socket.manager';
import { SocketEvents } from '../../../socket/socket.types';
import { recordWalletTransaction } from '../wallet/wallet.service';
import { rideCompletedEmailTemplate } from '../../utils/emailNotification';

// ─────────────────────────────────────────────────────────────────────────────

const buildPagination = (query: Record<string, unknown>) => {
  const page  = Math.max(1, Number(query.page)  || 1);
  const limit = Math.max(1, Number(query.limit) || 10);
  return { skip: (page - 1) * limit, take: limit, page, limit };
};

const generateTransactionId = async (): Promise<string> => {
  while (true) {
    const candidate = `#MNP${Math.floor(1000 + Math.random() * 9000)}`;
    const exists    = await prisma.payment.findUnique({ where: { transactionId: candidate } });
    if (!exists) return candidate;
  }
};

// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePaymentPayload {
  rideId:           string;
  passengerId:      string;
  driverId:         string;
  amount:           number;
  totalFare?:       number;
  driverEarning?:   number;
  adminCommission?: number;
  promo?:           string;
  promoDiscount?:   number;
  tip?:             number;
  paymentMethod:    TPaymentMethod;
  stripePaymentIntentId?: string;
}

const createPayment = async (payload: CreatePaymentPayload): Promise<IPayment> => {
  const transactionId = await generateTransactionId();

  return prisma.payment.create({
    data: {
      transactionId,
      rideId:                payload.rideId,
      passengerId:           payload.passengerId,
      driverId:              payload.driverId,
      amount:                payload.amount,
      totalFare:             payload.totalFare      ?? payload.amount,
      driverEarning:         payload.driverEarning  ?? 0,
      adminCommission:       payload.adminCommission ?? 0,
      promo:                 payload.promo           ?? null,
      promoDiscount:         payload.promoDiscount   ?? 0,
      tip:                   payload.tip             ?? 0,
      paymentMethod:         payload.paymentMethod,
      paymentStatus:         'PAID',
      stripePaymentIntentId: payload.stripePaymentIntentId ?? null,
      paidAt:                new Date(),
    },
  }) as unknown as IPayment;
};

// ─────────────────────────────────────────────────────────────────────────────

const createCheckoutSession = async (
  rideId:      string,
  passengerId: string,
  tip = 0,
) => {
  const ride = await prisma.ride.findUnique({ where: { id: rideId, isDeleted: false} });
  if (!ride) throw new AppError(httpStatus.NOT_FOUND, 'Ride not found');

  if (ride.passengerId !== passengerId) {
    throw new AppError(httpStatus.FORBIDDEN, 'You are not the passenger of this ride');
  }
  if (ride.paymentMethod !== 'CARD') {
    throw new AppError(httpStatus.BAD_REQUEST, 'This ride is not set up for CARD payment');
  }
  if (ride.status !== 'CONFIRM_DROPOFF') {
    throw new AppError(httpStatus.BAD_REQUEST, `Payment not allowed in status: ${ride.status}`);
  }
  if (ride.paymentStatus === 'PAID') {
    throw new AppError(httpStatus.CONFLICT, 'Ride already paid');
  }

  const tipAmount    = Math.max(0, Math.round(tip));
  const subtotal     = ride.totalFare ?? 0;
  const newTotalFare = subtotal + tipAmount;

  let country = ride.country || "BANGLADESH";

  const fare            = await prisma.fare.findFirst({ where: { country, isActive: true } });
  const commissionPct   = fare?.platformCommissionPercentage ?? 0;
  const adminCommission = Math.round((subtotal * commissionPct) / 100);
  const driverEarning   = Math.round(newTotalFare - adminCommission);

  await prisma.ride.update({
    where: { id: rideId },
    data:  { tip: tipAmount, totalFare: newTotalFare, adminCommission, driverEarning },
  });

  const currency = config.stripe.stripe_currency as string;
  const zeroDecimalCurrencies = ['bif', 'clp', 'gnf', 'jpy', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'xaf', 'xof'];
  const stripeAmount = zeroDecimalCurrencies.includes(currency.toLowerCase())
    ? Math.round(newTotalFare)
    : Math.round(newTotalFare * 100);

  const session = await stripeClient.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [{
      price_data: {
        currency,
        unit_amount: stripeAmount,
        product_data: {
          name:        `Mino Ride Share — Ride ${ride.rideId ?? rideId}`,
          description: tipAmount > 0 ? `Fare: ${subtotal} + Tip: ${tipAmount}` : `Fare: ${subtotal}`,
        },
      },
      quantity: 1,
    }],
    metadata: {
      rideId,
      passengerId,
      driverId: ride.driverId ?? '',
      tip:      String(tipAmount),
    },
    success_url: `http://104.236.248.157:3000/payment/success?rideId=${rideId}`,
    cancel_url:  `http://104.236.248.157:3000/payment/cancel?rideId=${rideId}`,
  });

  return {
    checkoutUrl: session.url!,
    sessionId:   session.id,
    fareBreakdown: {
      estimatedFare:   ride.estimatedFare,
      promoDiscount:   ride.promoDiscount ?? 0,
      subtotal,
      tip:             tipAmount,
      totalFare:       newTotalFare,
      driverEarning,
      adminCommission,
    },
    currency,
  };
};

// ─────────────────────────────────────────────────────────────────────────────

const handleStripeWebhook = async (rawBody: Buffer, signature: string): Promise<void> => {
  const webhookSecret = config.stripe.stripe_webhook_secret;
  if (!webhookSecret) throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Stripe webhook secret not configured');

  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    throw new AppError(httpStatus.BAD_REQUEST, `Webhook signature verification failed: ${(err as Error).message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    // ── Wallet top-up ──────────────────────────────────────────────────────
    if (session.metadata?.type === 'WALLET_TOP_UP') {
      const { userId, role, amount } = session.metadata;
      if (!userId || !amount) return;

      const topUpAmount = Number(amount);
      if (topUpAmount <= 0) return;

      try {
        if (role === 'driver') {
          await prisma.$transaction(async (tx) => {
            const driver = await tx.driverProfile.findFirst({ where: { userId }, select: { id: true, walletBalance: true } });
            if (!driver) throw new AppError(httpStatus.NOT_FOUND, 'Driver profile not found');

            await tx.driverProfile.update({
              where: { id: driver.id },
              data:  { walletBalance: { increment: topUpAmount } },
            });

            await tx.walletTransaction.create({
              data: {
                userId,
                type:          'CREDIT',
                source:        'TOP_UP',
                amount:        topUpAmount,
                balanceBefore: driver.walletBalance,
                balanceAfter:  driver.walletBalance + topUpAmount,
                description:   'Wallet top-up via card',
              },
            });
          });
        } else {
          await recordWalletTransaction({
            userId,
            type:        'CREDIT',
            source:      'TOP_UP',
            amount:      topUpAmount,
            description: 'Wallet top-up via card',
          });
        }
      } catch (err) {
        logger.warn('handleStripeWebhook: wallet top-up failed:', err);
      }
      return;
    }
    // ── End wallet top-up ──────────────────────────────────────────────────

    const { rideId, passengerId, driverId } = session.metadata ?? {};
    if (!rideId) return;

    const ride = await prisma.ride.findUnique({ where: { id: rideId, isDeleted: false } });
    if (!ride || ride.paymentStatus === 'PAID') return;

    await prisma.ride.update({
      where: { id: rideId },
      data:  {
        paymentStatus: 'PAID',
        status:        'COMPLETED',
        statusHistory: { create: [{ status: 'COMPLETED' }] },
      },
    });

    // Send ride completed email (non-critical)
    prisma.user.findUnique({ where: { id: ride.passengerId }, select: { email: true, name: true } })
      .then((passenger) => {
        if (passenger?.email) {
          return rideCompletedEmailTemplate({
            sentTo:              passenger.email,
            subject:             'Your Ride is Completed',
            passengerName:       passenger.name ?? 'Passenger',
            rideId:              ride.rideId ?? rideId,
            date:                ride.createdAt.toLocaleDateString(),
            pickupAddress:       ride.pickupAddress ?? '',
            dropoffAddress:      ride.dropoffAddress ?? '',
            totalFare:           ride.totalFare ?? 0,
            subtotal:            ride.estimatedFare ?? undefined,
            discount:            ride.promoDiscount ?? undefined,
            platformCommission:  ride.adminCommission ?? undefined,
            paymentMethod:       'CARD',
            distanceKm:          ride.distanceKm ?? undefined,
            durationMin:         ride.durationMin ?? undefined,
          });
        }
      })
      .catch((err) => logger.warn('handleStripeWebhook: ride completed email failed:', err));

    try {
      const existingPayment = await prisma.payment.findFirst({ where: { rideId } });
      if (!existingPayment) {
        const transactionId = await generateTransactionId();
        await prisma.payment.create({
          data: {
            transactionId,
            rideId,
            passengerId:           passengerId ?? ride.passengerId,
            driverId:              driverId    ?? ride.driverId ?? '',
            amount:                ride.totalFare      ?? 0,
            totalFare:             ride.totalFare      ?? 0,
            driverEarning:         ride.driverEarning  ?? 0,
            adminCommission:       ride.adminCommission ?? 0,
            promo:                 ride.promoId         ?? null,
            promoDiscount:         ride.promoDiscount   ?? 0,
            tip:                   ride.tip             ?? 0,
            paymentMethod:         'CARD',
            paymentStatus:         'PAID',
            stripePaymentIntentId: session.payment_intent as string,
            paidAt:                new Date(),
          },
        });
      } else {
        await prisma.payment.update({
          where: { id: existingPayment.id },
          data:  {
            paymentStatus:         'PAID',
            totalFare:             ride.totalFare      ?? 0,
            driverEarning:         ride.driverEarning  ?? 0,
            adminCommission:       ride.adminCommission ?? 0,
            promo:                 ride.promoId         ?? null,
            promoDiscount:         ride.promoDiscount   ?? 0,
            tip:                   ride.tip             ?? 0,
            stripePaymentIntentId: session.payment_intent as string,
            paidAt:                new Date(),
          },
        });
      }
    } catch (err) {
      logger.warn('handleStripeWebhook: payment record upsert failed:', err);
    }

    try {
      const earning = ride.driverEarning ?? 0;
      if (driverId) {
        await prisma.driverProfile.update({
          where: { id: driverId },
          data:  { walletBalance: { increment: earning }, totalEarnings: { increment: earning }, totalTrips: { increment: 1 } },
        });

        if (earning > 0) {
          const dp = await prisma.driverProfile.findUnique({ where: { id: driverId }, select: { userId: true } });
          if (dp) {
            recordWalletTransaction({
              userId:      dp.userId,
              type:        'CREDIT',
              source:      'RIDE_EARNING',
              amount:      earning,
              description: `Earnings from ride #${ride.rideId ?? rideId}`,
              rideId,
            }).catch((err) => logger.warn('handleStripeWebhook: driver wallet tx failed:', err));
          }
        }
      }
    } catch (err) {
      logger.warn('handleStripeWebhook: driver wallet credit failed:', err);
    }

    try {
      if (isManagerReady()) {
        const payload = {
          rideId,
          pickupLocation:  { address: ride.pickupAddress,  coordinates: [ride.pickupLng,  ride.pickupLat]  },
          dropoffLocation: { address: ride.dropoffAddress, coordinates: [ride.dropoffLng, ride.dropoffLat] },
          distanceKm:      ride.distanceKm,
          durationMin:     ride.durationMin,
          estimatedFare:   ride.estimatedFare,
          totalFare:       ride.totalFare    ?? 0,
          tip:             ride.tip          ?? 0,
          driverEarning:   ride.driverEarning  ?? 0,
          adminCommission: ride.adminCommission ?? 0,
          promoDiscount:   ride.promoDiscount   ?? 0,
          paymentStatus:   'PAID',
          paymentMethod:   ride.paymentMethod,
          changedAt:       new Date(),
          status:          'PAYMENT_COMPLETED',
        };

        emitToRideRoom(rideId, SocketEvents.RIDE_COMPLETED, payload);
        emitToRideRoom(rideId, SocketEvents.RIDE_STATUS_UPDATED, { rideId, status: 'PAYMENT_COMPLETED', changedAt: new Date() });

        if (ride.driverId) {
          emitToDriver(ride.driverId, SocketEvents.RIDE_STATUS_UPDATED, payload);
          setDriverOnRide(ride.driverId, false);
        }
      }
    } catch (err) {
      logger.warn('handleStripeWebhook: socket emission failed:', err);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent   = event.data.object as Stripe.PaymentIntent;
    const { rideId } = intent.metadata;
    if (!rideId) return;

    await prisma.payment.updateMany({
      where: { rideId, stripePaymentIntentId: intent.id },
      data:  { paymentStatus: 'FAILED' },
    });
    logger.warn(`Stripe payment failed for ride ${rideId}: ${intent.last_payment_error?.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const getPaymentByRide = async (rideId: string) => {
  const payment = await prisma.payment.findFirst({
    where:   { rideId, isDeleted: false },
    include: {
      passenger: { select: { name: true, profileImage: true, phoneNumber: true } },
      driver:    {
        select: {
          vehicleModel: true, vehicleBrand: true,
          user: { select: { name: true, profileImage: true } },
        },
      },
      ride: {
        select: { rideId: true, pickupAddress: true, dropoffAddress: true, distanceKm: true, durationMin: true, status: true },
      },
    },
  });

  if (!payment) throw new AppError(httpStatus.NOT_FOUND, 'Payment not found for this ride');
  return payment;
};

// ─────────────────────────────────────────────────────────────────────────────

const getPassengerPayments = async (passengerId: string, query: Record<string, unknown>) => {
  const { skip, take, page, limit } = buildPagination(query);

  const [result, total] = await Promise.all([
    prisma.payment.findMany({
      where:   { passengerId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        ride:   { select: { rideId: true, pickupAddress: true, dropoffAddress: true, distanceKm: true, durationMin: true, status: true } },
        driver: { select: { vehicleModel: true, vehicleBrand: true, user: { select: { name: true, profileImage: true } } } },
      },
    }),
    prisma.payment.count({ where: { passengerId, isDeleted: false } }),
  ]);

  return { meta: { page, limit, total, totalPage: Math.ceil(total / limit) }, result };
};

// ─────────────────────────────────────────────────────────────────────────────

const getDriverPayments = async (driverId: string, query: Record<string, unknown>) => {
  const { skip, take, page, limit } = buildPagination(query);

  const [result, total] = await Promise.all([
    prisma.payment.findMany({
      where:   { driverId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        ride:      { select: { rideId: true, pickupAddress: true, dropoffAddress: true, distanceKm: true, durationMin: true, status: true } },
        passenger: { select: { name: true, profileImage: true, phoneNumber: true } },
      },
    }),
    prisma.payment.count({ where: { driverId, isDeleted: false } }),
  ]);

  return { meta: { page, limit, total, totalPage: Math.ceil(total / limit) }, result };
};

// ─────────────────────────────────────────────────────────────────────────────

const adminGetAllPayments = async (query: Record<string, unknown>) => {
  const { skip, take, page, limit } = buildPagination(query);
  const searchTerm = query.searchTerm as string | undefined;

  const where = {
    isDeleted: false,
    ...(searchTerm && {
      OR: [
        { transactionId: { contains: searchTerm, mode: 'insensitive' as const } },
        { paymentMethod: { equals: searchTerm.toUpperCase() as any } },
        { paymentStatus: { equals: searchTerm.toUpperCase() as any } },
      ],
    }),
  };

  const [result, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        passenger: { select: { name: true, profileImage: true, countryCode: true, phoneNumber: true } },
      },
    }),
    prisma.payment.count({ where }),
  ]);

  return { meta: { page, limit, total, totalPage: Math.ceil(total / limit) }, result };
};

// ─────────────────────────────────────────────────────────────────────────────
// captureRidePayment — called from payRide() once the passenger explicitly
// confirms (with an optional tip). Captures the previously authorized
// PaymentIntent for totalFare + tip, then marks the ride COMPLETED + PAID
// and credits the driver wallet. Commission is charged on the fare only —
// the tip passes through to the driver in full.
// ─────────────────────────────────────────────────────────────────────────────

const captureRidePayment = async (rideId: string, tip = 0): Promise<void> => {
  const ride = await prisma.ride.findUnique({ where: { id: rideId, isDeleted: false } });
  if (!ride)                       throw new AppError(httpStatus.NOT_FOUND,   'Ride not found');
  if (!ride.stripePaymentIntentId) throw new AppError(httpStatus.BAD_REQUEST, 'No Stripe PaymentIntent on this ride');
  if (ride.paymentStatus === 'PAID') return; // idempotent — already captured

  const tipAmount     = Math.max(0, Math.round(tip));
  const fareOnly      = ride.totalFare ?? 0;
  const totalFare     = fareOnly + tipAmount;
  const captureAmount = Math.round(totalFare * 100); // cents

  const fareConfig      = await prisma.fare.findFirst({ where: { country: ride.country, isActive: true } });
  const commissionPct   = fareConfig?.platformCommissionPercentage ?? 0;
  const adminCommission = Math.round((fareOnly * commissionPct) / 100);
  const driverEarning   = Math.round(totalFare - adminCommission);

  // Capture fare + tip (always ≤ authorized amount which was fareOnly × 1.5)
  await stripeClient.paymentIntents.capture(ride.stripePaymentIntentId, {
    amount_to_capture: captureAmount,
  });

  // Mark ride COMPLETED + PAID
  const saved: any = await prisma.ride.update({
    where: { id: rideId },
    data:  {
      tip:             tipAmount,
      totalFare,
      paymentStatus:   'PAID',
      status:          'COMPLETED',
      adminCommission,
      driverEarning,
      statusHistory:   { create: [{ status: 'COMPLETED' }] },
    },
  });

  // Credit driver wallet + stats (non-critical)
  if (ride.driverId) {
    prisma.driverProfile.update({
      where: { id: ride.driverId },
      data:  {
        walletBalance: { increment: driverEarning },
        totalEarnings: { increment: driverEarning },
        totalTrips:    { increment: 1 },
      },
    }).catch((err) => logger.warn('captureRidePayment: driver wallet update failed:', err));

    prisma.driverProfile.findUnique({ where: { id: ride.driverId }, select: { userId: true } })
      .then((dp) => {
        if (dp && adminCommission > 0) {
          recordWalletTransaction({
            userId:      dp.userId,
            type:        'DEBIT',
            source:      'ADMIN_COMMISSION',
            amount:      adminCommission,
            description: `Platform commission for ride #${ride.rideId ?? rideId}`,
            rideId,
          }).catch((e) => logger.warn('captureRidePayment: commission wallet tx failed:', e));
        }
      })
      .catch((e) => logger.warn('captureRidePayment: driver lookup failed:', e));
  }

  // Payment record (non-critical)
  prisma.payment.findFirst({ where: { rideId } }).then((existing) => {
    if (!existing) {
      createPayment({
        rideId,
        passengerId:           ride.passengerId,
        driverId:              ride.driverId!,
        amount:                totalFare,
        totalFare,
        driverEarning,
        adminCommission,
        promoDiscount:         ride.promoDiscount,
        tip:                   tipAmount,
        paymentMethod:         'CARD',
        stripePaymentIntentId: ride.stripePaymentIntentId!,
      }).catch((err) => logger.warn('captureRidePayment: payment record failed:', err));
    }
  }).catch((err) => logger.warn('captureRidePayment: payment lookup failed:', err));

  // Ride completed email (non-critical)
  prisma.user.findUnique({ where: { id: ride.passengerId }, select: { email: true, name: true } })
    .then((passenger) => {
      if (passenger?.email) {
        return rideCompletedEmailTemplate({
          sentTo:             passenger.email,
          subject:            'Your Ride is Completed',
          passengerName:      passenger.name ?? 'Passenger',
          rideId:             ride.rideId ?? rideId,
          date:               ride.createdAt.toLocaleDateString(),
          pickupAddress:      ride.pickupAddress  ?? '',
          dropoffAddress:     ride.dropoffAddress ?? '',
          totalFare,
          subtotal:           ride.estimatedFare  ?? undefined,
          discount:           ride.promoDiscount  ?? undefined,
          platformCommission: adminCommission,
          paymentMethod:      'CARD',
          distanceKm:         ride.distanceKm  ?? undefined,
          durationMin:        ride.durationMin ?? undefined,
        });
      }
    })
    .catch((err) => logger.warn('captureRidePayment: email failed:', err));

  // Socket — RIDE_COMPLETED
  try {
    if (isManagerReady()) {
      const completedPayload = {
        rideId,
        status:          'COMPLETED',
        totalFare,
        driverEarning,
        adminCommission,
        paymentStatus:   'PAID',
        paymentMethod:   'CARD',
        changedAt:       new Date(),
        serviceType:     saved.serviceType,
        pickupType:      saved.pickupType,
      };
      emitToRideRoom(rideId, SocketEvents.RIDE_COMPLETED, completedPayload);
      emitToDriver(saved.driverId, SocketEvents.RIDE_STATUS_UPDATED, { rideId, status: 'PAYMENT_COMPLETED', changedAt: new Date() });
      emitToPassenger(saved.passengerId, SocketEvents.RIDE_STATUS_UPDATED, { rideId, status: 'COMPLETED', changedAt: new Date() });
      if (ride.driverId) setDriverOnRide(ride.driverId, false);
    }
  } catch (err) {
    logger.warn('captureRidePayment: socket emission failed:', err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────

export const PaymentService = {
  createPayment,
  createCheckoutSession,
  handleStripeWebhook,
  getPaymentByRide,
  getPassengerPayments,
  getDriverPayments,
  adminGetAllPayments,
  captureRidePayment,
};
