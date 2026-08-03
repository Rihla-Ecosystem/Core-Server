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
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { adjust, grantBonus } from '../src/services/admin-token-wallet.service.js';
import { signAccessToken } from '../src/utils/token.js';
import {
  Gender,
  PaymentStatus,
  TokenTransactionSource,
  TokenTransactionType,
  WalletStatus,
} from '@prisma/client';

const ADMIN_USER_ID = 'aaaaaaa1-1111-4111-8111-111111111111';
const MISSING_ADMIN_USER_ID = 'aaaaaaa2-2222-4222-8222-222222222222';
const USER_TOKEN_SUB = 'aaaaaaa3-3333-4333-8333-333333333333';
const SECOND_ADMIN_USER_ID = 'aaaaaaa4-4444-4444-8444-444444444444';
const EMAIL_PREFIX = 'test_admin_wallet_';

const ADMIN_TOKEN = signAccessToken({ sub: ADMIN_USER_ID, role: 'admin' });
const MISSING_ADMIN_TOKEN = signAccessToken({ sub: MISSING_ADMIN_USER_ID, role: 'admin' });
const SECOND_ADMIN_TOKEN = signAccessToken({ sub: SECOND_ADMIN_USER_ID, role: 'admin' });
const USER_TOKEN = signAccessToken({ sub: USER_TOKEN_SUB, role: 'USER' });

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

function userHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${USER_TOKEN}` };
}

function jsonAdminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
}

async function fetchJson(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, opts);
  const body = await res.json();
  return { status: res.status, body };
}

async function postBonus(
  userId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = jsonAdminHeaders(),
) {
  const res = await fetch(`${baseUrl}/api/admin/token-wallets/${userId}/bonus`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const responseBody = await res.json();
  return { status: res.status, body: responseBody };
}

async function postAdjustment(
  userId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = jsonAdminHeaders(),
) {
  const res = await fetch(`${baseUrl}/api/admin/token-wallets/${userId}/adjustments`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const responseBody = await res.json();
  return { status: res.status, body: responseBody };
}

let baseUrl = '';

describe('Admin Token Wallet API', () => {
  let server: Server;

  async function cleanupSuiteData(): Promise<void> {
    const emailFilter = { email: { startsWith: EMAIL_PREFIX } };
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ actor: emailFilter }, { target: emailFilter }],
      },
    });
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.payment.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenPackage.deleteMany({ where: { code: { startsWith: 'ADJ_TEST_' } } });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function createUser(overrides: Partial<{ displayName: string; email: string; isDeleted: boolean }> = {}) {
    return prisma.user.create({
      data: {
        email: overrides.email ?? `${EMAIL_PREFIX}${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: overrides.displayName ?? 'Wallet Test User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        isDeleted: overrides.isDeleted ?? false,
      },
    });
  }

  async function createWallet(userId: string, tokenBalance: number, status: WalletStatus = WalletStatus.ACTIVE) {
    return prisma.tokenWallet.create({
      data: { userId, tokenBalance, status },
    });
  }

  async function createTargetUser(wallet?: { tokenBalance: number; status: WalletStatus }) {
    const user = await createUser();
    if (wallet) {
      await createWallet(user.id, wallet.tokenBalance, wallet.status);
    }
    return user;
  }

  async function assertNoBonusWrites(userId: string): Promise<void> {
    assert.equal(await prisma.tokenWallet.count({ where: { userId } }), 0);
    assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { targetUserId: userId } }), 0);
  }

  async function createDirectTransaction(userId: string, walletId: string, data: {
    type: TokenTransactionType;
    source: TokenTransactionSource;
    tokens: number;
    paymentId?: string | null;
    referenceId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  }) {
    return prisma.tokenTransaction.create({
      data: {
        walletId,
        userId,
        type: data.type,
        tokens: data.tokens,
        source: data.source,
        paymentId: data.paymentId ?? null,
        referenceId: data.referenceId ?? crypto.randomUUID(),
        metadata: data.metadata,
        createdAt: data.createdAt,
      },
    });
  }

  async function createTestTokenPackage() {
    const suffix = crypto.randomUUID();
    return prisma.tokenPackage.create({
      data: {
        name: `Adj Test Pkg ${suffix}`,
        code: `ADJ_TEST_${suffix}`,
        price: '50.00',
        currency: 'EGP',
        tokens: 100,
        sortOrder: 1,
        isActive: true,
      },
    });
  }

  async function createTestPaymentForUser(
    userId: string,
  ) {
    const pkg = await createTestTokenPackage();
    const payment = await prisma.payment.create({
      data: {
        userId,
        tokenPackageId: pkg.id,
        amount: '50.00',
        currency: 'EGP',
        status: PaymentStatus.COMPLETED,
        packageNameSnapshot: pkg.name,
        tokensSnapshot: pkg.tokens,
        priceSnapshot: pkg.price.toString(),
        currencySnapshot: pkg.currency,
        provider: 'PAYMOB',
        paidAt: new Date('2026-07-15T12:00:00.000Z'),
      },
    });
    return { payment, pkg };
  }

  async function cleanupAdjustmentRefs(
    userId: string,
    packageIds: number[] = [],
  ): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { targetUserId: userId } });
    await prisma.tokenTransaction.deleteMany({ where: { userId } });
    await prisma.payment.deleteMany({ where: { userId } });
    await prisma.tokenWallet.deleteMany({ where: { userId } });
    if (packageIds.length > 0) {
      await prisma.tokenPackage.deleteMany({ where: { id: { in: packageIds } } });
    }
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  before(async () => {
    await cleanupSuiteData();

    const adminRole = await prisma.role.upsert({
      where: { name: 'admin' },
      update: {},
      create: { id: 9987, name: 'admin', permissions: [] },
    });

    const userRole = await prisma.role.upsert({
      where: { name: 'USER' },
      update: {},
      create: { id: 9986, name: 'USER', permissions: [] },
    });

    await prisma.user.upsert({
      where: { id: ADMIN_USER_ID },
      update: {},
      create: {
        id: ADMIN_USER_ID,
        email: `${EMAIL_PREFIX}admin@example.com`,
        passwordHash: 'hash',
        displayName: 'Wallet Admin',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: adminRole.id,
        isEmailVerified: true,
      },
    });

    await prisma.user.upsert({
      where: { id: USER_TOKEN_SUB },
      update: {},
      create: {
        id: USER_TOKEN_SUB,
        email: `${EMAIL_PREFIX}regular@example.com`,
        passwordHash: 'hash',
        displayName: 'Wallet Regular User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: userRole.id,
        isEmailVerified: true,
      },
    });

    await prisma.user.upsert({
      where: { id: SECOND_ADMIN_USER_ID },
      update: {},
      create: {
        id: SECOND_ADMIN_USER_ID,
        email: `${EMAIL_PREFIX}admin2@example.com`,
        passwordHash: 'hash',
        displayName: 'Second Wallet Admin',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: adminRole.id,
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
      await cleanupSuiteData();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await prisma.$disconnect();
    }
  });

  /* ========== Authorization ========== */

  test('1. GET wallet list without authorization returns 401', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/admin/token-wallets`);
    assert.equal(status, 401);
    assert.equal(body.error, 'Missing or invalid authorization header');
  });

  test('2. GET wallet list with USER role returns 403', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/admin/token-wallets`, {
      headers: userHeaders(),
    });
    assert.equal(status, 403);
    assert.equal(body.error, 'Insufficient permissions');
  });

  test('3. POST bonus without authorization returns 401', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-wallets/00000000-0000-4000-8000-000000000000/bonus`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
    );
    assert.equal(status, 401);
    assert.equal(body.error, 'Missing or invalid authorization header');
  });

  test('4. POST bonus with USER role returns 403', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-wallets/00000000-0000-4000-8000-000000000000/bonus`,
      {
        method: 'POST',
        headers: { ...userHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'Insufficient permissions');
  });

  test('5. Valid admin JWT whose actor user is missing returns 401 and creates no records', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postBonus(
        target.id,
        { tokens: 50, reason: 'Welcome gift', idempotencyKey: crypto.randomUUID() },
        { Authorization: `Bearer ${MISSING_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      );
      assert.equal(status, 401);
      assert.equal(body.error, 'Authenticated user not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  /* ========== Wallet list ========== */

  test('6. Empty matching search returns 200 with empty items', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-wallets?search=ZZZ_NONEXISTENT_${crypto.randomUUID()}`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data, {
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  test('7. Wallet list returns user information and wallet fields', async () => {
    const user = await createUser({ displayName: 'Listed Wallet User' });
    const wallet = await createWallet(user.id, 500, WalletStatus.ACTIVE);
    try {
      const { status, body } = await fetchJson(`${baseUrl}/api/admin/token-wallets`, {
        headers: adminHeaders(),
      });
      assert.equal(status, 200);
      const found = body.data.items.find((item: { id: string }) => item.id === wallet.id);
      assert.ok(found, 'Created wallet not found in list');
      assert.equal(found.userId, user.id);
      assert.equal(found.tokenBalance, 500);
      assert.equal(found.status, 'ACTIVE');
      assert.equal(typeof found.createdAt, 'string');
      assert.equal(typeof found.updatedAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(found.createdAt)));
      assert.ok(!Number.isNaN(Date.parse(found.updatedAt)));
      assert.deepEqual(found.user, {
        id: user.id,
        email: user.email,
        displayName: 'Listed Wallet User',
        isActive: true,
        isBanned: false,
      });
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('8. Search matches user email case-insensitively', async () => {
    const email = `${EMAIL_PREFIX}${crypto.randomUUID()}SEARCHME@example.com`;
    const user = await createUser({ email, displayName: 'Email Search User' });
    const wallet = await createWallet(user.id, 10);
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets?search=searchme`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const found = body.data.items.find((item: { id: string }) => item.id === wallet.id);
      assert.ok(found, 'Email search should match the wallet');
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('9. Search matches displayName case-insensitively', async () => {
    const user = await createUser({ displayName: 'UniqueDisplayNameXyz' });
    const wallet = await createWallet(user.id, 10);
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets?search=uniquedisplayname`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const found = body.data.items.find((item: { id: string }) => item.id === wallet.id);
      assert.ok(found, 'displayName search should match the wallet');
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('10. Status filter returns only the requested wallet status', async () => {
    const activeUser = await createUser({ displayName: `StatusActive_${crypto.randomUUID()}` });
    const blockedUser = await createUser({ displayName: `StatusBlocked_${crypto.randomUUID()}` });
    const activeWallet = await createWallet(activeUser.id, 10, WalletStatus.ACTIVE);
    const blockedWallet = await createWallet(blockedUser.id, 20, WalletStatus.BLOCKED);
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets?status=BLOCKED`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const ids = body.data.items.map((item: { id: string }) => item.id);
      assert.ok(ids.includes(blockedWallet.id));
      assert.ok(!ids.includes(activeWallet.id));
      for (const item of body.data.items) {
        assert.equal(item.status, 'BLOCKED');
      }
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: { in: [activeUser.id, blockedUser.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [activeUser.id, blockedUser.id] } } });
    }
  });

  test('11. Pagination metadata is correct', async () => {
    const token = `Pagin_${crypto.randomUUID()}`;
    const users = await Promise.all(
      Array.from({ length: 5 }, () => createUser({ displayName: token })),
    );
    const wallets = await Promise.all(users.map((u) => createWallet(u.id, 5)));
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets?search=${token}&page=2&limit=2`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.data.items.length, 2);
      assert.equal(body.data.pagination.page, 2);
      assert.equal(body.data.pagination.limit, 2);
      assert.equal(body.data.pagination.total, 5);
      assert.equal(body.data.pagination.totalPages, 3);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { id: { in: wallets.map((w) => w.id) } } });
      await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    }
  });

  test('12. tokenBalance sorting works', async () => {
    const prefix = `SortBal_${crypto.randomUUID()}`;
    const users = await Promise.all([
      createUser({ displayName: `${prefix}A` }),
      createUser({ displayName: `${prefix}B` }),
      createUser({ displayName: `${prefix}C` }),
    ]);
    const walletA = await createWallet(users[0].id, 30);
    const walletB = await createWallet(users[1].id, 10);
    const walletC = await createWallet(users[2].id, 20);
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets?search=${prefix}&sortBy=tokenBalance&sortOrder=asc`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const ids = body.data.items.map((item: { id: string }) => item.id);
      assert.deepEqual(ids, [walletB.id, walletC.id, walletA.id]);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { id: { in: [walletA.id, walletB.id, walletC.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    }
  });

  test('13. Default updatedAt descending sorting is stable', async () => {
    const prefix = `Stable_${crypto.randomUUID()}`;
    const baseDate = new Date('2026-08-01T12:00:00.000Z');
    const users = await Promise.all([
      createUser({ displayName: `${prefix}A` }),
      createUser({ displayName: `${prefix}B` }),
      createUser({ displayName: `${prefix}C` }),
    ]);
    const wallets = await Promise.all(
      users.map((u, i) =>
        prisma.tokenWallet.create({
          data: { userId: u.id, tokenBalance: i + 1, status: WalletStatus.ACTIVE, createdAt: baseDate, updatedAt: baseDate },
        }),
      ),
    );
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets?search=${prefix}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const ids = body.data.items.map((item: { id: string }) => item.id);
      assert.equal(ids.length, 3);
      const expectedOrder = wallets.map((w) => w.id).sort().reverse();
      assert.deepEqual(ids, expectedOrder);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { id: { in: wallets.map((w) => w.id) } } });
      await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    }
  });

  test('14. Soft-deleted users are excluded from the wallet list', async () => {
    const user = await createUser({ displayName: `Deleted_${crypto.randomUUID()}`, isDeleted: true });
    const wallet = await createWallet(user.id, 100);
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets?search=Deleted_`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const found = body.data.items.find((item: { id: string }) => item.id === wallet.id);
      assert.equal(found, undefined);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('15. Wallet list response contains only allowed safe fields', async () => {
    const user = await createUser({ displayName: 'SafeFieldsUser' });
    const wallet = await createWallet(user.id, 42);
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets?search=SafeFieldsUser`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const found = body.data.items.find((item: { id: string }) => item.id === wallet.id);
      assert.ok(found);

      const expectedItemKeys = ['id', 'userId', 'tokenBalance', 'status', 'createdAt', 'updatedAt', 'user'].sort();
      assert.deepEqual(Object.keys(found).sort(), expectedItemKeys);
      const expectedUserKeys = ['id', 'email', 'displayName', 'isActive', 'isBanned'].sort();
      assert.deepEqual(Object.keys(found.user).sort(), expectedUserKeys);
      assert.equal(Object.prototype.hasOwnProperty.call(found.user, 'passwordHash'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(found.user, 'roleId'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(found.user, 'deletedAt'), false);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  /* ========== Wallet details ========== */

  test('16. Missing target user returns 404', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-wallets/00000000-0000-4000-8000-000000000000`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 404);
    assert.equal(body.error, 'User not found');
  });

  test('17. Soft-deleted target user returns 404', async () => {
    const user = await createUser({ isDeleted: true });
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 404);
      assert.equal(body.error, 'User not found');
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('18. User without a wallet returns a safe virtual state and creates no wallet', async () => {
    const user = await createUser({ displayName: 'No Wallet User' });
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.wallet.id, null);
      assert.equal(body.data.wallet.userId, user.id);
      assert.equal(body.data.wallet.tokenBalance, 0);
      assert.equal(body.data.wallet.status, 'ACTIVE');
      assert.equal(body.data.wallet.createdAt, null);
      assert.equal(body.data.wallet.updatedAt, null);
      assert.deepEqual(body.data.summary, {
        remainingTokens: 0,
        purchasedTokens: 0,
        consumedTokens: 0,
        refundedTokens: 0,
        netConsumedTokens: 0,
        bonusTokens: 0,
        adjustmentCredits: 0,
        adjustmentDebits: 0,
        netAdjustments: 0,
      });
      assert.equal(await prisma.tokenWallet.count({ where: { userId: user.id } }), 0);
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('19. User with a wallet returns real wallet fields', async () => {
    const user = await createUser({ displayName: 'Real Wallet User' });
    const wallet = await createWallet(user.id, 250, WalletStatus.ACTIVE);
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.data.wallet.id, wallet.id);
      assert.equal(body.data.wallet.userId, user.id);
      assert.equal(body.data.wallet.tokenBalance, 250);
      assert.equal(body.data.wallet.status, 'ACTIVE');
      assert.equal(typeof body.data.wallet.createdAt, 'string');
      assert.equal(typeof body.data.wallet.updatedAt, 'string');
      assert.equal(body.data.user.id, user.id);
      assert.equal(body.data.user.email, user.email);
      assert.equal(body.data.user.displayName, 'Real Wallet User');
      assert.equal(body.data.summary.remainingTokens, 250);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('20. Summary correctly calculates all token metrics', async () => {
    const user = await createUser({ displayName: 'Summary User' });
    const wallet = await createWallet(user.id, 150);
    try {
      await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.GRANT,
        source: TokenTransactionSource.PURCHASE,
        tokens: 200,
        referenceId: 'grant:summary',
      });
      await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 50,
        referenceId: 'bonus:summary',
      });
      await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.CHAT,
        tokens: 100,
        referenceId: 'consume:summary',
      });
      await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.REFUND,
        source: TokenTransactionSource.CHAT,
        tokens: 30,
        referenceId: 'refund:summary',
      });

      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.deepEqual(body.data.summary, {
        remainingTokens: 150,
        purchasedTokens: 200,
        consumedTokens: 100,
        refundedTokens: 30,
        netConsumedTokens: 70,
        bonusTokens: 50,
        adjustmentCredits: 0,
        adjustmentDebits: 0,
        netAdjustments: 0,
      });
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId: user.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  /* ========== Transactions ========== */

  test('21. User without transactions returns an empty paginated result', async () => {
    const user = await createUser();
    await createWallet(user.id, 0);
    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}/transactions`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.deepEqual(body.data, {
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('22. Transactions return newest first by default', async () => {
    const user = await createUser();
    const wallet = await createWallet(user.id, 0);
    try {
      const t1 = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 10,
        referenceId: 'bonus:first',
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
      });
      const t2 = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 20,
        referenceId: 'bonus:second',
        createdAt: new Date('2026-08-02T10:00:00.000Z'),
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}/transactions`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const ids = body.data.items.map((item: { id: string }) => item.id);
      assert.deepEqual(ids, [t2.id, t1.id]);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId: user.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('23. Stable secondary ID ordering is applied', async () => {
    const user = await createUser();
    const wallet = await createWallet(user.id, 0);
    const exactTs = new Date('2026-08-01T12:00:00.000Z');
    try {
      const t1 = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 10,
        referenceId: 'bonus:stable1',
        createdAt: exactTs,
      });
      const t2 = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 20,
        referenceId: 'bonus:stable2',
        createdAt: exactTs,
      });
      const t3 = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 30,
        referenceId: 'bonus:stable3',
        createdAt: exactTs,
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}/transactions`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const ids = body.data.items.map((item: { id: string }) => item.id);
      const expectedOrder = [t1.id, t2.id, t3.id].sort().reverse();
      assert.deepEqual(ids, expectedOrder);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId: user.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('24. Type filter works', async () => {
    const user = await createUser();
    const wallet = await createWallet(user.id, 0);
    try {
      await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.CHAT,
        tokens: 5,
        referenceId: 'consume:type',
      });
      const bonus = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 50,
        referenceId: 'bonus:type',
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}/transactions?type=BONUS`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const ids = body.data.items.map((item: { id: string }) => item.id);
      assert.deepEqual(ids, [bonus.id]);
      for (const item of body.data.items) {
        assert.equal(item.type, 'BONUS');
      }
      assert.equal(body.data.pagination.total, 1);
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId: user.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('25. Source filter works', async () => {
    const user = await createUser();
    const wallet = await createWallet(user.id, 0);
    try {
      await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.ADMIN,
        tokens: 5,
        referenceId: 'admin-source',
      });
      const imageTx = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.CONSUME,
        source: TokenTransactionSource.IMAGE,
        tokens: 5,
        referenceId: 'image-source',
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}/transactions?source=IMAGE`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const ids = body.data.items.map((item: { id: string }) => item.id);
      assert.deepEqual(ids, [imageTx.id]);
      for (const item of body.data.items) {
        assert.equal(item.source, 'IMAGE');
      }
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId: user.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('26. dateFrom/dateTo filtering works', async () => {
    const user = await createUser();
    const wallet = await createWallet(user.id, 0);
    try {
      const before = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 10,
        referenceId: 'bonus:before',
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
      });
      const inside = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 20,
        referenceId: 'bonus:inside',
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
      });
      const after = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 30,
        referenceId: 'bonus:after',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      });

      const dateFrom = new Date('2026-07-01T00:00:00.000Z');
      const dateTo = new Date('2026-07-31T23:59:59.999Z');
      const params = new URLSearchParams({
        dateFrom: dateFrom.toISOString(),
        dateTo: dateTo.toISOString(),
        sortOrder: 'asc',
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}/transactions?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const ids = body.data.items.map((item: { id: string }) => item.id);
      assert.deepEqual(ids, [inside.id]);
      assert.ok(!ids.includes(before.id));
      assert.ok(!ids.includes(after.id));
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId: user.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('27. Invalid date range returns 400', async () => {
    const user = await createUser();
    try {
      const params = new URLSearchParams({
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-07-01T00:00:00.000Z',
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}/transactions?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  test('28. Missing user returns 404 for transactions', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-wallets/00000000-0000-4000-8000-000000000000/transactions`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 404);
    assert.equal(body.error, 'User not found');
  });

  test('29. Transaction response contains all required fields', async () => {
    const user = await createUser();
    const wallet = await createWallet(user.id, 100);
    try {
      const tx = await createDirectTransaction(user.id, wallet.id, {
        type: TokenTransactionType.BONUS,
        source: TokenTransactionSource.ADMIN,
        tokens: 100,
        referenceId: 'bonus:550e8400-e29b-41d4-a716-446655440000',
        metadata: { reason: 'Campaign', previousBalance: 0, newBalance: 100 },
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${user.id}/transactions?limit=100`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const found = body.data.items.find((item: { id: string }) => item.id === tx.id);
      assert.ok(found);
      const expectedKeys = [
        'id', 'walletId', 'userId', 'type', 'tokens', 'source',
        'paymentId', 'referenceId', 'metadata', 'createdAt',
      ].sort();
      assert.deepEqual(Object.keys(found).sort(), expectedKeys);
      assert.equal(found.walletId, wallet.id);
      assert.equal(found.userId, user.id);
      assert.equal(found.type, 'BONUS');
      assert.equal(found.tokens, 100);
      assert.equal(found.source, 'ADMIN');
      assert.equal(found.paymentId, null);
      assert.equal(found.referenceId, 'bonus:550e8400-e29b-41d4-a716-446655440000');
      assert.deepEqual(found.metadata, { reason: 'Campaign', previousBalance: 0, newBalance: 100 });
      assert.equal(typeof found.createdAt, 'string');
    } finally {
      await prisma.tokenTransaction.deleteMany({ where: { userId: user.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  /* ========== Bonus ========== */

  test('30. Granting bonus to a user without a wallet creates an ACTIVE wallet, increments balance, records one transaction and one audit log', async () => {
    const target = await createTargetUser();
    const key = crypto.randomUUID();
    const paymentCountBefore = await prisma.payment.count();
    const packageCountBefore = await prisma.tokenPackage.count();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 100,
        reason: 'Welcome campaign',
        idempotencyKey: key,
      });
      assert.equal(status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.userId, target.id);
      assert.equal(body.data.tokensGranted, 100);
      assert.equal(body.data.previousBalance, 0);
      assert.equal(body.data.newBalance, 100);
      assert.equal(body.data.reason, 'Welcome campaign');
      assert.equal(body.data.idempotentReplay, false);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.ok(wallet, 'Wallet should be created');
      assert.equal(wallet.tokenBalance, 100);
      assert.equal(wallet.status, WalletStatus.ACTIVE);

      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      assert.equal(transactions.length, 1);
      assert.equal(transactions[0].type, TokenTransactionType.BONUS);
      assert.equal(transactions[0].source, TokenTransactionSource.ADMIN);
      assert.equal(transactions[0].tokens, 100);
      assert.equal(transactions[0].paymentId, null);
      assert.equal(transactions[0].referenceId, `bonus:${key}`);
      assert.equal(transactions[0].walletId, wallet.id);

      const auditLogs = await prisma.auditLog.findMany({ where: { targetUserId: target.id } });
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'token_bonus_granted');
      assert.equal(auditLogs[0].actorId, ADMIN_USER_ID);

      assert.equal(await prisma.payment.count(), paymentCountBefore);
      assert.equal(await prisma.tokenPackage.count(), packageCountBefore);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('31. Granting bonus to an existing ACTIVE wallet preserves previous balance and increments atomically', async () => {
    const target = await createTargetUser({ tokenBalance: 150, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 50,
        reason: 'Reward bonus',
        idempotencyKey: key,
      });
      assert.equal(status, 201);
      assert.equal(body.data.previousBalance, 150);
      assert.equal(body.data.newBalance, 200);
      assert.equal(await (async () => {
        const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
        return wallet?.tokenBalance;
      })(), 200);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('32. Transaction metadata contains reason, actorId, idempotencyKey, previousBalance, and newBalance', async () => {
    const target = await createTargetUser({ tokenBalance: 10, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    try {
      const { status } = await postBonus(target.id, {
        tokens: 40,
        reason: 'Metadata check',
        idempotencyKey: key,
      });
      assert.equal(status, 201);
      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      assert.equal(transactions.length, 1);
      assert.deepEqual(transactions[0].metadata, {
        reason: 'Metadata check',
        actorId: ADMIN_USER_ID,
        idempotencyKey: key,
        previousBalance: 10,
        newBalance: 50,
      });
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('33. AuditLog contains actorId, targetUserId, action, and expected metadata', async () => {
    const target = await createTargetUser({ tokenBalance: 20, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    try {
      const { status } = await postBonus(target.id, {
        tokens: 30,
        reason: 'Audit check',
        idempotencyKey: key,
      });
      assert.equal(status, 201);
      const auditLogs = await prisma.auditLog.findMany({ where: { targetUserId: target.id } });
      assert.equal(auditLogs.length, 1);
      const audit = auditLogs[0];
      assert.equal(audit.actorId, ADMIN_USER_ID);
      assert.equal(audit.targetUserId, target.id);
      assert.equal(audit.action, 'token_bonus_granted');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.ok(wallet);
      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      assert.equal(transactions.length, 1);
      assert.deepEqual(audit.metadata, {
        walletId: wallet.id,
        transactionId: transactions[0].id,
        tokens: 30,
        reason: 'Audit check',
        idempotencyKey: key,
        previousBalance: 20,
        newBalance: 50,
      });
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('34. Repeating the exact same request returns 200 idempotent replay without double-crediting', async () => {
    const target = await createTargetUser();
    const key = crypto.randomUUID();
    const body = { tokens: 100, reason: 'Replay test', idempotencyKey: key };
    try {
      const first = await postBonus(target.id, body);
      assert.equal(first.status, 201);
      assert.equal(first.body.data.idempotentReplay, false);
      const firstTransactionId = first.body.data.transactionId;

      const second = await postBonus(target.id, body);
      assert.equal(second.status, 200);
      assert.equal(second.body.success, true);
      assert.equal(second.body.data.idempotentReplay, true);
      assert.equal(second.body.data.transactionId, firstTransactionId);
      assert.equal(second.body.data.walletId, first.body.data.walletId);
      assert.equal(second.body.data.tokensGranted, 100);
      assert.equal(second.body.data.previousBalance, 0);
      assert.equal(second.body.data.newBalance, 100);
      assert.equal(second.body.data.createdAt, first.body.data.createdAt);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 100);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('35. Reusing the idempotency key with a different amount returns 409', async () => {
    const target = await createTargetUser();
    const key = crypto.randomUUID();
    try {
      const first = await postBonus(target.id, { tokens: 100, reason: 'Conflict amount', idempotencyKey: key });
      assert.equal(first.status, 201);

      const second = await postBonus(target.id, { tokens: 200, reason: 'Conflict amount', idempotencyKey: key });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token bonus idempotency conflict');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 100);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('36. Reusing the idempotency key with a different reason returns 409', async () => {
    const target = await createTargetUser();
    const key = crypto.randomUUID();
    try {
      const first = await postBonus(target.id, { tokens: 100, reason: 'Original reason', idempotencyKey: key });
      assert.equal(first.status, 201);

      const second = await postBonus(target.id, { tokens: 100, reason: 'Changed reason', idempotencyKey: key });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token bonus idempotency conflict');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 100);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('37. Reusing the idempotency key for another user returns 409', async () => {
    const targetA = await createTargetUser();
    const targetB = await createTargetUser();
    const key = crypto.randomUUID();
    try {
      const first = await postBonus(targetA.id, { tokens: 100, reason: 'Cross user', idempotencyKey: key });
      assert.equal(first.status, 201);

      const second = await postBonus(targetB.id, { tokens: 100, reason: 'Cross user', idempotencyKey: key });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token bonus idempotency conflict');

      const walletB = await prisma.tokenWallet.findUnique({ where: { userId: targetB.id } });
      assert.equal(walletB, null);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: targetB.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: targetB.id } }), 0);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: { in: [targetA.id, targetB.id] } } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: { in: [targetA.id, targetB.id] } } });
      await prisma.tokenWallet.deleteMany({ where: { userId: { in: [targetA.id, targetB.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [targetA.id, targetB.id] } } });
    }
  });

  test('38. INACTIVE wallet returns 403 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 500, status: WalletStatus.INACTIVE });
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 100,
        reason: 'Inactive wallet',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 403);
      assert.equal(body.error, 'Token wallet is not active');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 500);
      assert.equal(wallet?.status, WalletStatus.INACTIVE);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('39. BLOCKED wallet returns 403 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 500, status: WalletStatus.BLOCKED });
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 100,
        reason: 'Blocked wallet',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 403);
      assert.equal(body.error, 'Token wallet is not active');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 500);
      assert.equal(wallet?.status, WalletStatus.BLOCKED);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('40. Missing target user returns 404 and writes nothing', async () => {
    const missingId = crypto.randomUUID();
    const { status, body } = await postBonus(missingId, {
      tokens: 100,
      reason: 'Missing user',
      idempotencyKey: crypto.randomUUID(),
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'User not found');
    assert.equal(await prisma.tokenWallet.count({ where: { userId: missingId } }), 0);
    assert.equal(await prisma.tokenTransaction.count({ where: { userId: missingId } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { targetUserId: missingId } }), 0);
  });

  test('41. Soft-deleted target returns 404 and writes nothing', async () => {
    const target = await createTargetUser();
    await prisma.user.update({ where: { id: target.id }, data: { isDeleted: true } });
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 100,
        reason: 'Deleted target',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 404);
      assert.equal(body.error, 'User not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('42. Zero tokens returns 400', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 0,
        reason: 'Zero tokens',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('43. Negative tokens returns 400', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: -10,
        reason: 'Negative tokens',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('44. Decimal tokens returns 400', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 10.5,
        reason: 'Decimal tokens',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('45. Numeric-string tokens returns 400', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: '100',
        reason: 'String tokens',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('46. Blank or short reason returns 400', async () => {
    const target = await createTargetUser();
    try {
      for (const reason of ['', '  ', 'ab']) {
        const { status, body } = await postBonus(target.id, {
          tokens: 10,
          reason,
          idempotencyKey: crypto.randomUUID(),
        });
        assert.equal(status, 400);
        assert.equal(body.error, 'Validation error');
      }
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('47. Invalid idempotency UUID returns 400', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 10,
        reason: 'Invalid key',
        idempotencyKey: 'not-a-uuid',
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('48. Unknown request body properties return 400', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 10,
        reason: 'Unknown props',
        idempotencyKey: crypto.randomUUID(),
        extraField: 'nope',
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('49. Two concurrent requests with the same idempotency key result in one grant and one replay', async () => {
    const target = await createTargetUser();
    const key = crypto.randomUUID();
    const body = { tokens: 100, reason: 'Concurrent same key', idempotencyKey: key };
    try {
      const [resA, resB] = await Promise.all([
        postBonus(target.id, body),
        postBonus(target.id, body),
      ]);

      const statuses = [resA.status, resB.status].sort();
      assert.deepEqual(statuses, [200, 201]);

      const created = resA.status === 201 ? resA : resB;
      const replay = resA.status === 200 ? resA : resB;
      assert.equal(created.body.data.idempotentReplay, false);
      assert.equal(replay.body.data.idempotentReplay, true);
      assert.equal(replay.body.data.transactionId, created.body.data.transactionId);
      assert.equal(replay.body.data.newBalance, created.body.data.newBalance);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 100);
      assert.equal(wallet?.status, WalletStatus.ACTIVE);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('50. Two concurrent requests with different idempotency keys both succeed', async () => {
    const target = await createTargetUser();
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    try {
      const [resA, resB] = await Promise.all([
        postBonus(target.id, { tokens: 100, reason: 'Concurrent A', idempotencyKey: keyA }),
        postBonus(target.id, { tokens: 100, reason: 'Concurrent B', idempotencyKey: keyB }),
      ]);

      assert.deepEqual([resA.status, resB.status].sort(), [201, 201]);
      assert.equal(resA.body.data.idempotentReplay, false);
      assert.equal(resB.body.data.idempotentReplay, false);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 200);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 2);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 2);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('51. A failure after wallet creation rolls back wallet creation and all bonus writes', async () => {
    const target = await createUser();
    try {
      await assert.rejects(
        grantBonus(ADMIN_USER_ID, target.id, {
          tokens: 3000000000,
          reason: 'Rollback atomicity',
          idempotencyKey: crypto.randomUUID(),
        }),
      );

      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('52. A single bonus above the Int maximum returns 400 and creates no records', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 2_147_483_648,
        reason: 'Above Int maximum',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('53. A bonus that would push the balance above the Int maximum returns 409 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 2_147_483_600, status: WalletStatus.ACTIVE });
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 100,
        reason: 'Would exceed maximum',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 409);
      assert.equal(body.error, 'Token balance limit exceeded');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 2_147_483_600);
      assert.equal(wallet?.status, WalletStatus.ACTIVE);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('54. A bonus that lands exactly on the Int maximum succeeds with correct balances', async () => {
    const target = await createTargetUser({ tokenBalance: 2_147_483_547, status: WalletStatus.ACTIVE });
    try {
      const { status, body } = await postBonus(target.id, {
        tokens: 100,
        reason: 'Exact maximum',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 201);
      assert.equal(body.data.idempotentReplay, false);
      assert.equal(body.data.tokensGranted, 100);
      assert.equal(body.data.previousBalance, 2_147_483_547);
      assert.equal(body.data.newBalance, 2_147_483_647);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 2_147_483_647);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('55. Concurrent different keys on an existing wallet produce a valid balance transition chain', async () => {
    const target = await createTargetUser({ tokenBalance: 0, status: WalletStatus.ACTIVE });
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    try {
      const [resA, resB] = await Promise.all([
        postBonus(target.id, { tokens: 100, reason: 'Chain A', idempotencyKey: keyA }),
        postBonus(target.id, { tokens: 100, reason: 'Chain B', idempotencyKey: keyB }),
      ]);

      assert.deepEqual([resA.status, resB.status].sort(), [201, 201]);
      assert.equal(resA.body.data.idempotentReplay, false);
      assert.equal(resB.body.data.idempotentReplay, false);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 200);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 2);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 2);

      const transactions = await prisma.tokenTransaction.findMany({
        where: { userId: target.id },
        select: { metadata: true },
      });
      const transitions = transactions.map((transaction) => {
        const metadata = transaction.metadata as { previousBalance: number; newBalance: number };
        return `${metadata.previousBalance}:${metadata.newBalance}`;
      });
      assert.deepEqual(transitions.sort(), ['0:100', '100:200']);
    } finally {
      await prisma.auditLog.deleteMany({ where: { targetUserId: target.id } });
      await prisma.tokenTransaction.deleteMany({ where: { userId: target.id } });
      await prisma.tokenWallet.deleteMany({ where: { userId: target.id } });
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  /* ========== Adjustment ========== */

  test('56. POST adjustment without authorization returns 401', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-wallets/00000000-0000-4000-8000-000000000000/adjustments`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
    );
    assert.equal(status, 401);
    assert.equal(body.error, 'Missing or invalid authorization header');
  });

  test('57. POST adjustment with USER role returns 403', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-wallets/00000000-0000-4000-8000-000000000000/adjustments`,
      {
        method: 'POST',
        headers: { ...userHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'Insufficient permissions');
  });

  test('58. Valid admin JWT whose actor user is missing returns 401 and creates no records', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postAdjustment(
        target.id,
        { operation: 'CREDIT', tokens: 50, reason: 'Missing actor', idempotencyKey: crypto.randomUUID() },
        { Authorization: `Bearer ${MISSING_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      );
      assert.equal(status, 401);
      assert.equal(body.error, 'Authenticated user not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('59. Invalid adjustment request bodies return 400 and create no records', async () => {
    const target = await createTargetUser();
    const valid = {
      operation: 'CREDIT',
      tokens: 10,
      reason: 'Valid base adjustment',
      idempotencyKey: crypto.randomUUID(),
    };
    const cases: Record<string, unknown>[] = [
      { ...valid, operation: undefined },
      { ...valid, operation: 'ADUSTMENT' },
      { ...valid, operation: 'TOPUP' },
      { ...valid, tokens: 0 },
      { ...valid, tokens: -10 },
      { ...valid, tokens: 10.5 },
      { ...valid, tokens: '100' },
      { ...valid, tokens: 2_147_483_648 },
      { ...valid, reason: '' },
      { ...valid, reason: '  ' },
      { ...valid, reason: 'ab' },
      { ...valid, reason: 'abcd' },
      { ...valid, idempotencyKey: 'not-a-uuid' },
      { ...valid, extraField: 'nope' },
      { ...valid, paymentId: 'not-a-uuid' },
      { ...valid, relatedTransactionId: 'not-a-uuid' },
    ];
    try {
      for (const body of cases) {
        const { status, body: responseBody } = await postAdjustment(target.id, body);
        assert.equal(status, 400, JSON.stringify(body));
        assert.equal(responseBody.error, 'Validation error', JSON.stringify(body));
      }
      await assertNoBonusWrites(target.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('60. Missing target user returns 404 and writes nothing', async () => {
    const missingId = crypto.randomUUID();
    const { status, body } = await postAdjustment(missingId, {
      operation: 'CREDIT',
      tokens: 100,
      reason: 'Missing user',
      idempotencyKey: crypto.randomUUID(),
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'User not found');
    assert.equal(await prisma.tokenWallet.count({ where: { userId: missingId } }), 0);
    assert.equal(await prisma.tokenTransaction.count({ where: { userId: missingId } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { targetUserId: missingId } }), 0);
  });

  test('61. Soft-deleted target user returns 404 and writes nothing', async () => {
    const target = await createTargetUser();
    await prisma.user.update({ where: { id: target.id }, data: { isDeleted: true } });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 100,
        reason: 'Deleted target',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 404);
      assert.equal(body.error, 'User not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.deleteMany({ where: { id: target.id } });
    }
  });

  test('62. CREDIT to a user without a wallet creates an ACTIVE wallet, increments balance, records one ADJUSTMENT transaction and one audit log', async () => {
    const target = await createTargetUser();
    const key = crypto.randomUUID();
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 120,
        reason: 'Manual credit',
        idempotencyKey: key,
      });
      assert.equal(status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.userId, target.id);
      assert.equal(body.data.operation, 'CREDIT');
      assert.equal(body.data.tokensAdjusted, 120);
      assert.equal(body.data.tokens, undefined);
      assert.equal(body.data.previousBalance, 0);
      assert.equal(body.data.newBalance, 120);
      assert.equal(body.data.reason, 'Manual credit');
      assert.equal(body.data.paymentId, null);
      assert.equal(body.data.relatedTransactionId, null);
      assert.equal(body.data.idempotentReplay, false);
      assert.equal(typeof body.data.createdAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(body.data.createdAt)));

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 120);
      assert.equal(wallet.status, WalletStatus.ACTIVE);

      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      assert.equal(transactions.length, 1);
      assert.equal(transactions[0].type, TokenTransactionType.ADJUSTMENT);
      assert.equal(transactions[0].source, TokenTransactionSource.ADMIN);
      assert.equal(transactions[0].tokens, 120);
      assert.equal(transactions[0].paymentId, null);
      assert.equal(transactions[0].referenceId, `adjustment:${key}`);
      assert.equal(transactions[0].walletId, wallet.id);

      const auditLogs = await prisma.auditLog.findMany({ where: { targetUserId: target.id } });
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'token_adjustment_created');
      assert.equal(auditLogs[0].actorId, ADMIN_USER_ID);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('63. CREDIT to an existing ACTIVE wallet preserves previous balance and stores operation in metadata', async () => {
    const target = await createTargetUser({ tokenBalance: 30, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 40,
        reason: 'Metadata credit',
        idempotencyKey: key,
      });
      assert.equal(status, 201);
      assert.equal(body.data.previousBalance, 30);
      assert.equal(body.data.newBalance, 70);

      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      assert.equal(transactions.length, 1);
      assert.deepEqual(transactions[0].metadata, {
        operation: 'CREDIT',
        reason: 'Metadata credit',
        actorId: ADMIN_USER_ID,
        idempotencyKey: key,
        previousBalance: 30,
        newBalance: 70,
        relatedTransactionId: null,
      });
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('64. CREDIT that would push the balance above the Int maximum returns 409 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 2_147_483_600, status: WalletStatus.ACTIVE });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 100,
        reason: 'Would exceed maximum',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 409);
      assert.equal(body.error, 'Token balance limit exceeded');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 2_147_483_600);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('65. CREDIT that lands exactly on the Int maximum succeeds with correct balances', async () => {
    const target = await createTargetUser({ tokenBalance: 2_147_483_547, status: WalletStatus.ACTIVE });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 100,
        reason: 'Exact maximum credit',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 201);
      assert.equal(body.data.idempotentReplay, false);
      assert.equal(body.data.previousBalance, 2_147_483_547);
      assert.equal(body.data.newBalance, 2_147_483_647);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 2_147_483_647);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('66. DEBIT to a user without a wallet returns 409 and creates no wallet or records', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 50,
        reason: 'Debit missing wallet',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 409);
      assert.equal(body.error, 'Insufficient token balance for adjustment');
      assert.equal(await prisma.tokenWallet.count({ where: { userId: target.id } }), 0);
      await assertNoBonusWrites(target.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('67. DEBIT with sufficient balance decrements atomically and records one transaction and one audit log', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 60,
        reason: 'Manual debit',
        idempotencyKey: key,
      });
      assert.equal(status, 201);
      assert.equal(body.data.operation, 'DEBIT');
      assert.equal(body.data.previousBalance, 200);
      assert.equal(body.data.newBalance, 140);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 140);

      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      assert.equal(transactions.length, 1);
      assert.equal(transactions[0].type, TokenTransactionType.ADJUSTMENT);
      assert.equal(transactions[0].source, TokenTransactionSource.ADMIN);
      assert.equal(transactions[0].tokens, 60);
      assert.equal(transactions[0].referenceId, `adjustment:${key}`);
      const metadata = transactions[0].metadata as { operation: string };
      assert.equal(metadata.operation, 'DEBIT');

      const auditLogs = await prisma.auditLog.findMany({ where: { targetUserId: target.id } });
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'token_adjustment_created');
      assert.equal(auditLogs[0].actorId, ADMIN_USER_ID);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('68. DEBIT that lands exactly on zero succeeds', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.ACTIVE });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 100,
        reason: 'Debit to zero',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 201);
      assert.equal(body.data.previousBalance, 100);
      assert.equal(body.data.newBalance, 0);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 0);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('69. DEBIT with insufficient balance returns 409 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 10, status: WalletStatus.ACTIVE });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 100,
        reason: 'Insufficient debit',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 409);
      assert.equal(body.error, 'Insufficient token balance for adjustment');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 10);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('70. DEBIT on an INACTIVE wallet returns 403 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 500, status: WalletStatus.INACTIVE });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 100,
        reason: 'Inactive debit',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 403);
      assert.equal(body.error, 'Token wallet is not active');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 500);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('71. DEBIT on a BLOCKED wallet returns 403 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 500, status: WalletStatus.BLOCKED });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 100,
        reason: 'Blocked debit',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 403);
      assert.equal(body.error, 'Token wallet is not active');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 500);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('72. Repeating the exact same adjustment request returns 200 idempotent replay without double-applying', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    const body = { operation: 'DEBIT', tokens: 40, reason: 'Replay adjustment', idempotencyKey: key };
    try {
      const first = await postAdjustment(target.id, body);
      assert.equal(first.status, 201);
      assert.equal(first.body.data.idempotentReplay, false);
      const firstTransactionId = first.body.data.transactionId;

      const second = await postAdjustment(target.id, body);
      assert.equal(second.status, 200);
      assert.equal(second.body.success, true);
      assert.equal(second.body.data.idempotentReplay, true);
      assert.equal(second.body.data.transactionId, firstTransactionId);
      assert.equal(second.body.data.walletId, first.body.data.walletId);
      assert.equal(second.body.data.userId, first.body.data.userId);
      assert.equal(second.body.data.operation, 'DEBIT');
      assert.equal(second.body.data.tokensAdjusted, 40);
      assert.equal(second.body.data.tokens, undefined);
      assert.equal(second.body.data.previousBalance, 100);
      assert.equal(second.body.data.newBalance, 60);
      assert.equal(second.body.data.reason, 'Replay adjustment');
      assert.equal(second.body.data.paymentId, first.body.data.paymentId);
      assert.equal(second.body.data.relatedTransactionId, first.body.data.relatedTransactionId);
      assert.equal(second.body.data.createdAt, first.body.data.createdAt);
      assert.equal(typeof second.body.data.createdAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(second.body.data.createdAt)));

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 60);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('73. Reusing the idempotency key with a different token amount returns 409', async () => {
    const target = await createTargetUser({ tokenBalance: 500, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    try {
      const first = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 50,
        reason: 'Conflict amount',
        idempotencyKey: key,
      });
      assert.equal(first.status, 201);

      const second = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 100,
        reason: 'Conflict amount',
        idempotencyKey: key,
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token adjustment idempotency conflict');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 450);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('74. Reusing the idempotency key with a different operation returns 409', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    try {
      const first = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Conflict operation',
        idempotencyKey: key,
      });
      assert.equal(first.status, 201);

      const second = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 50,
        reason: 'Conflict operation',
        idempotencyKey: key,
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token adjustment idempotency conflict');
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('75. Reusing the idempotency key with a different reason returns 409', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    try {
      const first = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Original reason',
        idempotencyKey: key,
      });
      assert.equal(first.status, 201);

      const second = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Changed reason',
        idempotencyKey: key,
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token adjustment idempotency conflict');
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('76. Reusing the idempotency key for another user returns 409', async () => {
    const targetA = await createTargetUser();
    const targetB = await createTargetUser();
    const key = crypto.randomUUID();
    try {
      const first = await postAdjustment(targetA.id, {
        operation: 'CREDIT',
        tokens: 100,
        reason: 'Cross user',
        idempotencyKey: key,
      });
      assert.equal(first.status, 201);

      const second = await postAdjustment(targetB.id, {
        operation: 'CREDIT',
        tokens: 100,
        reason: 'Cross user',
        idempotencyKey: key,
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token adjustment idempotency conflict');

      const walletB = await prisma.tokenWallet.findUnique({ where: { userId: targetB.id } });
      assert.equal(walletB, null);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: targetB.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: targetB.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(targetA.id);
      await cleanupAdjustmentRefs(targetB.id);
    }
  });

  test('77. Two concurrent CREDIT requests with the same idempotency key result in one application and one replay', async () => {
    const target = await createTargetUser();
    const key = crypto.randomUUID();
    const body = { operation: 'CREDIT', tokens: 100, reason: 'Concurrent same key', idempotencyKey: key };
    try {
      const [resA, resB] = await Promise.all([
        postAdjustment(target.id, body),
        postAdjustment(target.id, body),
      ]);

      const statuses = [resA.status, resB.status].sort();
      assert.deepEqual(statuses, [200, 201]);

      const created = resA.status === 201 ? resA : resB;
      const replay = resA.status === 200 ? resA : resB;
      assert.equal(created.body.data.idempotentReplay, false);
      assert.equal(replay.body.data.idempotentReplay, true);
      assert.equal(replay.body.data.transactionId, created.body.data.transactionId);
      assert.equal(replay.body.data.newBalance, created.body.data.newBalance);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 100);
      assert.equal(wallet?.status, WalletStatus.ACTIVE);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('78. Two concurrent adjustments with different idempotency keys both succeed with a valid balance transition chain', async () => {
    const target = await createTargetUser({ tokenBalance: 0, status: WalletStatus.ACTIVE });
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    try {
      const [resA, resB] = await Promise.all([
        postAdjustment(target.id, { operation: 'CREDIT', tokens: 100, reason: 'Chain A', idempotencyKey: keyA }),
        postAdjustment(target.id, { operation: 'CREDIT', tokens: 100, reason: 'Chain B', idempotencyKey: keyB }),
      ]);

      assert.deepEqual([resA.status, resB.status].sort(), [201, 201]);
      assert.equal(resA.body.data.idempotentReplay, false);
      assert.equal(resB.body.data.idempotentReplay, false);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 200);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 2);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 2);

      const transactions = await prisma.tokenTransaction.findMany({
        where: { userId: target.id },
        select: { metadata: true },
      });
      const transitions = transactions.map((transaction) => {
        const metadata = transaction.metadata as { previousBalance: number; newBalance: number };
        return `${metadata.previousBalance}:${metadata.newBalance}`;
      });
      assert.deepEqual(transitions.sort(), ['0:100', '100:200']);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('79. A CREDIT failure after wallet creation rolls back wallet creation and all adjustment writes', async () => {
    const target = await createUser();
    try {
      await assert.rejects(
        adjust(ADMIN_USER_ID, target.id, {
          operation: 'CREDIT',
          tokens: 3000000000,
          reason: 'Rollback credit atomicity',
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      await assertNoBonusWrites(target.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('80. A DEBIT failure rolls back all adjustment writes', async () => {
    const target = await createUser();
    await createWallet(target.id, 10);
    try {
      await assert.rejects(
        adjust(ADMIN_USER_ID, target.id, {
          operation: 'DEBIT',
          tokens: 100,
          reason: 'Rollback debit atomicity',
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 10);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('81. A CREDIT adjustment with a paymentId owned by the target user is accepted and stored', async () => {
    const target = await createTargetUser();
    const { payment, pkg } = await createTestPaymentForUser(target.id);
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Payment referenced',
        idempotencyKey: crypto.randomUUID(),
        paymentId: payment.id,
      });
      assert.equal(status, 201);
      assert.equal(body.data.userId, target.id);

      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      assert.equal(transactions.length, 1);
      assert.equal(transactions[0].paymentId, payment.id);
      assert.equal(transactions[0].type, TokenTransactionType.ADJUSTMENT);
      assert.equal(transactions[0].source, TokenTransactionSource.ADMIN);
    } finally {
      await cleanupAdjustmentRefs(target.id, [pkg.id]);
    }
  });

  test('82. A paymentId belonging to another user returns 404 and writes nothing', async () => {
    const target = await createTargetUser();
    const other = await createTargetUser();
    const { payment, pkg } = await createTestPaymentForUser(other.id);
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Foreign payment',
        idempotencyKey: crypto.randomUUID(),
        paymentId: payment.id,
      });
      assert.equal(status, 404);
      assert.equal(body.error, 'Payment not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
      await cleanupAdjustmentRefs(other.id, [pkg.id]);
    }
  });

  test('83. A nonexistent paymentId returns 404 and writes nothing', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Missing payment',
        idempotencyKey: crypto.randomUUID(),
        paymentId: crypto.randomUUID(),
      });
      assert.equal(status, 404);
      assert.equal(body.error, 'Payment not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('84. A relatedTransactionId owned by the target user is accepted and stored in metadata', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.ACTIVE });
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
    assert.ok(wallet);
    const related = await createDirectTransaction(target.id, wallet.id, {
      type: TokenTransactionType.GRANT,
      source: TokenTransactionSource.PURCHASE,
      tokens: 100,
      referenceId: 'grant:related-ref',
    });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 30,
        reason: 'Related transaction referenced',
        idempotencyKey: crypto.randomUUID(),
        relatedTransactionId: related.id,
      });
      assert.equal(status, 201);
      assert.equal(body.data.newBalance, 70);

      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      const adjustmentTx = transactions.find((t) => t.type === TokenTransactionType.ADJUSTMENT);
      assert.ok(adjustmentTx);
      const metadata = adjustmentTx.metadata as { relatedTransactionId: string };
      assert.equal(metadata.relatedTransactionId, related.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('85. A relatedTransactionId belonging to another user returns 404 and writes nothing', async () => {
    const target = await createTargetUser();
    const other = await createTargetUser();
    const otherWallet = await createWallet(other.id, 100);
    const foreignTx = await createDirectTransaction(other.id, otherWallet.id, {
      type: TokenTransactionType.GRANT,
      source: TokenTransactionSource.PURCHASE,
      tokens: 100,
      referenceId: 'grant:foreign-related-ref',
    });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Foreign related transaction',
        idempotencyKey: crypto.randomUUID(),
        relatedTransactionId: foreignTx.id,
      });
      assert.equal(status, 404);
      assert.equal(body.error, 'Related token transaction not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
      await cleanupAdjustmentRefs(other.id);
    }
  });

  test('86. A nonexistent relatedTransactionId returns 404 and writes nothing', async () => {
    const target = await createTargetUser();
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Missing related transaction',
        idempotencyKey: crypto.randomUUID(),
        relatedTransactionId: crypto.randomUUID(),
      });
      assert.equal(status, 404);
      assert.equal(body.error, 'Related token transaction not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('87. Both paymentId and relatedTransactionId are accepted together', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
    assert.ok(wallet);
    const { payment, pkg } = await createTestPaymentForUser(target.id);
    const related = await createDirectTransaction(target.id, wallet.id, {
      type: TokenTransactionType.GRANT,
      source: TokenTransactionSource.PURCHASE,
      tokens: 200,
      referenceId: 'grant:both-ref',
    });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 80,
        reason: 'Both references',
        idempotencyKey: crypto.randomUUID(),
        paymentId: payment.id,
        relatedTransactionId: related.id,
      });
      assert.equal(status, 201);
      assert.equal(body.data.newBalance, 120);

      const transactions = await prisma.tokenTransaction.findMany({ where: { userId: target.id } });
      const adjustmentTx = transactions.find((t) => t.type === TokenTransactionType.ADJUSTMENT);
      assert.ok(adjustmentTx);
      assert.equal(adjustmentTx.paymentId, payment.id);
      const metadata = adjustmentTx.metadata as { relatedTransactionId: string };
      assert.equal(metadata.relatedTransactionId, related.id);
    } finally {
      await cleanupAdjustmentRefs(target.id, [pkg.id]);
    }
  });

  test('88. Wallet details summary reflects adjustment credits and debits', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.ACTIVE });
    try {
      const credit = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 200,
        reason: 'Summary credit',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(credit.status, 201);

      const debit = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 50,
        reason: 'Summary debit',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(debit.status, 201);

      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-wallets/${target.id}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.deepEqual(body.data.summary, {
        remainingTokens: 250,
        purchasedTokens: 0,
        consumedTokens: 0,
        refundedTokens: 0,
        netConsumedTokens: 0,
        bonusTokens: 0,
        adjustmentCredits: 200,
        adjustmentDebits: 50,
        netAdjustments: 150,
      });
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('89. CREDIT on an INACTIVE wallet returns 403 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.INACTIVE });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Inactive credit',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 403);
      assert.equal(body.error, 'Token wallet is not active');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 100);
      assert.equal(wallet?.status, WalletStatus.INACTIVE);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('90. CREDIT on a BLOCKED wallet returns 403 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.BLOCKED });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Blocked credit',
        idempotencyKey: crypto.randomUUID(),
      });
      assert.equal(status, 403);
      assert.equal(body.error, 'Token wallet is not active');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 100);
      assert.equal(wallet?.status, WalletStatus.BLOCKED);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('91. A related transaction whose payment differs from the supplied paymentId returns 409 and writes nothing', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
    assert.ok(wallet);
    const { payment: paymentA, pkg: pkgA } = await createTestPaymentForUser(target.id);
    const { payment: paymentB, pkg: pkgB } = await createTestPaymentForUser(target.id);
    const related = await createDirectTransaction(target.id, wallet.id, {
      type: TokenTransactionType.GRANT,
      source: TokenTransactionSource.PURCHASE,
      tokens: 200,
      paymentId: paymentB.id,
      referenceId: 'grant:conflicting-payment-ref',
    });
    try {
      const { status, body } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 50,
        reason: 'Conflicting references',
        idempotencyKey: crypto.randomUUID(),
        paymentId: paymentA.id,
        relatedTransactionId: related.id,
      });
      assert.equal(status, 409);
      assert.equal(body.error, 'Adjustment reference conflict');

      const walletAfter = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(walletAfter?.tokenBalance, 200);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        }),
        0,
      );
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 0);
    } finally {
      await cleanupAdjustmentRefs(target.id, [pkgA.id, pkgB.id]);
    }
  });

  test('92. An exact replay of an adjustment with payment and related references returns the same response fields', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
    assert.ok(wallet);
    const { payment, pkg } = await createTestPaymentForUser(target.id);
    const related = await createDirectTransaction(target.id, wallet.id, {
      type: TokenTransactionType.GRANT,
      source: TokenTransactionSource.PURCHASE,
      tokens: 200,
      paymentId: payment.id,
      referenceId: 'grant:replay-related-ref',
    });
    const key = crypto.randomUUID();
    const body = {
      operation: 'DEBIT',
      tokens: 80,
      reason: 'Replay with references',
      idempotencyKey: key,
      paymentId: payment.id,
      relatedTransactionId: related.id,
    };
    try {
      const first = await postAdjustment(target.id, body);
      assert.equal(first.status, 201);
      assert.equal(first.body.data.tokensAdjusted, 80);
      assert.equal(first.body.data.paymentId, payment.id);
      assert.equal(first.body.data.relatedTransactionId, related.id);
      assert.equal(typeof first.body.data.createdAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(first.body.data.createdAt)));

      const second = await postAdjustment(target.id, body);
      assert.equal(second.status, 200);
      assert.equal(second.body.data.idempotentReplay, true);
      assert.equal(second.body.data.transactionId, first.body.data.transactionId);
      assert.equal(second.body.data.tokensAdjusted, 80);
      assert.equal(second.body.data.tokens, undefined);
      assert.equal(second.body.data.paymentId, payment.id);
      assert.equal(second.body.data.relatedTransactionId, related.id);
      assert.equal(second.body.data.createdAt, first.body.data.createdAt);

      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        }),
        1,
      );
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await cleanupAdjustmentRefs(target.id, [pkg.id]);
    }
  });

  test('93. Reusing the idempotency key with a different paymentId returns 409', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const { payment: paymentA, pkg: pkgA } = await createTestPaymentForUser(target.id);
    const { payment: paymentB, pkg: pkgB } = await createTestPaymentForUser(target.id);
    const key = crypto.randomUUID();
    try {
      const first = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Payment key conflict',
        idempotencyKey: key,
        paymentId: paymentA.id,
      });
      assert.equal(first.status, 201);

      const second = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Payment key conflict',
        idempotencyKey: key,
        paymentId: paymentB.id,
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token adjustment idempotency conflict');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 250);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        }),
        1,
      );
    } finally {
      await cleanupAdjustmentRefs(target.id, [pkgA.id, pkgB.id]);
    }
  });

  test('94. Reusing the idempotency key with a different relatedTransactionId returns 409', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
    assert.ok(wallet);
    const relatedA = await createDirectTransaction(target.id, wallet.id, {
      type: TokenTransactionType.GRANT,
      source: TokenTransactionSource.PURCHASE,
      tokens: 200,
      referenceId: 'grant:related-key-a',
    });
    const relatedB = await createDirectTransaction(target.id, wallet.id, {
      type: TokenTransactionType.GRANT,
      source: TokenTransactionSource.PURCHASE,
      tokens: 200,
      referenceId: 'grant:related-key-b',
    });
    const key = crypto.randomUUID();
    try {
      const first = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 50,
        reason: 'Related key conflict',
        idempotencyKey: key,
        relatedTransactionId: relatedA.id,
      });
      assert.equal(first.status, 201);

      const second = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 50,
        reason: 'Related key conflict',
        idempotencyKey: key,
        relatedTransactionId: relatedB.id,
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token adjustment idempotency conflict');

      const walletAfter = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(walletAfter?.tokenBalance, 150);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        }),
        1,
      );
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('95. Reusing the idempotency key with the same body from a different admin actor returns 409', async () => {
    const target = await createTargetUser({ tokenBalance: 100, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    const body = { operation: 'DEBIT', tokens: 40, reason: 'Actor key conflict', idempotencyKey: key };
    try {
      const first = await postAdjustment(target.id, body);
      assert.equal(first.status, 201);
      assert.equal(first.body.data.idempotentReplay, false);

      const second = await postAdjustment(
        target.id,
        body,
        { Authorization: `Bearer ${SECOND_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      );
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'Token adjustment idempotency conflict');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 60);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId: target.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('96. An adjustment referencing a payment leaves the referenced payment unchanged', async () => {
    const target = await createTargetUser();
    const { payment, pkg } = await createTestPaymentForUser(target.id);
    try {
      const before = await prisma.payment.findUnique({ where: { id: payment.id } });
      const { status } = await postAdjustment(target.id, {
        operation: 'CREDIT',
        tokens: 50,
        reason: 'Payment unchanged check',
        idempotencyKey: crypto.randomUUID(),
        paymentId: payment.id,
      });
      assert.equal(status, 201);

      const after = await prisma.payment.findUnique({ where: { id: payment.id } });
      assert.deepEqual(after, before);
    } finally {
      await cleanupAdjustmentRefs(target.id, [pkg.id]);
    }
  });

  test('97. An adjustment referencing a related transaction leaves the related transaction unchanged', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
    assert.ok(wallet);
    const related = await createDirectTransaction(target.id, wallet.id, {
      type: TokenTransactionType.GRANT,
      source: TokenTransactionSource.PURCHASE,
      tokens: 200,
      referenceId: 'grant:unchanged-ref',
      metadata: { note: 'related' },
    });
    try {
      const before = await prisma.tokenTransaction.findUnique({ where: { id: related.id } });
      const { status } = await postAdjustment(target.id, {
        operation: 'DEBIT',
        tokens: 30,
        reason: 'Related unchanged check',
        idempotencyKey: crypto.randomUUID(),
        relatedTransactionId: related.id,
      });
      assert.equal(status, 201);

      const after = await prisma.tokenTransaction.findUnique({ where: { id: related.id } });
      assert.deepEqual(after, before);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('98. Two concurrent DEBIT requests with the same idempotency key result in one debit and one replay', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const key = crypto.randomUUID();
    const body = { operation: 'DEBIT', tokens: 60, reason: 'Concurrent debit same key', idempotencyKey: key };
    try {
      const [resA, resB] = await Promise.all([
        postAdjustment(target.id, body),
        postAdjustment(target.id, body),
      ]);

      const statuses = [resA.status, resB.status].sort();
      assert.deepEqual(statuses, [200, 201]);

      const created = resA.status === 201 ? resA : resB;
      const replay = resA.status === 200 ? resA : resB;
      assert.equal(created.body.data.idempotentReplay, false);
      assert.equal(created.body.data.operation, 'DEBIT');
      assert.equal(created.body.data.tokensAdjusted, 60);
      assert.equal(replay.body.data.idempotentReplay, true);
      assert.equal(replay.body.data.transactionId, created.body.data.transactionId);
      assert.equal(replay.body.data.newBalance, created.body.data.newBalance);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 140);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        }),
        1,
      );
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('99. Two concurrent DEBIT requests with different keys and sufficient balance both succeed with a valid transition chain', async () => {
    const target = await createTargetUser({ tokenBalance: 300, status: WalletStatus.ACTIVE });
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    try {
      const [resA, resB] = await Promise.all([
        postAdjustment(target.id, { operation: 'DEBIT', tokens: 50, reason: 'Debit chain A', idempotencyKey: keyA }),
        postAdjustment(target.id, { operation: 'DEBIT', tokens: 100, reason: 'Debit chain B', idempotencyKey: keyB }),
      ]);

      assert.deepEqual([resA.status, resB.status].sort(), [201, 201]);
      assert.equal(resA.body.data.idempotentReplay, false);
      assert.equal(resB.body.data.idempotentReplay, false);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 150);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        }),
        2,
      );
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 2);

      const transactions = await prisma.tokenTransaction.findMany({
        where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        select: { metadata: true },
      });
      const transitions = transactions.map((transaction) => {
        const metadata = transaction.metadata as { previousBalance: number; newBalance: number };
        return { previousBalance: metadata.previousBalance, newBalance: metadata.newBalance };
      });

      const byPrevious = new Map(transitions.map((t) => [t.previousBalance, t.newBalance]));
      let cursor = 300;
      let steps = 0;
      while (byPrevious.has(cursor)) {
        cursor = byPrevious.get(cursor) as number;
        steps++;
      }
      assert.equal(steps, 2);
      assert.equal(cursor, 150);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('100. Two concurrent DEBIT requests with different keys but only one funded result in one success, one 409, and no negative balance', async () => {
    const target = await createTargetUser({ tokenBalance: 50, status: WalletStatus.ACTIVE });
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    try {
      const [resA, resB] = await Promise.all([
        postAdjustment(target.id, { operation: 'DEBIT', tokens: 50, reason: 'Funded debit', idempotencyKey: keyA }),
        postAdjustment(target.id, { operation: 'DEBIT', tokens: 100, reason: 'Unfunded debit', idempotencyKey: keyB }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      assert.deepEqual(statuses, [201, 409]);

      const funded = resA.status === 201 ? resA : resB;
      const unfunded = resA.status === 409 ? resA : resB;
      assert.equal(funded.body.data.idempotentReplay, false);
      assert.equal(funded.body.data.newBalance, 0);
      assert.equal(unfunded.body.error, 'Insufficient token balance for adjustment');

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 0);
      assert.ok((wallet?.tokenBalance ?? -1) >= 0);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        }),
        1,
      );
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 1);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('101. A concurrent CREDIT and DEBIT produce the correct final balance with two transactions and valid serial transitions', async () => {
    const target = await createTargetUser({ tokenBalance: 200, status: WalletStatus.ACTIVE });
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    try {
      const [creditRes, debitRes] = await Promise.all([
        postAdjustment(target.id, { operation: 'CREDIT', tokens: 100, reason: 'Concurrent credit', idempotencyKey: keyA }),
        postAdjustment(target.id, { operation: 'DEBIT', tokens: 50, reason: 'Concurrent debit', idempotencyKey: keyB }),
      ]);

      assert.deepEqual([creditRes.status, debitRes.status].sort(), [201, 201]);
      assert.equal(creditRes.body.data.idempotentReplay, false);
      assert.equal(debitRes.body.data.idempotentReplay, false);

      const wallet = await prisma.tokenWallet.findUnique({ where: { userId: target.id } });
      assert.equal(wallet?.tokenBalance, 250);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        }),
        2,
      );
      assert.equal(await prisma.auditLog.count({ where: { targetUserId: target.id } }), 2);

      const transactions = await prisma.tokenTransaction.findMany({
        where: { userId: target.id, type: TokenTransactionType.ADJUSTMENT },
        select: { metadata: true },
      });
      const transitions = transactions.map((transaction) => {
        const metadata = transaction.metadata as { previousBalance: number; newBalance: number };
        assert.ok(metadata.previousBalance >= 0);
        assert.ok(metadata.newBalance >= 0);
        return { previousBalance: metadata.previousBalance, newBalance: metadata.newBalance };
      });

      const newBalances = transitions.map((t) => t.newBalance);
      const prevBalances = transitions.map((t) => t.previousBalance);
      assert.ok(newBalances.includes(250));
      assert.ok(prevBalances.includes(200));
      const intermediateNew = newBalances.find((balance) => balance !== 250);
      const intermediatePrev = prevBalances.find((balance) => balance !== 200);
      assert.equal(intermediateNew, intermediatePrev);
      assert.ok(intermediateNew === 150 || intermediateNew === 300);
    } finally {
      await cleanupAdjustmentRefs(target.id);
    }
  });

  test('102. A soft-deleted admin actor returns 401 and writes nothing', async () => {
    const target = await createTargetUser();
    await prisma.user.update({ where: { id: SECOND_ADMIN_USER_ID }, data: { isDeleted: true } });
    try {
      const { status, body } = await postAdjustment(
        target.id,
        { operation: 'CREDIT', tokens: 50, reason: 'Deleted actor', idempotencyKey: crypto.randomUUID() },
        { Authorization: `Bearer ${SECOND_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      );
      assert.equal(status, 401);
      assert.equal(body.error, 'Authenticated user not found');
      await assertNoBonusWrites(target.id);
    } finally {
      await prisma.user.update({ where: { id: SECOND_ADMIN_USER_ID }, data: { isDeleted: false } });
      await cleanupAdjustmentRefs(target.id);
    }
  });
});
