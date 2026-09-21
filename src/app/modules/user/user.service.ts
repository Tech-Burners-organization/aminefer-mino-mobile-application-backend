/* eslint-disable @typescript-eslint/no-explicit-any */
import bcrypt from 'bcrypt';
import httpStatus from 'http-status';
import fs from 'fs';
import path from 'path';
import { AdminVerifiedStatus, DocumentReviewStatus, Prisma, UserRole, UserStatus, VehicleType } from '@prisma/client';

import prisma from '../../config/prisma';
import AppError from '../../error/AppError';
import config from '../../config';
import { createToken, verifyToken } from '../../utils/tokenManage';
import { otpServices } from '../otp/otp.service';
import { generateOptAndExpireTime } from '../otp/otp.utils';
import { getAdminId } from '../../DB/adminStrore';
import { emitNotification } from '../../../socketIo';
import { USER_ROLE } from './user.constants';
import { otpSendEmail, sendNotificationEmail } from '../../utils/emailNotification';
import { buildAccessToken } from './user.utils';
import type {
  CreateSuperAdminProps,
  DeleteAccountPayload,
  JwtUserPayload,
  PaginateQuery,
  TEmergencyContact,
  TUserCreate,
  TUserUpdate,
} from './user.interface';

// ── Local types ───────────────────────────────────────────────────────────────

export interface OTPVerifyAndCreateUserProps {
  otp: string;
  token: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPagination(query: PaginateQuery) {
  const page  = Number(query.page)  || 1;
  const limit = Number(query.limit) || 10;
  return { skip: (page - 1) * limit, take: limit, page, limit };
}

function buildUserSearch(searchTerm?: string): Prisma.UserWhereInput {
  if (!searchTerm) return {};
  return {
    OR: [
      { name:  { contains: searchTerm, mode: 'insensitive' } },
      { email: { contains: searchTerm, mode: 'insensitive' } },
    ],
  };
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Step 1 of registration: validate, send OTP, return short-lived token.
 */
const createUserToken = async (payload: TUserCreate) => {
  const { name, email, password, role, countryCode, country, phoneNumber, gender, dateOfBirth, acceptTerms, driverType, homeAddress } = payload;

  const userExist = await getUserByEmail(email);
  if (userExist) {
    throw new AppError(httpStatus.BAD_REQUEST, 'User already exists!');
  }

  const { isExist, isExpireOtp } = await otpServices.checkOtpByEmail(email, 'email-verification');
  const { otp, expiredAt } = generateOptAndExpireTime();
  const otpPurpose = 'email-verification';

  if (isExist && !isExpireOtp) {
    throw new AppError(httpStatus.BAD_REQUEST, 'OTP already sent. Check your email.');
  } else if (isExist && isExpireOtp) {
    await otpServices.updateOtpByEmail(email, otpPurpose, { otp, expiredAt });
  } else {
    await otpServices.createOtp({
      name: name || 'Customer',
      sentTo: email,
      receiverType: 'email',
      purpose: otpPurpose,
      otp,
      expiredAt,
    });
  }


  process.nextTick(async () => {
    await otpSendEmail({ sentTo: email, subject: 'Your OTP for email verification', name: name || 'Customer', otp, expiredAt });
  });

  const otpBody: Partial<TUserCreate> = { name, email, password, role, driverType, countryCode, phoneNumber, country, gender, dateOfBirth, homeAddress, acceptTerms };

  return createToken({
    payload: otpBody,
    access_secret: config.jwt_access_secret as string,
    expity_time: config.otp_token_expire_time as string | number,
  });
};

/**
 * Step 2 of registration: verify OTP, create user in PostgreSQL.
 */
const otpVerifyAndCreateUser = async ({ otp, token }: OTPVerifyAndCreateUserProps) => {

  console.log({otp, token});
  
  if (!token) throw new AppError(httpStatus.BAD_REQUEST, 'Token not found');

  const decodeData = verifyToken({ token, access_secret: config.jwt_access_secret as string });
  
  if (!decodeData) throw new AppError(httpStatus.BAD_REQUEST, 'You are not authorised');

  const { name, email, password, role, countryCode, phoneNumber, country, gender, dateOfBirth, acceptTerms, driverType, homeAddress } = decodeData as TUserCreate;


  const isOtpMatch = await otpServices.otpMatch(email, 'email-verification', otp);
  if (!isOtpMatch) throw new AppError(httpStatus.BAD_REQUEST, 'OTP did not match');

  await otpServices.updateOtpByEmail(email, 'email-verification', { status: 'verified' });

  const isExist = await getUserByEmail(email as string);
  if (isExist) throw new AppError(httpStatus.FORBIDDEN, 'User already exists with this email');

  const hashedPassword = await bcrypt.hash(password as string, Number(config.bcrypt_salt_rounds));

  const user = await prisma.user.create({
    data: {
      name,
      email: email as string,
      password: hashedPassword,
      role: role as UserRole,
      countryCode,
      phoneNumber,
      country,
      gender,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
      homeAddress: typeof homeAddress === 'string' ? homeAddress : undefined,
      acceptTerms: acceptTerms ?? true,
      driverType,
      adminVerified: role !== USER_ROLE.DRIVER ? AdminVerifiedStatus.verified : AdminVerifiedStatus.pending,
    },
  });

  const jwtPayload: JwtUserPayload = {
    userId:                  user.id,
    name:                    user.name ?? '',
    email:                   user.email,
    role:                    user.role,
    adminVerified:           user.adminVerified,
    profileImage:            user.profileImage,
    homeAddress:             user.homeAddress ?? '',
    isDriverProfileCompleted: user.isDriverProfileCompleted,
  };

  return createToken({ payload: jwtPayload, access_secret: config.jwt_access_secret as string, expity_time: '5m' });
};

// ── Profile ───────────────────────────────────────────────────────────────────

const getMyProfile = async (id: string) => {
  return prisma.user.findUnique({
    where: { id },
    include: { driverProfile: true, emergencyContacts: true },
  });
};

const getAdminProfile = async (id: string) => {
  const result = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, profileImage: true },
  });
  if (!result) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  return result;
};

