{
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Safety check failed: DATABASE_URL is not set');
  const parsed = new URL(dbUrl);
  if (parsed.pathname !== '/core_server_test' && parsed.pathname !== '/core_server_test_suite') {
    throw new Error(
      `Safety check failed: DATABASE_URL must point to /core_server_test or /core_server_test_suite, got "${parsed.pathname}"`,
    );
  }
}

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { signAccessToken } from '../src/utils/token.js';
import { ensureAdminRole, ensureUserRole } from './helpers/test-role-fixtures.js';
import { Gender, TokenTransactionSource, WalletStatus } from '@prisma/client';
import { reserveBusinessTokensForAmount } from '../src/services/token-reservation.service.js';
import type { AdminBillingRecoveryActionBody } from '../src/schemas/admin-billing-recovery.schema.js';

const ADMIN_USER_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_PREFIX = 'recovery-http-';

const ADMIN_TOKEN = signAccessToken({ sub: ADMIN_USER_ID, role: 'admin' });

function version(): string {
  return `${VERSION_PREFIX}${crypto.randomUUID()}`;
}

function adminHeaders(): HeadersInit {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

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
}

describe('Admin Billing Recovery HTTP (AI Billing Recovery)', () => {
  let server: Server;
  let baseUrl: string;
  let targetUserId: string;
  let USER_ROLE_ID: number;

  before(async () => {
    USER_ROLE_ID = (await ensureUserRole()).id;
    const adminRole = await ensureAdminRole();
    await prisma.user.create({
      data: {
        id: ADMIN_USER_ID,
        email: 'test_recovery_http_admin@example.com',
        passwordHash: 'hash',
        displayName: 'Admin Recovery HTTP User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: adminRole.id,
        isEmailVerified: true,
      },
    });
    targetUserId = '66666666-6666-4666-8666-666666666666';
    await prisma.user.create({
      data: {
        id: targetUserId,
        email: 'test_recovery_http_target@example.com',
        passwordHash: 'hash',
        displayName: 'Recovery HTTP Target',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: USER_ROLE_ID,
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

  after(async () => {
    try {
      await cleanupRateCardData();
      await prisma.tokenReservationFundingAllocation.deleteMany({
        where: { reservation: { userId: targetUserId } },
      });
      await prisma.tokenFundingLot.deleteMany({ where: { userId: targetUserId } });
      await prisma.aIBillingOperation.deleteMany({ where: { userId: targetUserId } });
      await prisma.tokenReservation.deleteMany({ where: { userId: targetUserId } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: targetUserId } });
      await prisma.tokenWallet.deleteMany({ where: { userId: targetUserId } });
      await prisma.user.deleteMany({ where: { id: { in: [ADMIN_USER_ID, targetUserId] } } });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  async function createTargetWallet(balance: number): Promise<{ walletId: string }> {
    const wallet = await prisma.tokenWallet.create({
      data: {
        userId: targetUserId,
        tokenBalance: balance,
        reservedBalance: 0,
        status: WalletStatus.ACTIVE,
      },
    });
    if (balance > 0) {
      const grant = await prisma.tokenTransaction.create({
        data: {
          walletId: wallet.id,
          userId: targetUserId,
          type: 'GRANT',
          tokens: balance,
          source: TokenTransactionSource.PURCHASE,
          referenceId: `test-grant-${crypto.randomUUID()}`,
        },
      });
      await prisma.tokenFundingLot.create({
        data: {
          walletId: wallet.id,
          userId: targetUserId,
          source: TokenTransactionSource.PURCHASE,
          sourceTransactionId: grant.id,
          originalTokens: balance,
          availableTokens: balance,
          reservedTokens: 0,
          consumedTokens: 0,
        },
      });
    }
    return { walletId: wallet.id };
  }

  async function reserveFixture(
    walletId: string,
    tokens: number,
    extraMetadata: Record<string, unknown> = {},
    rateCardVersion = version(),
  ): Promise<{ reservationId: string; referenceId: string }> {
    const reserved = await reserveBusinessTokensForAmount({
      userId: targetUserId,
      feature: 'AI_CHAT_QUERY',
      source: 'CHAT',
      tokens,
      idempotencyKey: crypto.randomUUID(),
      metadata: {
        aiBilling: {
          schemaVersion: 1,
          requestedMode: 'USAGE_BASED',
          feature: 'AI_CHAT_QUERY',
          reservationTokens: tokens,
          maxInputTokens: 12000,
          maxOutputTokens: 1200,
          rateCardVersion,
          walletPolicyVersion: '1',
          walletPolicySnapshot: {
            walletTokenValueNanoUsd: 100000,
            markupBasisPoints: 10000,
            minimumWalletTokens: 1,
          },
        },
        ...extraMetadata,
      },
    });
    await prisma.aIBillingOperation.create({
      data: {
        operationId: crypto.randomUUID(),
        reservationId: reserved.reservationId,
        walletId,
        userId: targetUserId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        status: 'REVIEW_REQUIRED',
        reservedTokens: tokens,
        reservationPricingVersion: 1,
        rateCardVersion,
        walletPolicyVersion: '1',
      },
    });
    return { reservationId: reserved.reservationId, referenceId: reserved.referenceId };
  }

  async function seedGeminiSnapshot(rateCardVersion: string): Promise<void> {
    await prisma.providerRateCardSnapshot.create({
      data: {
        version: rateCardVersion,
        status: 'ACTIVE',
        source: 'https://example.test/pricing',
        generatedAt: new Date('2026-08-10'),
        effectiveFrom: new Date('2025-01-01'),
        publishedAt: new Date('2026-08-10'),
        entries: {
          create: [
            {
              provider: 'google',
              model: 'gemini-3.6-flash',
              status: 'STABLE',
              tier: 'STANDARD',
              billingUnit: 'TOKEN',
              inputMicrosPerMillion: 1_500_000n,
              outputMicrosPerMillion: 7_500_000n,
              cachedInputMicrosPerMillion: 150_000n,
              cachedInputAccounting: 'DISJOINT',
              effectiveFrom: new Date('2025-01-01'),
              inactive: false,
            },
          ],
        },
      },
    });
  }

  async function resetTargetUser(): Promise<void> {
    await prisma.tokenReservationFundingAllocation.deleteMany({
      where: { reservation: { userId: targetUserId } },
    });
    await prisma.tokenFundingLot.deleteMany({ where: { userId: targetUserId } });
    await prisma.aIBillingOperation.deleteMany({ where: { userId: targetUserId } });
    await prisma.tokenReservation.deleteMany({ where: { userId: targetUserId } });
    await prisma.tokenTransaction.deleteMany({ where: { userId: targetUserId } });
    await prisma.tokenWallet.deleteMany({ where: { userId: targetUserId } });
  }

  async function recoverViaHttp(
    reservationId: string,
    body: AdminBillingRecoveryActionBody,
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/admin/billing-recovery/${reservationId}/action`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('HTTP 1. Reservation not found surfaces HTTP 404 with semantic code', async () => {
    const missingId = crypto.randomUUID();
    const res = await recoverViaHttp(missingId, {
      type: 'REVIEW',
      reason: 'not found probe',
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'RESERVATION_NOT_FOUND');
    assert.equal(body.reservationId, missingId);
    assert.equal(body.recoveryRequired, true);
  });

  test('HTTP 2. Invalid action body surfaces HTTP 400 (schema validation)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/billing-recovery/${crypto.randomUUID()}/action`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'APPROVE_SYSTEM_RECOMMENDATION',
        confirmation: 'WRONG_CONFIRMATION',
        actualTokens: 5,
        reason: 'should be schema-rejected',
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Validation error');
  });

  test('HTTP 3. Integrity conflict surfaces semantic 409, NOT 500, with zero wallet mutation', async () => {
    await resetTargetUser();
    const { walletId } = await createTargetWallet(100);
    const { reservationId, referenceId } = await reserveFixture(walletId, 5);

    const releaseRes = await recoverViaHttp(reservationId, {
      type: 'MANUAL_RELEASE',
      confirmation: 'ADMIN_CONFIRMED_NON_BILLABLE',
      reason: 'release then attempt settle',
    });
    assert.equal(releaseRes.status, 200);
    const releaseBody = await releaseRes.json();
    assert.equal(releaseBody.data.outcome, 'RELEASED');

    const before = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
    assert.equal(before?.tokenBalance, 100);
    assert.equal(before?.reservedBalance, 0);

    const settleRes = await recoverViaHttp(reservationId, {
      type: 'MANUAL_SETTLE',
      confirmation: 'ADMIN_CONFIRMED_ACTUAL_TOKENS',
      actualTokens: 5,
      reason: 'settle on already released reservation',
    });
    assert.equal(settleRes.status, 409);
    const settleBody = await settleRes.json();
    assert.equal(settleBody.code, 'INTEGRITY_CONFLICT');

    const after = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
    assert.equal(after?.tokenBalance, 100);
    assert.equal(after?.reservedBalance, 0);

    const consumes = await prisma.tokenTransaction.findMany({
      where: { referenceId: `${referenceId}:settle`, type: 'CONSUME' },
    });
    assert.equal(consumes.length, 0);
  });

  test('HTTP 4. Authoritative approval returns HTTP 200 with correct settlement', async () => {
    await resetTargetUser();
    const rateCardVersion = version();
    await seedGeminiSnapshot(rateCardVersion);
    const { walletId } = await createTargetWallet(500);
    const chatEvidence = {
      kind: 'PRICED',
      reason: 'ACTUAL_MODEL',
      pricedAt: '2026-08-18',
      provider: 'google',
      rateCard: { tier: 'standard', model: 'gemini-3.6-flash', version: rateCardVersion, billingUnit: 'TOKEN' },
      operation: 'TEXT_CHAT',
      actualModel: 'gemini-3.6-flash',
      costNanoUsd: '9435000',
      usageApplied: { inputTokens: 2835, outputTokens: 691 },
      providerCallId: 'call-1',
      requestedModel: 'gemini-3.6-flash',
    };
    const { reservationId, referenceId } = await reserveFixture(
      walletId,
      225,
      { providerExecution: { providerCalls: [chatEvidence] } },
      rateCardVersion,
    );

    const inspectRes = await fetch(`${baseUrl}/api/admin/billing-recovery/${reservationId}`, {
      method: 'GET',
      headers: adminHeaders(),
    });
    assert.equal(inspectRes.status, 200);
    const inspectBody = await inspectRes.json();
    const rec = inspectBody.data.repricingRecommendation;
    assert.equal(rec.repricingStatus, 'AUTHORITATIVE_REPRICE_AVAILABLE');
    assert.equal(rec.recommendedActualWalletTokens, 94);
    assert.equal(rec.recommendedReturnedTokens, 131);

    const approveRes = await recoverViaHttp(reservationId, {
      type: 'APPROVE_SYSTEM_RECOMMENDATION',
      confirmation: 'APPROVE_SYSTEM_RECOMMENDATION',
      reason: 'approve server-calculated recommendation',
    });
    assert.equal(approveRes.status, 200);
    const approveBody = await approveRes.json();
    assert.equal(approveBody.data.outcome, 'SETTLED');
    assert.equal(approveBody.data.actualTokens, 94);
    assert.equal(approveBody.data.releasedTokens, 131);

    const reservationInDb = await prisma.tokenReservation.findUnique({
      where: { id: reservationId },
    });
    assert.equal(reservationInDb?.status, 'COMPLETED');
    assert.ok(reservationInDb?.settledAt);

    const consumes = await prisma.tokenTransaction.findMany({
      where: { referenceId: `${referenceId}:settle`, type: 'CONSUME' },
    });
    assert.equal(consumes.length, 1);
  });
});