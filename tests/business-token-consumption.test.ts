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
import { Gender, TokenTransactionType, TokenTransactionSource, WalletStatus } from '@prisma/client';
import {
  consumeBusinessTokens,
  isBusinessConsumptionSource,
} from '../src/services/business-token-consumption.service.js';
import type {
  ConsumeBusinessTokensInput,
  BusinessConsumptionSource,
} from '../src/services/business-token-consumption.service.js';

describe('Business Token Consumption Service', () => {
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
    await prisma.tokenTransaction.deleteMany({
      where: { user: { email: { startsWith: 'test_business_consume_' } } },
    });
    await prisma.tokenWallet.deleteMany({
      where: { user: { email: { startsWith: 'test_business_consume_' } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'test_business_consume_' } },
    });
  }

  async function createUserWithWallet(
    balance: number,
    status: WalletStatus = WalletStatus.ACTIVE,
  ): Promise<{ userId: string; walletId: string }> {
    const user = await prisma.user.create({
      data: {
        email: `test_business_consume_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Business Token Consume User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const wallet = await prisma.tokenWallet.create({
      data: {
        userId: user.id,
        tokenBalance: balance,
        status,
      },
    });

    return { userId: user.id, walletId: wallet.id };
  }

  async function countConsumeTransactions(userId: string): Promise<number> {
    return prisma.tokenTransaction.count({
      where: { userId, type: TokenTransactionType.CONSUME },
    });
  }

  function buildInput(
    userId: string,
    overrides: Partial<ConsumeBusinessTokensInput> = {},
  ): ConsumeBusinessTokensInput {
    return {
      userId,
      feature: 'AI_CHAT_QUERY',
      source: 'CHAT',
      businessRequestId: crypto.randomUUID(),
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

  test('1. Successful AI_CHAT_QUERY consumption', async () => {
    const { userId, walletId } = await createUserWithWallet(10);

    try {
      const input = buildInput(userId, { feature: 'AI_CHAT_QUERY', source: 'CHAT' });

      const result = await consumeBusinessTokens(input);

      assert.equal(result.walletId, walletId);
      assert.equal(result.feature, 'AI_CHAT_QUERY');
      assert.equal(result.source, 'CHAT');
      assert.equal(result.tokensConsumed, 2);
      assert.equal(result.walletBalance, 8);
      assert.equal(result.idempotentReplay, false);

      const transaction = await prisma.tokenTransaction.findUnique({
        where: { id: result.transactionId },
      });
      assert.ok(transaction);
      assert.equal(transaction.walletId, walletId);
      assert.equal(transaction.userId, userId);
      assert.equal(transaction.type, TokenTransactionType.CONSUME);
      assert.equal(transaction.tokens, 2);
      assert.equal(transaction.source, TokenTransactionSource.CHAT);
      assert.equal(transaction.paymentId, null);
      assert.equal(
        transaction.referenceId,
        `${userId}:AI_CHAT_QUERY:${input.businessRequestId}`,
      );
      assert.deepEqual(transaction.metadata, {
        feature: 'AI_CHAT_QUERY',
        businessRequestId: input.businessRequestId,
      });

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 8);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('2. Caller cannot supply a token amount through the input contract', () => {
    type HasTokensKey = 'tokens' extends keyof ConsumeBusinessTokensInput ? true : false;
    const compileTimeCheck: HasTokensKey extends false ? true : never = true;
    assert.equal(compileTimeCheck, true);

    const input: ConsumeBusinessTokensInput = {
      userId: 'some-user-id',
      feature: 'AI_CHAT_QUERY',
      source: 'CHAT',
      businessRequestId: 'some-request-id',
    };
    assert.deepEqual(
      Object.keys(input).sort(),
      ['businessRequestId', 'feature', 'source', 'userId'],
    );
  });

  test('3. Sequential duplicate request is idempotent', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const businessRequestId = crypto.randomUUID();
      const input = buildInput(userId, { businessRequestId });

      const first = await consumeBusinessTokens(input);
      const second = await consumeBusinessTokens(input);

      assert.equal(first.idempotentReplay, false);
      assert.equal(second.idempotentReplay, true);
      assert.equal(second.transactionId, first.transactionId);
      assert.equal(second.walletId, first.walletId);
      assert.equal(second.tokensConsumed, first.tokensConsumed);
      assert.equal(second.walletBalance, 8);
      assert.equal(await countConsumeTransactions(userId), 1);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 8);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('4. Different business request IDs consume independently', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const first = await consumeBusinessTokens(buildInput(userId));
      const second = await consumeBusinessTokens(buildInput(userId));

      assert.equal(first.idempotentReplay, false);
      assert.equal(second.idempotentReplay, false);
      assert.notEqual(second.transactionId, first.transactionId);
      assert.equal(await countConsumeTransactions(userId), 2);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 6);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('5. Insufficient balance rejects and deducts nothing', async () => {
    const { userId, walletId } = await createUserWithWallet(1);

    try {
      await expectAppError(
        consumeBusinessTokens(buildInput(userId)),
        402,
        'Insufficient token balance',
      );

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('6. Missing wallet rejects with insufficient balance and creates no rows', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_business_consume_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Business Token No Wallet User',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });

    try {
      await expectAppError(
        consumeBusinessTokens(buildInput(user.id)),
        402,
        'Insufficient token balance',
      );

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: user.id } });
      assert.equal(wallet, null);
      assert.equal(await countConsumeTransactions(user.id), 0);
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('7. INACTIVE wallet rejects with 403 and changes nothing', async () => {
    const { userId, walletId } = await createUserWithWallet(10, WalletStatus.INACTIVE);

    try {
      await expectAppError(
        consumeBusinessTokens(buildInput(userId)),
        403,
        'Token wallet is not active',
      );

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 10);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('8. BLOCKED wallet rejects with the same safe 403 message', async () => {
    const { userId, walletId } = await createUserWithWallet(10, WalletStatus.BLOCKED);

    try {
      await expectAppError(
        consumeBusinessTokens(buildInput(userId)),
        403,
        'Token wallet is not active',
      );

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 10);
      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('9. Exact-balance consumption succeeds with zero remaining', async () => {
    const { userId } = await createUserWithWallet(2);

    try {
      const result = await consumeBusinessTokens(buildInput(userId));

      assert.equal(result.idempotentReplay, false);
      assert.equal(result.tokensConsumed, 2);
      assert.equal(result.walletBalance, 0);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('10. Concurrent distinct requests cannot overspend', async () => {
    const { userId } = await createUserWithWallet(2);

    try {
      const first = consumeBusinessTokens(buildInput(userId));
      const second = consumeBusinessTokens(buildInput(userId));

      const settled = await Promise.allSettled([first, second]);

      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const rejectedError = rejected[0];
      if (rejectedError.status === 'rejected') {
        assert.ok(rejectedError.reason instanceof AppError);
        assert.equal(rejectedError.reason.statusCode, 402);
        assert.equal(rejectedError.reason.message, 'Insufficient token balance');
      }

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.ok(wallet.tokenBalance >= 0);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('11. Concurrent duplicate requests are idempotent', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      const businessRequestId = crypto.randomUUID();
      const input = buildInput(userId, { businessRequestId });

      const [first, second] = await Promise.all([
        consumeBusinessTokens(input),
        consumeBusinessTokens(input),
      ]);

      assert.equal(first.transactionId, second.transactionId);
      assert.equal(first.walletId, second.walletId);

      const replays = [first, second].filter((r) => r.idempotentReplay === true);
      const originals = [first, second].filter((r) => r.idempotentReplay === false);
      assert.equal(replays.length, 1);
      assert.equal(originals.length, 1);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 8);
      assert.equal(await countConsumeTransactions(userId), 1);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('12. Empty or whitespace userId is rejected with status 400', async () => {
    await expectAppError(
      consumeBusinessTokens(buildInput('   ')),
      400,
      'userId must not be empty',
    );
  });

  test('13. Empty or whitespace businessRequestId is rejected with status 400', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      await expectAppError(
        consumeBusinessTokens(buildInput(userId, { businessRequestId: '   ' })),
        400,
        'businessRequestId must not be empty',
      );
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('14. PURCHASE and ADMIN cannot be used as business consumption sources', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      assert.equal(isBusinessConsumptionSource('PURCHASE'), false);
      assert.equal(isBusinessConsumptionSource('ADMIN'), false);
      assert.equal(isBusinessConsumptionSource('CHAT'), true);
      assert.equal(isBusinessConsumptionSource('IMAGE'), true);
      assert.equal(isBusinessConsumptionSource('FILE_UPLOAD'), true);
      assert.equal(isBusinessConsumptionSource('OCR'), true);
      assert.equal(isBusinessConsumptionSource('VOICE'), true);
      assert.equal(isBusinessConsumptionSource('not-a-source'), false);

      for (const source of ['PURCHASE', 'ADMIN']) {
        await expectAppError(
          consumeBusinessTokens(
            buildInput(userId, { source: source as BusinessConsumptionSource }),
          ),
          400,
          'Invalid business consumption source',
        );
      }

      assert.equal(await countConsumeTransactions(userId), 0);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('15. The service creates only CONSUME transactions', async () => {
    const { userId } = await createUserWithWallet(10);

    try {
      await consumeBusinessTokens(buildInput(userId));

      const types = await prisma.tokenTransaction.groupBy({
        by: ['type'],
        where: { userId },
        _count: { id: true },
      });

      assert.deepEqual(
        types.map((t) => ({ type: t.type, count: t._count.id })),
        [{ type: TokenTransactionType.CONSUME, count: 1 }],
      );

      const nonConsumeCount = await prisma.tokenTransaction.count({
        where: { userId, type: { not: TokenTransactionType.CONSUME } },
      });
      assert.equal(nonConsumeCount, 0);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
