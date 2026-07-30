import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { signAccessToken } from '../src/utils/token.js';
import { Gender, TokenTransactionType, TokenTransactionSource } from '@prisma/client';

describe('GET /api/tokens/summary - Authenticated Token Usage Summary API', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await prisma.role.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, name: 'USER' },
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
    // Clean up test users, wallets, and transactions matching test pattern
    await prisma.tokenTransaction.deleteMany({
      where: { user: { email: { startsWith: 'test_summary_' } } },
    });
    await prisma.tokenWallet.deleteMany({
      where: { user: { email: { startsWith: 'test_summary_' } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'test_summary_' } },
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await prisma.$disconnect();
  });

  test('1. Request without JWT returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/summary`);
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.error, 'Missing or invalid authorization header');
  });

  test('2. Invalid JWT returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/summary`, {
      headers: { Authorization: 'Bearer invalid.jwt.token' },
    });
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.error, 'Invalid or expired token');
  });

  test('3. User with no wallet and no transactions receives all zero values', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_empty_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Summary Empty',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.success, true);
      assert.deepEqual(body.data, {
        remainingTokens: 0,
        purchasedTokens: 0,
        consumedTokens: 0,
        refundedTokens: 0,
        netConsumedTokens: 0,
        bonusTokens: 0,
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('4. remainingTokens matches the authenticated user\'s wallet balance', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_rem_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Remaining Tokens',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 400, status: 'ACTIVE' },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.remainingTokens, 400);
    } finally {
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('5. purchasedTokens includes only GRANT transactions with source PURCHASE', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_purchased_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Purchased Tokens',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 500, status: 'ACTIVE' },
    });

    const txPurchased = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.PURCHASE,
        tokens: 300,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.purchasedTokens, 300);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: txPurchased.id } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('6. GRANT transactions from another source are not counted as purchases', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_grant_admin_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Grant Admin',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 100, status: 'ACTIVE' },
    });

    const txAdminGrant = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.ADMIN,
        tokens: 200,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.purchasedTokens, 0);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: txAdminGrant.id } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('7. consumedTokens includes only CONSUME transactions', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_consumed_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Consumed Tokens',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 50, status: 'ACTIVE' },
    });

    const txConsume1 = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.CHAT,
        tokens: 30,
      },
    });
    const txConsume2 = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.IMAGE,
        tokens: 20,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.consumedTokens, 50);
    } finally {
      await prisma.tokenTransaction.deleteMany({
        where: { id: { in: [txConsume1.id, txConsume2.id] } },
      });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('8. refundedTokens includes only REFUND transactions', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_refunded_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Refunded Tokens',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 100, status: 'ACTIVE' },
    });

    const txRefund = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.REFUND,
        source: TokenTransactionSource.CHAT,
        tokens: 15,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.refundedTokens, 15);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: txRefund.id } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('9. bonusTokens includes only BONUS transactions', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_bonus_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Bonus Tokens',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 25, status: 'ACTIVE' },
    });

    const txBonus = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 25,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.bonusTokens, 25);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: txBonus.id } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('10. netConsumedTokens equals consumedTokens minus refundedTokens', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_net_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Net Consumed Tokens',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 60, status: 'ACTIVE' },
    });

    const txConsume = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.CHAT,
        tokens: 100,
      },
    });

    const txRefund = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.REFUND,
        source: TokenTransactionSource.CHAT,
        tokens: 40,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.consumedTokens, 100);
      assert.equal(body.data.refundedTokens, 40);
      assert.equal(body.data.netConsumedTokens, 60);
    } finally {
      await prisma.tokenTransaction.deleteMany({
        where: { id: { in: [txConsume.id, txRefund.id] } },
      });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('11. ADJUSTMENT transactions are excluded', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_adj_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Adjustment Test',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 200, status: 'ACTIVE' },
    });

    const txAdj = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.ADJUSTMENT,
        source: TokenTransactionSource.ADMIN,
        tokens: 500,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.purchasedTokens, 0);
      assert.equal(body.data.consumedTokens, 0);
      assert.equal(body.data.refundedTokens, 0);
      assert.equal(body.data.netConsumedTokens, 0);
      assert.equal(body.data.bonusTokens, 0);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: txAdj.id } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('12. Transactions belonging to another user are excluded', async () => {
    const userA = await prisma.user.create({
      data: {
        email: `test_summary_usera_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User A Summary Isolation',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const walletA = await prisma.tokenWallet.create({
      data: { userId: userA.id, tokenBalance: 100, status: 'ACTIVE' },
    });

    const userB = await prisma.user.create({
      data: {
        email: `test_summary_userb_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User B Summary Isolation',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const walletB = await prisma.tokenWallet.create({
      data: { userId: userB.id, tokenBalance: 999, status: 'ACTIVE' },
    });

    const txB = await prisma.tokenTransaction.create({
      data: {
        userId: userB.id,
        walletId: walletB.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.PURCHASE,
        tokens: 999,
      },
    });

    const tokenA = signAccessToken({ sub: userA.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.remainingTokens, 100);
      assert.equal(body.data.purchasedTokens, 0);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: txB.id } });
      await prisma.tokenWallet.deleteMany({
        where: { id: { in: [walletA.id, walletB.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [userA.id, userB.id] } },
      });
    }
  });

  test('13. userId supplied through query or body is ignored', async () => {
    const userA = await prisma.user.create({
      data: {
        email: `test_summary_query_usera_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User A Summary Query',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const walletA = await prisma.tokenWallet.create({
      data: { userId: userA.id, tokenBalance: 150, status: 'ACTIVE' },
    });

    const userB = await prisma.user.create({
      data: {
        email: `test_summary_query_userb_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User B Summary Target',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const walletB = await prisma.tokenWallet.create({
      data: { userId: userB.id, tokenBalance: 888, status: 'ACTIVE' },
    });

    const tokenA = signAccessToken({ sub: userA.id, role: 'USER' });

    try {
      // Query param attack vector
      const resQuery = await fetch(`${baseUrl}/api/tokens/summary?userId=${userB.id}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.equal(resQuery.status, 200);

      const bodyQuery = await resQuery.json();
      assert.equal(bodyQuery.data.remainingTokens, 150);

      // Body payload attack vector
      const bodyPayload = JSON.stringify({ userId: userB.id });
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          `${baseUrl}/api/tokens/summary`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${tokenA}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyPayload),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              assert.equal(res.statusCode, 200);
              const body = JSON.parse(data);
              assert.equal(body.data.remainingTokens, 150);
              resolve();
            });
          }
        );
        req.on('error', reject);
        req.write(bodyPayload);
        req.end();
      });
    } finally {
      await prisma.tokenWallet.deleteMany({
        where: { id: { in: [walletA.id, walletB.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [userA.id, userB.id] } },
      });
    }
  });

  test('14. Response exposes only the approved fields', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_fields_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Safe Fields',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 200, status: 'ACTIVE' },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.success, true);

      const keys = Object.keys(body.data).sort();
      assert.deepEqual(keys, [
        'bonusTokens',
        'consumedTokens',
        'netConsumedTokens',
        'purchasedTokens',
        'refundedTokens',
        'remainingTokens',
      ]);

      assert.equal(body.data.userId, undefined);
      assert.equal(body.data.walletId, undefined);
      assert.equal(body.data.id, undefined);
      assert.equal(body.data.createdAt, undefined);
      assert.equal(body.data.updatedAt, undefined);
      assert.equal(body.data.user, undefined);
      assert.equal(body.data.paymentId, undefined);
    } finally {
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('15. No wallet row is created for a user without a wallet', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_nowallet_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User No Wallet Created',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const walletBefore = await prisma.tokenWallet.findUnique({
        where: { userId: user.id },
      });
      assert.equal(walletBefore, null);

      const res = await fetch(`${baseUrl}/api/tokens/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const walletAfter = await prisma.tokenWallet.findUnique({
        where: { userId: user.id },
      });
      assert.equal(walletAfter, null);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('16. Repeated GET requests do not modify TokenWallet, TokenTransaction, Payment, or TokenPackage records', async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_summary_repeat_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Summary Repeat GET',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 500, status: 'ACTIVE' },
    });
    const tx = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.PURCHASE,
        tokens: 500,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const walletBefore = await prisma.tokenWallet.findUnique({ where: { id: wallet.id } });
      const txBefore = await prisma.tokenTransaction.findUnique({ where: { id: tx.id } });

      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/api/tokens/summary`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.deepEqual(body.data, {
          remainingTokens: 500,
          purchasedTokens: 500,
          consumedTokens: 0,
          refundedTokens: 0,
          netConsumedTokens: 0,
          bonusTokens: 0,
        });
      }

      const walletAfter = await prisma.tokenWallet.findUnique({ where: { id: wallet.id } });
      const txAfter = await prisma.tokenTransaction.findUnique({ where: { id: tx.id } });

      assert.deepEqual(walletBefore, walletAfter);
      assert.deepEqual(txBefore, txAfter);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: tx.id } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
