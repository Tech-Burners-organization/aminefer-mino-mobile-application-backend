import bcrypt from 'bcrypt';
import httpStatus from 'http-status';
import { Request } from 'express';
import UAParser from 'ua-parser-js';
import { AdminVerifiedStatus, LoginWith, User, UserRole, UserStatus } from '@prisma/client';

import prisma from '../../config/prisma';
import AppError from '../../error/AppError';
import config from '../../config';
import { createToken, verifyToken } from '../../utils/tokenManage';
import { otpServices } from '../otp/otp.service';
import { generateOptAndExpireTime } from '../otp/otp.utils';
import { otpSendEmail } from '../../utils/emailNotification';
import { USER_ROLE } from '../user/user.constants';
import type { TLogin } from './auth.interface';
import type { OTPVerifyAndCreateUserProps } from '../user/user.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const buildDeviceInfo = (req: Request) => {
  const ip =
    req.headers['x-forwarded-for']?.toString().split(',')[0] ||
    req.socket.remoteAddress ||
    '';
  const userAgent = req.headers['user-agent'] || '';
  // @ts-ignore
  const parser = new UAParser(userAgent);
  const result = parser.getResult();
  return {
    ip,
    browser: result.browser.name || '',
    os:      result.os.name      || '',
    device:  result.device.model || 'Desktop',
    lastLogin: new Date().toISOString(),
  };
};

const buildJwtPayload = (user: User, driverProfileId?: string) => ({
  userId:                   user.id,
  name:                     user.name                    ?? '',
  profileImage:             user.profileImage,
  email:                    user.email,
  role:                     user.role,
  country:                  user.country                 ?? '',
  countryCode:              user.countryCode ?? '',
  phone:                    user.phoneNumber ?? '',
  adminVerified:            user.adminVerified,
  isDriverProfileCompleted: user.isDriverProfileCompleted,
  driverProfileId:          driverProfileId              ?? '',
});

const generateAndReturnTokens = async (user: User) => {
  const driverProfile = user.role === UserRole.driver
    ? await prisma.driverProfile.findUnique({ where: { userId: user.id }, select: { id: true } })
    : null;

  const jwtPayload = buildJwtPayload(user, driverProfile?.id);

  const accessToken = createToken({
    payload:       jwtPayload,
    access_secret: config.jwt_access_secret as string,
    expity_time:   config.jwt_access_expires_in as string,
  });

  const refreshToken = createToken({
    payload:       jwtPayload,
    access_secret: config.jwt_refresh_secret as string,
    expity_time:   config.jwt_refresh_expires_in as string,
  });

  return { user, accessToken, refreshToken };
};

// ── Login ─────────────────────────────────────────────────────────────────────

const login = async (payload: TLogin, req: Request) => {

  
  const user = await prisma.user.findUnique({
    where: { email: payload.email },
  });

  if (!user || user.isDeleted || user.status !== UserStatus.active) {
    throw new AppError(httpStatus.BAD_REQUEST, 'User not found');
  }

  if (payload.role === USER_ROLE.DRIVER || payload.role === USER_ROLE.PASSENGER) {
    const requestedRole = payload.role === USER_ROLE.DRIVER ? UserRole.driver : UserRole.passenger;
    if (requestedRole !== user.role) {
      throw new AppError(httpStatus.FORBIDDEN, `This account is registered as a ${user.role}. Please log in from the ${user.role} app.`);
    }
  }

  const passwordMatch = await bcrypt.compare(payload.password, user.password);
  if (!passwordMatch) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Password does not match');
  }

  const device = buildDeviceInfo(req);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      deviceIp:        device.ip,
      deviceBrowser:   device.browser,
      deviceOs:        device.os,
      deviceName:      device.device,
      deviceLastLogin: device.lastLogin,
      ...(payload.fcmToken ? { fcmToken: payload.fcmToken } : {}),
    },
  });

  return generateAndReturnTokens(user);
};

// ── Google Login ──────────────────────────────────────────────────────────────

