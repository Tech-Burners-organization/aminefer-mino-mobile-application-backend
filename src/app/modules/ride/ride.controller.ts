import { Request, Response } from 'express';
import { RideService } from './ride.service';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { estimateMotoOptions, estimateRideOptions } from './ride.utils';


const createRide = catchAsync(async (req: Request, res: Response) => {
  const {userId, country} = req.user;

  req.body.passenger = userId;

  const result = await RideService.createRide(req.body);

  // No drivers found — ride was deleted
  if (!result) {
    sendResponse(res, {
      statusCode: 200,
      success: false,
      message: 'No drivers are currently available in your area. Please try again in a few minutes.',
      data: null,
    });
    return;
  }

  // CARD: 3DS authentication required before ride can be created
  if ('requiresAction' in result && result.requiresAction) {
    sendResponse(res, {
      statusCode: 200,
      success: false,
      message: result.message as string,
      data: {
        requiresAction:  true,
        clientSecret:    result.clientSecret,
        paymentIntentId: result.paymentIntentId,
      },
    });
    return;
  }

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Ride created successfully',
    data: result,
  });
});


const driverAcceptRide = catchAsync(async (req: Request, res: Response) => {


  const { driverProfileId } = req.user;
  const { rideId } = req.params;
  const { lat, lng } = req.body;

  const result = await RideService.driverAcceptRide(
    rideId,
    driverProfileId,
    lat !== undefined ? Number(lat) : undefined,
    lng !== undefined ? Number(lng) : undefined,
  );

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Ride accepted successfully',
    data: result,
  });

})

const updateRideStatus = catchAsync(async (req: Request, res: Response) => {

  const {rideId} = req.params;
  const {status} = req.body;
  const result = await RideService.updateRideStatus(rideId, status);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Ride status updated successfully',
    data: result,
  });

})


const getRideEstimates = catchAsync(async (req, res) => {
    const { country, distanceKm, pickupLat, pickupLng} = req.body;

  const data = await estimateRideOptions({distanceKm, country, pickupLat, pickupLng });

  console.log({data});  

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Ride estimates retrieved',
    data: data,
  });
});

const getMotorcycleEstimates = catchAsync(async (req, res) => {
    const { distanceKm, pickupLat, pickupLng} = req.body;
    const country = req.user?.country;

  const data = await estimateMotoOptions({distanceKm, country, pickupLat, pickupLng });

  console.log({data});  

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Motorcycle estimates retrieved',
    data: data,
  });
});

const getMyRides = catchAsync(async (req: Request, res: Response) => {
  const { userId, driverProfileId, role } = req.user;


  const isDriver = role === 'driver';
  const id       = isDriver ? driverProfileId : userId;

  console.log("params data =>>> ", userId, driverProfileId, role);

  const result = await RideService.getMyRides(id, isDriver ? 'driver' : 'passenger', req.query);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Rides retrieved successfully',
    meta: result.meta,
    data: result.result,
  });
});




const getRidesByStatus = catchAsync(async (req: Request, res: Response) => {
  const { status } = req.params;
  const role = req.user.role as 'passenger' | 'driver';
  const id   = role === 'driver' ? req.user.driverProfileId : req.user.userId;

  const result = await RideService.getRidesByStatus(
    id,
    role,
    status as 'completed' | 'cancelled' | 'upcoming',
    req.query,
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: `${role} ${status} rides retrieved`,
    meta: result.meta,
    data: result.result,
  });
});

const adminGetAllRides = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.adminGetAllRides(req.query);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'All rides retrieved',
    meta: result.meta,
    data: result.result,
  });
});

// GET nearest rides for driver
const getNearestRides = catchAsync(async (req: Request, res: Response) => {
  const { longitude, latitude, maxDistance } = req.query;

  if (!longitude || !latitude) {
    throw new Error('Driver location required');
  }

  const rides = await RideService.getNearestRides({
    driverLat:         Number(latitude),
    driverLng:         Number(longitude),
    maxDistanceMeters: maxDistance ? Number(maxDistance) : undefined,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Nearest rides fetched successfully',
    data: rides,
  });
});


const getRecentRides = catchAsync(async (req: Request, res: Response) => {
  const { userId, role } = req.user;

  if (!userId) {
    throw new Error('User ID is required');
  }

  const data = await RideService.getRecentRides(
    userId,
    (role as 'passenger' | 'driver') ?? 'passenger',
    req.query as Record<string, unknown>,
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Recent rides fetched successfully',
    data: data.result,
    meta: data.meta,
  });
});


const endRide = catchAsync(async (req: Request, res: Response) => {
  const { driverProfileId } = req.user;
  const { rideId } = req.params;
  const { address, coordinates } = req.body; // { address: string, coordinates: [lng, lat] }

  const dropoffLocation = {
    address,
    lng: coordinates[0] as number,
    lat: coordinates[1] as number,
  };

  const result = await RideService.endRide(rideId, driverProfileId, dropoffLocation);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Ride ended successfully',
    data: result,
  });
});

const confirmDropoff = catchAsync(async (req: Request, res: Response) => {
  const { driverProfileId } = req.user;
  const { rideId } = req.params;
  const { deliveryProofImage } = req.body;

  const result = await RideService.confirmDropoff(rideId, driverProfileId, deliveryProofImage);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Dropoff confirmed successfully',
    data: result,
  });
});

const payRide = catchAsync(async (req: Request, res: Response) => {
  const { userId } = req.user;
  const { rideId } = req.params;
  const { tip } = req.body; // optional tip amount

  const result = await RideService.payRide(rideId, userId, tip ?? 0);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Payment successful',
    data: result,
  });
});

const submitRideReview = catchAsync(async (req: Request, res: Response) => {
  const { rideId } = req.params;
  const { role }   = req.user;
  const { rating, comment } = req.body;

  console.log("submitRideReview  ==>>> ", {rideId, role, rating, comment});


  const result = await RideService.submitRideReview(
    rideId,
    role as 'passenger' | 'driver',
    { rating, comment },
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Review submitted successfully',
    data: result,
  });
});

const getMyActiveRide = catchAsync(async (req: Request, res: Response) => {
  const { userId, driverProfileId, role } = req.user;
  const id = role === 'driver' ? driverProfileId : userId;

  const result = await RideService.getMyActiveRide(id, role as 'passenger' | 'driver');

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: result ? 'Active ride found' : 'No active ride',
    data: result,
  });
});

const collectCashPayment = catchAsync(async (req: Request, res: Response) => {
  const { driverProfileId } = req.user;
  const { rideId } = req.params;
  const { tip } = req.body;

  const result = await RideService.collectCashPayment(rideId, driverProfileId, tip ?? 0);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Cash payment collected successfully',
    data: result,
  });
});

const getRideReview = catchAsync(async (req: Request, res: Response) => {

  
  const { rideId } = req.params;
  const { userId, driverProfileId, role } = req.user;
  const id = role === 'driver' ? driverProfileId : userId;

  console.log("params data =>>> ", userId, driverProfileId, role);

  const result = await RideService.getRideReview(rideId, id, role as 'passenger' | 'driver');

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Ride review retrieved successfully',
    data: result,
  });
});

export const RideController = {
  createRide,
  getMotorcycleEstimates,
  getRideEstimates,
  getMyRides,
  getRidesByStatus,
  submitRideReview,
  getRideReview,
  getMyActiveRide,
  driverAcceptRide,
  updateRideStatus,
  endRide,
  confirmDropoff,
  payRide,
  collectCashPayment,
  adminGetAllRides,
  getNearestRides,
  getRecentRides,
};