const getUserById = async (id: string) => {
  const result = await prisma.user.findUnique({ where: { id, isDeleted: false } });
  if (!result) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  return result;
};

const getUserByEmail = async (email: string) => {
  return prisma.user.findUnique({ where: { email } });
};

const getUserByEmailWithPassword = async (email: string) => {
  return prisma.user.findUnique({ where: { email, isDeleted: false } });
};

// Fields that live on DriverProfile, not User.
// NOTE: vehicleTypes is intentionally excluded — it's admin-assigned only,
// during driver verification (see verifyDriverUserById), never driver-editable.
const DRIVER_PROFILE_FIELDS = new Set([
  'licenseNumber', 'licenseExpiryDate', 'licenseImage', 'licenseBackImage', 'socialSecurityNumber',
  'backgroundCheckImage',
  'vehicleBrand', 'vehicleModel', 'vehicleColor', 'vehicleImages', 'vehicleInspectionImage',
  'registrationImage', 'roadworthinessCertificate',
]);

const normalizeUserPayload = (payload: TUserUpdate) => {
  const { role, ...rest } = payload as any;
  void role;

  // Flatten homeAddress: { address, location: { coordinates: [lng, lat] } }
  if (rest.homeAddress && typeof rest.homeAddress === 'object') {
    const ha = rest.homeAddress as any;
    rest.homeAddress    = ha.address ?? ha.homeAddress ?? undefined;
    rest.homeAddressLng = ha.location?.coordinates?.[0] ?? ha.lng ?? undefined;
    rest.homeAddressLat = ha.location?.coordinates?.[1] ?? ha.lat ?? undefined;
  }

  // Flatten workAddress: same shape
  if (rest.workAddress && typeof rest.workAddress === 'object') {
    const wa = rest.workAddress as any;
    rest.workAddress    = wa.address ?? wa.workAddress ?? undefined;
    rest.workAddressLng = wa.location?.coordinates?.[0] ?? wa.lng ?? undefined;
    rest.workAddressLat = wa.location?.coordinates?.[1] ?? wa.lat ?? undefined;
  }

  // Convert dateOfBirth string to Date; drop it entirely if empty
  if (typeof rest.dateOfBirth === 'string') {
    if (rest.dateOfBirth) rest.dateOfBirth = new Date(rest.dateOfBirth);
    else delete rest.dateOfBirth;
  }

  // Convert licenseExpiryDate string to Date; drop it entirely if empty
  if (typeof rest.licenseExpiryDate === 'string') {
    if (rest.licenseExpiryDate) rest.licenseExpiryDate = new Date(rest.licenseExpiryDate);
    else delete rest.licenseExpiryDate;
  }

  // Split into user fields and driver profile fields
  const userFields: Record<string, unknown> = {};
  const driverFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rest)) {
    if (DRIVER_PROFILE_FIELDS.has(key)) {
      driverFields[key] = value;
    } else {
      userFields[key] = value;
    }
  }

  return { userFields, driverFields };
};

