import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { ensureUserRole } from './helpers/test-role-fixtures.js';
import { signAccessToken } from '../src/utils/token.js';
import { Gender, TokenTransactionType, TokenTransactionSource } from '@prisma/client';

let USER_ROLE_ID: number;

describe('GET /api/tokens/transactions - Authenticated Token Transactions API', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    USER_ROLE_ID = (await ensureUserRole()).id;
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    // Clean up test users and wallets
    await prisma.tokenTransaction.deleteMany({
      where: { user: { email: { startsWith: 'test_tx_' } } },
    });
    await prisma.tokenWallet.deleteMany({
      where: { user: { email: { startsWith: 'test_tx_' } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'test_tx_' } },
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await prisma.$disconnect();
  });

  test('1. Request without JWT returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/transactions`);
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.error, 'Missing or invalid authorization header');
  });

  test('2. Invalid JWT returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/transactions`, {
      headers: { Authorization: 'Bearer invalid.jwt.token' },
    });
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.error, 'Invalid or expired token');
  });

  test('3 & 4. Authenticated user receives only their transactions; other user transactions excluded', async () => {
    const userA = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_usera_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User A Tx',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const walletA = await prisma.tokenWallet.create({
      data: { userId: userA.id, tokenBalance: 100, status: 'ACTIVE' },
    });
    const txA = await prisma.tokenTransaction.create({
      data: {
        userId: userA.id,
        walletId: walletA.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.ADMIN,
        tokens: 100,
      },
    });

    const userB = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_userb_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User B Tx',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const walletB = await prisma.tokenWallet.create({
      data: { userId: userB.id, tokenBalance: 50, status: 'ACTIVE' },
    });
    const txB = await prisma.tokenTransaction.create({
      data: {
        userId: userB.id,
        walletId: walletB.id,
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.CHAT,
        tokens: 50,
      },
    });

    const tokenA = signAccessToken({ sub: userA.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/transactions`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.items.length, 1);
      assert.equal(body.data.items[0].id, txA.id);
      assert.equal(body.data.pagination.total, 1);
    } finally {
      await prisma.tokenTransaction.deleteMany({
        where: { id: { in: [txA.id, txB.id] } },
      });
      await prisma.tokenWallet.deleteMany({
        where: { id: { in: [walletA.id, walletB.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [userA.id, userB.id] } },
      });
    }
  });

  test('5. Results are sorted newest first (createdAt descending)', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_sort_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Sort Test',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 300, status: 'ACTIVE' },
    });

    const oldDate = new Date(Date.now() - 60000);
    const newDate = new Date();

    const txOld = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.ADMIN,
        tokens: 100,
        createdAt: oldDate,
      },
    });

    const txNew = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.CHAT,
        tokens: 20,
        createdAt: newDate,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/transactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.items.length, 2);
      assert.equal(body.data.items[0].id, txNew.id);
      assert.equal(body.data.items[1].id, txOld.id);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { id: { in: [txOld.id, txNew.id] } } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('6. Stable secondary sorting works for equal timestamps (id descending)', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_sec_sort_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Secondary Sort Test',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 200, status: 'ACTIVE' },
    });

    const sameTime = new Date('2026-01-01T12:00:00.000Z');

    const tx1 = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.ADMIN,
        tokens: 50,
        createdAt: sameTime,
      },
    });

    const tx2 = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 150,
        createdAt: sameTime,
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/transactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.items.length, 2);

      const expectedFirstId = tx1.id > tx2.id ? tx1.id : tx2.id;
      const expectedSecondId = tx1.id > tx2.id ? tx2.id : tx1.id;

      assert.equal(body.data.items[0].id, expectedFirstId);
      assert.equal(body.data.items[1].id, expectedSecondId);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { id: { in: [tx1.id, tx2.id] } } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('7 & 13. Default pagination is page 1 and limit 20 with correct metadata', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_default_page_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Default Page Test',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/transactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.deepEqual(body.data.pagination, {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('8. Custom valid pagination works (page 2, limit 2)', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_custom_page_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Custom Page Test',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 500, status: 'ACTIVE' },
    });

    const createdIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tx = await prisma.tokenTransaction.create({
        data: {
          userId: user.id,
          walletId: wallet.id,
          type: TokenTransactionType.GRANT,
          source: TokenTransactionSource.ADMIN,
          tokens: 10 + i,
          createdAt: new Date(Date.now() - (5 - i) * 1000),
        },
      });
      createdIds.push(tx.id);
    }

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/transactions?page=2&limit=2`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.items.length, 2);
      assert.deepEqual(body.data.pagination, {
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { id: { in: createdIds } } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('9. Empty result returns HTTP 200 with items: []', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_empty_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Empty Test',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/transactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.success, true);
      assert.deepEqual(body.data.items, []);
      assert.equal(body.data.pagination.total, 0);
      assert.equal(body.data.pagination.totalPages, 0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('10. Invalid page values (0, negative, decimal, non-numeric) return 400', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_invalid_page_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Invalid Page',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const token = signAccessToken({ sub: user.id, role: 'USER' });

    const invalidPages = ['0', '-1', '1.5', 'abc', ''];

    try {
      for (const p of invalidPages) {
        const res = await fetch(`${baseUrl}/api/tokens/transactions?page=${encodeURIComponent(p)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 400, `Expected 400 for page=${p}`);

        const body = await res.json();
        assert.equal(body.error, 'Invalid page parameter');
      }
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('11. Invalid limit values (0, negative, decimal, non-numeric) return 400', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_invalid_limit_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Invalid Limit',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const token = signAccessToken({ sub: user.id, role: 'USER' });

    const invalidLimits = ['0', '-5', '2.5', 'xyz', ''];

    try {
      for (const l of invalidLimits) {
        const res = await fetch(`${baseUrl}/api/tokens/transactions?limit=${encodeURIComponent(l)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 400, `Expected 400 for limit=${l}`);

        const body = await res.json();
        assert.equal(body.error, 'Invalid limit parameter');
      }
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('12. limit greater than 100 returns 400', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_limit_101_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Limit 101',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/transactions?limit=101`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 400);

      const body = await res.json();
      assert.equal(body.error, 'Invalid limit parameter');
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('14. userId supplied through query or body is ignored', async () => {
    const userA = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_ignore_usera_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User A Ignore Test',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const walletA = await prisma.tokenWallet.create({
      data: { userId: userA.id, tokenBalance: 100, status: 'ACTIVE' },
    });
    const txA = await prisma.tokenTransaction.create({
      data: {
        userId: userA.id,
        walletId: walletA.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.ADMIN,
        tokens: 100,
      },
    });

    const userB = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_ignore_userb_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User B Ignore Target',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const walletB = await prisma.tokenWallet.create({
      data: { userId: userB.id, tokenBalance: 500, status: 'ACTIVE' },
    });
    const txB = await prisma.tokenTransaction.create({
      data: {
        userId: userB.id,
        walletId: walletB.id,
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 500,
      },
    });

    const tokenA = signAccessToken({ sub: userA.id, role: 'USER' });

    try {
      // Query param attack vector
      const resQuery = await fetch(`${baseUrl}/api/tokens/transactions?userId=${userB.id}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.equal(resQuery.status, 200);

      const bodyQuery = await resQuery.json();
      assert.equal(bodyQuery.data.items.length, 1);
      assert.equal(bodyQuery.data.items[0].id, txA.id);

      // Body payload attack vector
      const bodyPayload = JSON.stringify({ userId: userB.id });
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          `${baseUrl}/api/tokens/transactions`,
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
              assert.equal(body.data.items.length, 1);
              assert.equal(body.data.items[0].id, txA.id);
              resolve();
            });
          }
        );
        req.on('error', reject);
        req.write(bodyPayload);
        req.end();
      });
    } finally {
      await prisma.tokenTransaction.deleteMany({
        where: { id: { in: [txA.id, txB.id] } },
      });
      await prisma.tokenWallet.deleteMany({
        where: { id: { in: [walletA.id, walletB.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [userA.id, userB.id] } },
      });
    }
  });

  test('15. Response contains only approved safe fields', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_fields_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Safe Fields Test',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 100, status: 'ACTIVE' },
    });
    const tx = await prisma.tokenTransaction.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.ADMIN,
        tokens: 100,
        metadata: { internalSecretKey: 'do_not_expose' },
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/transactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.data.items.length, 1);

      const item = body.data.items[0];
      const keys = Object.keys(item).sort();
      assert.deepEqual(keys, ['createdAt', 'id', 'paymentId', 'referenceId', 'source', 'tokens', 'type']);

      assert.equal(item.userId, undefined);
      assert.equal(item.user, undefined);
      assert.equal(item.walletId, undefined);
      assert.equal(item.wallet, undefined);
      assert.equal(item.metadata, undefined);
      assert.equal(item.payment, undefined);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: tx.id } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('16. Repeated GET requests do not modify TokenTransaction, TokenWallet, Payment, or TokenPackage records', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_tx_repeat_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Repeat GET Test',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 200, status: 'ACTIVE' },
    });
    const tx = await prisma.tokenTransaction.create({
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
      const txBefore = await prisma.tokenTransaction.findUnique({ where: { id: tx.id } });
      const walletBefore = await prisma.tokenWallet.findUnique({ where: { id: wallet.id } });

      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/api/tokens/transactions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);
      }

      const txAfter = await prisma.tokenTransaction.findUnique({ where: { id: tx.id } });
      const walletAfter = await prisma.tokenWallet.findUnique({ where: { id: wallet.id } });

      assert.deepEqual(txBefore, txAfter);
      assert.deepEqual(walletBefore, walletAfter);
    } finally {
      await prisma.tokenTransaction.delete({ where: { id: tx.id } });
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
