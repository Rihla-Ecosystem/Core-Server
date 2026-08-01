import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

function computeLevel(totalXp: number): number {
  let level = 1;
  let cumulative = 0;
  while (true) {
    const needed = Math.round(100 * Math.pow(level, 1.5));
    if (totalXp < cumulative + needed) break;
    cumulative += needed;
    level++;
  }
  return level;
}

export async function listJourneys(userId: string) {
  return prisma.journey.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' }, include: { steps: { orderBy: { stepNumber: 'asc' }, select: { id: true, stepNumber: true, title: true, content: true, xpReward: true } }, progress: { where: { userId }, include: { steps: true } } } });
}

export async function startJourney(userId: string, slug: string) {
  const journey = await prisma.journey.findUnique({ where: { slug }, include: { steps: { orderBy: { stepNumber: 'asc' } } } });
  if (!journey || !journey.isActive) return null;
  return prisma.userJourney.upsert({ where: { userId_journeyId: { userId, journeyId: journey.id } }, update: {}, create: { userId, journeyId: journey.id }, include: { journey: { include: { steps: { orderBy: { stepNumber: 'asc' } } } }, steps: true } });
}

async function awardXp(tx: Prisma.TransactionClient, userId: string, amount: number, reason: string): Promise<void> {
  if (amount <= 0) return;
  const existing = await tx.xpTransaction.findFirst({ where: { userId, reason } });
  if (existing) return;

  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  await tx.xpTransaction.create({ data: { userId, amount, reason } });
  const newXp = user.xp + amount;
  await tx.user.update({
    where: { id: userId },
    data: { xp: newXp, level: computeLevel(newXp) },
  });
}

export async function completeJourneyStep(userId: string, slug: string, stepNumber: number) {
  const journey = await prisma.journey.findUnique({ where: { slug }, include: { steps: { where: { stepNumber } } } });
  const step = journey?.steps[0];
  if (!journey || !step) return null;

  const result = await prisma.$transaction(
    async (tx) => {
      const progress = await tx.userJourney.upsert({
        where: { userId_journeyId: { userId, journeyId: journey.id } },
        update: {},
        create: { userId, journeyId: journey.id },
      });
      const existingCompletion = await tx.userJourneyStep.findUnique({
        where: { userJourneyId_stepId: { userJourneyId: progress.id, stepId: step.id } },
      });

      let wasNewlyCompleted = false;
      if (!existingCompletion) {
        await tx.userJourneyStep.create({ data: { userJourneyId: progress.id, stepId: step.id } });
        wasNewlyCompleted = true;
      }

      let journeyCompleted = false;
      if (wasNewlyCompleted) {
        await awardXp(tx, userId, step.xpReward, `journey_step:${journey.id}:${step.id}`);
      }

      const total = await tx.journeyStep.count({ where: { journeyId: journey.id } });
      const completed = await tx.userJourneyStep.count({ where: { userJourneyId: progress.id } });
      journeyCompleted = completed >= total;

      if (journeyCompleted) {
        await tx.userJourney.update({ where: { id: progress.id }, data: { completedAt: new Date() } });
        await awardXp(tx, userId, journey.xpReward, `journey_complete:${journey.id}`);
        const badge = await tx.badge.findFirst({ where: { criteriaType: 'journey_complete', name: 'Scam-Smart Traveler' } });
        if (badge) await tx.userBadge.upsert({ where: { userId_badgeId: { userId, badgeId: badge.id } }, update: {}, create: { userId, badgeId: badge.id } });
      }

      return { progress, wasNewlyCompleted, total, completed, journeyCompleted };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  return { journey: slug, step: stepNumber, completed: result.completed, total: result.total, journeyCompleted: result.journeyCompleted };
}
