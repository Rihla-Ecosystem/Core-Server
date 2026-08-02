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

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { signAccessToken } from '../src/utils/token.js';

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_TOKEN_SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ADMIN_TOKEN = signAccessToken({ sub: ADMIN_USER_ID, role: 'admin' });
const USER_TOKEN = signAccessToken({ sub: USER_TOKEN_SUB, role: 'user' });

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

function userHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${USER_TOKEN}` };
}

let uniqueCounter = 0;
function uniqueSuffix(): string {
  uniqueCounter++;
  return `${Date.now()}_${uniqueCounter}`;
}

async function cleanupTestData(): Promise<void> {
  const suffix = new Set<string>();
  await prisma.role.deleteMany({ where: { name: { startsWith: 'TEST_ENT_ROLE_' } } });
  await prisma.badge.deleteMany({ where: { name: { startsWith: 'TEST_ENT_BADGE_' } } });
  await prisma.journey.deleteMany({ where: { slug: { startsWith: 'test-ent-' } } });
  await prisma.notification.deleteMany({ where: { userId: { in: [ADMIN_USER_ID, USER_TOKEN_SUB] } } });
  await prisma.auditLog.deleteMany({
    where: { actorId: { in: [ADMIN_USER_ID] }, action: { in: ['role_deleted', 'badge_deleted', 'journey_deleted', 'trip_deleted'] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN_USER_ID, USER_TOKEN_SUB] } } });
}

describe('Admin Enterprise API', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await cleanupTestData();

    const adminRole = await prisma.role.upsert({
      where: { name: 'admin' },
      update: {},
      create: { id: 9901, name: 'admin', permissions: [] },
    });
    const userRole = await prisma.role.upsert({
      where: { name: 'user' },
      update: {},
      create: { id: 9902, name: 'user', permissions: [] },
    });

    await prisma.user.createMany({
      data: [
        {
          id: ADMIN_USER_ID,
          email: `test_ent_admin_${uniqueSuffix()}@test.com`,
          passwordHash: 'x',
          displayName: 'Ent Admin',
          gender: 'MALE',
          nationality: 'EG',
          language: ['en'],
          roleId: adminRole.id,
        },
        {
          id: USER_TOKEN_SUB,
          email: `test_ent_user_${uniqueSuffix()}@test.com`,
          passwordHash: 'x',
          displayName: 'Ent User',
          gender: 'FEMALE',
          nationality: 'US',
          language: ['en'],
          roleId: userRole.id,
        },
      ],
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(async () => {
    await cleanupTestData();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [ADMIN_USER_ID, USER_TOKEN_SUB] } } });
  });

  describe('Roles', () => {
    test('1. Admin can list roles with pagination', async () => {
      const res = await fetch(`${baseUrl}/admin/enterprise/roles?page=1&limit=5`, { headers: adminHeaders() });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(Array.isArray(body.data.roles));
      assert.ok(body.data.pagination.total > 0);
    });

    test('2. Non-admin cannot access roles', async () => {
      const res = await fetch(`${baseUrl}/admin/enterprise/roles`, { headers: userHeaders() });
      assert.equal(res.status, 403);
    });

    test('3. Admin can create, update, and delete a role', async () => {
      const suffix = uniqueSuffix();
      const createRes = await fetch(`${baseUrl}/admin/enterprise/roles`, {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `TEST_ENT_ROLE_${suffix}`, permissions: ['users:read'] }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      assert.equal(created.data.permissions.length, 1);

      const patchRes = await fetch(`${baseUrl}/admin/enterprise/roles/${created.data.id}`, {
        method: 'PATCH',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: ['users:read', 'users:write'] }),
      });
      assert.equal(patchRes.status, 200);
      const updated = await patchRes.json();
      assert.equal(updated.data.permissions.length, 2);

      const delRes = await fetch(`${baseUrl}/admin/enterprise/roles/${created.data.id}`, {
        method: 'DELETE',
        headers: adminHeaders(),
      });
      assert.equal(delRes.status, 200);
    });

    test('4. Creating a duplicate role returns 409', async () => {
      const res = await fetch(`${baseUrl}/admin/enterprise/roles`, {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'admin', permissions: [] }),
      });
      assert.equal(res.status, 409);
    });
  });

  describe('Badges', () => {
    test('5. Admin can create, list, update, and delete a badge', async () => {
      const suffix = uniqueSuffix();
      const name = `TEST_ENT_BADGE_${suffix}`;
      const createRes = await fetch(`${baseUrl}/admin/enterprise/badges`, {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, criteriaType: 'xp_threshold', criteriaValue: 100 }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();

      const listRes = await fetch(`${baseUrl}/admin/enterprise/badges?search=${name}`, { headers: adminHeaders() });
      assert.equal(listRes.status, 200);
      const list = await listRes.json();
      assert.equal(list.data.badges.length, 1);

      const patchRes = await fetch(`${baseUrl}/admin/enterprise/badges/${created.data.id}`, {
        method: 'PATCH',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ criteriaValue: 250 }),
      });
      assert.equal(patchRes.status, 200);

      const delRes = await fetch(`${baseUrl}/admin/enterprise/badges/${created.data.id}`, {
        method: 'DELETE',
        headers: adminHeaders(),
      });
      assert.equal(delRes.status, 200);
    });
  });

  describe('Journeys', () => {
    test('6. Admin can create a journey with steps, update, and delete it', async () => {
      const suffix = uniqueSuffix();
      const createRes = await fetch(`${baseUrl}/admin/enterprise/journeys`, {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: `test-ent-${suffix}`,
          title: `Test Journey ${suffix}`,
          xpReward: 50,
          steps: [{ stepNumber: 1, title: 'Step One', content: 'Content', xpReward: 10 }],
        }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();

      const getRes = await fetch(`${baseUrl}/admin/enterprise/journeys/${created.data.id}`, { headers: adminHeaders() });
      assert.equal(getRes.status, 200);
      const detail = await getRes.json();
      assert.equal(detail.data.steps.length, 1);

      const patchRes = await fetch(`${baseUrl}/admin/enterprise/journeys/${created.data.id}`, {
        method: 'PATCH',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      });
      assert.equal(patchRes.status, 200);

      const delRes = await fetch(`${baseUrl}/admin/enterprise/journeys/${created.data.id}`, {
        method: 'DELETE',
        headers: adminHeaders(),
      });
      assert.equal(delRes.status, 200);
    });

    test('7. Duplicate journey slug returns 409', async () => {
      const suffix = uniqueSuffix();
      const slug = `test-ent-dup-${suffix}`;
      const payload = JSON.stringify({ slug, title: `Dup ${suffix}` });
      const headers = { ...adminHeaders(), 'Content-Type': 'application/json' };
      await fetch(`${baseUrl}/admin/enterprise/journeys`, { method: 'POST', headers, body: payload });
      const res = await fetch(`${baseUrl}/admin/enterprise/journeys`, { method: 'POST', headers, body: payload });
      assert.equal(res.status, 409);
    });
  });

  describe('Notifications', () => {
    test('8. Admin can send a notification to a user and it appears in their feed', async () => {
      const createRes = await fetch(`${baseUrl}/admin/enterprise/notifications`, {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'INFO', title: 'Test Notice', message: 'Hello', userId: USER_TOKEN_SUB }),
      });
      assert.equal(createRes.status, 201);

      const feedRes = await fetch(`${baseUrl}/notifications`, { headers: userHeaders() });
      assert.equal(feedRes.status, 200);
      const feed = await feedRes.json();
      assert.ok(feed.data.notifications.some((n: { title: string }) => n.title === 'Test Notice'));
    });

    test('9. User can mark a notification as read and see unread count', async () => {
      const createRes = await fetch(`${baseUrl}/admin/enterprise/notifications`, {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'WARNING', title: 'Read Me', message: 'Body', userId: USER_TOKEN_SUB }),
      });
      const created = await createRes.json();

      const countRes = await fetch(`${baseUrl}/notifications/unread-count`, { headers: userHeaders() });
      const count = await countRes.json();
      assert.ok(count.data.unread >= 1);

      const readRes = await fetch(`${baseUrl}/notifications/${created.data.notification.id}/read`, {
        method: 'PATCH',
        headers: userHeaders(),
      });
      assert.equal(readRes.status, 200);

      const countAfter = await fetch(`${baseUrl}/notifications/unread-count`, { headers: userHeaders() });
      const countBody = await countAfter.json();
      assert.equal(countBody.data.unread, 0);
    });

    test('10. User cannot read another user notification via path param', async () => {
      const createRes = await fetch(`${baseUrl}/admin/enterprise/notifications`, {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ERROR', title: 'Private', message: 'Body', userId: ADMIN_USER_ID }),
      });
      const created = await createRes.json();

      const res = await fetch(`${baseUrl}/notifications/${created.data.notification.id}/read`, {
        method: 'PATCH',
        headers: userHeaders(),
      });
      assert.equal(res.status, 404);
    });
  });

  describe('Overview, transactions, trips, conversations', () => {
    test('11. Overview endpoint returns aggregated KPIs', async () => {
      const res = await fetch(`${baseUrl}/admin/enterprise/overview`, { headers: adminHeaders() });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.data.users.total >= 2);
      assert.ok(typeof body.data.payments.totalRevenue === 'number');
      assert.ok(typeof body.data.content.badges === 'number');
    });

    test('12. Transactions list and statistics endpoints work', async () => {
      const listRes = await fetch(`${baseUrl}/admin/enterprise/transactions?page=1&limit=10`, { headers: adminHeaders() });
      assert.equal(listRes.status, 200);
      const list = await listRes.json();
      assert.ok(Array.isArray(list.data.transactions));

      const statsRes = await fetch(`${baseUrl}/admin/enterprise/transactions/statistics`, { headers: adminHeaders() });
      assert.equal(statsRes.status, 200);
      const stats = await statsRes.json();
      assert.ok(typeof stats.data.totalTransactions === 'number');
    });

    test('13. Trips and conversations list endpoints work', async () => {
      const tripsRes = await fetch(`${baseUrl}/admin/enterprise/trips`, { headers: adminHeaders() });
      assert.equal(tripsRes.status, 200);

      const convRes = await fetch(`${baseUrl}/admin/enterprise/conversations`, { headers: adminHeaders() });
      assert.equal(convRes.status, 200);
    });

    test('14. Audit logs endpoint supports filters', async () => {
      const res = await fetch(`${baseUrl}/admin/enterprise/audit-logs?page=1&limit=5&action=role`, {
        headers: adminHeaders(),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.data.logs));
    });
  });
});