const updateMyProfile = async (userId: string, payload: TUserUpdate) => {

  const user = await prisma.user.findUnique({ where: { id: userId, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  if (payload.profileImage && user.profileImage) {
    const oldPath = path.join(process.cwd(), 'public', user.profileImage);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const { userFields, driverFields } = normalizeUserPayload(payload);


  // If driver, update user + upsert driver profile in one transaction
  if (user.role === USER_ROLE.DRIVER) {
    const existingDriverProfile = await prisma.driverProfile.findUnique({ where: { userId } });
    const hasDriverFieldChanges = Object.keys(driverFields).length > 0;

    // Already-verified driver touching document/vehicle fields — stage for
    // admin review instead of overwriting the live, approved profile.
    if (existingDriverProfile?.approvalStatus === 'verified' && hasDriverFieldChanges) {
      const pendingRequest = await prisma.driverDocumentUpdateRequest.findFirst({
        where: { driverProfileId: existingDriverProfile.id, status: DocumentReviewStatus.pending },
      });
      if (pendingRequest) {
        throw new AppError(
          httpStatus.CONFLICT,
          'You already have a document update pending admin review. Please wait for it to be reviewed before submitting another.',
        );
      }

      const [updatedUser] = await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: userFields as any }),
        prisma.driverProfile.update({
          where: { id: existingDriverProfile.id },
          data:  { hasPendingDocumentUpdate: true },
        }),
        prisma.driverDocumentUpdateRequest.create({
          data: {
            driverProfileId: existingDriverProfile.id,
            changes:         driverFields as Prisma.InputJsonValue,
          },
        }),
      ]);

      process.nextTick(() => {
        emitNotification({
          userId:     userId,
          receiverId: getAdminId() as string,
          message:    { fullName: user.name ?? 'Driver', image: user.profileImage, text: `${user.name ?? 'A driver'} submitted document updates for review.`, photos: [] },
          type:       'adminApprovalUpdate',
        }).catch(console.error);
      });

      return {
        user: updatedUser,
        driver: existingDriverProfile,
        documentUpdatePending: true,
        accessToken: buildAccessToken(updatedUser),
      }; 
    }

    // First-time submission, or not yet verified — apply directly (existing behavior).
    const [, driverProfile] = await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: userFields as any }),
      prisma.driverProfile.upsert({
        where:  { userId },
        create: {
          userId,
          driverType:  user.driverType ?? 'car',
          licenseNumber: '', licenseExpiryDate: new Date(), licenseImage: '',
          vehicleBrand: '', vehicleModel: '', vehicleColor: '',
          registrationImage: '',
          ...driverFields,
        },
        update: driverFields,
      }),
    ]);

    // Mark profile complete when all required driver fields are filled
    const isComplete = !!(
      driverProfile.licenseNumber &&
      driverProfile.licenseImage &&
      driverProfile.vehicleBrand &&
      driverProfile.vehicleModel &&
      driverProfile.vehicleColor &&
      driverProfile.registrationImage
    );

    // console.log("driverprofile data >>>>>>>>>>>>>>>>>>>>>>>>>> ", driverProfile)
    // console.log("is completed =>>>> ", isComplete)

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data:  { ...userFields as any, isDriverProfileCompleted: isComplete },
    });

    // console.log("updated user =>>>>> ", updatedUser)

    return { user: updatedUser, driver: driverProfile, accessToken: buildAccessToken(updatedUser) };
  }

  const updatedUser = await prisma.user.update({ where: { id: userId }, data: userFields as any });


  return { user: updatedUser, accessToken: buildAccessToken(updatedUser) };
};

