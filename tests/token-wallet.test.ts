import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { ensureUserRole } from './helpers/test-role-fixtures.js';
import { signAccessToken } from '../src/utils/token.js';
import { Gender } from '@prisma/client';

let USER_ROLE_ID: number;

describe('GET /api/tokens/wallet - Authenticated Token Wallet Balance API', () => {
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
    // Clean up test data matching test patterns
    await prisma.tokenWallet.deleteMany({
      where: { user: { email: { startsWith: 'test_wallet_' } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'test_wallet_' } },
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await prisma.$disconnect();
  });

  test('1. GET /api/tokens/wallet without JWT returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/wallet`);
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.error, 'Missing or invalid authorization header');
  });

  test('2. Invalid JWT returns the expected safe authentication error', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/wallet`, {
      headers: {
        Authorization: 'Bearer invalid.jwt.token',
      },
    });
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.error, 'Invalid or expired token');
  });

  test('3. Authenticated user with a wallet receives the actual balance', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_user_with_wallet_${Date.now()}@example.com`,
        passwordHash: 'hashed_password_123',
        displayName: 'Test User With Wallet',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const wallet = await prisma.tokenWallet.create({
      data: {
        userId: user.id,
        tokenBalance: 400,
        status: 'ACTIVE',
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/wallet`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.success, true);
      assert.deepEqual(body.data, {
        balance: 400,
        availableBalance: 400,
        reservedBalance: 0,
        totalBalance: 400,
        status: 'ACTIVE',
      });
    } finally {
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('4. Authenticated user without a wallet receives balance 0', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_user_no_wallet_${Date.now()}@example.com`,
        passwordHash: 'hashed_password_123',
        displayName: 'Test User Without Wallet',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/wallet`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.success, true);
      assert.deepEqual(body.data, {
        balance: 0,
        availableBalance: 0,
        reservedBalance: 0,
        totalBalance: 0,
        status: 'ACTIVE',
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('5. No TokenWallet row is created for a user without a wallet', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_user_no_row_${Date.now()}@example.com`,
        passwordHash: 'hashed_password_123',
        displayName: 'Test User No Row Created',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const walletBefore = await prisma.tokenWallet.findUnique({
        where: { userId: user.id },
      });
      assert.equal(walletBefore, null);

      const res = await fetch(`${baseUrl}/api/tokens/wallet`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
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

  test('6. A user receives only their own wallet balance (User Isolation)', async () => {
    const userA = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_usera_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User A',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const walletA = await prisma.tokenWallet.create({
      data: {
        userId: userA.id,
        tokenBalance: 150,
        status: 'ACTIVE',
      },
    });

    const userB = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_userb_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User B',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const walletB = await prisma.tokenWallet.create({
      data: {
        userId: userB.id,
        tokenBalance: 850,
        status: 'ACTIVE',
      },
    });

    const tokenA = signAccessToken({ sub: userA.id, role: 'USER' });
    const tokenB = signAccessToken({ sub: userB.id, role: 'USER' });

    try {
      const resA = await fetch(`${baseUrl}/api/tokens/wallet`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const bodyA = await resA.json();
      assert.equal(bodyA.data.balance, 150);

      const resB = await fetch(`${baseUrl}/api/tokens/wallet`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      const bodyB = await resB.json();
      assert.equal(bodyB.data.balance, 850);
    } finally {
      await prisma.tokenWallet.deleteMany({
        where: { id: { in: [walletA.id, walletB.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [userA.id, userB.id] } },
      });
    }
  });

  test('7. Supplying userId in query parameters is ignored', async () => {
    const userA = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_query_usera_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User A Query',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const walletA = await prisma.tokenWallet.create({
      data: { userId: userA.id, tokenBalance: 250, status: 'ACTIVE' },
    });

    const userB = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_query_userb_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User B Query Target',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const walletB = await prisma.tokenWallet.create({
      data: { userId: userB.id, tokenBalance: 999, status: 'ACTIVE' },
    });

    const tokenA = signAccessToken({ sub: userA.id, role: 'USER' });

    try {
      // User A attempts to pass User B's ID in query parameter
      const res = await fetch(`${baseUrl}/api/tokens/wallet?userId=${userB.id}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      assert.equal(res.status, 200);

      const body = await res.json();
      // Must return User A's balance (250), ignoring query parameter
      assert.equal(body.data.balance, 250);
      assert.notEqual(body.data.balance, 999);
    } finally {
      await prisma.tokenWallet.deleteMany({
        where: { id: { in: [walletA.id, walletB.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [userA.id, userB.id] } },
      });
    }
  });

  test('8. Supplying userId in the request body is ignored', async () => {
    const userA = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_body_usera_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User A Body',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const walletA = await prisma.tokenWallet.create({
      data: { userId: userA.id, tokenBalance: 320, status: 'ACTIVE' },
    });

    const userB = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_body_userb_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User B Body Target',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    const walletB = await prisma.tokenWallet.create({
      data: { userId: userB.id, tokenBalance: 777, status: 'ACTIVE' },
    });
    const tokenA = signAccessToken({ sub: userA.id, role: 'USER' });

    try {
      const bodyPayload = JSON.stringify({ userId: userB.id });
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          `${baseUrl}/api/tokens/wallet`,
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
              assert.equal(body.data.balance, 320);
              assert.notEqual(body.data.balance, 777);
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

  test('9. Response exposes only balance and status', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_fields_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Fields Test',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 500, status: 'ACTIVE' },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const res = await fetch(`${baseUrl}/api/tokens/wallet`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.success, true);

      const keys = Object.keys(body.data).sort();
      assert.deepEqual(keys, [
        'availableBalance',
        'balance',
        'reservedBalance',
        'status',
        'totalBalance',
      ]);
      assert.equal(body.data.userId, undefined);
      assert.equal(body.data.id, undefined);
      assert.equal(body.data.createdAt, undefined);
      assert.equal(body.data.updatedAt, undefined);
      assert.equal(body.data.user, undefined);
      assert.equal(body.data.transactions, undefined);
    } finally {
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('10. No Payment, TokenTransaction, TokenPackage, or existing wallet record is modified', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_readonly_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Read Only Test',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 600, status: 'ACTIVE' },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      const walletBefore = await prisma.tokenWallet.findUnique({ where: { id: wallet.id } });

      const res = await fetch(`${baseUrl}/api/tokens/wallet`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const walletAfter = await prisma.tokenWallet.findUnique({ where: { id: wallet.id } });

      assert.deepEqual(walletBefore, walletAfter);
    } finally {
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test('11. Repeated GET requests remain read-only and return the same result', async () => {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_wallet_repeated_${Date.now()}@example.com`,
        passwordHash: 'hash',
        displayName: 'User Repeated Request',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: 750, status: 'ACTIVE' },
    });

    const token = signAccessToken({ sub: user.id, role: 'USER' });

    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/api/tokens/wallet`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.deepEqual(body.data, {
          balance: 750,
          availableBalance: 750,
          reservedBalance: 0,
          totalBalance: 750,
          status: 'ACTIVE',
        });
      }
    } finally {
      await prisma.tokenWallet.delete({ where: { id: wallet.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
