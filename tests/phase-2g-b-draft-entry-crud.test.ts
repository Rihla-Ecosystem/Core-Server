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
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { signAccessToken } from '../src/utils/token.js';
import { ensureAdminRole, ensureUserRole } from './helpers/test-role-fixtures.js';
import { Gender } from '@prisma/client';

const VERSION_PREFIX = '2gb-crud-';

const ADMIN_USER_ID = 'ccccccc1-1111-4111-8111-111111111111';
const ADMIN_TOKEN = signAccessToken({ sub: ADMIN_USER_ID, role: 'admin' });

const AUDIT_ACTIONS = [
  'rate_card_entry_created',
  'rate_card_entry_updated',
  'rate_card_entry_deleted',
];

function version(): string {
  return `${VERSION_PREFIX}${crypto.randomUUID()}`;
}

function entryBody(model: string): Record<string, unknown> {
  return {
    provider: 'google',
    model,
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: '1500000',
      outputMicrosPerMillion: '7500000',
      cachedInputMicrosPerMillion: '150000',
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://example.test/pricing',
    verifiedAt: '2026-08-03',
  };
}

describe('Phase 2G-B Draft Rate Card Entry CRUD', () => {
  let server: Server;
  let baseUrl: string;

  async function cleanupRateCardData(): Promise<void> {
    const snapshots = await prisma.providerRateCardSnapshot.findMany({
      where: { version: { startsWith: VERSION_PREFIX } },
      select: { id: true },
    });
    const ids = snapshots.map((s) => s.id);
    if (ids.length) {
      await prisma.providerRateCardEntry.deleteMany({ where: { snapshotId: { in: ids } } });
      await prisma.providerRateCardSnapshot.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.auditLog.deleteMany({
      where: { actorId: ADMIN_USER_ID, action: { in: AUDIT_ACTIONS } },
    });
  }

  async function cleanupAdmin(): Promise<void> {
    await prisma.user.deleteMany({ where: { id: ADMIN_USER_ID } });
  }

  async function request(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body: json };
  }

  async function createDraft(v: string): Promise<void> {
    const res = await request('POST', '/api/admin/rate-cards/drafts', ADMIN_TOKEN, {
      version: v,
      source: 's',
      generatedAt: '2026-08-03',
    });
    assert.equal(res.status, 201);
  }

  async function publish(v: string): Promise<void> {
    const res = await request('POST', `/api/admin/rate-cards/${v}/publish`, ADMIN_TOKEN, {
      effectiveFrom: '2026-08-03',
    });
    assert.equal(res.status, 200);
  }

  before(async () => {
    await cleanupRateCardData();
    await cleanupAdmin();
    const adminRole = await ensureAdminRole();
    await prisma.user.create({
      data: {
        id: ADMIN_USER_ID,
        email: 'test_2gb_crud_admin@example.com',
        passwordHash: 'hash',
        displayName: 'Phase 2G-B CRUD Admin',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: adminRole.id,
        isEmailVerified: true,
      },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    await cleanupRateCardData();
  });

  after(async () => {
    try {
      await cleanupRateCardData();
    } finally {
      try {
        await cleanupAdmin();
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        await prisma.$disconnect();
      }
    }
  });

  test('1. POST entry creates a single entry (201, entryCount 1)', async () => {
    const v = version();
    await createDraft(v);
    const model = `gemini-${crypto.randomUUID().slice(0, 8)}`;
    const res = await request(
      'POST',
      `/api/admin/rate-cards/drafts/${v}/entries`,
      ADMIN_TOKEN,
      entryBody(model),
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    const data = res.body.data as { status: string; entryCount: number };
    assert.equal(data.status, 'DRAFT');
    assert.equal(data.entryCount, 1);

    const rows = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'google');
    assert.equal(rows[0].model, model);
    assert.equal(rows[0].inputMicrosPerMillion, 1_500_000n, 'money string persists as exact bigint');
  });

  test('2. POST entry with a duplicate (provider, model, tier) identity -> 400 DUPLICATE_IDENTITY', async () => {
    const v = version();
    await createDraft(v);
    const model = `dup-${crypto.randomUUID().slice(0, 8)}`;
    const first = await request(
      'POST',
      `/api/admin/rate-cards/drafts/${v}/entries`,
      ADMIN_TOKEN,
      entryBody(model),
    );
    assert.equal(first.status, 201);
    const second = await request(
      'POST',
      `/api/admin/rate-cards/drafts/${v}/entries`,
      ADMIN_TOKEN,
      entryBody(model),
    );
    assert.equal(second.status, 400);
    assert.equal(second.body.code, 'RATE_CARD_ADMIN_DUPLICATE_IDENTITY');
  });

  test('3. POST entry on a published snapshot -> 409 IMMUTABLE', async () => {
    const v = version();
    await createDraft(v);
    await request('POST', `/api/admin/rate-cards/drafts/${v}/import`, ADMIN_TOKEN, {
      source: 's',
      generatedAt: '2026-08-03',
      entries: [entryBody(`pre-${crypto.randomUUID().slice(0, 8)}`)],
    });
    await publish(v);
    const res = await request(
      'POST',
      `/api/admin/rate-cards/drafts/${v}/entries`,
      ADMIN_TOKEN,
      entryBody(`post-${crypto.randomUUID().slice(0, 8)}`),
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'RATE_CARD_ADMIN_IMMUTABLE');
  });

  test('4. POST entry with an unknown key -> 400 Validation error (strict schema)', async () => {
    const v = version();
    await createDraft(v);
    const res = await request(
      'POST',
      `/api/admin/rate-cards/drafts/${v}/entries`,
      ADMIN_TOKEN,
      { ...entryBody('strict-model'), unexpectedKey: true },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Validation error');
  });

  test('5. POST entry with JSON numeric money -> 400 Validation error', async () => {
    const v = version();
    await createDraft(v);
    const res = await request(
      'POST',
      `/api/admin/rate-cards/drafts/${v}/entries`,
      ADMIN_TOKEN,
      {
        ...entryBody('money-number'),
        tokenRates: { inputMicrosPerMillion: 1_500_000, outputMicrosPerMillion: '7500000' },
      },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Validation error');
  });

  test('6. PATCH entry updates a single field and re-validates the merged entry', async () => {
    const v = version();
    await createDraft(v);
    const model = `patch-${crypto.randomUUID().slice(0, 8)}`;
    await request('POST', `/api/admin/rate-cards/drafts/${v}/entries`, ADMIN_TOKEN, entryBody(model));

    const rows = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    const entryId = rows[0].id;

    const res = await request(
      'PATCH',
      `/api/admin/rate-cards/drafts/${v}/entries/${entryId}`,
      ADMIN_TOKEN,
      { tokenRates: { inputMicrosPerMillion: '9999999' } },
    );
    assert.equal(res.status, 200);

    const updated = await prisma.providerRateCardEntry.findUnique({ where: { id: entryId } });
    assert.equal(updated?.inputMicrosPerMillion, 9_999_999n);
    assert.equal(updated?.outputMicrosPerMillion, 7_500_000n, 'omitted sub-object fields are preserved');
    assert.equal(updated?.provider, 'google', 'unpatched scalars are preserved');
  });

  test('7. PATCH entry onto another identity -> 400 DUPLICATE_IDENTITY', async () => {
    const v = version();
    await createDraft(v);
    const modelA = `a-${crypto.randomUUID().slice(0, 8)}`;
    const modelB = `b-${crypto.randomUUID().slice(0, 8)}`;
    await request('POST', `/api/admin/rate-cards/drafts/${v}/entries`, ADMIN_TOKEN, entryBody(modelA));
    await request('POST', `/api/admin/rate-cards/drafts/${v}/entries`, ADMIN_TOKEN, entryBody(modelB));

    const rows = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    const entryA = rows.find((r) => r.model === modelA)!;

    const res = await request(
      'PATCH',
      `/api/admin/rate-cards/drafts/${v}/entries/${entryA.id}`,
      ADMIN_TOKEN,
      { model: modelB },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'RATE_CARD_ADMIN_DUPLICATE_IDENTITY');
  });

  test('8. PATCH entry with an empty body -> 400 Validation error', async () => {
    const v = version();
    await createDraft(v);
    const model = `empty-${crypto.randomUUID().slice(0, 8)}`;
    await request('POST', `/api/admin/rate-cards/drafts/${v}/entries`, ADMIN_TOKEN, entryBody(model));
    const rows = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    const res = await request(
      'PATCH',
      `/api/admin/rate-cards/drafts/${v}/entries/${rows[0].id}`,
      ADMIN_TOKEN,
      {},
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Validation error');
  });

  test('9. PATCH entry on a published snapshot -> 409 IMMUTABLE', async () => {
    const v = version();
    await createDraft(v);
    const model = `imm-${crypto.randomUUID().slice(0, 8)}`;
    await request('POST', `/api/admin/rate-cards/drafts/${v}/entries`, ADMIN_TOKEN, entryBody(model));
    await publish(v);
    const rows = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    const res = await request(
      'PATCH',
      `/api/admin/rate-cards/drafts/${v}/entries/${rows[0].id}`,
      ADMIN_TOKEN,
      { inactive: true },
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'RATE_CARD_ADMIN_IMMUTABLE');
  });

  test('10. DELETE entry removes it (200, entryCount 0)', async () => {
    const v = version();
    await createDraft(v);
    const model = `del-${crypto.randomUUID().slice(0, 8)}`;
    await request('POST', `/api/admin/rate-cards/drafts/${v}/entries`, ADMIN_TOKEN, entryBody(model));
    const rows = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    const res = await request(
      'DELETE',
      `/api/admin/rate-cards/drafts/${v}/entries/${rows[0].id}`,
      ADMIN_TOKEN,
    );
    assert.equal(res.status, 200);
    assert.equal((res.body.data as { entryCount: number }).entryCount, 0);

    const remaining = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    assert.equal(remaining.length, 0);
  });

  test('11. DELETE entry on a published snapshot -> 409 IMMUTABLE', async () => {
    const v = version();
    await createDraft(v);
    const model = `delimm-${crypto.randomUUID().slice(0, 8)}`;
    await request('POST', `/api/admin/rate-cards/drafts/${v}/entries`, ADMIN_TOKEN, entryBody(model));
    await publish(v);
    const rows = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    const res = await request(
      'DELETE',
      `/api/admin/rate-cards/drafts/${v}/entries/${rows[0].id}`,
      ADMIN_TOKEN,
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'RATE_CARD_ADMIN_IMMUTABLE');
  });

  test('12. PATCH/DELETE a missing entryId -> 404 ENTRY_NOT_FOUND', async () => {
    const v = version();
    await createDraft(v);
    const missing = crypto.randomUUID();
    const patch = await request(
      'PATCH',
      `/api/admin/rate-cards/drafts/${v}/entries/${missing}`,
      ADMIN_TOKEN,
      { inactive: true },
    );
    assert.equal(patch.status, 404);
    assert.equal(patch.body.code, 'RATE_CARD_ADMIN_ENTRY_NOT_FOUND');

    const del = await request(
      'DELETE',
      `/api/admin/rate-cards/drafts/${v}/entries/${missing}`,
      ADMIN_TOKEN,
    );
    assert.equal(del.status, 404);
    assert.equal(del.body.code, 'RATE_CARD_ADMIN_ENTRY_NOT_FOUND');
  });

  test('13. entry CRUD writes audit evidence with the admin actor', async () => {
    const v = version();
    await createDraft(v);
    const model = `audit-${crypto.randomUUID().slice(0, 8)}`;
    await request('POST', `/api/admin/rate-cards/drafts/${v}/entries`, ADMIN_TOKEN, entryBody(model));
    const rows = await prisma.providerRateCardEntry.findMany({
      where: { snapshot: { version: v } },
    });
    await request(
      'PATCH',
      `/api/admin/rate-cards/drafts/${v}/entries/${rows[0].id}`,
      ADMIN_TOKEN,
      { inactive: true },
    );
    await request('DELETE', `/api/admin/rate-cards/drafts/${v}/entries/${rows[0].id}`, ADMIN_TOKEN);

    const logs = await prisma.auditLog.findMany({
      where: { actorId: ADMIN_USER_ID, action: { in: AUDIT_ACTIONS } },
    });
    assert.ok(logs.some((l) => l.action === 'rate_card_entry_created'));
    assert.ok(logs.some((l) => l.action === 'rate_card_entry_updated'));
    assert.ok(logs.some((l) => l.action === 'rate_card_entry_deleted'));
  });
});
