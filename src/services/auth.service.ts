import { prisma } from '../config/prisma.js';
import { hashPassword, comparePassword, hashToken } from '../utils/hash.js';
import { signAccessToken, generateOpaqueToken, getRefreshTokenExpiry } from '../utils/token.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../utils/email.js';
import { addXp } from './xp.service.js';
import { AppError } from '../middleware/errorHandler.js';

export async function registerUser(data: {
  email: string;
  password: string;
  displayName: string;
  gender: 'MALE' | 'FEMALE';
  nationality: string;
  language: string[];
  budgetLevel?: string;
  arrivalDate?: string;
  departureDate?: string;
  travelStyle?: string;
  interests?: string[];
  accommodationType?: string;
}) {
  const { email, password, displayName, gender, nationality, language, budgetLevel, arrivalDate, departureDate, travelStyle, interests, accommodationType } = data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, 'Unable to register with these details');
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName,
      gender,
      nationality,
      language,
      ...(budgetLevel && { budgetLevel }),
      ...(arrivalDate && { arrivalDate: new Date(arrivalDate) }),
      ...(departureDate && { departureDate: new Date(departureDate) }),
      ...(travelStyle && { travelStyle }),
      ...(interests && { interests }),
      ...(accommodationType && { accommodationType }),
    },
    select: { id: true, email: true, displayName: true, gender: true, nationality: true, language: true, createdAt: true },
  });

  const { raw, hash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.emailVerificationToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt },
  });

  await sendVerificationEmail(email, raw).catch((err) => console.error('Failed to send verification email:', err));

  await addXp(user.id, 5, 'registration');

  return user;
}

export async function verifyEmail(token: string) {
  const tokenHash = hashToken(token);
  const record = await prisma.emailVerificationToken.findFirst({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
  });

  if (!record) {
    throw new AppError(400, 'Invalid or expired verification token');
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { isEmailVerified: true } }),
    prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);

  await addXp(record.userId, 10, 'email_verified');
}

export async function resendVerification(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.isEmailVerified) return;

  const { raw, hash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.emailVerificationToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt },
  });

  await sendVerificationEmail(email, raw).catch((err) => console.error('Failed to send verification email:', err));
}

export async function loginUser(email: string, password: string, ipAddress?: string, deviceInfo?: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError(401, 'Invalid credentials');
  }

  if (user.isBanned) {
    throw new AppError(403, 'Account suspended');
  }

  if (!user.isEmailVerified) {
    throw new AppError(403, 'Please verify your email before logging in');
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, 'Invalid credentials');
  }

  const role = await prisma.role.findUniqueOrThrow({ where: { id: user.roleId } });
  const accessToken = signAccessToken({ userId: user.id, role: role.name });

  const { raw, hash } = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: getRefreshTokenExpiry(),
      ipAddress,
      deviceInfo,
    },
  });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const alreadyAwarded = await prisma.xpTransaction.findFirst({
    where: { userId: user.id, reason: 'daily_login', createdAt: { gte: today } },
  });
  if (!alreadyAwarded) {
    await addXp(user.id, 5, 'daily_login');
  }

  return {
    accessToken,
    refreshToken: raw,
    user: { id: user.id, email: user.email, displayName: user.displayName, gender: user.gender, nationality: user.nationality, language: user.language, role: role.name },
  };
}

export async function refreshTokens(refreshToken: string) {
  const tokenHash = hashToken(refreshToken);
  const record = await prisma.refreshToken.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
  });

  if (!record) {
    throw new AppError(401, 'Invalid or expired refresh token');
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
  const role = await prisma.role.findUniqueOrThrow({ where: { id: user.roleId } });
  const accessToken = signAccessToken({ userId: user.id, role: role.name });

  const { raw, hash: newHash } = generateOpaqueToken();
  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } }),
    prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: newHash, expiresAt: getRefreshTokenExpiry() },
    }),
  ]);

  return { accessToken, refreshToken: raw };
}

export async function logoutUser(refreshToken: string) {
  const tokenHash = hashToken(refreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function logoutAllUsers(userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function forgotPassword(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;

  const { raw, hash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt },
  });

  await sendPasswordResetEmail(email, raw).catch((err) => console.error('Failed to send password reset email:', err));
}

export async function resetPassword(token: string, newPassword: string) {
  const tokenHash = hashToken(token);
  const record = await prisma.passwordResetToken.findFirst({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
  });

  if (!record) {
    throw new AppError(400, 'Invalid or expired reset token');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
