import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { addXp } from './xp.service.js';
import { uploadToCloudinary, deleteFromCloudinary, extractPublicId } from '../utils/cloudinary.js';

export async function getUserProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      gender: true,
      nationality: true,
      language: true,
      budgetLevel: true,
      arrivalDate: true,
      departureDate: true,
      travelStyle: true,
      interests: true,
      accommodationType: true,
      roleId: true,
      isEmailVerified: true,
      xp: true,
      level: true,
      createdAt: true,
      role: { select: { name: true } },
    },
  });

  if (!user) {
    throw new AppError(404, 'User not found');
  }

  return user;
}

export async function updateUserProfile(
  userId: string,
  data: {
    displayName?: string;
    avatarUrl?: string;
    bio?: string;
    gender?: 'MALE' | 'FEMALE';
    nationality?: string;
    language?: string[];
    budgetLevel?: string;
    arrivalDate?: string;
    departureDate?: string;
    travelStyle?: string;
    interests?: string[];
    accommodationType?: string;
  },
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, 'User not found');
  }

  const hadAvatar = !!user.avatarUrl;
  const hadBio = !!user.bio;

  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      if (key === 'arrivalDate' || key === 'departureDate') {
        updateData[key] = new Date(value as string);
      } else {
        updateData[key] = value;
      }
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      gender: true,
      nationality: true,
      language: true,
      budgetLevel: true,
      arrivalDate: true,
      departureDate: true,
      travelStyle: true,
      interests: true,
      accommodationType: true,
      xp: true,
      level: true,
    },
  });

  const nowHasAvatar = !!updated.avatarUrl;
  const nowHasBio = !!updated.bio;
  const profileCompleted = nowHasAvatar && nowHasBio && (!hadAvatar || !hadBio);

  if (profileCompleted) {
    await addXp(userId, 20, 'profile_completed');
  }

  return updated;
}

export async function deleteUserAccount(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user?.avatarUrl) {
    const publicId = extractPublicId(user.avatarUrl);
    if (publicId) await deleteFromCloudinary(publicId).catch(() => {});
  }
  await prisma.user.delete({ where: { id: userId } });
}

export async function updateAvatar(userId: string, buffer: Buffer) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'User not found');

  if (user.avatarUrl) {
    const oldPublicId = extractPublicId(user.avatarUrl);
    if (oldPublicId) await deleteFromCloudinary(oldPublicId).catch(() => {});
  }

  const { url } = await uploadToCloudinary(buffer, 'avatars');

  const hadBio = !!user.bio;

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: url },
    select: { id: true, avatarUrl: true, bio: true, xp: true, level: true },
  });

  if (hadBio && !user.avatarUrl) {
    await addXp(userId, 20, 'profile_completed');
  }

  return { avatarUrl: updated.avatarUrl };
}

export async function deleteAvatar(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'User not found');
  if (!user.avatarUrl) return { avatarUrl: null };

  const publicId = extractPublicId(user.avatarUrl);
  if (publicId) await deleteFromCloudinary(publicId).catch(() => {});

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: null },
    select: { id: true, avatarUrl: true },
  });

  return { avatarUrl: updated.avatarUrl };
}

export async function getUserBadges(userId: string) {
  const badges = await prisma.userBadge.findMany({
    where: { userId },
    include: { badge: true },
    orderBy: { awardedAt: 'desc' },
  });
  return badges.map((ub: any) => ub.badge);
}

export async function getLeaderboard(limit = 50) {
  return prisma.user.findMany({
    orderBy: { xp: 'desc' },
    take: limit,
    select: { id: true, displayName: true, avatarUrl: true, xp: true, level: true },
  });
}

