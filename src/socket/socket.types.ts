// ─────────────────────────────────────────────────────────────────────────────
// socket.types.ts
// Central type registry for all Socket.IO payloads, events, and entities.
// ─────────────────────────────────────────────────────────────────────────────

import { IParcelDetails } from "../app/modules/ride/ride.interface";

// ─── Authenticated socket user ────────────────────────────────────────────────

export interface ISocketUser {
  _id: string;
  name: string;
  email: string;
  role: 'passenger' | 'driver' | 'ADMIN';
  driverProfileId?: string; // set for drivers
  country?: string;
}

// ─── Online user registry entries ─────────────────────────────────────────────

export interface IOnlineUserEntry {
  socketId: string;
  userId: string;
  role: string;
  connectedAt: Date;
  lastSeen: Date;
}

export interface IOnlineDriverEntry extends IOnlineUserEntry {
  driverProfileId: string;
  location?: [number, number]; // [lng, lat] — kept in-memory for quick lookups
  vehicleTypes?: string[];
  isOnRide: boolean;
}

// ─── Event name constants ─────────────────────────────────────────────────────

export const SocketEvents = {
  // ── Passenger → Server ──────────────────────────────────────────────────
  REQUEST_RIDE: 'request_ride',      // broadcast already-created ride to nearby drivers
  CANCEL_RIDE: 'cancel_ride',
  APPLY_PROMO: 'apply_promo',

  // ── Driver → Server ──────────────────────────────────────────────────────
  DRIVER_GO_ONLINE: 'driver:goOnline',
  DRIVER_GO_OFFLINE: 'driver:goOffline',
  UPDATE_LOCATION: 'driver:updateLocation',
  ACCEPT_RIDE: 'accept_ride',
  ARRIVED_PICKUP: 'arrived_pickup',
  START_RIDE: 'start_ride',
  END_RIDE: 'end_ride',
  ARRIVED_DROPOFF: 'arrived_dropoff',
  CONFIRM_DROPOFF: 'confirm_dropoff',
  COMPLETE_RIDE: 'complete_ride',
  PAYMENT_COMPLETED: 'payment_completed',
  PAYMENT_COLLECTED: 'payment_collected',
  // ── Room management ──────────────────────────────────────────────────────
  JOIN_RIDE_ROOM: 'join_ride_room',
  LEAVE_RIDE_ROOM: 'leave_ride_room',

  // ── Server → Client: system events ──────────────────────────────────────
  RIDE_REQUESTED: 'ride_requested',
  RIDE_ACCEPTED: 'ride_accepted',
  RIDE_ARRIVED_PICKUP: 'ride_arrived_pickup',
  RIDE_STARTED: 'ride_started',
  RIDE_ENDED: 'ride_ended',
  RIDE_CONFIRM_DROPOFF: 'ride_confirm_dropoff',
  RIDE_COMPLETED: 'ride_completed',
  RIDE_CANCELLED: 'ride_cancelled',
  RIDE_STATUS_UPDATED: 'ride_status_updated',
  PROMO_APPLIED: 'promo_applied',
  DRIVER_LOCATION_UPDATED: 'driver_location_updated',

  // ── Server → Client: driver status ───────────────────────────────────────
  DRIVER_STATUS_UPDATED: 'driver:statusUpdated',
  DRIVER_LOCATION_ACK: 'driver:locationUpdated',
  DRIVER_ERROR: 'driver:error',

  // ── Chat ─────────────────────────────────────────────────────────────────
  SEND_MESSAGE:     'send_message',      // client → server
  MESSAGE_RECEIVED: 'message_received',  // server → client

  // ── Notifications ────────────────────────────────────────────────────────
  READ_NOTIFICATION: 'readNotification', // client → server
  NOTIFICATION:       'notification',    // server → client

  // ── System / housekeeping ────────────────────────────────────────────────
  ONLINE_USERS: 'onlineUser',
  USER_CONNECTED: 'userConnected', // legacy manual registration
  ERROR: 'error',
  NO_DRIVERS_AVAILABLE: 'no_drivers_available',
  RIDE_TAKEN: 'ride_taken',
  RIDE_SCHEDULED: 'ride_scheduled',

} as const;

