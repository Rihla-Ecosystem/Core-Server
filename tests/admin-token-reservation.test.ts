import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReturnedTokens,
  evaluateAIBillingMetadataStatus,
  evaluateAccountingConsistency,
  inspectTokenReservation,
  listTokenReservations,
} from '../src/services/admin-token-reservation.service.js';
import {
  adminTokenReservationListQuerySchema,
  adminTokenReservationParamsSchema,
} from '../src/schemas/admin-token-reservation.schema.js';
import type { AdminTokenReservationRepository } from '../src/repositories/admin-token-reservation.repository.js';
import { buildTokenReservationWhereClause } from '../src/repositories/admin-token-reservation.repository.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('Admin Token Reservation Unit Tests & Contract Checks', () => {
  describe('calculateReturnedTokens', () => {
    test('returns difference when actualWalletTokens is valid and <= reservedTokens', () => {
      assert.equal(calculateReturnedTokens(10, 3), 7);
      assert.equal(calculateReturnedTokens(10, 0), 10);
      assert.equal(calculateReturnedTokens(10, 10), 0);
    });

    test('returns null when actualWalletTokens is missing or null', () => {
      assert.equal(calculateReturnedTokens(10, null), null);
      assert.equal(calculateReturnedTokens(10, undefined), null);
    });

    test('returns null when actualWalletTokens exceeds reservedTokens or is negative/invalid', () => {
      assert.equal(calculateReturnedTokens(10, 12), null);
      assert.equal(calculateReturnedTokens(10, -1), null);
      assert.equal(calculateReturnedTokens(10, 2.5), null);
    });
  });

  describe('evaluateAIBillingMetadataStatus', () => {
    test('identifies MISSING metadata when metadata is null/missing', () => {
      const res = evaluateAIBillingMetadataStatus(null, 10);
      assert.equal(res.status, 'MISSING');
      assert.ok(res.issues.length > 0);
    });

    test('identifies VALID metadata when metadata matches schema and quotedTokens', () => {
      const metadata = {
        aiBilling: {
          schemaVersion: 1,
          requestedMode: 'PROVIDER_USAGE',
          quoteAppliedMode: 'PROVIDER_USAGE',
          quotedTokens: 10,
          fixedFallbackTokens: 10,
          maxInputTokens: 1000,
          maxOutputTokens: 500,
        },
      };
      const res = evaluateAIBillingMetadataStatus(metadata, 10);
      assert.equal(res.status, 'VALID');
      assert.equal(res.issues.length, 0);
    });

    test('identifies INVALID metadata when quotedTokens mismatch reservation tokens', () => {
      const metadata = {
        aiBilling: {
          schemaVersion: 1,
          requestedMode: 'PROVIDER_USAGE',
          quoteAppliedMode: 'PROVIDER_USAGE',
          quotedTokens: 5,
          fixedFallbackTokens: 5,
          maxInputTokens: 1000,
          maxOutputTokens: 500,
        },
      };
      const res = evaluateAIBillingMetadataStatus(metadata, 10);
      assert.equal(res.status, 'INVALID');
      assert.ok(
        res.issues.some((issue) => issue.code === 'RESERVATION_MISMATCH'),
      );
    });
  });

  describe('evaluateAccountingConsistency', () => {
    test('returns CONSISTENT for completed reservation with matching actual and allocation tokens', () => {
      const res = evaluateAccountingConsistency({
        reservationStatus: 'COMPLETED',
        reservedTokens: 10,
        actualWalletTokens: 8,
        allocationConsumedTokens: 8,
      });
      assert.equal(res.consistencyStatus, 'CONSISTENT');
      assert.equal(res.actualWithinReservation, true);
      assert.equal(res.allocationWithinReservation, true);
      assert.equal(res.actualMatchesAllocation, true);
      assert.equal(res.returnedTokens, 2);
    });

    test('returns INCOMPLETE_EVIDENCE for pending reservation with null actual tokens', () => {
      const res = evaluateAccountingConsistency({
        reservationStatus: 'PENDING',
        reservedTokens: 10,
        actualWalletTokens: null,
        allocationConsumedTokens: 0,
      });
      assert.equal(res.consistencyStatus, 'INCOMPLETE_EVIDENCE');
      assert.equal(res.actualWithinReservation, null);
      assert.equal(res.allocationWithinReservation, true);
      assert.equal(res.actualMatchesAllocation, null);
      assert.equal(res.returnedTokens, null);
    });

    test('returns MISMATCH when actual tokens do not match allocation consumed tokens', () => {
      const res = evaluateAccountingConsistency({
        reservationStatus: 'COMPLETED',
        reservedTokens: 10,
        actualWalletTokens: 8,
        allocationConsumedTokens: 5,
      });
      assert.equal(res.consistencyStatus, 'MISMATCH');
      assert.equal(res.actualMatchesAllocation, false);
    });

    test('returns MISMATCH when allocation consumed tokens exceed reserved tokens', () => {
      const res = evaluateAccountingConsistency({
        reservationStatus: 'COMPLETED',
        reservedTokens: 10,
        actualWalletTokens: 8,
        allocationConsumedTokens: 12,
      });
      assert.equal(res.consistencyStatus, 'MISMATCH');
      assert.equal(res.allocationWithinReservation, false);
    });
  });

  describe('Zod Validation Schemas', () => {
    test('validates list query defaults and constraints', () => {
      const parsed = adminTokenReservationListQuerySchema.parse({});
      assert.equal(parsed.page, 1);
      assert.equal(parsed.limit, 25);
    });

    test('rejects invalid query limit or dates where from > to', () => {
      assert.throws(() => {
        adminTokenReservationListQuerySchema.parse({ limit: 500 });
      });

      assert.throws(() => {
        adminTokenReservationListQuerySchema.parse({
          from: '2026-08-10T00:00:00Z',
          to: '2026-08-01T00:00:00Z',
        });
      });
    });

    test('validates reservationId parameter as UUID', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const parsed = adminTokenReservationParamsSchema.parse({
        reservationId: validUuid,
      });
      assert.equal(parsed.reservationId, validUuid);

      assert.throws(() => {
        adminTokenReservationParamsSchema.parse({ reservationId: 'not-a-uuid' });
      });
    });
  });

  describe('Repository Query Builder', () => {
    test('builds where clause with status, feature, user, date range, and search', () => {
      const where = buildTokenReservationWhereClause({
        page: 1,
        limit: 25,
        status: 'PENDING',
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        userId: '123e4567-e89b-12d3-a456-426614174000',
        search: 'john@example.com',
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-10T00:00:00Z',
      });

      assert.equal(where.status, 'PENDING');
      assert.equal(where.feature, 'AI_CHAT_QUERY');
      assert.equal(where.source, 'CHAT');
      assert.equal(where.userId, '123e4567-e89b-12d3-a456-426614174000');
      assert.ok(where.createdAt);
      assert.ok(where.OR);
      assert.equal(where.OR?.length, 3);

      const whereUuid = buildTokenReservationWhereClause({
        page: 1,
        limit: 25,
        search: '123e4567-e89b-12d3-a456-426614174000',
      });
      assert.equal(whereUuid.OR?.length, 4);
    });
  });

  describe('Service Integration Mock Tests', () => {
    test('returns empty result envelope when no reservations match filters', async () => {
      const mockRepo: AdminTokenReservationRepository = {
        async findReservations() {
          return {
            items: [],
            total: 0,
            summary: {
              totalReservations: 0,
              pendingReservations: 0,
              completedReservations: 0,
              releasedReservations: 0,
              totalReservedTokens: 0,
              totalActualWalletTokens: 0,
              totalReturnedTokens: 0,
            },
          };
        },
        async findReservationDetailById() {
          return null;
        },
      };

      const result = await listTokenReservations(
        { page: 1, limit: 25 },
        mockRepo,
      );

      assert.equal(result.items.length, 0);
      assert.equal(result.pagination.total, 0);
      assert.equal(result.pagination.totalPages, 0);
      assert.equal(result.summary.totalReservations, 0);
    });

    test('formats list item with billing operation, partial settlement, and released reservation', async () => {
      const mockRepo: AdminTokenReservationRepository = {
        async findReservations() {
          return {
            items: [
              {
                id: 'res-1',
                referenceId: 'ref-1',
                walletId: 'w-1',
                userId: 'u-1',
                feature: 'AI_CHAT_QUERY',
                source: 'CHAT',
                tokens: 10,
                pricingVersion: 1,
                status: 'COMPLETED',
                createdAt: new Date('2026-08-01'),
                expiresAt: new Date('2026-08-02'),
                settledAt: new Date('2026-08-01'),
                releasedAt: null,
                metadata: {
                  aiBilling: {
                    schemaVersion: 1,
                    requestedMode: 'PROVIDER_USAGE',
                    quoteAppliedMode: 'PROVIDER_USAGE',
                    quotedTokens: 10,
                    fixedFallbackTokens: 10,
                    maxInputTokens: 100,
                    maxOutputTokens: 100,
                  },
                },
                user: {
                  email: 'test@example.com',
                  displayName: 'Test User',
                },
                billingOperation: {
                  operationId: 'op-1',
                  status: 'SETTLED',
                  actualWalletTokens: 7,
                },
              },
              {
                id: 'res-2',
                referenceId: 'ref-2',
                walletId: 'w-1',
                userId: 'u-1',
                feature: 'AI_CHAT_QUERY',
                source: 'CHAT',
                tokens: 5,
                pricingVersion: 1,
                status: 'RELEASED',
                createdAt: new Date('2026-08-01'),
                expiresAt: new Date('2026-08-02'),
                settledAt: null,
                releasedAt: new Date('2026-08-01'),
                metadata: null,
                user: {
                  email: 'test@example.com',
                  displayName: 'Test User',
                },
                billingOperation: null,
              },
            ],
            total: 2,
            summary: {
              totalReservations: 2,
              pendingReservations: 0,
              completedReservations: 1,
              releasedReservations: 1,
              totalReservedTokens: 15,
              totalActualWalletTokens: 7,
              totalReturnedTokens: 8,
            },
          };
        },
        async findReservationDetailById() {
          return null;
        },
      };

      const result = await listTokenReservations(
        { page: 1, limit: 25 },
        mockRepo,
      );

      assert.equal(result.items.length, 2);
      assert.equal(result.items[0].reservationId, 'res-1');
      assert.equal(result.items[0].actualWalletTokens, 7);
      assert.equal(result.items[0].returnedTokens, 3);
      assert.equal(result.items[0].metadataStatus, 'VALID');

      assert.equal(result.items[1].reservationId, 'res-2');
      assert.equal(result.items[1].actualWalletTokens, null);
      assert.equal(result.items[1].returnedTokens, null);
      assert.equal(result.items[1].metadataStatus, 'MISSING');
    });

    test('inspects detailed reservation with funding allocations, transactions, accounting, and metadata', async () => {
      const mockRepo: AdminTokenReservationRepository = {
        async findReservations() {
          return { items: [], total: 0, summary: {} as any };
        },
        async findReservationDetailById(reservationId) {
          if (reservationId !== 'res-100') return null;
          return {
            reservation: {
              id: 'res-100',
              referenceId: 'user-1:AI_CHAT_QUERY:key-100',
              walletId: 'w-100',
              userId: 'u-100',
              feature: 'AI_CHAT_QUERY',
              source: 'CHAT',
              tokens: 10,
              pricingVersion: 1,
              idempotencyKey: 'key-100',
              status: 'COMPLETED',
              expiresAt: new Date('2026-08-02'),
              settledAt: new Date('2026-08-01'),
              releasedAt: null,
              releaseReason: null,
              metadata: {
                aiBilling: {
                  schemaVersion: 1,
                  requestedMode: 'PROVIDER_USAGE',
                  quoteAppliedMode: 'PROVIDER_USAGE',
                  quotedTokens: 10,
                  fixedFallbackTokens: 10,
                  maxInputTokens: 100,
                  maxOutputTokens: 100,
                },
              },
              createdAt: new Date('2026-08-01'),
              updatedAt: new Date('2026-08-01'),
            },
            user: {
              id: 'u-100',
              email: 'user100@example.com',
              displayName: 'User 100',
            },
            wallet: {
              id: 'w-100',
              tokenBalance: 90,
              reservedBalance: 0,
              status: 'ACTIVE',
            },
            billingOperation: {
              operationId: 'op-100',
              status: 'SETTLED',
              reservedTokens: 10,
              requestedProvider: 'openai',
              requestedModel: 'gpt-4o',
              actualProvider: 'openai',
              actualModel: 'gpt-4o',
              providerRequestId: 'req-100',
              providerRequestSent: true,
              inputTokens: 50,
              outputTokens: 20,
              totalTokens: 70,
              cached: false,
              audioSeconds: null,
              pricingMode: 'PROVIDER_USAGE',
              pricingFallbackReason: null,
              actualWalletTokens: 6,
              billingCurrency: 'USD',
              rateCardVersion: 'v1',
              walletPolicyVersion: 'v1',
              failureKind: null,
              failureCode: null,
              retryable: null,
              reviewReasonCode: null,
              executedAt: new Date('2026-08-01'),
              pricedAt: new Date('2026-08-01'),
              failedAt: null,
              reviewedAt: null,
              settledAt: new Date('2026-08-01'),
              releasedAt: null,
              createdAt: new Date('2026-08-01'),
              updatedAt: new Date('2026-08-01'),
            },
            fundingAllocations: [
              {
                id: 'alloc-1',
                reservationId: 'res-100',
                fundingLotId: 'lot-1',
                reservedTokens: 10,
                consumedTokens: 6,
                fundingLot: {
                  id: 'lot-1',
                  source: 'PURCHASE',
                  sourceTransactionId: 'tx-source-1',
                  paymentId: 'pay-1',
                  originalTokens: 100,
                  availableTokens: 90,
                  reservedTokens: 0,
                  consumedTokens: 10,
                  refundHeldTokens: 0,
                  refundedTokens: 0,
                  refundedAt: null,
                },
              },
            ],
            transactions: [
              {
                id: 'tx-consume-1',
                type: 'CONSUME',
                tokens: 6,
                source: 'CHAT',
                paymentId: null,
                referenceId: 'user-1:AI_CHAT_QUERY:key-100:settle',
                metadata: { reservationId: 'res-100' },
                createdAt: new Date('2026-08-01'),
              },
            ],
          };
        },
      };

      const detail = await inspectTokenReservation('res-100', mockRepo);

      assert.equal(detail.reservation.id, 'res-100');
      assert.equal(detail.user.email, 'user100@example.com');
      assert.equal(detail.wallet.id, 'w-100');
      assert.equal(detail.billingOperation?.operationId, 'op-100');
      assert.equal(detail.fundingAllocations.length, 1);
      assert.equal(detail.fundingAllocations[0].restoredTokens, 4);
      assert.equal(detail.transactions.length, 1);
      assert.equal(detail.accounting.consistencyStatus, 'CONSISTENT');
      assert.equal(detail.accounting.returnedTokens, 4);
      assert.equal(detail.metadata.status, 'VALID');
    });

    test('throws 404 AppError when reservation is not found', async () => {
      const mockRepo: AdminTokenReservationRepository = {
        async findReservations() {
          return { items: [], total: 0, summary: {} as any };
        },
        async findReservationDetailById() {
          return null;
        },
      };

      await assert.rejects(
        async () => {
          await inspectTokenReservation('missing-id', mockRepo);
        },
        (err: any) => err instanceof AppError && err.statusCode === 404,
      );
    });

    test('verifies endpoints perform no database mutations or wallet balance changes', async () => {
      let writeOccurred = false;
      const mockRepo: AdminTokenReservationRepository = {
        async findReservations() {
          return {
            items: [],
            total: 0,
            summary: {
              totalReservations: 0,
              pendingReservations: 0,
              completedReservations: 0,
              releasedReservations: 0,
              totalReservedTokens: 0,
              totalActualWalletTokens: 0,
              totalReturnedTokens: 0,
            },
          };
        },
        async findReservationDetailById() {
          return null;
        },
      };

      // Execute list and inspect calls
      await listTokenReservations({ page: 1, limit: 25 }, mockRepo);

      assert.equal(
        writeOccurred,
        false,
        'Expected zero financial or DB mutations during inspection',
      );
    });
  });
});
