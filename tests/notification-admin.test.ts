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
import { classifyPoi } from '../src/services/context-aggregator.service.js';
import {
  createTemplate,
  listTemplates,
  updateTemplate,
  deleteTemplate,
  getAnalytics,
  getReadUnreadStats,
  createAndSendNotification,
  listHistory,
} from '../src/services/notification-admin.service.js';
import type { NearbyPoi } from '../src/types/context-notification.js';

let USER_ROLE_ID: number;
let ADMIN_USER_ID: string;
const createdUserIds: string[] = [];

async function cleanup(): Promise<void> {
  await prisma.notificationInbox.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.userNotificationStatus.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.contextReport.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.notificationHistory.deleteMany({ where: { title: { startsWith: 'Test Note ' } } });
  await prisma.notificationTemplate.deleteMany({ where: { code: { startsWith: 'test_' } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  createdUserIds.length = 0;
}

describe('Context aggregator classification', () => {
  test('classifies hotels, restaurants, hospitals, police, transport, historical', () => {
    const cases: Array<[NearbyPoi, string]> = [
      [{ name: 'Four Seasons Hotel' }, 'hotel'],
      [{ name: 'Cafe Lux' }, 'restaurant'],
      [{ name: 'Kasr El Ainy Hospital' }, 'hospital'],
      [{ name: 'Central Police Station' }, 'police'],
      [{ name: 'Ramses Metro Station' }, 'transportation'],
      [{ name: 'Pyramid of Giza' }, 'historical'],
      [{ name: 'Green Park' }, 'attraction'],
    ];
    for (const [poi, expected] of cases) {
      assert.equal(classifyPoi(poi), expected, `${poi.name} should be ${expected}`);
    }
  });
});

describe('Notification admin service', () => {
  before(async () => {
    USER_ROLE_ID = (await ensureUserRole()).id;
    await cleanup();
    const admin = await prisma.user.create({
      data: {
        email: `test_note_admin_${crypto.randomUUID().slice(0, 8)}@test.example`,
        passwordHash: crypto.randomBytes(16).toString('hex'),
        displayName: 'Test Admin',
        gender: 'MALE' as Gender,
        nationality: 'EG',
        language: ['en'],
        roleId: USER_ROLE_ID,
      },
    });
    ADMIN_USER_ID = admin.id;
    createdUserIds.push(admin.id);
  });

  after(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  async function createUser(tag: string): Promise<string> {
    const email = `test_note_${tag}_${crypto.randomUUID().slice(0, 8)}@test.example`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: crypto.randomBytes(16).toString('hex'),
        displayName: `Test ${tag}`,
        gender: 'MALE' as Gender,
        nationality: 'EG',
        language: ['en'],
        roleId: USER_ROLE_ID,
      },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  test('template CRUD lifecycle', async () => {
    const code = `test_${crypto.randomUUID().slice(0, 8)}`;
    const created = await createTemplate(
      { code, name: 'Test Template', title: 'Hello {name}', message: 'Welcome {name}', type: 'INFO', category: 'SYSTEM', priority: 'NORMAL' },
      ADMIN_USER_ID,
    );
    assert.equal(created.code, code);

    const list = await listTemplates({ search: code });
    assert.equal(list.templates.length, 1);

    const updated = await updateTemplate(created.id, { title: 'Updated {name}' });
    assert.equal(updated.title, 'Updated {name}');

    const deleted = await deleteTemplate(created.id);
    assert.equal(deleted.deleted, true);

    const afterDelete = await listTemplates({ search: code });
    assert.equal(afterDelete.templates.length, 0);
  });

  test('duplicate template code is rejected', async () => {
    const code = `test_dup_${crypto.randomUUID().slice(0, 8)}`;
    await createTemplate({ code, name: 'A', title: 'A', message: 'A' }, ADMIN_USER_ID);
    await assert.rejects(
      () => createTemplate({ code, name: 'B', title: 'B', message: 'B' }, ADMIN_USER_ID),
      /already exists/i,
    );
  });

  test('send a notification to specific users', async () => {
    const userId = await createUser('target');
    const result = await createAndSendNotification(
      {
        title: `Test Note ${crypto.randomUUID().slice(0, 8)}`,
        message: 'Targeted hello',
        type: 'INFO',
        category: 'TOURIST',
        priority: 'NORMAL',
        audience: { userIds: [userId] },
      },
      ADMIN_USER_ID,
    );
    assert.equal(result.recipients, 1);
    assert.equal(result.delivered, 0);

    const inbox = await prisma.notificationInbox.findFirst({ where: { userId } });
    assert.ok(inbox);
    assert.equal(inbox.category, 'TOURIST');
  });

  test('schedule a notification instead of sending immediately', async () => {
    const userId = await createUser('sched');
    const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await createAndSendNotification(
      {
        title: `Test Note ${crypto.randomUUID().slice(0, 8)}`,
        message: 'Scheduled hello',
        audience: { userIds: [userId] },
        schedule: { sendAt },
      },
      ADMIN_USER_ID,
    );
    assert.equal(result.scheduled, true);

    const history = await listHistory({ search: result.historyId ?? '' });
    assert.ok(history);
  });

  test('analytics and read/unread stats are coherent', async () => {
    const analytics = await getAnalytics();
    assert.ok(typeof analytics.totalSent === 'number');
    assert.ok(typeof analytics.readRate === 'number');
    const stats = await getReadUnreadStats();
    assert.equal(stats.total, stats.read + stats.unread);
  });
});