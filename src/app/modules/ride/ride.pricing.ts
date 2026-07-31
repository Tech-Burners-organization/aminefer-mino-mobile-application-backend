import { Fare } from '@prisma/client';
import prisma from '../../config/prisma';
import AppError from '../../error/AppError';
import httpStatus from 'http-status';

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for ride fare math.
//
// Nothing outside this file should compute estimatedFare/totalFare/driverEarning/
// adminCommission from a Fare row — estimateRideOptions(), estimateMotoOptions(),
// recalculateFare() and createRide() all route through computeFareBreakdown().
// ─────────────────────────────────────────────────────────────────────────────

export type TVehicleCategory = 'MINO_GO' | 'MINO_COMFORT' | 'MINO_XL' | 'MINO_MOTO';

export interface RideFareBreakdown {
  baseFare:        number;
  bookingFee:      number;
  distanceFare:    number;
  waitingCharge:   number;
  surchargeFare:   number;
  subtotalFare:    number;
  estimatedFare:   number;
  totalFare:       number;
  adminCommission: number;
  driverEarning:   number;
}

interface VehiclePricing {
  baseFee:     number;
  bookingFee:  number;
  ratePerKm:   number;
  minimumFare: number;
}

const vehiclePricingFromFare = (fare: Fare): Record<TVehicleCategory, VehiclePricing> => ({
  MINO_GO:      { baseFee: fare.minoGoBaseFee,   bookingFee: fare.minoGoBookingFee,   ratePerKm: fare.minoGoRatePerKm,   minimumFare: fare.minoGoMinimumFare },
  MINO_COMFORT: { baseFee: fare.minoGoBaseFee,   bookingFee: fare.minoGoBookingFee,   ratePerKm: fare.minoGoRatePerKm,   minimumFare: fare.minoGoMinimumFare },
  MINO_XL:      { baseFee: fare.minoXLBaseFee,   bookingFee: fare.minoXLBookingFee,   ratePerKm: fare.minoXLRatePerKm,   minimumFare: fare.minoXLMinimumFare },
  MINO_MOTO:    { baseFee: fare.minoMotoBaseFee, bookingFee: fare.minoMotoBookingFee, ratePerKm: fare.minoMotoRatePerKm, minimumFare: fare.minoMotoMinimumFare },
});

// ── getActiveFare — the one place "which Fare row applies to this country" is decided ──

export const getActiveFare = async (country: string): Promise<Fare> => {
  const fare = await prisma.fare.findFirst({
    where: { country: (country || 'BANGLADESH').toUpperCase(), isActive: true },
  });
  if (!fare) throw new AppError(httpStatus.BAD_REQUEST, 'Fare configuration not found for this country');
  return fare;
};

// ── computeFareBreakdown — pure math, no I/O. Callers that already hold a Fare row
//    (e.g. estimating all 4 vehicle types from one fetch) call this directly. ──────

export const computeFareBreakdown = (
  fare:            Fare,
  vehicleCategory: string,
  distanceKm:      number,
): RideFareBreakdown => {
  if (!distanceKm || isNaN(Number(distanceKm))) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid distanceKm value');
  }
  distanceKm = Number(distanceKm);

  const pricingMap = vehiclePricingFromFare(fare);
  const pricing     = pricingMap[vehicleCategory as TVehicleCategory] ?? pricingMap.MINO_GO;

  const baseFare     = pricing.baseFee;
  const bookingFee   = pricing.bookingFee;
  const distanceFare = pricing.ratePerKm * distanceKm;

  const subtotalFare  = baseFare + bookingFee + distanceFare;
  const estimatedFare = Math.max(subtotalFare, pricing.minimumFare);

  // Waiting charge depends on actual driver-wait time (arrivedPickupAt → startRideAt),
  // which doesn't exist yet at quote/creation time — it's computed once the ride has
  // actually happened, via computeWaitingCharge() (see recalculateFare()).
  const waitingCharge = 0;
  const surchargeFare = fare.surchargeEnabled ? fare.surchargeValue : 0;

  const totalFare       = estimatedFare + waitingCharge + surchargeFare;
  const adminCommission = (totalFare * fare.platformCommissionPercentage) / 100;
  const driverEarning   = totalFare - adminCommission;

  return {
    baseFare:        Math.round(baseFare),
    bookingFee:      Math.round(bookingFee),
    distanceFare:    Math.round(distanceFare),
    waitingCharge:   Math.round(waitingCharge),
    surchargeFare:   Math.round(surchargeFare),
    subtotalFare:    Math.round(subtotalFare),
    estimatedFare:   Math.round(estimatedFare),
    totalFare:       Math.round(totalFare),
    adminCommission: Math.round(adminCommission),
    driverEarning:   Math.round(driverEarning),
  };
};

// ── computeWaitingCharge — actual driver-wait time, charged only past the grace period.
//    waitingTime is the elapsed minutes between the driver arriving at pickup and the
//    ride actually starting; only known once both timestamps exist on the ride. ───────

export interface WaitingChargeResult {
  waitingTime:   number; // minutes
  waitingCharge: number;
}

export const computeWaitingCharge = (
  fare:            Fare,
  arrivedPickupAt: Date | null | undefined,
  startRideAt:     Date | null | undefined,
): WaitingChargeResult => {
  if (!fare.waitingChargeEnabled || !arrivedPickupAt || !startRideAt) {
    return { waitingTime: 0, waitingCharge: 0 };
  }

  const waitingTime = Math.max(0, Math.round((startRideAt.getTime() - arrivedPickupAt.getTime()) / 60_000));

  if (waitingTime <= fare.waitingChargeGracePeriod) {
    return { waitingTime, waitingCharge: 0 };
  }

  const chargeableWaitingTime = waitingTime - fare.waitingChargeGracePeriod;
  const waitingCharge         = Math.round(chargeableWaitingTime * fare.waitingChargeRate);

  return { waitingTime, waitingCharge };
};

// ── calculateRideFare — the reusable pricing entry point (fetch + compute). ──────────
//    This is what createRide() calls: it never trusts a client-sent fare, it derives
//    one from country + vehicleCategory + distanceKm against the live Fare table.

export const calculateRideFare = async ({
  country,
  vehicleCategory,
  distanceKm,
  durationMin,
}: {
  country:         string;
  vehicleCategory: string;
  distanceKm:      number;
  durationMin?:    number;
}): Promise<RideFareBreakdown> => {
  void durationMin; // reserved — no duration-based charge exists today, kept for interface parity
  const fare = await getActiveFare(country);
  return computeFareBreakdown(fare, vehicleCategory, distanceKm);
};

// ── buildFareBreakdown — project a persisted Ride's snapshot columns into the
//    API-facing fareBreakdown shape (Ride Details response). ────────────────────────

export const buildFareBreakdown = (ride: {
  baseFare:        number;
  bookingFee:      number;
  distanceFare:    number;
  waitingCharge:   number;
  surchargeFare:   number;
  subtotalFare:    number;
  promoDiscount:   number;
  tip:             number;
  totalFare:       number;
  adminCommission: number;
  driverEarning:   number;
}) => ({
  baseFare:        ride.baseFare,
  bookingFee:      ride.bookingFee,
  distanceFare:    ride.distanceFare,
  waitingCharge:   ride.waitingCharge,
  surchargeFare:   ride.surchargeFare,
  subtotalFare:    ride.subtotalFare,
  promoDiscount:   ride.promoDiscount,
  tip:             ride.tip,
  totalFare:       ride.totalFare,
  platformFee:     ride.adminCommission,
  driverEarning:   ride.driverEarning,
});
