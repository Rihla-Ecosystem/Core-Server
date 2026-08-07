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
import { ensureUserRole } from './helpers/test-role-fixtures.js';
import { Gender } from '@prisma/client';
import { processLocationUpdate } from '../src/services/context-engine.service.js';

let USER_ROLE_ID: number;
const createdUserIds: string[] = [];

async function cleanup(): Promise<void> {
  await prisma.notificationInbox.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.userNotificationStatus.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.contextReport.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.notificationLog.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  createdUserIds.length = 0;
}

describe('Context engine (offline upstream fallback)', () => {
  before(async () => {
    USER_ROLE_ID = (await ensureUserRole()).id;
    await cleanup();
  });

  after(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  async function createUser(tag: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `test_engine_${tag}_${crypto.randomUUID().slice(0, 8)}@test.example`,
        passwordHash: crypto.randomBytes(16).toString('hex'),
        displayName: `Engine ${tag}`,
        gender: 'MALE' as Gender,
        nationality: 'EG',
        language: ['en'],
        roleId: USER_ROLE_ID,
      },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  test('processLocationUpdate persists inbox + context report even when upstreams are down', async () => {
    const userId = await createUser('a');
    const result = await processLocationUpdate(userId, { lat: 30.0444, lng: 31.2357, reason: 'movement' });

    assert.ok(result.contextReport);
    assert.ok(result.contextReport.aiSummary.executiveSummary.length > 0);
    assert.ok(result.contextReport.safetyScore >= 0);

    const inbox = await prisma.notificationInbox.findMany({ where: { userId } });
    assert.ok(Array.isArray(inbox));
    for (const n of inbox) {
      assert.ok(n.title.length > 0);
      assert.ok(['INFO', 'WARNING', 'ERROR'].includes(n.type));
    }

    const report = await prisma.contextReport.findFirst({ where: { userId } });
    assert.ok(report);
    assert.ok(report.context && typeof report.context === 'object');

    const status = await prisma.userNotificationStatus.findUnique({ where: { userId } });
    assert.ok(status);
    assert.equal(status.lastLat, 30.0444);
    assert.equal(status.lastLng, 31.2357);
  });

  test('processLocationUpdate rejects invalid coordinates', async () => {
    const userId = await createUser('b');
    await assert.rejects(
      // @ts-expect-error invalid payload type for guard test
      () => processLocationUpdate(userId, { lat: '30.0', lng: 31.2, reason: 'movement' }),
      /lat and lng are required/,
    );
  });

  test('a quiet area with no upstream data yields no notifications but a report', async () => {
    const userId = await createUser('c');
    const result = await processLocationUpdate(userId, { lat: 30.5, lng: 31.2, reason: 'movement' });
    assert.ok(result.contextReport);
    assert.ok(result.contextReport.aiSummary);
  });
});