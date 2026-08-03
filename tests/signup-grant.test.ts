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
import { Gender, TokenTransactionSource, TokenTransactionType } from '@prisma/client';
import { grantSignupTokens } from '../src/services/auth.service.js';
import { env } from '../src/config/env.js';

describe('Signup Token Grant', () => {
  const expectedGrant = env.SIGNUP_TOKEN_GRANT;

  before(async () => {
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
      where: { user: { email: { startsWith: 'test_signup_grant_' } } },
    });
    await prisma.tokenWallet.deleteMany({
      where: { user: { email: { startsWith: 'test_signup_grant_' } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'test_signup_grant_' } },
    });
  }

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `test_signup_grant_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Signup Grant User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    return user.id;
  }

  test('1. Grant creates an ACTIVE wallet and one GRANT transaction', async () => {
    const userId = await createUser();

    try {
      await grantSignupTokens(userId);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.equal(wallet.status, 'ACTIVE');
      assert.equal(wallet.tokenBalance, expectedGrant);

      const transaction = await prisma.tokenTransaction.findFirst({
        where: { userId },
      });
      assert.ok(transaction);
      assert.equal(transaction.type, TokenTransactionType.GRANT);
      assert.equal(transaction.source, TokenTransactionSource.ADMIN);
      assert.equal(transaction.tokens, expectedGrant);
      assert.equal(transaction.referenceId, `signup-grant:${userId}`);
      assert.deepEqual(transaction.metadata, { reason: 'SIGNUP_GRANT' });
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('2. Duplicate grant cannot double-credit the wallet', async () => {
    const userId = await createUser();

    try {
      await grantSignupTokens(userId);

      await assert.rejects(grantSignupTokens(userId));

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, expectedGrant);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId } }),
        1,
      );
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
