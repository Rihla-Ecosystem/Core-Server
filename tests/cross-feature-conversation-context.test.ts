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
import { prisma } from '../src/config/prisma.js';
import { ensureUserRole } from './helpers/test-role-fixtures.js';
import { Gender } from '@prisma/client';
import {
  deriveDeterministicMessageId,
  validateConversationOwnership,
  persistAndMaterializeConversationContext,
  createConversationContextEvent,
  materializeConversationContextEvent,
  repairConversationContextEvent,
  formatCompactImageSummary,
} from '../src/utils/conversation-context.js';
import { buildChatContext } from '../src/utils/chat-context-builder.js';
import { identifyLandmarkWithTokens } from '../src/services/identify.service.js';

let USER_ROLE_ID: number;

describe('cross-feature-conversation-context', () => {
  before(async () => {
    const role = await ensureUserRole();
    USER_ROLE_ID = role.id;

    await prisma.providerRateCardEntry.deleteMany({});
    await prisma.providerRateCardSnapshot.deleteMany({});

    const snap = await prisma.providerRateCardSnapshot.create({
      data: {
        version: '1.0.0',
        source: 'STATIC_DEFAULTS',
        status: 'ACTIVE',
        effectiveFrom: new Date(Date.now() - 86400000),
        generatedAt: new Date(),
        publishedAt: new Date(),
      },
    });

    await prisma.providerRateCardEntry.createMany({
      data: [
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
        'gemini-3-flash-preview',
        'gemini-2.5-flash-lite',
      ].map(model => ({
        snapshotId: snap.id,
        provider: 'google',
        model,
        status: 'STABLE',
        tier: 'STANDARD',
        billingUnit: 'TOKEN',
        inputMicrosPerMillion: 1500000n,
        outputMicrosPerMillion: 6000000n,
        cachedInputMicrosPerMillion: 150000n,
        cachedInputAccounting: 'DISJOINT',
        inactive: false,
        effectiveFrom: new Date(Date.now() - 86400000),
      })),
    });
  });

  async function createTestUser(): Promise<string> {
    const id = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id,
        email: `ctx-test-${id.slice(0, 8)}@test.local`,
        passwordHash: 'test-hash',
        displayName: `Test User ${id.slice(0, 8)}`,
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: USER_ROLE_ID,
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: id, tokenBalance: 10000, status: 'ACTIVE' },
    });
    const tx = await prisma.tokenTransaction.create({
      data: {
        userId: id,
        walletId: wallet.id,
        type: 'GRANT',
        source: 'PURCHASE',
        tokens: 10000,
      },
    });
    await prisma.tokenFundingLot.create({
      data: {
        walletId: wallet.id,
        userId: id,
        sourceTransactionId: tx.id,
        source: 'PURCHASE',
        originalTokens: 10000,
        availableTokens: 10000,
      },
    });
    return id;
  }

  async function createTestConversation(userId: string): Promise<string> {
    const conv = await prisma.conversation.create({
      data: {
        userId,
        title: 'Test Tourist Session',
      },
    });
    return conv.id;
  }

  // ──────────────────────────────────────────────
  // 1. Message ID Identity
  // ──────────────────────────────────────────────
  describe('deriveDeterministicMessageId', () => {
    test('1. produces identical IDs for same inputs', () => {
      const brId = crypto.randomUUID();
      const convId = crypto.randomUUID();
      const id1 = deriveDeterministicMessageId(brId, 'user', convId);
      const id2 = deriveDeterministicMessageId(brId, 'user', convId);
      assert.equal(id1, id2);
    });

    test('2. produces different IDs for user vs assistant role', () => {
      const brId = crypto.randomUUID();
      const convId = crypto.randomUUID();
      const userId = deriveDeterministicMessageId(brId, 'user', convId);
      const assistantId = deriveDeterministicMessageId(brId, 'assistant', convId);
      assert.notEqual(userId, assistantId);
    });

    test('3. produces valid UUID v4 format', () => {
      const brId = crypto.randomUUID();
      const id = deriveDeterministicMessageId(brId, 'user');
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.ok(uuidRegex.test(id), `Expected valid UUID v4, got "${id}"`);
    });

    test('4. produces different IDs for different businessRequestIds', () => {
      const brId1 = crypto.randomUUID();
      const brId2 = crypto.randomUUID();
      const id1 = deriveDeterministicMessageId(brId1, 'user');
      const id2 = deriveDeterministicMessageId(brId2, 'user');
      assert.notEqual(id1, id2);
    });

    test('5. includes conversationId in seed when provided', () => {
      const brId = crypto.randomUUID();
      const convId1 = crypto.randomUUID();
      const convId2 = crypto.randomUUID();
      const id1 = deriveDeterministicMessageId(brId, 'user', convId1);
      const id2 = deriveDeterministicMessageId(brId, 'user', convId2);
      assert.notEqual(id1, id2);
    });
  });

  // ──────────────────────────────────────────────
  // 2. Ownership Validation
  // ──────────────────────────────────────────────
  describe('validateConversationOwnership', () => {
    test('6. returns undefined when conversationId is undefined', async () => {
      const userId = await createTestUser();
      const result = await validateConversationOwnership(userId, undefined);
      assert.equal(result, undefined);
    });

    test('7. returns conversation ID for valid ownership', async () => {
      const userId = await createTestUser();
      const convId = await createTestConversation(userId);
      const result = await validateConversationOwnership(userId, convId);
      assert.equal(result, convId);
    });

    test('8. throws 404 when conversation belongs to different user', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const convId = await createTestConversation(user1);

      await assert.rejects(
        async () => validateConversationOwnership(user2, convId),
        (err: any) => err.statusCode === 404 && err.message === 'Conversation not found',
      );
    });

    test('9. throws 404 for non-existent conversation', async () => {
      const userId = await createTestUser();
      const fakeConvId = crypto.randomUUID();

      await assert.rejects(
        async () => validateConversationOwnership(userId, fakeConvId),
        (err: any) => err.statusCode === 404 && err.message === 'Conversation not found',
      );
    });
  });

  // ──────────────────────────────────────────────
  // 3. Compact Formatters
  // ──────────────────────────────────────────────
  describe('compact context formatters', () => {
    test('10. formatCompactImageSummary produces semantic text under 350 chars', () => {
      const summary = formatCompactImageSummary(
        'Cairo Citadel',
        'Historical Landmark',
        'A massive medieval Islamic-era fortification in Cairo, Egypt, built by Saladin.',
      );
      assert.ok(summary.startsWith('[Identified: Cairo Citadel (Historical Landmark) —'));
      assert.ok(summary.length < 350);
    });
  });

  // ──────────────────────────────────────────────
  // 4. ConversationContextEvent & Materialization
  // ──────────────────────────────────────────────
  describe('persistAndMaterializeConversationContext', () => {
    test('12. persists ConversationContextEvent and materializes user and assistant messages', async () => {
      const userId = await createTestUser();
      const convId = await createTestConversation(userId);
      const brId = crypto.randomUUID();

      await persistAndMaterializeConversationContext({
        conversationId: convId,
        businessRequestId: brId,
        feature: 'AI_IMAGE_ANALYSIS',
        userContent: '[Image identification request]',
        assistantContent: '[Identified: Sphinx]',
      });

      // Verify ConversationContextEvent row
      const event = await prisma.conversationContextEvent.findUnique({
        where: {
          conversationId_businessRequestId_feature: {
            conversationId: convId,
            businessRequestId: brId,
            feature: 'AI_IMAGE_ANALYSIS',
          },
        },
      });
      assert.ok(event);
      assert.equal(event.status, 'MATERIALIZED');
      assert.ok(event.materializedAt !== null);

      // Verify Message rows
      const messages = await prisma.message.findMany({
        where: { conversationId: convId },
        orderBy: { createdAt: 'asc' },
      });

      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, '[Image identification request]');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, '[Identified: Sphinx]');
    });

    test('13. idempotent on double-call (no duplicate messages or events)', async () => {
      const userId = await createTestUser();
      const convId = await createTestConversation(userId);
      const brId = crypto.randomUUID();

      const input = {
        conversationId: convId,
        businessRequestId: brId,
        feature: 'AI_IMAGE_ANALYSIS',
        userContent: '[Image identification request]',
        assistantContent: '[Identified: Pyramids]',
      };

      await persistAndMaterializeConversationContext(input);
      await persistAndMaterializeConversationContext(input);

      const events = await prisma.conversationContextEvent.findMany({
        where: { conversationId: convId },
      });
      assert.equal(events.length, 1, 'Should have exactly 1 ConversationContextEvent');

      const messages = await prisma.message.findMany({
        where: { conversationId: convId },
      });
      assert.equal(messages.length, 2, 'Should have exactly 2 messages (1 user, 1 assistant)');
    });
  });

  // ──────────────────────────────────────────────
  // 5. Decoupled Durability & Financial Independence Tests
  // ──────────────────────────────────────────────
  describe('decoupled context durability & financial independence', () => {
    test('TEST 1 (Image): financial settlement succeeds even when context event persistence fails', async () => {
      const userId = await createTestUser();
      const convId = await createTestConversation(userId);
      const brId = crypto.randomUUID();

      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'Cairo Citadel',
          category: 'Historical',
          description: 'Saladin fortress',
          cached: false,
          providerCalls: [{
            providerCallMade: true,
            provider: 'google',
            model: 'gemini-3.6-flash',
            actualModel: 'gemini-3.6-flash',
            operation: 'IMAGE_IDENTIFY',
            inputTokens: 100,
            outputTokens: 50,
            usageApplied: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          }],
          usage: { model: 'gemini-3.6-flash', inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        }),
      })) as any;

      const origCreateEvent = prisma.conversationContextEvent.upsert;
      (prisma.conversationContextEvent as any).upsert = async () => {
        throw new Error('Database connection failure during ConversationContextEvent insert');
      };

      let result: any;
      try {
        result = await identifyLandmarkWithTokens({
          userId,
          businessRequestId: brId,
          image: Buffer.from('fake-image-bytes'),
          mimeType: 'image/jpeg',
          conversationId: convId,
        });
      } finally {
        prisma.conversationContextEvent.upsert = origCreateEvent;
        globalThis.fetch = origFetch;
      }

      assert.ok(result, 'Image analysis business result must be returned');
      assert.equal(result.name, 'Cairo Citadel');

      // Verify financial billing: 1 reservation, COMPLETED status, 1 CONSUME transaction, ZERO recovery
      const reservation = await prisma.tokenReservation.findFirst({
        where: { idempotencyKey: brId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, 'COMPLETED');

      const op = await prisma.aIBillingOperation.findUnique({
        where: { operationId: `usage:AI_IMAGE_ANALYSIS:${brId}` },
      });
      assert.ok(op);
      assert.equal(op.status, 'SETTLED');

      const consumeTxCount = await prisma.tokenTransaction.count({
        where: { userId, type: 'CONSUME' },
      });
      assert.equal(consumeTxCount, 1, 'Exactly one CONSUME transaction');
    });

    test('TEST 3: ContextEvent created but Message materialization fails; later repair materializes messages without financial mutation', async () => {
      const userId = await createTestUser();
      const convId = await createTestConversation(userId);
      const brId = crypto.randomUUID();

      // Create ContextEvent in PENDING status
      const event = await createConversationContextEvent({
        conversationId: convId,
        businessRequestId: brId,
        feature: 'AI_IMAGE_ANALYSIS',
        userContent: '[Image identification request]',
        assistantContent: '[Identified: Sphinx]',
      });
      assert.ok(event);
      assert.equal(event.status, 'PENDING');

      // Verify 0 messages initially
      const countBefore = await prisma.message.count({ where: { conversationId: convId } });
      assert.equal(countBefore, 0);

      // Execute repair
      const repaired = await repairConversationContextEvent({
        conversationId: convId,
        businessRequestId: brId,
        feature: 'AI_IMAGE_ANALYSIS',
      });
      assert.ok(repaired, 'Repair must succeed');

      // Verify messages materialized
      const countAfter = await prisma.message.count({ where: { conversationId: convId } });
      assert.equal(countAfter, 2);

      const updatedEvent = await prisma.conversationContextEvent.findUnique({
        where: { id: event.id },
      });
      assert.equal(updatedEvent?.status, 'MATERIALIZED');
    });

    test('TEST 4 & 5: Partial USER-only Message write repair & repeated repair produce no duplicate Messages', async () => {
      const userId = await createTestUser();
      const convId = await createTestConversation(userId);
      const brId = crypto.randomUUID();

      // Create ContextEvent
      const event = await createConversationContextEvent({
        conversationId: convId,
        businessRequestId: brId,
        feature: 'AI_IMAGE_ANALYSIS',
        userContent: '[Image request]',
        assistantContent: '[Identified: Citadel]',
      });
      assert.ok(event);

      // Write ONLY user message to simulate partial write
      const userMsgId = deriveDeterministicMessageId(brId, 'user', convId);
      await prisma.message.create({
        data: {
          id: userMsgId,
          conversationId: convId,
          role: 'user',
          content: '[Image request]',
        },
      });

      // Execute repair twice
      await repairConversationContextEvent({ conversationId: convId, businessRequestId: brId, feature: 'AI_IMAGE_ANALYSIS' });
      await repairConversationContextEvent({ conversationId: convId, businessRequestId: brId, feature: 'AI_IMAGE_ANALYSIS' });

      const messages = await prisma.message.findMany({
        where: { conversationId: convId },
        orderBy: { createdAt: 'asc' },
      });

      assert.equal(messages.length, 2, 'Should repair to exactly 2 messages with 0 duplicates');
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[1].role, 'assistant');

      // Execute 3rd repair when event is already MATERIALIZED to prove no-op guard
      const matEventBefore = await prisma.conversationContextEvent.findUnique({ where: { id: event.id } });
      assert.equal(matEventBefore?.status, 'MATERIALIZED');
      const matAtBefore = matEventBefore?.materializedAt?.getTime();

      const noopRepairResult = await repairConversationContextEvent({ conversationId: convId, businessRequestId: brId, feature: 'AI_IMAGE_ANALYSIS' });
      assert.equal(noopRepairResult, true, 'Repair on MATERIALIZED event must return true');

      const messagesAfter = await prisma.message.findMany({ where: { conversationId: convId } });
      assert.equal(messagesAfter.length, 2, 'Message count must remain unchanged on MATERIALIZED event repair');

      const matEventAfter = await prisma.conversationContextEvent.findUnique({ where: { id: event.id } });
      assert.equal(matEventAfter?.materializedAt?.getTime(), matAtBefore, 'materializedAt timestamp must remain unchanged on MATERIALIZED event repair');
    });

    test('TEST 6: Repeated Idempotency-Key / Replay causes zero provider re-execution and zero financial mutation', async () => {
      const userId = await createTestUser();
      const convId = await createTestConversation(userId);
      const brId = crypto.randomUUID();

      // Seed settled reservation & AIBillingOperation
      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);

      const reservation = await prisma.tokenReservation.create({
        data: {
          walletId: wallet.id,
          userId,
          feature: 'AI_IMAGE_ANALYSIS',
          source: 'IMAGE',
          tokens: 100,
          idempotencyKey: brId,
          referenceId: `ref-${brId}`,
          status: 'COMPLETED',
          expiresAt: new Date(Date.now() + 3600000),
          metadata: {
            aiBilling: { schemaVersion: 1 },
            walletPolicySnapshot: { walletTokenValueNanoUsd: 1000 },
            rateCardVersion: 'v1.0.0',
          },
        },
      });

      await prisma.aIBillingOperation.create({
        data: {
          operationId: `usage:AI_IMAGE_ANALYSIS:${brId}`,
          reservationId: reservation.id,
          walletId: wallet.id,
          userId,
          feature: 'AI_IMAGE_ANALYSIS',
          source: 'IMAGE',
          status: 'SETTLED',
          reservedTokens: 100,
          reservationPricingVersion: 1,
        },
      });

      // Seed ConversationContextEvent in PENDING status
      await createConversationContextEvent({
        conversationId: convId,
        businessRequestId: brId,
        feature: 'AI_IMAGE_ANALYSIS',
        userContent: '[Image request]',
        assistantContent: '[Identified: Pyramids]',
      });

      // Track baseline counts before replay
      const reservationsBefore = await prisma.tokenReservation.findMany({ where: { idempotencyKey: brId } });
      const consumesBefore = await prisma.tokenTransaction.count({ where: { userId, type: 'CONSUME' } });

      let providerCallCount = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        providerCallCount++;
        return { ok: true, status: 200, json: async () => ({}) };
      }) as any;

      let replayCallbackExecutions = 0;
      const origUpdate = prisma.conversationContextEvent.update;
      (prisma.conversationContextEvent as any).update = async (...args: any[]) => {
        replayCallbackExecutions++;
        return origUpdate.apply(prisma.conversationContextEvent, args as any);
      };

      // Execute replay call
      let thrownErr: any;
      try {
        await identifyLandmarkWithTokens({
          userId,
          businessRequestId: brId,
          image: Buffer.from('fake-bytes'),
          mimeType: 'image/jpeg',
          conversationId: convId,
        });
      } catch (err) {
        thrownErr = err;
      } finally {
        globalThis.fetch = origFetch;
        prisma.conversationContextEvent.update = origUpdate;
      }

      // Assert HTTP replay status code remains 409
      assert.ok(thrownErr);
      assert.equal(thrownErr.statusCode, 409, 'Replay must return HTTP 409');

      // Assert onReplay callback executed EXACTLY ONCE
      assert.equal(replayCallbackExecutions, 1, 'onReplay callback execution count must be exactly 1');

      // Assert provider call count unchanged (0 provider calls on replay)
      assert.equal(providerCallCount, 0, 'Provider count must remain 0 on replay');

      // Assert reservation count unchanged
      const reservationsAfter = await prisma.tokenReservation.findMany({ where: { idempotencyKey: brId } });
      assert.equal(reservationsAfter.length, reservationsBefore.length, 'Reservation count must remain unchanged');

      // Assert CONSUME transaction count unchanged
      const consumesAfter = await prisma.tokenTransaction.count({ where: { userId, type: 'CONSUME' } });
      assert.equal(consumesAfter, consumesBefore, 'CONSUME transaction count must remain unchanged');

      // Verify ContextEvent repaired to MATERIALIZED and messages created
      const event = await prisma.conversationContextEvent.findUnique({
        where: {
          conversationId_businessRequestId_feature: {
            conversationId: convId,
            businessRequestId: brId,
            feature: 'AI_IMAGE_ANALYSIS',
          },
        },
      });
      assert.equal(event?.status, 'MATERIALIZED');

      const messages = await prisma.message.findMany({ where: { conversationId: convId } });
      assert.equal(messages.length, 2);
    });

    test('TEST 7: IDOR security check fails before provider execution / billing / context event creation', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const convId = await createTestConversation(user1);

      await assert.rejects(
        async () => validateConversationOwnership(user2, convId),
        (err: any) => err.statusCode === 404,
      );

      const eventsCount = await prisma.conversationContextEvent.count({
        where: { conversationId: convId },
      });
      assert.equal(eventsCount, 0, 'Zero context events created on IDOR rejection');
    });

    test('TEST 8: Standalone Image/Itinerary (omitting conversation_id) creates zero ConversationContextEvent rows', async () => {
      const userId = await createTestUser();
      const brId = crypto.randomUUID();

      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'Sphinx',
          category: 'Statue',
          cached: false,
          providerCalls: [{
            providerCallMade: true,
            provider: 'google',
            model: 'gemini-3.6-flash',
            actualModel: 'gemini-3.6-flash',
            operation: 'IMAGE_IDENTIFY',
            inputTokens: 100,
            outputTokens: 50,
            usageApplied: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          }],
          usage: { model: 'gemini-3.6-flash', inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        }),
      })) as any;

      try {
        await identifyLandmarkWithTokens({
          userId,
          businessRequestId: brId,
          image: Buffer.from('fake-image-bytes'),
          mimeType: 'image/jpeg',
          conversationId: undefined,
        });
      } finally {
        globalThis.fetch = origFetch;
      }

      const eventsCount = await prisma.conversationContextEvent.count({
        where: { businessRequestId: brId },
      });
      assert.equal(eventsCount, 0, 'Standalone request creates 0 ConversationContextEvent rows');
    });

    test('TEST 9: Billing metadata has no contextEvidence inside TokenReservation.metadata', async () => {
      const userId = await createTestUser();
      const brId = crypto.randomUUID();

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);

      const reservation = await prisma.tokenReservation.create({
        data: {
          walletId: wallet.id,
          userId,
          feature: 'AI_IMAGE_ANALYSIS',
          source: 'IMAGE',
          tokens: 100,
          idempotencyKey: brId,
          referenceId: `ref-${brId}`,
          status: 'COMPLETED',
          expiresAt: new Date(Date.now() + 3600000),
          metadata: {
            aiBilling: { schemaVersion: 1 },
            walletPolicySnapshot: { walletTokenValueNanoUsd: 1000 },
            rateCardVersion: 'v1.0.0',
          },
        },
      });

      const fetched = await prisma.tokenReservation.findUnique({ where: { id: reservation.id } });
      assert.ok(fetched?.metadata && typeof fetched.metadata === 'object');
      const meta = fetched.metadata as Record<string, any>;

      assert.deepEqual(meta.aiBilling, { schemaVersion: 1 });
      assert.equal(meta.contextEvidence, undefined, 'contextEvidence MUST NOT exist inside TokenReservation.metadata');
    });
  });

  after(async () => {
    await prisma.$disconnect();
  });
});
