import { prisma } from '../config/prisma.js';
import { addXp } from './xp.service.js';

export async function listJourneys(userId: string) {
  return prisma.journey.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' }, include: { steps: { orderBy: { stepNumber: 'asc' }, select: { id: true, stepNumber: true, title: true, content: true, xpReward: true } }, progress: { where: { userId }, include: { steps: true } } } });
}

export async function startJourney(userId: string, slug: string) {
  const journey = await prisma.journey.findUnique({ where: { slug }, include: { steps: { orderBy: { stepNumber: 'asc' } } } });
  if (!journey || !journey.isActive) return null;
  return prisma.userJourney.upsert({ where: { userId_journeyId: { userId, journeyId: journey.id } }, update: {}, create: { userId, journeyId: journey.id }, include: { journey: { include: { steps: { orderBy: { stepNumber: 'asc' } } } }, steps: true } });
}

export async function completeJourneyStep(userId: string, slug: string, stepNumber: number) {
  const journey = await prisma.journey.findUnique({ where: { slug }, include: { steps: { where: { stepNumber } } } });
  const step = journey?.steps[0];
  if (!journey || !step) return null;
  const { progress, wasNewlyCompleted } = await prisma.$transaction(async (tx) => {
    const progress = await tx.userJourney.upsert({
      where: { userId_journeyId: { userId, journeyId: journey.id } },
      update: {},
      create: { userId, journeyId: journey.id },
    });
    const existingCompletion = await tx.userJourneyStep.findUnique({
      where: { userJourneyId_stepId: { userJourneyId: progress.id, stepId: step.id } },
    });
    if (existingCompletion) return { progress, wasNewlyCompleted: false };
    await tx.userJourneyStep.create({ data: { userJourneyId: progress.id, stepId: step.id } });
    return { progress, wasNewlyCompleted: true };
  });
  if (wasNewlyCompleted) {
    const awardKey = `journey_step:${journey.id}:${step.id}`;
    const existing = await prisma.xpTransaction.findFirst({ where: { userId, reason: awardKey } });
    if (!existing) await addXp(userId, step.xpReward, awardKey);
  }
  const total = await prisma.journeyStep.count({ where: { journeyId: journey.id } });
  const completed = await prisma.userJourneyStep.count({ where: { userJourneyId: progress.id } });
  if (completed >= total) {
    await prisma.userJourney.update({ where: { id: progress.id }, data: { completedAt: new Date() } });
    const existing = await prisma.xpTransaction.findFirst({ where: { userId, reason: `journey_complete:${journey.id}` } });
    if (!existing) await addXp(userId, journey.xpReward, `journey_complete:${journey.id}`);
    const badge = await prisma.badge.findFirst({ where: { criteriaType: 'journey_complete', name: 'Scam-Smart Traveler' } });
    if (badge) await prisma.userBadge.upsert({ where: { userId_badgeId: { userId, badgeId: badge.id } }, update: {}, create: { userId, badgeId: badge.id } });
  }
  return { journey: slug, step: stepNumber, completed, total, journeyCompleted: completed >= total };
}