const googleLogin = async (
  payload: { email: string; name?: string; profileImage?: string; role?: string; fcmToken?: string },
  req: Request,
) => {

  console.log("google login payload =>>> ", payload)

  let user = await prisma.user.findUnique({ where: { email: payload.email } });

  if (user) {
    if (user.loginWith !== LoginWith.google) {
      throw new AppError(httpStatus.FORBIDDEN, `This account is registered with ${user.loginWith}. Please use that login method.`);
    }

    if (payload.role === USER_ROLE.DRIVER || payload.role === USER_ROLE.PASSENGER) {
      const requestedRole = payload.role === USER_ROLE.DRIVER ? UserRole.driver : UserRole.passenger;
      if (requestedRole !== user.role) {
        throw new AppError(httpStatus.FORBIDDEN, `This account is registered as a ${user.role}. Please log in from the ${user.role} app.`);
      }
    }

    if (user.isDeleted)     throw new AppError(httpStatus.FORBIDDEN, 'This account has been deleted');
    
    if (user.status === UserStatus.blocked || user.status === UserStatus.banned) {
      throw new AppError(httpStatus.FORBIDDEN, 'Your account has been suspended. Please contact support.');
    }

    const device = buildDeviceInfo(req);
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        deviceIp: device.ip, deviceBrowser: device.browser, deviceOs: device.os,
        deviceName: device.device, deviceLastLogin: device.lastLogin,
        ...(payload.fcmToken ? { fcmToken: payload.fcmToken } : {}),
      },
    });

    console.log({user})
    return generateAndReturnTokens(user);
  }

  const role = payload.role === USER_ROLE.DRIVER ? UserRole.driver : UserRole.passenger;
  const device = buildDeviceInfo(req);

  user = await prisma.user.create({
    data: {
      name:          payload.name         || '',
      email:         payload.email,
      password:      await bcrypt.hash(`google_${Date.now()}`, Number(config.bcrypt_salt_rounds)),
      profileImage:  payload.profileImage || '',
      role,
      loginWith:     LoginWith.google,
      adminVerified: role === UserRole.driver ? AdminVerifiedStatus.pending : AdminVerifiedStatus.verified,
      fcmToken:      payload.fcmToken     || '',
      deviceIp: device.ip, deviceBrowser: device.browser, deviceOs: device.os,
      deviceName: device.device, deviceLastLogin: device.lastLogin,
    },
  });

  const result = generateAndReturnTokens(user);

  console.log("google login result =>>> ", result);

  return result;
};

// ── Apple Login ───────────────────────────────────────────────────────────────

const appleLogin = async (
  payload: { appleId: string; email?: string; name?: string; role?: string; fcmToken?: string },
  req: Request,
) => {

  console.log("Payload of Apple login =>>>> ", payload);
  
  let user = await prisma.user.findFirst({ where: { appleId: payload.appleId } });

  if (!user && payload.email) {
    user = await prisma.user.findUnique({ where: { email: payload.email } });
  }

  if (user) {
    if (user.loginWith !== LoginWith.apple) {
      throw new AppError(httpStatus.FORBIDDEN, `This account is registered with ${user.loginWith}. Please use that login method.`);
    }

    if (payload.role === USER_ROLE.DRIVER || payload.role === USER_ROLE.PASSENGER) {
      const requestedRole = payload.role === USER_ROLE.DRIVER ? UserRole.driver : UserRole.passenger;
      if (requestedRole !== user.role) {
        throw new AppError(httpStatus.FORBIDDEN, `This account is registered as a ${user.role}. Please log in from the ${user.role} app.`);
      }
    }

    if (user.isDeleted)                                          throw new AppError(httpStatus.FORBIDDEN, 'This account has been deleted');
    if (user.status === UserStatus.blocked || user.status === UserStatus.banned) {
      throw new AppError(httpStatus.FORBIDDEN, 'Your account has been suspended. Please contact support.');
    }

    const device = buildDeviceInfo(req);
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(!user.appleId ? { appleId: payload.appleId } : {}),
        deviceIp: device.ip, deviceBrowser: device.browser, deviceOs: device.os,
        deviceName: device.device, deviceLastLogin: device.lastLogin,
        ...(payload.fcmToken ? { fcmToken: payload.fcmToken } : {}),
      },
    });

    return generateAndReturnTokens(user);
  }

  if (!payload.email) {
    payload.email = `apple_${payload.appleId}@privaterelay.appleid.com`;
  }

  const role   = payload.role === USER_ROLE.DRIVER ? UserRole.driver : UserRole.passenger;

  console.log("apple login role ===>>> ", role);

  const device = buildDeviceInfo(req);

  user = await prisma.user.create({
    data: {
      appleId:       payload.appleId,
      name:          payload.name  || '',
      email:         payload.email,
      password:      await bcrypt.hash(`apple_${Date.now()}`, Number(config.bcrypt_salt_rounds)),
      profileImage:  '',
      role,
      loginWith:     LoginWith.apple,
      adminVerified: role === UserRole.driver ? AdminVerifiedStatus.pending : AdminVerifiedStatus.verified,
      fcmToken:      payload.fcmToken || '',
      deviceIp: device.ip, deviceBrowser: device.browser, deviceOs: device.os,
      deviceName: device.device, deviceLastLogin: device.lastLogin,
    },
  });

  console.log("user =>>> ", user)

  return generateAndReturnTokens(user);
};

// ── Forgot password ───────────────────────────────────────────────────────────