const updateUser = async (userId: string, payload: TUserUpdate) => {
  const forbidden = ['email', 'password', 'role', 'adminVerified'];
  for (const field of forbidden) {
    if ((payload as any)[field] !== undefined) {
      throw new AppError(httpStatus.FORBIDDEN, `${field} cannot be updated here`);
    }
  }

  const existing = await prisma.user.findUnique({ where: { id: userId, isDeleted: false } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  if (payload.profileImage && existing.profileImage) {
    const oldPath = path.join(process.cwd(), 'public', existing.profileImage);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  return prisma.user.update({ where: { id: userId }, data: payload });
};

// ── Admin actions ─────────────────────────────────────────────────────────────

const verifyDriverUserById = async (userId: string, vehicleTypes: VehicleType[]) => {

  console.log("verify driver " , {userId, vehicleTypes} )

  if (!vehicleTypes || vehicleTypes.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Select at least one vehicle type to verify this driver');
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { adminVerified: AdminVerifiedStatus.verified },
  });
  if (!user) throw new AppError(httpStatus.BAD_REQUEST, 'User verification update failed');

  await prisma.driverProfile.updateMany({
    where: { userId },
    data: { approvalStatus: 'verified', vehicleTypes },
  });

  process.nextTick(() => {
    emitNotification({
      userId:     getAdminId() as string,
      receiverId: user.id,
      message:    { fullName: 'Admin', image: '', text: 'Congratulations! Your profile has been verified successfully.', photos: [] },
      type:       'driverVerified',
    }).catch(console.error);

    if (user.email) {
      sendNotificationEmail({
        sentTo:      user.email,
        subject:     'Your driver profile has been verified',
        userName:    user.name || 'Driver',
        messageText: 'Congratulations! Your profile has been verified successfully. You can now start accepting rides.',
      }).catch(console.error);
    }
  });

  return user;
};

const declineDriverUserById = async (userId: string, reason?: string) => {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isDeleted: true, adminVerified: AdminVerifiedStatus.rejected },
  });
  if (!user) throw new AppError(httpStatus.BAD_REQUEST, 'Failed to decline user');

  await prisma.driverProfile.updateMany({
    where: { userId },
    data: { approvalStatus: 'rejected', rejectionReason: reason ?? null },
  });

  process.nextTick(() => {
    emitNotification({
      userId:     getAdminId() as string,
      receiverId: user.id,
      message:    { fullName: 'Admin', image: '', text: reason ? `Your profile has been declined. Reason: ${reason}` : 'Your profile has been declined.', photos: [] },
      type:       'adminApprovalUpdate',
    }).catch(console.error);

    if (user.email) {
      sendNotificationEmail({
        sentTo:      user.email,
        subject:     'Your driver profile has been declined',
        userName:    user.name || 'Driver',
        messageText: reason ? `Your profile has been declined. Reason: ${reason}` : 'Your profile has been declined.',
      }).catch(console.error);
    }
  });

  return user;
};

// ── Driver document update review (admin) ────────────────────────────────────
// A verified driver's document/vehicle-field edits land in
// DriverDocumentUpdateRequest instead of DriverProfile directly (see
// updateMyProfile). These three functions drive the admin review queue.

const getDriverDocumentUpdateRequests = async (query: PaginateQuery) => {
  const { skip, take, page, limit } = buildPagination(query);
  const status = (query.status as DocumentReviewStatus | undefined) ?? DocumentReviewStatus.pending;

  const where: Prisma.DriverDocumentUpdateRequestWhereInput = { status };

  const [result, total] = await prisma.$transaction([
    prisma.driverDocumentUpdateRequest.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        driverProfile: {
          include: {
            user: { select: { id: true, name: true, email: true, phoneNumber: true, profileImage: true } },
          },
        },
      },
    }),
    prisma.driverDocumentUpdateRequest.count({ where }),
  ]);

  return { meta: { page, limit, total, totalPage: Math.ceil(total / limit) }, result };
};