export async function getAllUsers(page = 1, limit = 50) {
  const skip = (page - 1) * limit;
  const [total, users] = await Promise.all([
    prisma.user.count({ where: { isDeleted: false } }),
    prisma.user.findMany({
      where: { isDeleted: false },
      skip,
      take: limit,
      select: {
        id: true,
        email: true,
        displayName: true,
        gender: true,
        nationality: true,
        language: true,
        budgetLevel: true,
        arrivalDate: true,
        departureDate: true,
        travelStyle: true,
        interests: true,
        accommodationType: true,
        roleId: true,
        isActive: true,
        isBanned: true,
        isEmailVerified: true,
        xp: true,
        level: true,
        createdAt: true,
        role: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return {
    users,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function updateUserRole(targetUserId: string, roleId: number, actorId: string) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) {
    throw new AppError(404, 'User not found');
  }

  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) {
    throw new AppError(400, 'Role not found');
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { roleId },
    select: { id: true, email: true, displayName: true, roleId: true },
  });

  await prisma.auditLog.create({
    data: {
      actorId,
      action: 'role_changed',
      targetUserId,
      metadata: { newRole: role.name, previousRoleId: user.roleId },
    },
  });

  return updated;
}

export async function banUser(targetUserId: string, actorId: string) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) {
    throw new AppError(404, 'User not found');
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { isBanned: !user.isBanned },
    select: { id: true, email: true, displayName: true, isBanned: true },
  });

  await prisma.auditLog.create({
    data: {
      actorId,
      action: updated.isBanned ? 'user_banned' : 'user_unbanned',
      targetUserId,
    },
  });

  return updated;
}



export async function unbanUser(targetUserId: string, actorId: string) {
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
  });

  if (!user) {
    throw new AppError(404, "User not found");
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { isBanned: false },
    select: {
      id: true,
      email: true,
      displayName: true,
      isBanned: true,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId,
      action: "user_unbanned",
      targetUserId,
    },
  });

  return updated;
}

export async function getAdminStats() {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [totalUsers, activeToday, totalChats, purchasedTokens, revenueAgg, revenueToday, paymentCounts] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { lastLoginAt: { gte: dayAgo } } }),
      prisma.conversation.count(),
      prisma.tokenTransaction.aggregate({
        _sum: { tokens: true },
        where: { source: 'PURCHASE' },
      }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: 'COMPLETED' },
      }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: 'COMPLETED', paidAt: { gte: todayStart } },
      }),
      prisma.payment.groupBy({
        by: ['status'],
        _count: true,
      }),
    ]);
  const statusCounts = Object.fromEntries(paymentCounts.map((p: { status: string; _count: number }) => [p.status, p._count]));
  return {
    totalUsers,
    activeToday,
    totalChats,
    revenue: Number(revenueAgg._sum.amount ?? 0),
    revenueToday: Number(revenueToday._sum.amount ?? 0),
    purchasedTokens: purchasedTokens._sum.tokens ?? 0,
    payments: {
      completed: statusCounts.COMPLETED ?? 0,
      pending: statusCounts.PENDING ?? 0,
      failed: statusCounts.FAILED ?? 0,
      refunded: statusCounts.REFUNDED ?? 0,
      cancelled: statusCounts.CANCELLED ?? 0,
    },
  };
}

export async function getMonthlyStats(months = 6) {
  const now = new Date();
  const data: Array<{ name: string; users: number; chats: number; revenue: number }> = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const [users, chats, revenue] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: start, lt: end } } }),
      prisma.conversation.count({ where: { createdAt: { gte: start, lt: end } } }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: 'COMPLETED', paidAt: { gte: start, lt: end } },
      }),
    ]);
    data.push({
      name: start.toLocaleString('en', { month: 'short' }),
      users,
      chats,
      revenue: Number(revenue._sum.amount ?? 0),
    });
  }
  return data;
}

export async function getAuditLogs() {
  return prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      actor: { select: { displayName: true, email: true } },
      target: { select: { displayName: true, email: true } },
    },
  })
}


// return all roles

export async function getAllRoles() {
  const roles = await prisma.role.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return roles;
}