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
import { Gender, TokenTransactionSource, TokenTransactionType } from '@prisma/client';
import { grantFirstLoginTokens } from '../src/services/wallet-grant.service.js';
import { env, walletPolicyConfig } from '../src/config/env.js';

describe('First-Login Token Grant', () => {
  const expectedGrant = env.SIGNUP_TOKEN_GRANT;

  let USER_ROLE_ID: number;

  before(async () => {
    USER_ROLE_ID = (await ensureUserRole()).id;
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
        roleId: USER_ROLE_ID,
        email: `test_signup_grant_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'First-Login Grant User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    return user.id;
  }

  test('1. First successful login grants the signup amount and one GRANT transaction', async () => {
    const userId = await createUser();

    try {
      const result = await grantFirstLoginTokens(userId);
      assert.equal(result.reason, 'GRANTED');
      assert.equal(result.grantedTokens, expectedGrant);

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
      assert.equal(transaction.referenceId, `first-login-grant:${userId}`);
      assert.deepEqual(transaction.metadata, {
        reason: 'FIRST_LOGIN_GRANT',
        policyVersion: walletPolicyConfig.version,
      });
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('2. A second first-login grant is a no-op and never double-credits', async () => {
    const userId = await createUser();

    try {
      const first = await grantFirstLoginTokens(userId);
      assert.equal(first.reason, 'GRANTED');

      const second = await grantFirstLoginTokens(userId);
      assert.equal(second.reason, 'ALREADY_GRANTED');
      assert.equal(second.grantedTokens, 0);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, expectedGrant);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 1);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('3. A pre-cutover signup-grant marker counts as already granted (no top-up)', async () => {
    const userId = await createUser();

    try {
      const wallet = await prisma.tokenWallet.create({
        data: { userId, tokenBalance: expectedGrant, status: 'ACTIVE' },
      });
      await prisma.tokenTransaction.create({
        data: {
          walletId: wallet.id,
          userId,
          type: TokenTransactionType.GRANT,
          tokens: expectedGrant,
          source: TokenTransactionSource.ADMIN,
          paymentId: null,
          referenceId: `signup-grant:${userId}`,
          metadata: { reason: 'SIGNUP_GRANT' },
        },
      });

      const result = await grantFirstLoginTokens(userId);
      assert.equal(result.reason, 'ALREADY_GRANTED');
      assert.equal(result.grantedTokens, 0);

      const updatedWallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(updatedWallet);
      assert.equal(updatedWallet.tokenBalance, expectedGrant);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 1);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId } });
      await prisma.tokenWallet.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  test('4. Admin users are never granted', async () => {
    const preExisting = await prisma.role.findUnique({ where: { name: 'admin' } });
    const adminRole = preExisting
      ? preExisting
      : await prisma.role.create({ data: { name: 'admin' } });
    const user = await prisma.user.create({
      data: {
        roleId: adminRole.id,
        email: `test_signup_grant_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Admin Grant User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    try {
      const result = await grantFirstLoginTokens(user.id);
      assert.equal(result.reason, 'USER_EXEMPT');
      assert.equal(result.grantedTokens, 0);
      assert.equal(await prisma.tokenWallet.count({ where: { userId: user.id } }), 0);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: user.id } }), 0);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId: user.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
      if (!preExisting) {
        await prisma.role.deleteMany({ where: { id: adminRole.id } });
      }
    }
  });
});
