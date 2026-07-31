import prisma from '../../config/prisma';
import { getActiveFare, computeFareBreakdown, computeWaitingCharge } from './ride.pricing';

// ─────────────────────────────────────────────────────────────────────────────

interface EstimateRideOptionsProps {
  distanceKm: number;
  country:    string;
  pickupLat:  number;
  pickupLng:  number;
}

type TVehicleType = 'MINO_GO' | 'MINO_COMFORT' | 'MINO_XL' | 'MINO_MOTO';

const AVERAGE_SPEED_KMH: Record<TVehicleType, number> = {
  MINO_GO:      40,
  MINO_COMFORT: 40,
  MINO_XL:      35,
  MINO_MOTO:    45,
};

const NEARBY_DRIVER_RADIUS_METERS = 5_000;
const FALLBACK_PICKUP_DISTANCE_KM = 2;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Haversine formula — distance in km between two lat/lng points.
 */
export const getDistanceKm = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number => {
  const R    = 6_371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds available drivers near the pickup location using Haversine filtering
 * (replaces MongoDB $near).  Returns average pickup distance in km.
 */
const getAveragePickupDistanceKm = async (
  pickupLat:   number,
  pickupLng:   number,
  vehicleType: TVehicleType,
): Promise<{ avgDistanceKm: number; hasDrivers: boolean }> => {
  const radiusKm = NEARBY_DRIVER_RADIUS_RADIUS_KM();

  // Fetch candidates from a bounding box, then filter precisely with Haversine
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((pickupLat * Math.PI) / 180));

  const candidates = await prisma.driverProfile.findMany({
    where: {
      vehicleType,
      isOnline:       true,
      isOnRide:       false,
      approvalStatus: 'verified',
      currentLat: {
        gte: pickupLat - latDelta,
        lte: pickupLat + latDelta,
      },
      currentLng: {
        gte: pickupLng - lngDelta,
        lte: pickupLng + lngDelta,
      },
    },
    select: { currentLat: true, currentLng: true },
    take:   20,
  });

  // Filter with exact Haversine distance
  const nearby = candidates.filter((d) => {
    if (d.currentLat == null || d.currentLng == null) return false;
    return getDistanceKm(pickupLat, pickupLng, d.currentLat, d.currentLng) * 1_000 <= NEARBY_DRIVER_RADIUS_METERS;
  });

  if (!nearby.length) {
    return { avgDistanceKm: FALLBACK_PICKUP_DISTANCE_KM, hasDrivers: false };
  }

  const total = nearby.reduce(
    (sum, d) => sum + getDistanceKm(pickupLat, pickupLng, d.currentLat!, d.currentLng!),
    0,
  );

  return { avgDistanceKm: total / nearby.length, hasDrivers: true };
};

function NEARBY_DRIVER_RADIUS_RADIUS_KM() {
  return NEARBY_DRIVER_RADIUS_METERS / 1_000;
}

// ─────────────────────────────────────────────────────────────────────────────

export const estimateRideOptions = async ({
  distanceKm,
  country,
  pickupLat,
  pickupLng,
}: EstimateRideOptionsProps) => {
  if (!distanceKm || isNaN(Number(distanceKm))) {
    throw new Error('Invalid distanceKm value');
  }
  if (!pickupLat || !pickupLng || isNaN(pickupLat) || isNaN(pickupLng)) {
    throw new Error('Invalid pickup location coordinates');
  }

  distanceKm = Number(distanceKm);

  const fare = await getActiveFare(country);

  const vehicleTypes: TVehicleType[] = ['MINO_GO', 'MINO_COMFORT', 'MINO_XL', 'MINO_MOTO'];

  const pickupResults = await Promise.all(
    vehicleTypes.map((vehicleType) =>
      getAveragePickupDistanceKm(pickupLat, pickupLng, vehicleType),
    ),
  );

  return vehicleTypes.map((vehicleType, i) => {
    const { avgDistanceKm, hasDrivers } = pickupResults[i];
    const speed = AVERAGE_SPEED_KMH[vehicleType];
    const breakdown = computeFareBreakdown(fare, vehicleType, distanceKm);

    const estimatedArrivalTimeMin = Math.ceil((avgDistanceKm / speed) * 60);
    const estimatedRideTimeMin    = Math.ceil((distanceKm / speed) * 60);

    return {
      vehicleType,
      ...breakdown,
      estimatedArrivalTimeMin,
      estimatedRideTimeMin,
      isAvailable: hasDrivers,
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────

export const estimateMotoOptions = async ({
  distanceKm,
  country,
  pickupLat,
  pickupLng,
}: EstimateRideOptionsProps) => {
  if (!distanceKm || isNaN(Number(distanceKm))) {
    throw new Error('Invalid distanceKm value');
  }
  if (!pickupLat || !pickupLng || isNaN(pickupLat) || isNaN(pickupLng)) {
    throw new Error('Invalid pickup location coordinates');
  }

  distanceKm = Number(distanceKm);

  const fare = await getActiveFare(country);
  const { avgDistanceKm, hasDrivers } = await getAveragePickupDistanceKm(pickupLat, pickupLng, 'MINO_MOTO');
  const speed = AVERAGE_SPEED_KMH['MINO_MOTO'];
  const breakdown = computeFareBreakdown(fare, 'MINO_MOTO', distanceKm);

  return {
    vehicleType: 'MINO_MOTO' as TVehicleType,
    ...breakdown,
    estimatedArrivalTimeMin: Math.ceil((avgDistanceKm / speed) * 60),
    estimatedRideTimeMin:    Math.ceil((distanceKm / speed) * 60),
    isAvailable:             hasDrivers,
  };
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-calculate fare fields using actual distance at ride end, folding in the
 * real waiting charge (arrivedPickupAt → startRideAt) now that both timestamps
 * exist. Returns the updated fare numbers (does not write to DB).
 */
export const recalculateFare = async (params: {
  country:          string;
  vehicleCategory:  string;
  actualDistanceKm: number;
  promoDiscount:    number;
  arrivedPickupAt?: Date | null;
  startRideAt?:     Date | null;
}): Promise<{
  estimatedFare:   number;
  totalFare:       number;
  adminCommission: number;
  driverEarning:   number;
  waitingTime:     number;
  waitingCharge:   number;
}> => {

  const fare      = await getActiveFare(params.country);
  const breakdown = computeFareBreakdown(fare, params.vehicleCategory, params.actualDistanceKm);
  const { waitingTime, waitingCharge } = computeWaitingCharge(fare, params.arrivedPickupAt, params.startRideAt);

  const totalFare       = Math.max(0, breakdown.totalFare + waitingCharge - params.promoDiscount);
  const adminCommission = Math.round((totalFare * fare.platformCommissionPercentage) / 100);
  const driverEarning   = totalFare - adminCommission;

  return {
    estimatedFare: breakdown.estimatedFare,
    totalFare,
    adminCommission,
    driverEarning,
    waitingTime,
    waitingCharge,
  };
};