export type TSocketEvent = (typeof SocketEvents)[keyof typeof SocketEvents];

// ─── Inbound payloads (Client → Server) ──────────────────────────────────────

export interface RequestRidePayload {
  rideId: string; // ride must already exist (created via HTTP API)
}

export interface CancelRidePayload {
  rideId: string;
  reason: string;
  details?: string;
}

export interface ApplyPromoPayload {
  rideId: string;
  promoCode: string;
}

export interface DriverOnlinePayload {
  lat: number;
  lng: number;
}

export interface AcceptRidePayload {
  rideId: string;
}

export interface ArrivedPickupPayload {
  rideId: string;
}

export interface StartRidePayload {
  rideId: string;
}

export interface CompleteRidePayload {
  rideId: string;
}

export interface UpdateLocationPayload {
  lat: number;
  lng: number;
  rideId?: string; // include when on a ride to broadcast to the ride room
}

export interface JoinRideRoomPayload {
  rideId: string;
}

// ─── Outbound payloads (Server → Client) ─────────────────────────────────────

export interface RideRequestedPayload {
  id?: string;
  rideId: string;
  passengerId: string;
  passengerName: string;
  passengerProfileImage: string;
  passengerAverageRating: number;
  countryCode?: string;
  passengerPhone?: string;
  vehicleCategory: string;
  serviceType: string;
  pickupLocation: { address: string; coordinates: [number, number] };
  dropoffLocation: { address: string; coordinates: [number, number] };
  estimatedFare: number;
  totalFare: number | undefined;
  distanceKm: number | unknown;
  scheduledAt?: Date | null;
  distanceToPickupKm: number;   // driver current location → pickup
  estimatedArrivalMin: number;  // based on driver vehicle type speed
  pickupType: string;
  paymentMethod: string;
  parcelDetails?: IParcelDetails;

}

export interface RideAcceptedPayload {
  rideId: string;
  driverProfileId: string;
  driverName: string;
  driverProfileImage: string;
  driverAverageRating: number;
  driverPhoneNumber: string;
  driverCountryCode: string;
  vehicleBrand: string;
  vehicleModel: string;
  licenseNumber: string;
  driverCurrentLocation: { lat: number; lng: number }; // initial pin on map
  estimatedArrivalMin: number;
  acceptedAt: Date;
}

export interface RideStatusPayload {
  rideId: string;
  status: string;
  changedAt: Date;
}

export interface RideCancelledPayload {
  rideId: string;
  cancelledBy: 'PASSENGER' | 'DRIVER' | 'SYSTEM';
  reason: string;
  details?: string;
}

export interface PromoAppliedPayload {
  rideId: string;
  promoCode: string;
  promoDiscount: number | undefined;
  totalFare: number;
  driverEarning: number | undefined;
  adminCommission: number | undefined;
}

export interface RideEndedPayload {
  rideId: string;
  actualDropoffLocation: { address: string; coordinates: [number, number] };
  distanceKm: number | unknown;
  durationMin: number;
  estimatedFare: number;
  totalFare: number;
  driverEarning: number;
  adminCommission: number;
  changedAt: Date;
}

export interface ConfirmDropoffPayload {
  rideId: string;
  distanceKm: number | unknown;
  durationMin: number | unknown;
  estimatedFare: number;
  totalFare: number;
  driverEarning: number | undefined;
  adminCommission: number | undefined;
  promoDiscount: number | undefined;
  paymentMethod: string;
  changedAt: Date;
}

export interface RidePaidPayload {
  rideId: string;
  tip: number;
  totalFare: number;
  driverEarning: number;
  adminCommission: number;
  paymentStatus: string;
  changedAt: Date;
}

export interface DriverLocationPayload {
  driverProfileId: string;
  rideId?: string;
  coordinates: [number, number]; // [lng, lat]
  updatedAt: Date;
}

// ─── Acknowledgment wrapper ───────────────────────────────────────────────────

export interface SocketAck<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: number;
}