const approveDriverDocumentUpdate = async (requestId: string, adminId: string) => {
  const request = await prisma.driverDocumentUpdateRequest.findUnique({
    where:   { id: requestId },
    include: { driverProfile: { include: { user: true } } },
  });
  if (!request) throw new AppError(httpStatus.NOT_FOUND, 'Document update request not found');
  if (request.status !== DocumentReviewStatus.pending) {
    throw new AppError(httpStatus.BAD_REQUEST, `This request has already been ${request.status}`);
  }

  const changes = request.changes as Prisma.DriverProfileUpdateInput;

  const [, driverProfile] = await prisma.$transaction([
    prisma.driverDocumentUpdateRequest.update({
      where: { id: requestId },
      data:  { status: DocumentReviewStatus.verified, reviewedById: adminId, reviewedAt: new Date() },
    }),
    prisma.driverProfile.update({
      where: { id: request.driverProfileId },
      data:  { ...changes, hasPendingDocumentUpdate: false },
    }),
  ]);

  const driverUser = request.driverProfile.user;

  process.nextTick(() => {
    emitNotification({
      userId:     adminId,
      receiverId: driverUser.id,
      message:    { fullName: 'Admin', image: '', text: 'Your updated documents have been verified and applied to your profile.', photos: [] },
      type:       'driverVerified',
    }).catch(console.error);

    if (driverUser.email) {
      sendNotificationEmail({
        sentTo:      driverUser.email,
        subject:     'Your document update has been approved',
        userName:    driverUser.name || 'Driver',
        messageText: 'Your updated documents have been reviewed and verified. The changes are now live on your profile.',
      }).catch(console.error);
    }
  });

  return driverProfile;
};

const rejectDriverDocumentUpdate = async (requestId: string, adminId: string, reason?: string) => {
  const request = await prisma.driverDocumentUpdateRequest.findUnique({
    where:   { id: requestId },
    include: { driverProfile: { include: { user: true } } },
  });
  if (!request) throw new AppError(httpStatus.NOT_FOUND, 'Document update request not found');
  if (request.status !== DocumentReviewStatus.pending) {
    throw new AppError(httpStatus.BAD_REQUEST, `This request has already been ${request.status}`);
  }

  const [updatedRequest] = await prisma.$transaction([
    prisma.driverDocumentUpdateRequest.update({
      where: { id: requestId },
      data:  { status: DocumentReviewStatus.rejected, rejectionReason: reason ?? null, reviewedById: adminId, reviewedAt: new Date() },
    }),
    prisma.driverProfile.update({
      where: { id: request.driverProfileId },
      data:  { hasPendingDocumentUpdate: false },
    }),
  ]);

  const driverUser = request.driverProfile.user;
  const text = reason
    ? `Your document update was declined. Reason: ${reason}. Please re-upload the required documents.`
    : 'Your document update was declined. Please re-upload the required documents.';

  process.nextTick(() => {
    emitNotification({
      userId:     adminId,
      receiverId: driverUser.id,
      message:    { fullName: 'Admin', image: '', text, photos: [] },
      type:       'adminApprovalUpdate',
    }).catch(console.error);

    if (driverUser.email) {
      sendNotificationEmail({
        sentTo:      driverUser.email,
        subject:     'Your document update was declined',
        userName:    driverUser.name || 'Driver',
        messageText: text,
      }).catch(console.error);
    }
  });

  return updatedRequest;
};

