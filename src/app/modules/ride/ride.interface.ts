import {
  Ride,
  RideStatus,
  ServiceType,
  PaymentMethod,
  PickupType,
  CancellationActor,
  ParcelItemType,
  Prisma,
} from '@prisma/client';

// ── Re-export Prisma generated type as the canonical Ride type ────────────────
export type TRide = Ride;

// ── Subset types for embedded/related data ────────────────────────────────────
export type TRideStatus       = RideStatus;
export type TServiceType      = ServiceType;
export type TPickupType       = PickupType;
export type TCancellationActor = CancellationActor;

// ── Speed lookup by vehicle category ─────────────────────────────────────────
export const AVERAGE_SPEED_KMH: Record<string, number> = {
  MINO_MOTO:    35,
  MINO_GO:      40,
  MINO_COMFORT: 45,
  MINO_XL:      38,
};

// ── Nearest-ride query props ──────────────────────────────────────────────────
export interface NearestRidesProps {
  driverLat:        number;
  driverLng:        number;
  maxDistanceMeters?: number;
  now?:              Date;
}

// ── Review entry (used in submitRideReview response) ─────────────────────────
export interface IReviewEntry {
  rating:   number;
  comment?: string;
  givenAt:  Date;
}

// ── Location shape used inside service / socket payloads ─────────────────────
export interface ILocation {
  address: string;
  lat:     number;
  lng:     number;
}

// ── Cancellation payload ──────────────────────────────────────────────────────
export interface ICancellation {
  cancelledBy: CancellationActor;
  reason:      string;
  details?:    string;
  timestamp:   Date;
}

// ── Parcel details payload (used when creating a PARCEL ride) ─────────────────
export interface IParcelDetails {
  itemType:       ParcelItemType;
  approxWeightKg: number;
  isFragile:      boolean;
  notes?:         string;
  instructions?:  string;
  receiverName:   string;
  receiverPhone:  string;
}

// ── Create-ride payload ───────────────────────────────────────────────────────
// NOTE: fare fields (estimatedFare/totalFare/driverEarning/adminCommission) are
// intentionally NOT part of this payload — the backend derives them from the
// live Fare table via ride.pricing.ts#calculateRideFare(). Never accept them
// from the client. distanceKm/durationMin are still client-supplied (they come
// from the client's own Maps/Directions SDK, which the backend doesn't have).
export interface TRideCreate {
  country:        string;
  passengerId:    string;
  serviceType:    ServiceType;
  vehicleCategory: string;

  pickupAddress:  string;
  pickupLat:      number;
  pickupLng:      number;

  dropoffAddress: string;
  dropoffLat:     number;
  dropoffLng:     number;

  paymentMethod:  PaymentMethod;
  distanceKm:     number;
  durationMin:    number;

  pickupType:     PickupType;
  scheduledAt?:   Date | null;

  parcelDetails?: IParcelDetails;
}

// ── Ride with relations (for populated queries) ───────────────────────────────
export type TRideWithPassenger = Prisma.RideGetPayload<{
  include: {
    passenger: { select: { id: true; name: true; profileImage: true; phoneNumber: true; averageRating: true; totalReview: true; countryCode: true } };
    statusHistory: true;
    cancellations: true;
    parcelDetails: true;
  };
}>;

export type TRideWithDriver = Prisma.RideGetPayload<{
  include: {
    driver: {
      include: {
        user: { select: { id: true; name: true; profileImage: true; phoneNumber: true; countryCode: true; averageRating: true; totalReview: true } };
      };
    };
    statusHistory: true;
    cancellations: true;
    parcelDetails: true;
  };
}>;
