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
import {
  Gender,
  TokenReservationStatus,
  TokenTransactionSource,
  TokenTransactionType,
  WalletStatus,
} from '@prisma/client';

const ADMIN_USER_ID = 'bbbbbbb1-1111-4111-8111-111111111111';
const EMAIL_PREFIX = 'test_2gb_admin_wallet_';

const ADMIN_TOKEN = signAccessToken({ sub: ADMIN_USER_ID, role: 'admin' });
const USER_TOKEN = signAccessToken({ sub: crypto.randomUUID(), role: 'user' });

let USER_ROLE_ID: number;
let baseUrl = '';

describe('Phase 2G-B Admin Wallet + Recovery Queue API', () => {
  let server: Server;

  async function cleanupSuiteData(): Promise<void> {
    const emailFilter = { email: { startsWith: EMAIL_PREFIX } };
    const users = await prisma.user.findMany({ where: emailFilter, select: { id: true } });
    const userIds = users.map((u) => u.id);
    if (userIds.length) {
      await prisma.tokenReservation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
      await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    }
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorId: ADMIN_USER_ID },
          { actor: emailFilter },
          { target: emailFilter },
        ],
      },
    });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function createTargetUser(): Promise<{ id: string; email: string }> {
    return prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `${EMAIL_PREFIX}${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Phase 2G-B Wallet User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
      select: { id: true, email: true },
    });
  }

  async function createWallet(userId: string): Promise<string> {
    const wallet = await prisma.tokenWallet.create({
      data: { userId, tokenBalance: 1000, status: WalletStatus.ACTIVE },
    });
    return wallet.id;
  }

  function validReservationMetadata(tokens: number): unknown {
    return {
      aiBilling: {
        schemaVersion: 1,
        requestedMode: 'PROVIDER_USAGE',
        quoteAppliedMode: 'PROVIDER_USAGE',
        quotedTokens: tokens,
        fixedFallbackTokens: tokens,
        maxInputTokens: 12000,
        maxOutputTokens: 1200,
        provider: 'fake-provider',
        model: 'fake-model',
        rateCardVersion: 'rate-v1',
        walletPolicyVersion: 'policy-v1',
      },
    };
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

  before(async () => {
    await cleanupSuiteData();
    const adminRole = await ensureAdminRole();
    const userRole = await ensureUserRole();
    USER_ROLE_ID = userRole.id;
    await prisma.user.create({
      data: {
        id: ADMIN_USER_ID,
        email: 'phase_2gb_admin_wallet_admin@example.com',
        passwordHash: 'hash',
        displayName: 'Phase 2G-B Admin',
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
    await cleanupSuiteData();
  });

  after(async () => {
    try {
      await cleanupSuiteData();
      await prisma.user.deleteMany({ where: { id: ADMIN_USER_ID } });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await prisma.$disconnect();
    }
  });

  test('1. transactions endpoint accepts the ITINERARY source filter (Phase 2G-B gap)', async () => {
    const user = await createTargetUser();
    const walletId = await createWallet(user.id);
    await prisma.tokenTransaction.create({
      data: {
        walletId,
        userId: user.id,
        type: TokenTransactionType.CONSUME,
        tokens: 3,
        source: TokenTransactionSource.ITINERARY,
        referenceId: `itinerary:${crypto.randomUUID()}`,
      },
    });

    const res = await request(
      'GET',
      `/api/admin/token-wallets/${user.id}/transactions?source=ITINERARY`,
      ADMIN_TOKEN,
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const data = res.body.data as {
      items: Array<{ source: string; tokens: number }>;
      pagination: { total: number };
    };
    assert.equal(data.pagination.total, 1);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].source, 'ITINERARY');
    assert.equal(data.items[0].tokens, 3);
  });

  test('2. bonus returns previousBalance + newBalance and idempotent replay never double-credits', async () => {
    const user = await createTargetUser();
    await createWallet(user.id);
    const key = crypto.randomUUID();
    const body = {
      tokens: 50,
      reason: 'Phase 2G-B bonus test',
      idempotencyKey: key,
    };

    const first = await request(
      'POST',
      `/api/admin/token-wallets/${user.id}/bonus`,
      ADMIN_TOKEN,
      body,
    );
    assert.equal(first.status, 201);
    const firstData = first.body.data as {
      previousBalance: number;
      newBalance: number;
      idempotentReplay: boolean;
    };
    assert.equal(firstData.previousBalance, 1000);
    assert.equal(firstData.newBalance, 1050);
    assert.equal(firstData.idempotentReplay, false);

    const replay = await request(
      'POST',
      `/api/admin/token-wallets/${user.id}/bonus`,
      ADMIN_TOKEN,
      body,
    );
    assert.equal(replay.status, 200);
    const replayData = replay.body.data as {
      previousBalance: number;
      newBalance: number;
      idempotentReplay: boolean;
    };
    assert.equal(replayData.idempotentReplay, true);
    assert.equal(replayData.newBalance, 1050);

    const wallet = await prisma.tokenWallet.findUnique({ where: { userId: user.id } });
    assert.equal(wallet?.tokenBalance, 1050, 'replay must not double-credit');
  });

  test('3. recovery queue lists PENDING reservations with classification and aggregate', async () => {
    const user = await createTargetUser();
    const walletId = await createWallet(user.id);

    await prisma.tokenReservation.create({
      data: {
        walletId,
        userId: user.id,
        feature: 'AI_CHAT_QUERY',
        source: TokenTransactionSource.CHAT,
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
        referenceId: `res:valid:${crypto.randomUUID()}`,
        status: TokenReservationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
        metadata: validReservationMetadata(2),
      },
    });
    await prisma.tokenReservation.create({
      data: {
        walletId,
        userId: user.id,
        feature: 'AI_IMAGE_ANALYSIS',
        source: TokenTransactionSource.IMAGE,
        tokens: 5,
        idempotencyKey: crypto.randomUUID(),
        referenceId: `res:missing:${crypto.randomUUID()}`,
        status: TokenReservationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
        metadata: null,
      },
    });
    await prisma.tokenReservation.create({
      data: {
        walletId,
        userId: user.id,
        feature: 'AI_TRIP_ITINERARY',
        source: TokenTransactionSource.ITINERARY,
        tokens: 10,
        idempotencyKey: crypto.randomUUID(),
        referenceId: `res:expired:${crypto.randomUUID()}`,
        status: TokenReservationStatus.PENDING,
        expiresAt: new Date(Date.now() - 60_000),
        metadata: validReservationMetadata(10),
      },
    });
    await prisma.tokenReservation.create({
      data: {
        walletId,
        userId: user.id,
        feature: 'AI_CHAT_QUERY',
        source: TokenTransactionSource.CHAT,
        tokens: 1,
        idempotencyKey: crypto.randomUUID(),
        referenceId: `res:settled:${crypto.randomUUID()}`,
        status: TokenReservationStatus.COMPLETED,
        expiresAt: new Date(Date.now() + 60_000),
        settledAt: new Date(),
        metadata: validReservationMetadata(1),
      },
    });

    const res = await request('GET', '/api/admin/billing-recovery/queue', ADMIN_TOKEN);
    assert.equal(res.status, 200);
    const data = res.body.data as {
      items: Array<{
        feature: string;
        reservationStatus: string;
        metadataStatus: string;
        reasonCode: string;
        isExpired: boolean;
      }>;
      pagination: { total: number };
      aggregate: { count: number; totalTokens: number };
    };
    assert.equal(data.pagination.total, 4, 'queue lists all reservations regardless of status');
    assert.equal(data.aggregate.count, 4);
    assert.equal(data.aggregate.totalTokens, 18);

    const byFeature = new Map(data.items.map((i) => [i.feature, i]));
    const chat = byFeature.get('AI_CHAT_QUERY')!;
    assert.equal(chat.reservationStatus, 'PENDING');
    assert.equal(chat.metadataStatus, 'VALID');
    assert.equal(chat.reasonCode, 'PENDING_REVIEW');
    assert.equal(chat.isExpired, false);

    const image = byFeature.get('AI_IMAGE_ANALYSIS')!;
    assert.equal(image.metadataStatus, 'MISSING');
    assert.equal(image.reasonCode, 'METADATA_MISSING');

    const itinerary = byFeature.get('AI_TRIP_ITINERARY')!;
    assert.equal(itinerary.reasonCode, 'PENDING_REVIEW');
    assert.equal(itinerary.isExpired, true);

    const settled = data.items.find((i) => i.feature === 'AI_CHAT_QUERY' && i.reservationStatus === 'COMPLETED')!;
    assert.equal(settled.reasonCode, 'RESOLVED');
  });

  test('4. recovery queue status filter narrows the listing', async () => {
    const user = await createTargetUser();
    const walletId = await createWallet(user.id);
    await prisma.tokenReservation.create({
      data: {
        walletId,
        userId: user.id,
        feature: 'AI_CHAT_QUERY',
        source: TokenTransactionSource.CHAT,
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
        referenceId: `res:pending:${crypto.randomUUID()}`,
        status: TokenReservationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
        metadata: validReservationMetadata(2),
      },
    });
    await prisma.tokenReservation.create({
      data: {
        walletId,
        userId: user.id,
        feature: 'AI_CHAT_QUERY',
        source: TokenTransactionSource.CHAT,
        tokens: 3,
        idempotencyKey: crypto.randomUUID(),
        referenceId: `res:released:${crypto.randomUUID()}`,
        status: TokenReservationStatus.RELEASED,
        expiresAt: new Date(Date.now() + 60_000),
        releasedAt: new Date(),
        metadata: validReservationMetadata(3),
      },
    });

    const res = await request('GET', '/api/admin/billing-recovery/queue?status=PENDING', ADMIN_TOKEN);
    assert.equal(res.status, 200);
    const data = res.body.data as {
      items: Array<{ reservationStatus: string }>;
      pagination: { total: number };
      aggregate: { count: number; totalTokens: number };
    };
    assert.equal(data.pagination.total, 1);
    assert.equal(data.items[0].reservationStatus, 'PENDING');
    assert.equal(data.aggregate.count, 1);
    assert.equal(data.aggregate.totalTokens, 2);
  });

  test('5. recovery queue validates its query schema (unknown/out-of-range rejected)', async () => {
    const bad = await request('GET', '/api/admin/billing-recovery/queue?limit=101', ADMIN_TOKEN);
    assert.equal(bad.status, 400);

    const unknown = await request('GET', '/api/admin/billing-recovery/queue?bogus=1', ADMIN_TOKEN);
    assert.equal(unknown.status, 400);
  });

  test('6. recovery queue requires auth + admin role', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/admin/billing-recovery/queue`);
    assert.equal(unauthenticated.status, 401);

    const nonAdmin = await request('GET', '/api/admin/billing-recovery/queue', USER_TOKEN);
    assert.equal(nonAdmin.status, 403);
  });
});
