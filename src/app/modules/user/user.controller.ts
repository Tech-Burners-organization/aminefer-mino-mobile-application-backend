import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { userService } from './user.service';

import httpStatus from 'http-status';
import { storeFile, storeFiles } from '../../utils/fileHelper';
import { deleteFile } from '../../utils/deleteFile';
import AppError from '../../error/AppError';


const createUser = catchAsync(async (req: Request, res: Response) => {

  const createUserToken = await userService.createUserToken(req.body);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Check email for OTP',
    data:  createUserToken ,
  });
});

const userCreateVarification = catchAsync(async (req, res) => {
  const token = req.headers?.token as string;


  const { otp } = req.body;
  const newUser = await userService.otpVerifyAndCreateUser({ otp, token });

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User create successfully',
    data: newUser,
  });
});


const updateMyProfile = catchAsync(async (req: Request, res: Response) => {

  const {userId, role } = req.user;


  // 1️⃣ Handle uploaded files
  const payload: any = { ...req.body };
  payload.role = role;

  
  if (req.files && Object.keys(req.files).length > 0) {
    const files = req.files as { [fieldName: string]: Express.Multer.File[] };
    const uploadedFiles = storeFiles('ride', files);

    // Profile image (all roles)
    if (uploadedFiles.image) payload.profileImage = uploadedFiles.image[0];

    // Driver-specific uploads
    if (uploadedFiles.license) payload.licenseImage = uploadedFiles.license[0];
    if (uploadedFiles.licenseBack) payload.licenseBackImage = uploadedFiles.licenseBack[0];
    if (uploadedFiles.backgroundCheck) payload.backgroundCheckImage = uploadedFiles.backgroundCheck[0];
    if (uploadedFiles.registration) payload.registrationImage = uploadedFiles.registration[0];
    if (uploadedFiles.certificate) payload.roadworthinessCertificate = uploadedFiles.certificate[0];
    if (uploadedFiles.vehicleInspection) payload.vehicleInspectionImage = uploadedFiles.vehicleInspection[0];
    if (uploadedFiles.vehicle) payload.vehicleImages = uploadedFiles.vehicle;

    
  }

  // 2️⃣ Call service
  const { accessToken, ...rest } = await userService.updateMyProfile(userId, payload) as any;

  // 3️⃣ Send response
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Profile updated successfully',
    data: { ...rest, accessToken },
  });

});

// Standalone image upload — stores the file and returns its URL. Does not
// touch the database; the caller decides what to do with the returned path.
const uploadImage = catchAsync(async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(httpStatus.BAD_REQUEST, 'No image file provided');

  const image = storeFile('ride', req.file.filename);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Image uploaded successfully',
    data: { image },
  });
});

// Standalone image delete — removes the file from disk by its stored path.
// Does not touch the database.
const deleteImage = catchAsync(async (req: Request, res: Response) => {
  const { image } = req.body;
  if (!image) throw new AppError(httpStatus.BAD_REQUEST, 'image is required');

  deleteFile(image);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Image deleted successfully',
    data: null,
  });
});

const createSuperAdmin = catchAsync(
  async (req: Request, res: Response) => {
    const { name, email, phone,password } = req.body;

    const result = await userService.createSuperAdminByAdmin({
      name,
      email,
      phone,
      password
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Super Admin created successfully",
      data: result,
    });
  }
);



// rest >...............


const getAllUsers = catchAsync(async (req, res) => {
  const {userId} = req.user;
  const result = await userService.getAllUserQuery(userId, req.query);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    meta: result.meta,
    data: result.result,
    message: 'Users All are requered successful!!',
  });
});



const getAllPassengers = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.getAllPassengers(req.query);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    meta: result.meta,
    data: result.result,
    message: 'Passengers retrieved successfully',
  });
});

const getAllApprovedDrivers = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.getAllDrivers(req.query);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    meta: result.meta,
    data: result.result,
    message: 'Approved drivers retrieved successfully',
  });
});

const getAllRequestDrivers = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.getPendingDrivers(req.query);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    meta: result.meta,
    data: result.result,
    message: 'Pending driver requests retrieved successfully',
  });
});

const getMyProfile = catchAsync(async (req: Request, res: Response) => {

  const result = await userService.getMyProfile(req?.user?.userId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'profile fetched successfully',
    data: result,
  });
});

