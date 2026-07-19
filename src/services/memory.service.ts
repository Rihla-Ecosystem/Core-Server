import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export async function listTrips(userId: string) {
  return prisma.tripHistory.findMany({
    where: { userId },
    orderBy: { startDate: 'desc' },
  });
}

export async function createTrip(
  userId: string,
  data: {
    title: string;
    destination: string;
    startDate: string;
    endDate: string;
    itinerary?: unknown;
    notes?: string;
  },
) {
  return prisma.tripHistory.create({
    data: {
      userId,
      title: data.title,
      destination: data.destination,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
      itinerary: data.itinerary ?? undefined,
      notes: data.notes,
    },
  });
}

export async function deleteTrip(userId: string, tripId: string) {
  const trip = await prisma.tripHistory.findFirst({
    where: { id: tripId, userId },
  });
  if (!trip) throw new AppError(404, 'Trip not found');
  await prisma.tripHistory.delete({ where: { id: tripId } });
}

export async function getPreferences(userId: string) {
  const rows = await prisma.userPreference.findMany({
    where: { userId },
    select: { key: true, value: true },
  });
  const result: Record<string, unknown> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export async function setPreference(userId: string, key: string, value: unknown) {
  return prisma.userPreference.upsert({
    where: { userId_key: { userId, key } },
    update: { value: value as any },
    create: { userId, key, value: value as any },
  });
}

export async function createFeedback(
  userId: string,
  data: {
    type: string;
    targetId?: string;
    targetType?: string;
    rating?: number;
    comment?: string;
  },
) {
  return prisma.userFeedback.create({
    data: {
      userId,
      type: data.type,
      targetId: data.targetId,
      targetType: data.targetType,
      rating: data.rating,
      comment: data.comment,
    },
  });
}

export async function getSummary(userId: string) {
  return prisma.interactionSummary.findFirst({
    where: { userId },
    orderBy: { periodEnd: 'desc' },
  });
}

export async function upsertSummary(
  userId: string,
  data: {
    summary: string;
    periodStart: string;
    periodEnd: string;
  },
) {
  const existing = await prisma.interactionSummary.findFirst({
    where: { userId },
    orderBy: { periodEnd: 'desc' },
  });

  if (existing) {
    return prisma.interactionSummary.update({
      where: { id: existing.id },
      data: {
        summary: data.summary,
        periodStart: new Date(data.periodStart),
        periodEnd: new Date(data.periodEnd),
      },
    });
  }

  return prisma.interactionSummary.create({
    data: {
      userId,
      summary: data.summary,
      periodStart: new Date(data.periodStart),
      periodEnd: new Date(data.periodEnd),
    },
  });
}