const warnUser = async (targetUserId: string, adminId: string, reason: string) => {
  const user = await prisma.user.findUnique({ where: { id: targetUserId, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  if (user.status === UserStatus.banned) throw new AppError(httpStatus.BAD_REQUEST, 'Cannot warn a banned user');

  return prisma.$transaction([
    prisma.userWarningLog.create({ data: { userId: targetUserId, reason, warnedById: adminId } }),
    prisma.user.update({ where: { id: targetUserId }, data: { warningsCount: { increment: 1 } } }),
  ]);
};

const banUser = async (targetUserId: string, adminId: string, reason: string) => {
  const user = await prisma.user.findUnique({ where: { id: targetUserId, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  if (user.status === UserStatus.banned) throw new AppError(httpStatus.BAD_REQUEST, 'User is already banned');

  return prisma.user.update({
    where: { id: targetUserId },
    data: { status: UserStatus.banned, banReason: reason, bannedAt: new Date(), bannedById: adminId },
    select: { id: true, name: true, email: true, status: true, banReason: true, bannedAt: true },
  });
};

const unbanUser = async (targetUserId: string) => {
  const user = await prisma.user.findUnique({ where: { id: targetUserId, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  if (user.status !== UserStatus.banned) throw new AppError(httpStatus.BAD_REQUEST, 'User is not banned');

  return prisma.user.update({
    where: { id: targetUserId },
    data: { status: UserStatus.active, banReason: null, bannedAt: null, bannedById: null },
    select: { id: true, name: true, email: true, status: true },
  });
};

const blockedUser = async (id: string) => {
  const user = await prisma.user.findUnique({ where: { id, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  const newStatus = user.status === UserStatus.blocked ? UserStatus.active : UserStatus.blocked;
  const updated = await prisma.user.update({ where: { id }, data: { status: newStatus } });
  return { status: newStatus, user: updated };
};

const deletedUserById = async (id: string) => {
  const user = await prisma.user.findUnique({ where: { id, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  return prisma.user.update({ where: { id }, data: { isDeleted: true } });
};

const deleteMyAccount = async (id: string, { password }: DeleteAccountPayload) => {
  const user = await prisma.user.findUnique({ where: { id, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  const match = await bcrypt.compare(password, user.password);
  if (!match) throw new AppError(httpStatus.BAD_REQUEST, 'Password does not match');

  return prisma.user.update({ where: { id }, data: { isDeleted: true } });
};

// ── Listing queries ───────────────────────────────────────────────────────────

const getAllUserQuery = async (userId: string, query: PaginateQuery) => {
  const { skip, take, page, limit } = buildPagination(query);
  const search = buildUserSearch(query.searchTerm);

  const where: Prisma.UserWhereInput = { id: { not: userId }, isDeleted: false, ...search };
  const [result, total] = await prisma.$transaction([
    prisma.user.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where }),
  ]);

  return { meta: { page, limit, total }, result };
};

const getAllDrivers = async (query: PaginateQuery) => {
  const { skip, take, page, limit } = buildPagination(query);
  const search = buildUserSearch(query.searchTerm);
  const status = query.status as UserStatus | undefined;

  const where: Prisma.UserWhereInput = {
    role: UserRole.passenger,
    isDeleted: false,
    adminVerified: AdminVerifiedStatus.verified,
    ...(status && { status }),
    ...search,
  };


  const [drivers, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      skip,
      take,
      include: {
        driverProfile: true,
        warningLogs: {
          orderBy: { warnedAt: 'desc' },
          include: { warnedBy: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  const result = drivers.map(({ warningLogs, warningsCount, ...driver }) => ({
    ...driver,
    warnings: {
      count: warningsCount,
      logs: warningLogs.map((log) => ({
        id: log.id,
        warnedAt: log.warnedAt.toISOString(),
        warnedBy: log.warnedBy?.name ?? 'System',
        reason: log.reason,
      })),
    },
  }));

  return { meta: { page, limit, total }, result };
};

const getPendingDrivers = async (query: PaginateQuery) => {
  const { skip, take, page, limit } = buildPagination(query);
  const search = buildUserSearch(query.searchTerm);

  const where: Prisma.UserWhereInput = { role: UserRole.driver, adminVerified: AdminVerifiedStatus.pending, isDeleted: false, status: UserStatus.active, ...search };
  const [result, total] = await prisma.$transaction([
    prisma.user.findMany({ where, skip, take, include: { driverProfile: true }, orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where }),
  ]);

  return { meta: { page, limit, total }, result };
};

const getAllPassengers = async (query: PaginateQuery) => {
  const { skip, take, page, limit } = buildPagination(query);
  const search = buildUserSearch(query.searchTerm);
  const status = query.status as UserStatus | undefined;

  const where: Prisma.UserWhereInput = {
    role: UserRole.passenger,
    isDeleted: false,
    ...(status && { status }),
    ...search,
  };
  const [passengers, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      skip,
      take,
      include: {
        warningLogs: {
          orderBy: { warnedAt: 'desc' },
          include: { warnedBy: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  const result = passengers.map(({ warningLogs, warningsCount, ...passenger }) => ({
    ...passenger,
    warnings: {
      count: warningsCount,
      logs: warningLogs.map((log) => ({
        id: log.id,
        warnedAt: log.warnedAt.toISOString(),
        warnedBy: log.warnedBy?.name ?? 'System',
        reason: log.reason,
      })),
    },
  }));

  return { meta: { page, limit, total }, result };
};

const getAllSuperAdmins = async (payload?: any) => {
  return prisma.user.findMany({
    where: { role: UserRole.superadmin, isDeleted: false },
    select: { id: true, name: true, email: true, phoneNumber: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
};

const getAllUserCount = async () => prisma.user.count();

// ── Super-admin management ────────────────────────────────────────────────────

const createSuperAdminByAdmin = async ({ name, email, phone, password }: CreateSuperAdminProps) => {
  if (!name || !email || !phone || !password) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Name, email & phone are required');
  }

  const isExist = await getUserByEmail(email);
  if (isExist) throw new AppError(httpStatus.BAD_REQUEST, 'User already exists with this email');

  const hashedPassword = await bcrypt.hash(password, Number(config.bcrypt_salt_rounds));

  return prisma.user.create({
    data: {
      name,
      email,
      phoneNumber: phone,
      password: hashedPassword,
      role: UserRole.superadmin,
      adminVerified: AdminVerifiedStatus.verified,
    },
  });
};

const updateSuperAdminByAdmin = async (superAdminId: string, updateData: Partial<{ name: string; phoneNumber: string }>) => {
  const superAdmin = await prisma.user.findUnique({ where: { id: superAdminId, role: UserRole.superadmin } });
  if (!superAdmin) throw new AppError(httpStatus.NOT_FOUND, 'Super Admin not found');
  return prisma.user.update({ where: { id: superAdminId }, data: updateData });
};

// ── Emergency contacts ────────────────────────────────────────────────────────

const getEmergencyContacts = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  return prisma.emergencyContact.findMany({ where: { userId } });
};

const addEmergencyContact = async (userId: string, contact: TEmergencyContact) => {
  const user = await prisma.user.findUnique({ where: { id: userId, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  return prisma.emergencyContact.create({ data: { userId, ...contact } });
};

const updateEmergencyContact = async (userId: string, contactId: string, payload: Partial<TEmergencyContact>) => {
  const contact = await prisma.emergencyContact.findFirst({ where: { id: contactId, userId } });
  if (!contact) throw new AppError(httpStatus.NOT_FOUND, 'Contact not found');
  return prisma.emergencyContact.update({ where: { id: contactId }, data: payload });
};

const deleteEmergencyContact = async (userId: string, contactId: string) => {
  const contact = await prisma.emergencyContact.findFirst({ where: { id: contactId, userId } });
  if (!contact) throw new AppError(httpStatus.NOT_FOUND, 'Contact not found');
  return prisma.emergencyContact.delete({ where: { id: contactId } });
};

// ── Export ────────────────────────────────────────────────────────────────────

export const userService = {
  createUserToken,
  otpVerifyAndCreateUser,
  createSuperAdminByAdmin,
  updateMyProfile,
  getAllDrivers,
  getPendingDrivers,
  verifyDriverUserById,
  getMyProfile,
  getAdminProfile,
  getUserById,
  getUserByEmail,
  getUserByEmailWithPassword,
  updateUser,
  declineDriverUserById,
  getDriverDocumentUpdateRequests,
  approveDriverDocumentUpdate,
  rejectDriverDocumentUpdate,
  deleteMyAccount,
  blockedUser,
  getAllUserQuery,
  getAllUserCount,
  updateSuperAdminByAdmin,
  getAllSuperAdmins,
  getAllPassengers,
  warnUser,
  banUser,
  unbanUser,
  deletedUserById,
  getEmergencyContacts,
  addEmergencyContact,
  updateEmergencyContact,
  deleteEmergencyContact,
};