const getAdminProfile = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.getAdminProfile(req?.user?.userId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'profile fetched successfully',
    data: result,
  });
});

const getAllSuperAdmins = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.getAllSuperAdmins(req.query);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Super Admins fetched successfully',
    data: result,
  });
});

const updateSuperAdminByAdmin = catchAsync (async (req: Request, res: Response) => {
    
  const {superAdminId} = req.params;

  const result = await userService.updateSuperAdminByAdmin(superAdminId, req.body);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Super Admin updated successfully',
    data: result,
  })
})


const blockedUser = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.blockedUser(req.params.id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `User ${result.status ? 'blocked': 'unBlocked'} successfully`,
    data: result.user,
  });
});

const deleteMyAccount = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.deleteMyAccount(req.user?.userId, req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User deleted successfully',
    data: result,
  });
});

const deletedUserById = catchAsync(async (req: Request, res: Response) => {

  const result = await userService.deletedUserById(req.params.id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User deleted successfully',
    data: result,
  });
})

const approveDriver = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { vehicleTypes } = req.body;

  console.log({vehicleTypes})

  const result = await userService.verifyDriverUserById(id, vehicleTypes);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Driver approved successfully',
    data: result,
  });
});

const rejectDriver = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;

  const result = await userService.declineDriverUserById(id, reason);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Driver rejected successfully',
    data: result,
  });
});

// ── Driver document update review (admin) ────────────────────────────────────

const getDriverDocumentUpdateRequests = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.getDriverDocumentUpdateRequests(req.query);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Document update requests fetched successfully',
    data: result.result,
    meta: result.meta,
  });
});

const approveDriverDocumentUpdate = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { userId } = req.user;

  const result = await userService.approveDriverDocumentUpdate(id, userId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Document update approved and applied to profile',
    data: result,
  });
});

const rejectDriverDocumentUpdate = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { userId } = req.user;
  const { reason } = req.body;

  const result = await userService.rejectDriverDocumentUpdate(id, userId, reason);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Document update rejected',
    data: result,
  });
});

const warnUser = catchAsync(async (req: Request, res: Response) => {
  const adminId = req.user.userId;
  const { id }  = req.params;
  const { reason } = req.body;

  const result = await userService.warnUser(id, adminId, reason);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User warned successfully',
    data: result,
  });
});

const banUser = catchAsync(async (req: Request, res: Response) => {
  const adminId = req.user.userId;
  const { id }  = req.params;
  const { reason } = req.body;

  const result = await userService.banUser(id, adminId, reason);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User banned successfully',
    data: result,
  });
});

const unbanUser = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;

  const result = await userService.unbanUser(id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User unbanned successfully',
    data: result,
  });
});

// ─── Emergency Contacts ───────────────────────────────────────────────────────

const getEmergencyContacts = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.getEmergencyContacts(req.user.userId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Emergency contacts fetched successfully',
    data: result,
  });
});

const addEmergencyContact = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.addEmergencyContact(req.user.userId, req.body);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Emergency contact added successfully',
    data: result,
  });
});

const updateEmergencyContact = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.updateEmergencyContact(req.user.userId, req.params.contactId, req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Emergency contact updated successfully',
    data: result,
  });
});

const deleteEmergencyContact = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.deleteEmergencyContact(req.user.userId, req.params.contactId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Emergency contact deleted successfully',
    data: result,
  });
});

export const userController = {
  createUser,
  userCreateVarification,
  updateMyProfile,
  uploadImage,
  deleteImage,
  createSuperAdmin,
  getMyProfile,
  getAdminProfile,
  blockedUser,
  deleteMyAccount,
  getAllUsers,
  getAllPassengers,
  getAllApprovedDrivers,
  getAllRequestDrivers,
  approveDriver,
  rejectDriver,
  getDriverDocumentUpdateRequests,
  approveDriverDocumentUpdate,
  rejectDriverDocumentUpdate,
  warnUser,
  banUser,
  unbanUser,
  getAllSuperAdmins,
  updateSuperAdminByAdmin,
  deletedUserById,
  getEmergencyContacts,
  addEmergencyContact,
  updateEmergencyContact,
  deleteEmergencyContact,
};