const forgotPasswordByEmail = async (email: string) => {
  const user = await prisma.user.findUnique({
    where: { email, isDeleted: false, status: UserStatus.active },
  });
  if (!user) throw new AppError(httpStatus.BAD_REQUEST, 'User not found');

  const { isExist, isExpireOtp } = await otpServices.checkOtpByEmail(email, 'forget-password');
  const { otp, expiredAt }       = generateOptAndExpireTime();

  if (isExist && !isExpireOtp) {
    throw new AppError(httpStatus.BAD_REQUEST, 'OTP already sent. Check your email.');
  } else if (isExist && isExpireOtp) {
    await otpServices.updateOtpByEmail(email, 'forget-password', { otp, expiredAt: new Date(expiredAt), status: 'pending' });
  } else {
    await otpServices.createOtp({ name: 'Customer', sentTo: email, receiverType: 'email', purpose: 'forget-password', otp, expiredAt });
  }

  const forgetToken = createToken({
    payload:       { email, userId: user.id },
    access_secret: config.jwt_access_secret as string,
    expity_time:   config.otp_token_expire_time as string | number,
  });

  process.nextTick(async () => {
    await otpSendEmail({ sentTo: email, subject: 'Your OTP for password reset', name: user.name || '', otp, expiredAt });
  });

  return { forgetToken };
};

// ── Forgot password OTP match ─────────────────────────────────────────────────

const forgotPasswordOtpMatch = async ({ otp, token }: OTPVerifyAndCreateUserProps) => {
  if (!token) throw new AppError(httpStatus.BAD_REQUEST, 'Token not found');

  const decodeData = verifyToken({ token, access_secret: config.jwt_access_secret as string });
  if (!decodeData) throw new AppError(httpStatus.BAD_REQUEST, 'You are not authorised');

  const { email } = decodeData;

  const isOtpMatch = await otpServices.otpMatch(email, 'forget-password', otp);
  if (!isOtpMatch) throw new AppError(httpStatus.BAD_REQUEST, 'OTP did not match');

  process.nextTick(async () => {
    await otpServices.updateOtpByEmail(email, 'forget-password', { status: 'verified' });
  });

  const user = await prisma.user.findUnique({ where: { email, isDeleted: false, status: UserStatus.active } });
  if (!user) throw new AppError(httpStatus.BAD_REQUEST, 'User not found');

  const forgetOtpMatchToken = createToken({
    payload:       { email, userId: user.id },
    access_secret: config.jwt_access_secret as string,
    expity_time:   config.otp_token_expire_time as string | number,
  });

  return { forgetOtpMatchToken };
};

// ── Reset password ────────────────────────────────────────────────────────────

const resetPassword = async ({
  token,
  newPassword,
  confirmPassword,
}: {
  token: string;
  newPassword: string;
  confirmPassword: string;
}) => {
  if (newPassword !== confirmPassword) throw new AppError(httpStatus.BAD_REQUEST, 'Passwords do not match');
  if (!token)                          throw new AppError(httpStatus.BAD_REQUEST, 'Token not found');

  const decodeData = verifyToken({ token, access_secret: config.jwt_access_secret as string });
  if (!decodeData) throw new AppError(httpStatus.BAD_REQUEST, 'You are not authorised');

  const { email, userId } = decodeData;

  const user = await prisma.user.findUnique({ where: { email, isDeleted: false, status: UserStatus.active } });
  if (!user) throw new AppError(httpStatus.BAD_REQUEST, 'User not found');

  const hashedPassword = await bcrypt.hash(newPassword, Number(config.bcrypt_salt_rounds));

  return prisma.user.update({ where: { id: userId ?? user.id }, data: { password: hashedPassword } });
};

// ── Change password ───────────────────────────────────────────────────────────

const changePassword = async ({
  userId,
  newPassword,
  oldPassword,
}: {
  userId: string;
  newPassword: string;
  oldPassword: string;
}) => {
  const user = await prisma.user.findUnique({ where: { id: userId, isDeleted: false } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  const match = await bcrypt.compare(oldPassword, user.password);
  if (!match) throw new AppError(httpStatus.FORBIDDEN, 'Old password does not match');

  const hashedPassword = await bcrypt.hash(newPassword, Number(config.bcrypt_salt_rounds));
  return prisma.user.update({ where: { id: userId }, data: { password: hashedPassword } });
};

// ── Logout ────────────────────────────────────────────────────────────────────

const logout = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  return prisma.user.update({ where: { id: userId }, data: { fcmToken: '' } });
};

// ── Refresh token ─────────────────────────────────────────────────────────────

const refreshToken = async (token: string) => {
  if (!token) throw new AppError(httpStatus.BAD_REQUEST, 'Token not found');

  const decoded = verifyToken({ token, access_secret: config.jwt_refresh_secret as string });
  const { email } = decoded;

  const user = await prisma.user.findUnique({
    where: { email, isDeleted: false, status: UserStatus.active },
  });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  const accessToken = createToken({
    payload: {
      userId: user.id, name: user.name ?? '', profileImage: user.profileImage,
      email: user.email, role: user.role,
    },
    access_secret: config.jwt_access_secret as string,
    expity_time:   config.jwt_access_expires_in as string,
  });

  return { accessToken };
};

// ── Export ────────────────────────────────────────────────────────────────────

export const authServices = {
  login,
  googleLogin,
  appleLogin,
  forgotPasswordOtpMatch,
  changePassword,
  forgotPasswordByEmail,
  resetPassword,
  refreshToken,
  logout,
};
