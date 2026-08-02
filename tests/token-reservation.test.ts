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
import { AppError } from '../src/middleware/errorHandler.js';
import {
  Gender,
  TokenReservationStatus,
  TokenTransactionSource,
  TokenTransactionType,
  WalletStatus,
} from '@prisma/client';
import {
  releaseBusinessTokenReservation,
  reserveBusinessTokens,
  settleBusinessTokenReservation,
  settleBusinessTokenReservationForAmount,
} from '../src/services/token-reservation.service.js';
import type {
  ReleaseBusinessTokenReservationInput,
  ReserveBusinessTokensInput,
  SettleBusinessTokenReservationResult,
} from '../src/services/token-reservation.service.js';
import { BUSINESS_TOKEN_PRICING_VERSION } from '../src/config/business-token-features.js';

describe('Token Reservation Service', () => {
  before(async () => {
    await prisma.role.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, name: 'USER' },
    });
    await cleanupSuiteData();
  });

  after(async () => {
    try {
      await cleanupSuiteData();
    } finally {
      await prisma.$disconnect();
    }
  });

  async function cleanupSuiteData(): Promise<void> {
    const emailFilter = { email: { startsWith: 'test_reservation_' } };
    await prisma.tokenReservation.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function createUserWithWallet(
    balance: number,
    status: WalletStatus = WalletStatus.ACTIVE,
  ): Promise<{ userId: string; walletId: string }> {
    const user = await prisma.user.create({
      data: {
        email: `test_reservation_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Token Reservation User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const wallet = await prisma.tokenWallet.create({
      data: {
        userId: user.id,
        tokenBalance: balance,
        reservedBalance: 0,
        status,
      },
    });

    return { userId: user.id, walletId: wallet.id };
  }

  function buildInput(
    userId: string,
    overrides: Partial<ReserveBusinessTokensInput> = {},
  ): ReserveBusinessTokensInput {
    return {
      userId,
      feature: 'AI_CHAT_QUERY',
      source: 'CHAT',
      idempotencyKey: crypto.randomUUID(),
      ...overrides,
    };
  }

  async function expectAppError(
    promise: Promise<unknown>,
    statusCode: number,
    message: string,
  ): Promise<void> {
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, statusCode);
      assert.equal(err.message, message);
      return true;
    });
  }

  async function cleanupUser(userId: string): Promise<void> {
    await prisma.tokenReservation.deleteMany({ where: { userId } });
    await prisma.tokenTransaction.deleteMany({ where: { userId } });
    await prisma.tokenWallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  async function getWallet(userId: string) {
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
    assert.ok(wallet);
    return wallet;
  }

  async function countConsumeTransactions(userId: string): Promise<number> {
    return prisma.tokenTransaction.count({
      where: { userId, type: TokenTransactionType.CONSUME },
    });
  }

  test('1. Successful reserve holds tokens and creates a PENDING reservation', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const input = buildInput(userId, { metadata: { requestId: 'abc' } });
      const result = await reserveBusinessTokens(input);

      assert.equal(result.walletId, walletId);
      assert.equal(result.userId, userId);
      assert.equal(result.feature, 'AI_CHAT_QUERY');
      assert.equal(result.source, 'CHAT');
      assert.equal(result.tokens, 2);
      assert.equal(result.pricingVersion, BUSINESS_TOKEN_PRICING_VERSION);
      assert.equal(result.status, TokenReservationStatus.PENDING);
      assert.equal(result.availableBalance, 8);
      assert.equal(result.reservedBalance, 2);
      assert.equal(result.totalBalance, 10);
      assert.equal(result.idempotentReplay, false);
      assert.ok(result.expiresAt.getTime() > Date.now());
      assert.deepEqual(result.metadata, { requestId: 'abc' });

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.walletId, walletId);
      assert.equal(reservation.userId, userId);
      assert.equal(reservation.feature, 'AI_CHAT_QUERY');
      assert.equal(reservation.source, TokenTransactionSource.CHAT);
      assert.equal(reservation.tokens, 2);
      assert.equal(reservation.pricingVersion, BUSINESS_TOKEN_PRICING_VERSION);
      assert.equal(reservation.idempotencyKey, input.idempotencyKey);
      assert.equal(reservation.referenceId, `${userId}:AI_CHAT_QUERY:${input.idempotencyKey}`);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);
      assert.equal(reservation.settledAt, null);
      assert.equal(reservation.releasedAt, null);
      assert.equal(reservation.releaseReason, null);
      assert.deepEqual(reservation.metadata, { requestId: 'abc' });

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('2. Insufficient balance rejects and reserves nothing', async () => {
    const { userId } = await createUserWithWallet(1);

    try {
      await expectAppError(
        reserveBusinessTokens(buildInput(userId)),
        402,
        'Insufficient token balance',
      );

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 1);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(await prisma.tokenReservation.count({ where: { userId } }), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('3. Missing wallet rejects with 402 and creates no rows', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_reservation_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Token Reservation No Wallet User',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });

    try {
      await expectAppError(
        reserveBusinessTokens(buildInput(user.id)),
        402,
        'Insufficient token balance',
      );
      assert.equal(await prisma.tokenWallet.count({ where: { userId: user.id } }), 0);
      assert.equal(await prisma.tokenReservation.count({ where: { userId: user.id } }), 0);
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('4. INACTIVE and BLOCKED wallets reject with 403 and change nothing', async () => {
    for (const status of [WalletStatus.INACTIVE, WalletStatus.BLOCKED]) {
      const { userId } = await createUserWithWallet(10, status);

      try {
        await expectAppError(
          reserveBusinessTokens(buildInput(userId)),
          403,
          'Token wallet is not active',
        );

        const wallet = await getWallet(userId);
        assert.equal(wallet.tokenBalance, 10);
        assert.equal(wallet.reservedBalance, 0);
        assert.equal(await prisma.tokenReservation.count({ where: { userId } }), 0);
      } finally {
        await cleanupUser(userId);
      }
    }
  });

  test('5. Duplicate idempotency key returns the same reservation without double-reserving', async () => {
    const { userId } = await createUserWithWallet(10);
    const idempotencyKey = crypto.randomUUID();

    try {
      const first = await reserveBusinessTokens(buildInput(userId, { idempotencyKey }));
      const second = await reserveBusinessTokens(buildInput(userId, { idempotencyKey }));

      assert.equal(first.idempotentReplay, false);
      assert.equal(second.idempotentReplay, true);
      assert.equal(second.reservationId, first.reservationId);
      assert.equal(second.referenceId, first.referenceId);
      assert.equal(second.tokens, first.tokens);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(await prisma.tokenReservation.count({ where: { userId } }), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('6. Concurrent duplicate requests reserve once and roll back the loser transaction', async () => {
    const { userId } = await createUserWithWallet(10);
    const idempotencyKey = crypto.randomUUID();

    try {
      const [first, second] = await Promise.all([
        reserveBusinessTokens(buildInput(userId, { idempotencyKey })),
        reserveBusinessTokens(buildInput(userId, { idempotencyKey })),
      ]);

      assert.equal(first.reservationId, second.reservationId);

      const replays = [first, second].filter((r) => r.idempotentReplay === true);
      const originals = [first, second].filter((r) => r.idempotentReplay === false);
      assert.equal(replays.length, 1);
      assert.equal(originals.length, 1);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(await prisma.tokenReservation.count({ where: { userId } }), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('7. Concurrent distinct requests cannot overspend the available balance', async () => {
    const { userId } = await createUserWithWallet(2);

    try {
      const [first, second] = await Promise.allSettled([
        reserveBusinessTokens(buildInput(userId)),
        reserveBusinessTokens(buildInput(userId)),
      ]);

      const fulfilled = first.status === 'fulfilled' ? 1 : 0;
      const secondFulfilled = second.status === 'fulfilled' ? 1 : 0;
      assert.equal(fulfilled + secondFulfilled, 1);

      const rejected = first.status === 'rejected' ? first : second;
      assert.ok(rejected.status === 'rejected');
      assert.ok(rejected.reason instanceof AppError);
      assert.equal(rejected.reason.statusCode, 402);
      assert.equal(rejected.reason.message, 'Insufficient token balance');

      const wallet = await getWallet(userId);
      assert.ok(wallet.tokenBalance >= 0);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(await prisma.tokenReservation.count({ where: { userId } }), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('8. Successful settle creates exactly one CONSUME transaction', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const input = buildInput(userId);
      const reserved = await reserveBusinessTokens(input);
      const settled = await settleBusinessTokenReservation({
        reservationId: reserved.reservationId,
      });

      assert.equal(settled.reservationId, reserved.reservationId);
      assert.equal(settled.referenceId, reserved.referenceId);
      assert.equal(settled.status, TokenReservationStatus.COMPLETED);
      assert.equal(settled.tokens, 2);
      assert.equal(settled.feature, 'AI_CHAT_QUERY');
      assert.equal(settled.source, 'CHAT');
      assert.equal(settled.pricingVersion, BUSINESS_TOKEN_PRICING_VERSION);
      assert.equal(settled.idempotentReplay, false);
      assert.ok(settled.settledAt);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);
      assert.ok(reservation.settledAt);

      const transactions = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(transactions.length, 1);
      const consume = transactions[0];
      assert.equal(consume.walletId, walletId);
      assert.equal(consume.userId, userId);
      assert.equal(consume.tokens, 2);
      assert.equal(consume.source, TokenTransactionSource.CHAT);
      assert.equal(consume.referenceId, `${reserved.referenceId}:settle`);
      assert.deepEqual(consume.metadata, {
        feature: 'AI_CHAT_QUERY',
        reservationId: reserved.reservationId,
        idempotencyKey: input.idempotencyKey,
        pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
      });

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('9. Duplicate settle returns the completed result without a second transaction', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const first = await settleBusinessTokenReservation({
        reservationId: reserved.reservationId,
      });
      const second = await settleBusinessTokenReservation({
        reservationId: reserved.reservationId,
      });

      assert.equal(first.idempotentReplay, false);
      assert.equal(second.idempotentReplay, true);
      assert.equal(second.consumeTransactionId, first.consumeTransactionId);
      assert.equal(second.settledAt.getTime(), first.settledAt.getTime());
      assert.equal(await countConsumeTransactions(userId), 1);

      const consume = await prisma.tokenTransaction.findFirst({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.ok(consume);
      assert.equal(first.consumeTransactionId, consume.id);
      assert.equal(second.consumeTransactionId, consume.id);
      assert.notEqual(consume.id, reserved.reservationId);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('10. Concurrent duplicate settle produces exactly one CONSUME transaction', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const [first, second] = await Promise.all([
        settleBusinessTokenReservation({ reservationId: reserved.reservationId }),
        settleBusinessTokenReservation({ reservationId: reserved.reservationId }),
      ]);

      assert.equal(first.consumeTransactionId, second.consumeTransactionId);
      const replays = [first, second].filter((r) => r.idempotentReplay === true);
      assert.equal(replays.length, 1);
      assert.equal(await countConsumeTransactions(userId), 1);

      const wallet = await getWallet(userId);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('11. Successful release restores the available balance and stores the reason', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));
      const released = await releaseBusinessTokenReservation({
        reservationId: reserved.reservationId,
        reason: 'Service failed',
      });

      assert.equal(released.reservationId, reserved.reservationId);
      assert.equal(released.status, TokenReservationStatus.RELEASED);
      assert.equal(released.releaseReason, 'Service failed');
      assert.equal(released.idempotentReplay, false);
      assert.ok(released.releasedAt);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.RELEASED);
      assert.equal(reservation.releaseReason, 'Service failed');
      assert.ok(reservation.releasedAt);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 10);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('12. Duplicate release returns the released result without double-restoring', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const first = await releaseBusinessTokenReservation({
        reservationId: reserved.reservationId,
        reason: 'First release',
      });
      const second = await releaseBusinessTokenReservation({
        reservationId: reserved.reservationId,
        reason: 'Ignored reason',
      });

      assert.equal(first.idempotentReplay, false);
      assert.equal(second.idempotentReplay, true);
      assert.equal(second.releasedAt.getTime(), first.releasedAt.getTime());
      assert.equal(second.releaseReason, 'First release');

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 10);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('13. Invalid lifecycle transitions are rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await settleBusinessTokenReservation({ reservationId: reserved.reservationId });

      await expectAppError(
        releaseBusinessTokenReservation({
          reservationId: reserved.reservationId,
          reason: 'after settle',
        }),
        409,
        'Cannot release a completed reservation',
      );

      const secondReserved = await reserveBusinessTokens(buildInput(userId));

      await releaseBusinessTokenReservation({
        reservationId: secondReserved.reservationId,
        reason: 'released first',
      });

      await expectAppError(
        settleBusinessTokenReservation({ reservationId: secondReserved.reservationId }),
        409,
        'Cannot settle a released reservation',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('14. Missing reservations return 404', async () => {
    await expectAppError(
      settleBusinessTokenReservation({ reservationId: crypto.randomUUID() }),
      404,
      'Reservation not found',
    );
    await expectAppError(
      releaseBusinessTokenReservation({ reservationId: crypto.randomUUID() }),
      404,
      'Reservation not found',
    );
  });

  test('15. Settling works after the wallet becomes INACTIVE or BLOCKED', async () => {
    for (const status of [WalletStatus.INACTIVE, WalletStatus.BLOCKED]) {
      const { userId } = await createUserWithWallet(10);

      try {
        const reserved = await reserveBusinessTokens(buildInput(userId));

        await prisma.tokenWallet.update({
          where: { userId },
          data: { status },
        });

        const settled = await settleBusinessTokenReservation({
          reservationId: reserved.reservationId,
        });

        assert.equal(settled.status, TokenReservationStatus.COMPLETED);
        assert.equal(await countConsumeTransactions(userId), 1);

        const wallet = await getWallet(userId);
        assert.equal(wallet.status, status);
        assert.equal(wallet.tokenBalance, 8);
        assert.equal(wallet.reservedBalance, 0);
      } finally {
        await cleanupUser(userId);
      }
    }
  });

  test('16. Releasing works after the wallet becomes INACTIVE or BLOCKED', async () => {
    for (const status of [WalletStatus.INACTIVE, WalletStatus.BLOCKED]) {
      const { userId } = await createUserWithWallet(10);

      try {
        const reserved = await reserveBusinessTokens(buildInput(userId));

        await prisma.tokenWallet.update({
          where: { userId },
          data: { status },
        });

        const released = await releaseBusinessTokenReservation({
          reservationId: reserved.reservationId,
          reason: 'released after status change',
        });

        assert.equal(released.status, TokenReservationStatus.RELEASED);

        const wallet = await getWallet(userId);
        assert.equal(wallet.status, status);
        assert.equal(wallet.tokenBalance, 10);
        assert.equal(wallet.reservedBalance, 0);
        assert.equal(await countConsumeTransactions(userId), 0);
      } finally {
        await cleanupUser(userId);
      }
    }
  });

  test('17. Token cost is resolved only from the backend pricing catalogue', () => {
    type HasTokensKey = 'tokens' extends keyof ReserveBusinessTokensInput ? true : false;
    const compileTimeCheck: HasTokensKey extends false ? true : never = true;
    assert.equal(compileTimeCheck, true);

    const input: ReserveBusinessTokensInput = {
      userId: 'some-user-id',
      feature: 'AI_CHAT_QUERY',
      source: 'CHAT',
      idempotencyKey: 'some-key',
    };
    assert.deepEqual(
      Object.keys(input).sort(),
      ['feature', 'idempotencyKey', 'source', 'userId'],
    );
  });

  test('18. Reservations charge the catalogue cost for the requested feature', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(
        buildInput(userId, { feature: 'AI_TRIP_ITINERARY' }),
      );

      assert.equal(reserved.tokens, 10);
      assert.equal(reserved.pricingVersion, BUSINESS_TOKEN_PRICING_VERSION);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(wallet.reservedBalance, 10);
      assert.equal(wallet.tokenBalance + wallet.reservedBalance, 10);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('19. Invalid feature and source are rejected with 400', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      await expectAppError(
        reserveBusinessTokens(buildInput(userId, { feature: 'NOT_A_FEATURE' })),
        400,
        'Invalid business token feature',
      );
      await expectAppError(
        reserveBusinessTokens(buildInput(userId, { source: 'PURCHASE' })),
        400,
        'Invalid business consumption source',
      );
      await expectAppError(
        reserveBusinessTokens(buildInput(userId, { source: 'ADMIN' })),
        400,
        'Invalid business consumption source',
      );
      await expectAppError(
        reserveBusinessTokens(buildInput('   ')),
        400,
        'userId must not be empty',
      );
      await expectAppError(
        reserveBusinessTokens(buildInput(userId, { idempotencyKey: '   ' })),
        400,
        'idempotencyKey must not be empty',
      );
      await expectAppError(
        settleBusinessTokenReservation({ reservationId: '   ' }),
        400,
        'reservationId must not be empty',
      );

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 10);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('20. Settle fails with 409 when reservedBalance is lower than the reserved tokens', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenWallet.update({
        where: { userId },
        data: { reservedBalance: 1 },
      });

      await expectAppError(
        settleBusinessTokenReservation({ reservationId: reserved.reservationId }),
        409,
        'Token reservation integrity conflict',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('21. Failed Settle rolls back completely', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenWallet.update({
        where: { userId },
        data: { reservedBalance: 1 },
      });

      await expectAppError(
        settleBusinessTokenReservation({ reservationId: reserved.reservationId }),
        409,
        'Token reservation integrity conflict',
      );

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);
      assert.equal(reservation.settledAt, null);

      assert.equal(await countConsumeTransactions(userId), 0);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('22. Release fails with 409 when reservedBalance is lower than the reserved tokens', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenWallet.update({
        where: { userId },
        data: { reservedBalance: 1 },
      });

      await expectAppError(
        releaseBusinessTokenReservation({
          reservationId: reserved.reservationId,
          reason: 'Service failed',
        }),
        409,
        'Token reservation integrity conflict',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('23. Failed Release rolls back completely', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenWallet.update({
        where: { userId },
        data: { reservedBalance: 1 },
      });

      await expectAppError(
        releaseBusinessTokenReservation({
          reservationId: reserved.reservationId,
          reason: 'Service failed',
        }),
        409,
        'Token reservation integrity conflict',
      );

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);
      assert.equal(reservation.releasedAt, null);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 1);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('24. COMPLETED reservation without its CONSUME transaction returns 409', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: {
          status: TokenReservationStatus.COMPLETED,
          settledAt: new Date(),
        },
      });

      await expectAppError(
        settleBusinessTokenReservation({ reservationId: reserved.reservationId }),
        409,
        'Token reservation integrity conflict',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('25. Negative actualTokens is rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: -1,
        }),
        400,
        'actualTokens must be a safe non-negative integer',
      );

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('26. Decimal actualTokens is rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1.5,
        }),
        400,
        'actualTokens must be a safe non-negative integer',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('27. NaN actualTokens is rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: NaN,
        }),
        400,
        'actualTokens must be a safe non-negative integer',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('28. Infinity actualTokens is rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: Infinity,
        }),
        400,
        'actualTokens must be a safe non-negative integer',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('29. Unsafe actualTokens is rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 9007199254740992,
        }),
        400,
        'actualTokens must be a safe non-negative integer',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('30. Missing actualTokens in the explicit variable-settlement API is rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: undefined as unknown as number,
        }),
        400,
        'actualTokens must be a safe non-negative integer',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('31. A = R consumes the entire reservation with releasedTokens = 0', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const settled = await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 2,
      });

      assert.equal(settled.status, TokenReservationStatus.COMPLETED);
      assert.equal(settled.tokens, 2);
      assert.equal(settled.actualTokens, 2);
      assert.equal(settled.releasedTokens, 0);
      assert.equal(settled.idempotentReplay, false);
      assert.ok(settled.consumeTransactionId);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);
      assert.equal(reservation.tokens, 2);

      const transactions = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(transactions.length, 1);
      assert.equal(transactions[0].walletId, walletId);
      assert.equal(transactions[0].tokens, 2);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('32. A = R preserves the existing full-settlement wallet behavior', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));
      await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 2,
      });

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(wallet.tokenBalance + wallet.reservedBalance, 8);
      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('33. Partial settlement consumes only A and returns R - A to the available balance', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const settled = await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });

      assert.equal(settled.tokens, 2);
      assert.equal(settled.actualTokens, 1);
      assert.equal(settled.releasedTokens, 1);
      assert.equal(settled.status, TokenReservationStatus.COMPLETED);
      assert.equal(settled.idempotentReplay, false);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.tokens, 2);

      const transactions = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(transactions.length, 1);
      assert.equal(transactions[0].walletId, walletId);
      assert.equal(transactions[0].tokens, 1);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 9);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(wallet.tokenBalance + wallet.reservedBalance, 9);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('34. Partial settlement removes the complete R from reservedBalance', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));
      await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });

      const wallet = await getWallet(userId);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('35. Zero settlement returns the full reservation and completes it', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const settled = await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 0,
      });

      assert.equal(settled.status, TokenReservationStatus.COMPLETED);
      assert.equal(settled.tokens, 2);
      assert.equal(settled.actualTokens, 0);
      assert.equal(settled.releasedTokens, 2);
      assert.equal(settled.idempotentReplay, false);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);
      assert.equal(reservation.releasedAt, null);
      assert.equal(reservation.tokens, 2);

      const transactions = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(transactions.length, 1);
      assert.equal(transactions[0].walletId, walletId);
      assert.equal(transactions[0].tokens, 0);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 10);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('36. Zero settlement returns a real auditable completion transaction', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const input = buildInput(userId);
      const reserved = await reserveBusinessTokens(input);

      const settled = await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 0,
      });

      const consume = await prisma.tokenTransaction.findUnique({
        where: { id: settled.consumeTransactionId },
      });
      assert.ok(consume);
      assert.equal(consume.type, TokenTransactionType.CONSUME);
      assert.equal(consume.tokens, 0);
      assert.equal(consume.referenceId, `${reserved.referenceId}:settle`);
      assert.deepEqual(consume.metadata, {
        feature: 'AI_CHAT_QUERY',
        reservationId: reserved.reservationId,
        idempotencyKey: input.idempotencyKey,
        pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
      });
    } finally {
      await cleanupUser(userId);
    }
  });

  test('37. Zero settlement does not create a release-status reservation', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 0,
      });

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);
      assert.equal(reservation.releasedAt, null);
      assert.equal(reservation.releaseReason, null);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('38. A > R is rejected and changes nothing', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 3,
        }),
        409,
        'Token reservation integrity conflict',
      );

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);
      assert.equal(reservation.settledAt, null);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('39. A > R does not debit unreserved available tokens', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 10,
        }),
        409,
        'Token reservation integrity conflict',
      );

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(wallet.tokenBalance + wallet.reservedBalance, 10);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('40. Repeating settlement with the same A returns the same consume transaction', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const first = await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });
      const second = await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });

      assert.equal(first.idempotentReplay, false);
      assert.equal(second.idempotentReplay, true);
      assert.equal(second.consumeTransactionId, first.consumeTransactionId);
      assert.equal(second.actualTokens, 1);
      assert.equal(second.releasedTokens, 1);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 9);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('41. Repeating settlement with a different A is rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 2,
        }),
        409,
        'Token reservation integrity conflict',
      );

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 9);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('42. A COMPLETED reservation missing its consume transaction is rejected', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: {
          status: TokenReservationStatus.COMPLETED,
          settledAt: new Date(),
        },
      });

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
        409,
        'Token reservation integrity conflict',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('43. A RELEASED reservation cannot be settled', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await releaseBusinessTokenReservation({
        reservationId: reserved.reservationId,
        reason: 'released before settle',
      });

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
        409,
        'Cannot settle a released reservation',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('44. A consume transaction is not duplicated across retries', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });
      await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });
      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 0,
        }),
        409,
        'Token reservation integrity conflict',
      );

      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('45. Settle fails with 409 when reservedBalance is lower than the reserved tokens', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenWallet.update({
        where: { userId },
        data: { reservedBalance: 1 },
      });

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
        409,
        'Token reservation integrity conflict',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('46. A failed guarded wallet update leaves all state unchanged', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenWallet.update({
        where: { userId },
        data: { reservedBalance: 1 },
      });

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
        409,
        'Token reservation integrity conflict',
      );

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);
      assert.equal(reservation.settledAt, null);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 1);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('47. Two concurrent settlements with the same A produce one consume transaction', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const [first, second] = await Promise.all([
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
      ]);

      assert.equal(first.consumeTransactionId, second.consumeTransactionId);
      assert.equal(first.actualTokens, second.actualTokens);
      const replays = [first, second].filter((r) => r.idempotentReplay === true);
      assert.equal(replays.length, 1);
      assert.equal(await countConsumeTransactions(userId), 1);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 9);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('48. Two concurrent settlements with different A values cannot both succeed', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const [first, second] = await Promise.allSettled([
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 2,
        }),
      ]);

      const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
      const rejected = [first, second].filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const reason = rejected[0];
      assert.ok(reason.status === 'rejected');
      assert.ok(reason.reason instanceof AppError);
      assert.equal(reason.reason.statusCode, 409);

      assert.equal(await countConsumeTransactions(userId), 1);

      const wallet = await getWallet(userId);
      assert.ok(wallet.tokenBalance >= 0);
      assert.ok(wallet.reservedBalance >= 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('49. Concurrent settlement and release cannot both mutate the reservation', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const [settled, released] = await Promise.allSettled([
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
        releaseBusinessTokenReservation({
          reservationId: reserved.reservationId,
          reason: 'racing settle',
        }),
      ]);

      const fulfilled = [settled, released].filter((r) => r.status === 'fulfilled');
      const rejected = [settled, released].filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.notEqual(reservation.status, TokenReservationStatus.PENDING);

      const wallet = await getWallet(userId);
      assert.ok(wallet.tokenBalance >= 0);
      assert.ok(wallet.reservedBalance >= 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('50. Balances never become negative after variable settlement', async () => {
    const { userId } = await createUserWithWallet(2);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 0,
      });

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 2);
      assert.equal(wallet.reservedBalance, 0);

      const second = await reserveBusinessTokens(buildInput(userId));
      await settleBusinessTokenReservationForAmount({
        reservationId: second.reservationId,
        actualTokens: 2,
      });

      const finalWallet = await getWallet(userId);
      assert.equal(finalWallet.tokenBalance, 0);
      assert.equal(finalWallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('51. Same settlement referenceId across two different sources returns only the matching-source consume transaction', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));
      const settlementReferenceId = `${reserved.referenceId}:settle`;

      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: {
          status: TokenReservationStatus.COMPLETED,
          settledAt: new Date(),
        },
      });

      const matchingConsume = await prisma.tokenTransaction.create({
        data: {
          walletId,
          userId,
          type: TokenTransactionType.CONSUME,
          tokens: 1,
          source: TokenTransactionSource.CHAT,
          paymentId: null,
          referenceId: settlementReferenceId,
        },
      });

      const otherSourceConsume = await prisma.tokenTransaction.create({
        data: {
          walletId,
          userId,
          type: TokenTransactionType.CONSUME,
          tokens: 1,
          source: TokenTransactionSource.VOICE,
          paymentId: null,
          referenceId: settlementReferenceId,
        },
      });

      const settled = await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });

      assert.equal(settled.idempotentReplay, true);
      assert.equal(settled.consumeTransactionId, matchingConsume.id);
      assert.notEqual(settled.consumeTransactionId, otherSourceConsume.id);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('52. A newer transaction from another source is never selected', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));
      const settlementReferenceId = `${reserved.referenceId}:settle`;

      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: {
          status: TokenReservationStatus.COMPLETED,
          settledAt: new Date(),
        },
      });

      const olderMatchingConsume = await prisma.tokenTransaction.create({
        data: {
          walletId,
          userId,
          type: TokenTransactionType.CONSUME,
          tokens: 1,
          source: TokenTransactionSource.CHAT,
          paymentId: null,
          referenceId: settlementReferenceId,
          createdAt: new Date(Date.now() - 60_000),
        },
      });

      const newerOtherSourceConsume = await prisma.tokenTransaction.create({
        data: {
          walletId,
          userId,
          type: TokenTransactionType.CONSUME,
          tokens: 1,
          source: TokenTransactionSource.VOICE,
          paymentId: null,
          referenceId: settlementReferenceId,
          createdAt: new Date(),
        },
      });

      const settled = await settleBusinessTokenReservationForAmount({
        reservationId: reserved.reservationId,
        actualTokens: 1,
      });

      assert.equal(settled.idempotentReplay, true);
      assert.equal(settled.consumeTransactionId, olderMatchingConsume.id);
      assert.notEqual(settled.consumeTransactionId, newerOtherSourceConsume.id);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('53. A COMPLETED reservation with a corrupted CONSUME amount above R is rejected with 409', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));
      const settlementReferenceId = `${reserved.referenceId}:settle`;

      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: {
          status: TokenReservationStatus.COMPLETED,
          settledAt: new Date(),
        },
      });

      await prisma.tokenTransaction.create({
        data: {
          walletId,
          userId,
          type: TokenTransactionType.CONSUME,
          tokens: 3,
          source: TokenTransactionSource.CHAT,
          paymentId: null,
          referenceId: settlementReferenceId,
        },
      });

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 3,
        }),
        409,
        'Token reservation integrity conflict',
      );

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('54. A COMPLETED reservation with a corrupted CONSUME amount is rejected even when A <= R', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      for (const corruptedTokens of [-1, 3]) {
        const reserved = await reserveBusinessTokens(buildInput(userId));
        const settlementReferenceId = `${reserved.referenceId}:settle`;

        await prisma.tokenReservation.update({
          where: { id: reserved.reservationId },
          data: {
            status: TokenReservationStatus.COMPLETED,
            settledAt: new Date(),
          },
        });

        await prisma.tokenTransaction.create({
          data: {
            walletId,
            userId,
            type: TokenTransactionType.CONSUME,
            tokens: corruptedTokens,
            source: TokenTransactionSource.CHAT,
            paymentId: null,
            referenceId: settlementReferenceId,
          },
        });

        await expectAppError(
          settleBusinessTokenReservationForAmount({
            reservationId: reserved.reservationId,
            actualTokens: 1,
          }),
          409,
          'Token reservation integrity conflict',
        );

        await prisma.tokenTransaction.deleteMany({ where: { userId } });
        await prisma.tokenReservation.deleteMany({ where: { userId } });
      }
    } finally {
      await cleanupUser(userId);
    }
  });

  test('55. Successful full, partial, zero, and replay results satisfy the settlement invariant', async () => {
    const { userId } = await createUserWithWallet(20);

    try {
      const assertInvariant = (settled: SettleBusinessTokenReservationResult) => {
        assert.ok(settled.actualTokens <= settled.tokens);
        assert.ok(settled.releasedTokens >= 0);
        assert.equal(settled.releasedTokens, settled.tokens - settled.actualTokens);
      };

      const partial = await reserveBusinessTokens(buildInput(userId));
      const partialSettled = await settleBusinessTokenReservationForAmount({
        reservationId: partial.reservationId,
        actualTokens: 1,
      });
      assertInvariant(partialSettled);

      const partialReplay = await settleBusinessTokenReservationForAmount({
        reservationId: partial.reservationId,
        actualTokens: 1,
      });
      assert.equal(partialReplay.idempotentReplay, true);
      assertInvariant(partialReplay);

      const full = await reserveBusinessTokens(buildInput(userId));
      const fullSettled = await settleBusinessTokenReservationForAmount({
        reservationId: full.reservationId,
        actualTokens: 2,
      });
      assertInvariant(fullSettled);

      const zero = await reserveBusinessTokens(buildInput(userId));
      const zeroSettled = await settleBusinessTokenReservationForAmount({
        reservationId: zero.reservationId,
        actualTokens: 0,
      });
      assertInvariant(zeroSettled);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('56. A corrupted PENDING reservation with tokens = -1 cannot be settled through settleBusinessTokenReservation()', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: { tokens: -1 },
      });

      await expectAppError(
        settleBusinessTokenReservation({ reservationId: reserved.reservationId }),
        409,
        'Token reservation integrity conflict',
      );

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);
      assert.equal(reservation.settledAt, null);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('57. A corrupted PENDING reservation with tokens = -1 cannot be settled through settleBusinessTokenReservationForAmount()', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: { tokens: -1 },
      });

      await expectAppError(
        settleBusinessTokenReservationForAmount({
          reservationId: reserved.reservationId,
          actualTokens: 1,
        }),
        409,
        'Token reservation integrity conflict',
      );

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);
      assert.equal(reservation.settledAt, null);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('58. A corrupted COMPLETED reservation with a negative stored amount cannot be replayed', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: {
          status: TokenReservationStatus.COMPLETED,
          settledAt: new Date(),
          tokens: -1,
        },
      });

      await expectAppError(
        settleBusinessTokenReservation({ reservationId: reserved.reservationId }),
        409,
        'Token reservation integrity conflict',
      );

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);
      assert.equal(reservation.tokens, -1);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 2);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('59. Normal backward-compatible full settlement still works with A = R', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const reserved = await reserveBusinessTokens(buildInput(userId));

      const settled = await settleBusinessTokenReservation({
        reservationId: reserved.reservationId,
      });

      assert.equal(settled.tokens, 2);
      assert.equal(settled.actualTokens, 2);
      assert.equal(settled.releasedTokens, 0);
      assert.equal(settled.status, TokenReservationStatus.COMPLETED);
      assert.equal(settled.idempotentReplay, false);

      const consume = await prisma.tokenTransaction.findUnique({
        where: { id: settled.consumeTransactionId },
      });
      assert.ok(consume);
      assert.equal(consume.walletId, walletId);
      assert.equal(consume.tokens, 2);
      assert.equal(consume.source, TokenTransactionSource.CHAT);

      const wallet = await getWallet(userId);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(wallet.reservedBalance, 0);

      const replay = await settleBusinessTokenReservation({
        reservationId: reserved.reservationId,
      });
      assert.equal(replay.idempotentReplay, true);
      assert.equal(replay.actualTokens, 2);
      assert.equal(replay.releasedTokens, 0);
      assert.equal(replay.consumeTransactionId, settled.consumeTransactionId);
      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await cleanupUser(userId);
    }
  });
});
