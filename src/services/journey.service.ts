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

import { AppError } from '../middleware/errorHandler.js';
import { addXp } from './xp.service.js';


/**
 * Quest completion badges, keyed by journey slug.
 * Each quest awards its own badge when completed. New quests only need an
 * entry here (and a matching seeded badge) — no schema changes required.
 */
const JOURNEY_BADGE_BY_SLUG: Record<string, string> = {
  'scam-smart-traveler': 'Scam-Smart Traveler',
  'taxi-tricks': 'Taxi Savvy',
  'street-money-exchange': 'Money Maestro',
  'fake-guide-papyrus': 'Guide Guardian',
  'atm-card-scam': 'Card Safe',
  'giza-plateau': 'Pyramid Pioneer',
  'karnak-luxor': 'Temple Walker',
  'abu-simbel-nubia': 'Nubia Navigator',
  'coptic-islamic-cairo': 'Old Cairo Explorer',
};

type QuestTheme = 'scam' | 'archaeology';

/** Theme badges awarded when every quest in the theme is completed. */
const THEME_BADGE_BY_THEME: Record<QuestTheme, string> = {
  scam: 'Scam Shield',
  archaeology: 'Antiquity Explorer',
};

const THEME_BY_SLUG: Record<string, QuestTheme> = {
  'scam-smart-traveler': 'scam',
  'taxi-tricks': 'scam',
  'street-money-exchange': 'scam',
  'fake-guide-papyrus': 'scam',
  'atm-card-scam': 'scam',
  'giza-plateau': 'archaeology',
  'karnak-luxor': 'archaeology',
  'abu-simbel-nubia': 'archaeology',
  'coptic-islamic-cairo': 'archaeology',
};

const THEME_QUESTS: Record<QuestTheme, string[]> = {
  scam: [
    'scam-smart-traveler',
    'taxi-tricks',
    'street-money-exchange',
    'fake-guide-papyrus',
    'atm-card-scam',
  ],
  archaeology: [
    'giza-plateau',
    'karnak-luxor',
    'abu-simbel-nubia',
    'coptic-islamic-cairo',
  ],
};

interface JourneyStepView {
  id: string;
  stepNumber: number;
  title: string;
  content: string;
  xpReward: number;
}

interface JourneyView {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  xpReward: number;
  isActive: boolean;
  steps: JourneyStepView[];
  completedSteps: number;
  totalSteps: number;
  isCompleted: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
  nextStep: number | null;
}

function decorateJourney(journey: {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  xpReward: number;
  isActive: boolean;
  steps: JourneyStepView[];
  progress: { startedAt: Date; completedAt: Date | null; steps: { stepId: string }[] }[];
}): JourneyView {
  const progress = journey.progress[0] ?? null;
  const completedStepIds = new Set((progress?.steps ?? []).map((s) => s.stepId));
  const totalSteps = journey.steps.length;
  const completedSteps = completedStepIds.size;
  const nextStep =
    completedSteps >= totalSteps
      ? null
      : journey.steps.find((s) => !completedStepIds.has(s.id))?.stepNumber ?? null;

  return {
    id: journey.id,
    slug: journey.slug,
    title: journey.title,
    description: journey.description,
    xpReward: journey.xpReward,
    isActive: journey.isActive,
    steps: journey.steps,
    completedSteps,
    totalSteps,
    isCompleted: progress?.completedAt != null,
    startedAt: progress?.startedAt ?? null,
    completedAt: progress?.completedAt ?? null,
    nextStep,
  };
}

async function awardBadgeByName(userId: string, name: string): Promise<boolean> {
  const badge = await prisma.badge.findUnique({ where: { name } });
  if (!badge) return false;
  const existing = await prisma.userBadge.findUnique({
    where: { userId_badgeId: { userId, badgeId: badge.id } },
  });
  if (existing) return false;
  await prisma.userBadge.create({ data: { userId, badgeId: badge.id } });
  return true;
}

export async function listJourneys(userId: string): Promise<JourneyView[]> {
  const journeys = await prisma.journey.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        select: { id: true, stepNumber: true, title: true, content: true, xpReward: true },
      },
      progress: { where: { userId }, include: { steps: true } },
    },
  });
  return journeys.map((journey) => decorateJourney(journey));
}

export async function getJourneyDetail(userId: string, slug: string): Promise<JourneyView | null> {
  const journey = await prisma.journey.findUnique({
    where: { slug },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        select: { id: true, stepNumber: true, title: true, content: true, xpReward: true },
      },
      progress: { where: { userId }, include: { steps: true } },
    },
  });
  if (!journey || !journey.isActive) return null;
  return decorateJourney(journey);
}

export async function startJourney(userId: string, slug: string): Promise<JourneyView | null> {
  const journey = await prisma.journey.findUnique({ where: { slug }, include: { steps: { orderBy: { stepNumber: 'asc' } } } });
  if (!journey || !journey.isActive) return null;

  const userJourney = await prisma.userJourney.upsert({
    where: { userId_journeyId: { userId, journeyId: journey.id } },
    update: {},
    create: { userId, journeyId: journey.id },
    include: { steps: true },
  });

  return decorateJourney({
    id: journey.id,
    slug: journey.slug,
    title: journey.title,
    description: journey.description,
    xpReward: journey.xpReward,
    isActive: journey.isActive,
    steps: journey.steps.map((s) => ({
      id: s.id,
      stepNumber: s.stepNumber,
      title: s.title,
      content: s.content,
      xpReward: s.xpReward,
    })),
    progress: [userJourney],
  });
}

export interface CompleteJourneyStepResult {
  journey: string;
  step: number;
  completed: number;
  total: number;
  journeyCompleted: boolean;
  xpAwarded: number;
  badgesAwarded: string[];
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



