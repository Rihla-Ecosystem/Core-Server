{
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Safety check failed: DATABASE_URL is not set');
  const parsed = new URL(dbUrl);
  if (parsed.pathname !== '/core_server_test') {
    throw new Error(
      `Safety check failed: DATABASE_URL must point to /core_server_test, got "${parsed.pathname}"`,
    );
  }
}

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/config/prisma.js';
import { Gender } from '@prisma/client';
import {
  listJourneys,
  getJourneyDetail,
  startJourney,
  completeJourneyStep,
} from '../src/services/journey.service.js';

const ARCHAEOLOGY_SLUGS = ['giza-plateau', 'karnak-luxor', 'abu-simbel-nubia', 'coptic-islamic-cairo'];
const ARCHAEOLOGY_BADGES = ['Pyramid Pioneer', 'Temple Walker', 'Nubia Navigator', 'Old Cairo Explorer'];
const THEME_BADGE = 'Antiquity Explorer';

describe('Journeys & Quests', () => {
  before(async () => {
    await cleanupTestData();
    await seedArchaeologyQuests();
  });

  after(async () => {
    try {
      await cleanupTestData();
    } finally {
      await prisma.$disconnect();
    }
  });

  async function cleanupTestData(): Promise<void> {
    await prisma.user.deleteMany({ where: { email: { startsWith: 'test_quest_' } } });
    await prisma.journey.deleteMany({
      where: { slug: { in: [...ARCHAEOLOGY_SLUGS, 'test-quest-sequential'] } },
    });
  }

  async function seedArchaeologyQuests(): Promise<void> {
    for (let i = 0; i < ARCHAEOLOGY_SLUGS.length; i++) {
      const slug = ARCHAEOLOGY_SLUGS[i];
      const journey = await prisma.journey.upsert({
        where: { slug },
        update: { title: `Test ${slug}`, description: 'test', xpReward: 10, isActive: true },
        create: { slug, title: `Test ${slug}`, description: 'test', xpReward: 10, isActive: true },
      });
      await prisma.journeyStep.deleteMany({ where: { journeyId: journey.id } });
      await prisma.journeyStep.create({
        data: { journeyId: journey.id, stepNumber: 1, title: 'S1', content: 'C', xpReward: 5 },
      });
    }

    const sequential = await prisma.journey.upsert({
      where: { slug: 'test-quest-sequential' },
      update: { title: 'Sequential', description: 'test', xpReward: 10, isActive: true },
      create: { slug: 'test-quest-sequential', title: 'Sequential', description: 'test', xpReward: 10, isActive: true },
    });
    await prisma.journeyStep.deleteMany({ where: { journeyId: sequential.id } });
    await prisma.journeyStep.createMany({
      data: [
        { journeyId: sequential.id, stepNumber: 1, title: 'S1', content: 'C', xpReward: 5 },
        { journeyId: sequential.id, stepNumber: 2, title: 'S2', content: 'C', xpReward: 5 },
      ],
    });

    for (const name of [...ARCHAEOLOGY_BADGES, THEME_BADGE]) {
      await prisma.badge.upsert({
        where: { name },
        update: { description: 'test', criteriaType: 'journey_complete', iconUrl: '🛕' },
        create: { name, description: 'test', criteriaType: 'journey_complete', iconUrl: '🛕' },
      });
    }
  }

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `test_quest_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Quest User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    return user.id;
  }

  test('1. listJourneys returns computed progress fields', async () => {
    const userId = await createUser();
    const journeys = await listJourneys(userId);
    const quest = journeys.find((j) => j.slug === 'giza-plateau');
    assert.ok(quest);
    assert.equal(quest.completedSteps, 0);
    assert.equal(quest.totalSteps, 1);
    assert.equal(quest.isCompleted, false);
    assert.equal(quest.nextStep, 1);
  });

  test('2. getJourneyDetail returns null for inactive or unknown journeys', async () => {
    const userId = await createUser();
    assert.equal(await getJourneyDetail(userId, 'does-not-exist'), null);

    const inactive = await prisma.journey.create({
      data: { slug: 'test-quest-inactive', title: 'Inactive', isActive: false },
    });
    try {
      assert.equal(await getJourneyDetail(userId, 'test-quest-inactive'), null);
    } finally {
      await prisma.journey.delete({ where: { id: inactive.id } });
    }
  });

  test('3. startJourney creates progress and keeps detail consistent', async () => {
    const userId = await createUser();
    const started = await startJourney(userId, 'giza-plateau');
    assert.ok(started);
    assert.equal(started.totalSteps, 1);
    assert.equal(started.completedSteps, 0);
    assert.ok(started.startedAt);
    assert.equal(started.isCompleted, false);
  });

  test('4. completing a step of an unstarted journey is blocked', async () => {
    const userId = await createUser();
    await assert.rejects(
      completeJourneyStep(userId, 'test-quest-sequential', 2),
      (err: { statusCode?: number }) => err.statusCode === 409,
    );
  });

  test('5. sequential gating rejects skipping ahead', async () => {
    const userId = await createUser();
    const started = await startJourney(userId, 'test-quest-sequential');
    assert.ok(started);

    await assert.rejects(
      completeJourneyStep(userId, 'test-quest-sequential', 2),
      (err: { statusCode?: number }) => err.statusCode === 400,
    );

    const first = await completeJourneyStep(userId, 'test-quest-sequential', 1);
    assert.ok(first);
    assert.equal(first.completed, 1);
    assert.equal(first.journeyCompleted, false);

    const second = await completeJourneyStep(userId, 'test-quest-sequential', 2);
    assert.ok(second);
    assert.equal(second.completed, 2);
    assert.equal(second.journeyCompleted, true);
  });

  test('6. completing a step awards XP exactly once', async () => {
    const userId = await createUser();
    await startJourney(userId, 'giza-plateau');

    const first = await completeJourneyStep(userId, 'giza-plateau', 1);
    assert.ok(first);
    assert.equal(first.xpAwarded, 15);
    assert.equal(first.journeyCompleted, true);

    const second = await completeJourneyStep(userId, 'giza-plateau', 1);
    assert.ok(second);
    assert.equal(second.xpAwarded, 0);
    assert.equal(second.completed, 1);

    const xpCount = await prisma.xpTransaction.count({ where: { userId } });
    assert.equal(xpCount, 2);
  });

  test('7. completing every archaeology quest awards quest badges and the theme badge', async () => {
    const userId = await createUser();

    for (let i = 0; i < ARCHAEOLOGY_SLUGS.length; i++) {
      const result = await completeJourneyStep(userId, ARCHAEOLOGY_SLUGS[i], 1);
      assert.ok(result);
      assert.equal(result.journeyCompleted, true);
      assert.equal(result.xpAwarded, 15);
      assert.ok(result.badgesAwarded.includes(ARCHAEOLOGY_BADGES[i]));
      assert.equal(
        result.badgesAwarded.includes(THEME_BADGE),
        i === ARCHAEOLOGY_SLUGS.length - 1,
      );
    }

    const badges = await prisma.userBadge.findMany({
      where: { userId },
      include: { badge: true },
    });
    const names = badges.map((b) => b.badge.name).filter((n) => n !== 'Welcome Aboard');
    assert.deepEqual([...names].sort(), [...ARCHAEOLOGY_BADGES, THEME_BADGE].sort());

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(user.xp, ARCHAEOLOGY_SLUGS.length * 15);
  });
});
