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
import { signAccessToken } from '../src/utils/token.js';
import { ensureAdminRole, ensureUserRole } from './helpers/test-role-fixtures.js';
import { Gender, PaymentStatus, Prisma } from '@prisma/client';

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_TOKEN_SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING_ADMIN_USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEST_PAYMENT_USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NO_PAYMENT_USER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const ADMIN_TOKEN = signAccessToken({ sub: ADMIN_USER_ID, role: 'admin' });
const USER_TOKEN = signAccessToken({ sub: USER_TOKEN_SUB, role: 'USER' });
const MISSING_ADMIN_USER_TOKEN = signAccessToken({ sub: MISSING_ADMIN_USER_ID, role: 'admin' });

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

function userHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${USER_TOKEN}` };
}

let uniqueCounter = 0;
function uniqueSuffix(): string {
  uniqueCounter++;
  return `${Date.now()}_${uniqueCounter}`;
}

async function cleanupTestData(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: { actorId: { in: [ADMIN_USER_ID, MISSING_ADMIN_USER_ID] } },
  });
  await prisma.tokenTransaction.deleteMany({
    where: { userId: { in: [ADMIN_USER_ID, TEST_PAYMENT_USER_ID] } },
  });
  await prisma.tokenWallet.deleteMany({
    where: { userId: { in: [ADMIN_USER_ID, TEST_PAYMENT_USER_ID] } },
  });
  await prisma.payment.deleteMany({
    where: { userId: { in: [ADMIN_USER_ID, TEST_PAYMENT_USER_ID] } },
  });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { id: { in: [ADMIN_USER_ID, MISSING_ADMIN_USER_ID, TEST_PAYMENT_USER_ID] } },
        { email: { startsWith: 'test_admin_pay_' } },
      ],
    },
  });
  await prisma.tokenPackage.deleteMany({
    where: { code: { startsWith: 'TEST_ADMIN_PAY_' } },
  });
}

describe('Admin Payment API', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await cleanupTestData();

    const adminRole = await ensureAdminRole();

    const userRole = await ensureUserRole();

    await prisma.user.upsert({
      where: { id: ADMIN_USER_ID },
      update: {},
      create: {
        id: ADMIN_USER_ID,
        email: 'test_admin_pay_admin@example.com',
        passwordHash: 'hash',
        displayName: 'Admin Payment Test Admin',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: adminRole.id,
        isEmailVerified: true,
      },
    });

    await prisma.user.upsert({
      where: { id: TEST_PAYMENT_USER_ID },
      update: {},
      create: {
        id: TEST_PAYMENT_USER_ID,
        email: 'test_admin_pay_user@example.com',
        passwordHash: 'hash',
        displayName: 'Admin Payment Test User',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
        roleId: userRole.id,
        isEmailVerified: true,
      },
    });

    await prisma.user.upsert({
      where: { id: USER_TOKEN_SUB },
      update: {},
      create: {
        id: USER_TOKEN_SUB,
        email: 'test_admin_pay_regular@example.com',
        passwordHash: 'hash',
        displayName: 'Regular User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
        roleId: userRole.id,
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
      await cleanupTestData();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await prisma.$disconnect();
    }
  });

  /* ---------- helpers ---------- */

  async function fetchJson(url: string, opts: RequestInit = {}) {
    const res = await fetch(url, opts);
    const body = await res.json();
    return { status: res.status, body };
  }

  function jsonHeaders(token: string = ADMIN_TOKEN): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  async function createTestTokenPackage(overrides: Partial<Prisma.TokenPackageUncheckedCreateInput> = {}) {
    const suffix = uniqueSuffix();
    return prisma.tokenPackage.create({
      data: {
        name: `Test Pkg ${suffix}`,
        code: `TEST_ADMIN_PAY_${suffix}`,
        price: '50.00',
        currency: 'EGP',
        tokens: 100,
        sortOrder: 1,
        isActive: true,
        ...overrides,
      },
    });
  }

  async function createTestPayment(
    overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
  ) {
    const suffix = uniqueSuffix();
    const pkg = await createTestTokenPackage({ name: `Pay Pkg ${suffix}` });
    return prisma.payment.create({
      data: {
        userId: TEST_PAYMENT_USER_ID,
        tokenPackageId: pkg.id,
        amount: '100.00',
        currency: 'EGP',
        status: PaymentStatus.COMPLETED,
        packageNameSnapshot: pkg.name,
        tokensSnapshot: pkg.tokens,
        priceSnapshot: pkg.price.toString(),
        currencySnapshot: pkg.currency,
        provider: 'PAYMOB',
        paidAt: new Date('2026-07-15T12:00:00.000Z'),
        ...overrides,
      },
    });
  }

  /* ========== Auth & Authorization ========== */

  test('1. Unauthenticated request returns 401', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/admin/payments`);
    assert.equal(status, 401);
    assert.equal(body.error, 'Missing or invalid authorization header');
  });

  test('2. Non-admin user returns 403', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/admin/payments`, {
      headers: userHeaders(),
    });
    assert.equal(status, 403);
    assert.equal(body.error, 'Insufficient permissions');
  });

  /* ========== List Payments ========== */

  test('3. Empty list returns paginated result with 0 items', async () => {
    const params = new URLSearchParams({ userId: NO_PAYMENT_USER_ID });
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/payments?${params.toString()}`,
      { headers: adminHeaders() },
    );

    assert.equal(status, 200);
    assert.equal(body.success, true);

    assert.deepEqual(Object.keys(body).sort(), ['data', 'success']);
    assert.deepEqual(Object.keys(body.data).sort(), ['items', 'pagination']);
    assert.deepEqual(Object.keys(body.data.pagination).sort(), ['limit', 'page', 'total', 'totalPages']);

    assert.ok(Array.isArray(body.data.items));
    assert.equal(body.data.items.length, 0);
    assert.equal(body.data.pagination.page, 1);
    assert.equal(body.data.pagination.limit, 20);
    assert.equal(body.data.pagination.total, 0);
    assert.equal(body.data.pagination.totalPages, 0);
  });

  test('4. List returns created payments with default pagination', async () => {
    const payment = await createTestPayment();

    try {
      const params = new URLSearchParams({ userId: TEST_PAYMENT_USER_ID });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.items.length, 1);
      assert.equal(body.data.pagination.page, 1);
      assert.equal(body.data.pagination.limit, 20);
      assert.equal(body.data.pagination.total, 1);

      const found = body.data.items.find((p: { id: string }) => p.id === payment.id);
      assert.ok(found, 'Created payment not found in list');
      assert.equal(found.userId, TEST_PAYMENT_USER_ID);
      assert.equal(found.amount, '100');
      assert.equal(found.currency, 'EGP');
      assert.equal(found.status, PaymentStatus.COMPLETED);
      assert.equal(found.provider, 'PAYMOB');
    } finally {
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: payment.tokenPackageId } });
    }
  });

  test('5. List respects page and limit', async () => {
    const payments: Awaited<ReturnType<typeof createTestPayment>>[] = [];

    try {
      for (let i = 0; i < 5; i++) {
        const p = await createTestPayment();
        payments.push(p);
      }

      const params = new URLSearchParams({
        userId: TEST_PAYMENT_USER_ID,
        page: '1',
        limit: '2',
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      assert.equal(body.data.items.length, 2);
      assert.equal(body.data.pagination.page, 1);
      assert.equal(body.data.pagination.limit, 2);
      assert.equal(body.data.pagination.total, 5);
      assert.equal(body.data.pagination.totalPages, 3);
    } finally {
      await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
      await prisma.tokenPackage.deleteMany({ where: { id: { in: payments.map((p) => p.tokenPackageId) } } });
    }
  });

  test('6. Filter by status', async () => {
    const pkg = await createTestTokenPackage();
    const pendingPayments: Awaited<ReturnType<typeof createTestPayment>>[] = [];
    const completedPayments: Awaited<ReturnType<typeof createTestPayment>>[] = [];

    try {
      const pending = await prisma.payment.create({
        data: {
          userId: TEST_PAYMENT_USER_ID,
          tokenPackageId: pkg.id,
          amount: '50.00',
          currency: 'EGP',
          status: PaymentStatus.PENDING,
          packageNameSnapshot: pkg.name,
          tokensSnapshot: pkg.tokens,
          priceSnapshot: pkg.price.toString(),
          currencySnapshot: pkg.currency,
          provider: 'PAYMOB',
        },
      });
      pendingPayments.push(pending);

      const completed = await prisma.payment.create({
        data: {
          userId: TEST_PAYMENT_USER_ID,
          tokenPackageId: pkg.id,
          amount: '75.00',
          currency: 'EGP',
          status: PaymentStatus.COMPLETED,
          packageNameSnapshot: pkg.name,
          tokensSnapshot: pkg.tokens,
          priceSnapshot: pkg.price.toString(),
          currencySnapshot: pkg.currency,
          provider: 'PAYMOB',
          paidAt: new Date(),
        },
      });
      completedPayments.push(completed);

      const pendingParams = new URLSearchParams({
        userId: TEST_PAYMENT_USER_ID,
        status: 'PENDING',
      });
      const { status: pendingStatus, body: pendingBody } = await fetchJson(
        `${baseUrl}/api/admin/payments?${pendingParams.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(pendingStatus, 200);
      assert.ok(pendingBody.data.items.length >= 1);
      const foundPending = pendingBody.data.items.find(
        (p: { id: string }) => p.id === pending.id,
      );
      assert.ok(foundPending);
      const foundCompletedInPending = pendingBody.data.items.find(
        (p: { id: string }) => p.id === completed.id,
      );
      assert.equal(foundCompletedInPending, undefined);
      for (const item of pendingBody.data.items) {
        assert.equal(item.status, PaymentStatus.PENDING);
      }

      const completedParams = new URLSearchParams({
        userId: TEST_PAYMENT_USER_ID,
        status: 'COMPLETED',
      });
      const { status: completedStatus, body: completedBody } = await fetchJson(
        `${baseUrl}/api/admin/payments?${completedParams.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(completedStatus, 200);
      const foundCompleted = completedBody.data.items.find(
        (p: { id: string }) => p.id === completed.id,
      );
      assert.ok(foundCompleted);
      const foundPendingInCompleted = completedBody.data.items.find(
        (p: { id: string }) => p.id === pending.id,
      );
      assert.equal(foundPendingInCompleted, undefined);
      for (const item of completedBody.data.items) {
        assert.equal(item.status, PaymentStatus.COMPLETED);
      }
    } finally {
      await prisma.payment.deleteMany({
        where: { id: { in: [...pendingPayments.map((p) => p.id), ...completedPayments.map((p) => p.id)] } },
      });
      await prisma.tokenPackage.deleteMany({ where: { id: pkg.id } });
    }
  });

  test('7. Filter by userId', async () => {
    const payment = await createTestPayment();

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?userId=${TEST_PAYMENT_USER_ID}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      assert.ok(body.data.items.length >= 1);
      const found = body.data.items.find((p: { id: string }) => p.id === payment.id);
      assert.ok(found);
      assert.equal(found.userId, TEST_PAYMENT_USER_ID);
      for (const item of body.data.items) {
        assert.equal(item.userId, TEST_PAYMENT_USER_ID);
      }
    } finally {
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: payment.tokenPackageId } });
    }
  });

  test('8. Sort by amount asc', async () => {
    const payments: Awaited<ReturnType<typeof createTestPayment>>[] = [];

    try {
      for (let i = 1; i <= 3; i++) {
        const p = await createTestPayment({
          amount: (i * 50).toString(),
        });
        payments.push(p);
      }

      const params = new URLSearchParams({
        userId: TEST_PAYMENT_USER_ID,
        sortBy: 'amount',
        sortOrder: 'asc',
        limit: '50',
      });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      const found = body.data.items.filter(
        (p: { id: string }) => payments.some((pp) => pp.id === p.id),
      );
      assert.equal(found.length, 3);

      const amounts = found.map((p: { amount: string }) => parseFloat(p.amount));
      if (amounts.length >= 2) {
        for (let i = 1; i < amounts.length; i++) {
          assert.ok(amounts[i] >= amounts[i - 1], `Expected asc order: ${amounts[i]} >= ${amounts[i - 1]}`);
        }
      }
    } finally {
      await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
      await prisma.tokenPackage.deleteMany({ where: { id: { in: payments.map((p) => p.tokenPackageId) } } });
    }
  });

  test('9. Response includes related user and tokenPackage', async () => {
    const payment = await createTestPayment();

    try {
      const params = new URLSearchParams({ userId: TEST_PAYMENT_USER_ID, limit: '50' });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      const found = body.data.items.find((p: { id: string }) => p.id === payment.id);
      assert.ok(found);

      assert.ok(found.user);
      assert.equal(found.user.id, TEST_PAYMENT_USER_ID);
      assert.equal(found.user.displayName, 'Admin Payment Test User');
      assert.equal(found.user.email, 'test_admin_pay_user@example.com');

      assert.ok(found.tokenPackage);
      assert.equal(found.tokenPackage.id, payment.tokenPackageId);
    } finally {
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: payment.tokenPackageId } });
    }
  });

  test('10. List response contains only approved fields, excludes detail-only fields', async () => {
    const payment = await createTestPayment({
      providerIntentionId: 'int_test_list_001',
      providerOrderId: 'ord_test_list_002',
      providerTransactionId: 'txn_test_list_003',
      failureReason: 'card_declined',
      providerData: { cardLast4: '1234', bank: 'test' },
    });

    try {
      const params = new URLSearchParams({ userId: TEST_PAYMENT_USER_ID, limit: '50' });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      const found = body.data.items.find((p: { id: string }) => p.id === payment.id);
      assert.ok(found);

      const expectedKeys = [
        'id', 'userId', 'tokenPackageId',
        'amount', 'currency', 'status',
        'packageNameSnapshot', 'tokensSnapshot', 'priceSnapshot', 'currencySnapshot',
        'provider', 'paidAt', 'createdAt', 'updatedAt',
        'user', 'tokenPackage',
      ].sort();
      assert.deepEqual(Object.keys(found).sort(), expectedKeys);

      assert.equal(Object.prototype.hasOwnProperty.call(found, 'providerIntentionId'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(found, 'providerOrderId'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(found, 'providerTransactionId'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(found, 'failureReason'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(found, 'providerData'), false);
    } finally {
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: payment.tokenPackageId } });
    }
  });

  test('11. Decimal fields are strings, dates are ISO strings', async () => {
    const payment = await createTestPayment();

    try {
      const params = new URLSearchParams({ userId: TEST_PAYMENT_USER_ID, limit: '50' });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      const found = body.data.items.find((p: { id: string }) => p.id === payment.id);
      assert.ok(found);

      assert.equal(typeof found.amount, 'string');
      assert.equal(typeof found.priceSnapshot, 'string');
      assert.equal(typeof found.createdAt, 'string');
      assert.equal(typeof found.updatedAt, 'string');

      assert.ok(found.paidAt === null || typeof found.paidAt === 'string');
    } finally {
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: payment.tokenPackageId } });
    }
  });

  /* ========== Get Payment By ID ========== */

  test('12. Get payment by valid ID returns payment', async () => {
    const payment = await createTestPayment();

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments/${payment.id}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.id, payment.id);
      assert.equal(body.data.amount, '100');
      assert.equal(body.data.currency, 'EGP');
      assert.equal(body.data.status, PaymentStatus.COMPLETED);
      assert.equal(body.data.provider, 'PAYMOB');

      assert.ok(body.data.user);
      assert.equal(body.data.user.id, TEST_PAYMENT_USER_ID);
      assert.ok(body.data.tokenPackage);
    } finally {
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: payment.tokenPackageId } });
    }
  });

  test('13. Get payment by non-existent UUID returns 404', async () => {
    const nonExistentId = '00000000-0000-4000-8000-000000000000';

    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/payments/${nonExistentId}`,
      { headers: adminHeaders() },
    );

    assert.equal(status, 404);
    assert.equal(body.error, 'Payment not found');
  });

  test('14. Get payment with invalid UUID returns 400', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/payments/not-a-uuid`,
      { headers: adminHeaders() },
    );

    assert.equal(status, 400);
    assert.equal(body.error, 'Validation error');
  });

  test('15. Detail response contains all fields including provider references and failure reason', async () => {
    const payment = await createTestPayment({
      providerIntentionId: 'int_test_dtl_001',
      providerOrderId: 'ord_test_dtl_002',
      providerTransactionId: 'txn_test_dtl_003',
      failureReason: 'insufficient_funds',
      providerData: { raw: 'sensitive_data' },
    });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments/${payment.id}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);
      assert.equal(body.success, true);

      const expectedKeys = [
        'id', 'userId', 'tokenPackageId',
        'amount', 'currency', 'status',
        'packageNameSnapshot', 'tokensSnapshot', 'priceSnapshot', 'currencySnapshot',
        'provider', 'providerIntentionId', 'providerOrderId',
        'providerTransactionId', 'failureReason',
        'paidAt', 'createdAt', 'updatedAt',
        'user', 'tokenPackage',
      ].sort();
      assert.deepEqual(Object.keys(body.data).sort(), expectedKeys);

      assert.equal(body.data.providerIntentionId, 'int_test_dtl_001');
      assert.equal(body.data.providerOrderId, 'ord_test_dtl_002');
      assert.equal(body.data.providerTransactionId, 'txn_test_dtl_003');
      assert.equal(body.data.failureReason, 'insufficient_funds');

      assert.equal(Object.prototype.hasOwnProperty.call(body.data, 'providerData'), false);
    } finally {
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: payment.tokenPackageId } });
    }
  });

  test('16. Unauthenticated get by ID returns 401', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/payments/00000000-0000-4000-8000-000000000000`,
    );

    assert.equal(status, 401);
    assert.equal(body.error, 'Missing or invalid authorization header');
  });

  test('17. Non-admin get by ID returns 403', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/payments/00000000-0000-4000-8000-000000000000`,
      { headers: userHeaders() },
    );

    assert.equal(status, 403);
    assert.equal(body.error, 'Insufficient permissions');
  });

  test('18. createdAt descending has stable id tie-breaker', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const payments: Awaited<ReturnType<typeof createTestPayment>>[] = [];
    const exactTs = new Date('2026-08-01T12:00:00.000Z');

    try {
      for (let i = 0; i < 3; i++) {
        const payment = await createTestPayment({
          id: ids[i],
          createdAt: exactTs,
          paidAt: exactTs,
        });
        payments.push(payment);
      }

      const params = new URLSearchParams({
        userId: TEST_PAYMENT_USER_ID,
        dateFrom: exactTs.toISOString(),
        dateTo: exactTs.toISOString(),
        sortBy: 'createdAt',
        sortOrder: 'desc',
        limit: '100',
      });

      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);

      const found = body.data.items.filter(
        (p: { id: string }) => ids.includes(p.id),
      );

      assert.equal(found.length, 3);

      const expectedOrder = [...ids].sort().reverse();
      for (let i = 0; i < 3; i++) {
        assert.equal(found[i].id, expectedOrder[i]);
      }
    } finally {
      await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
      await prisma.tokenPackage.deleteMany({ where: { id: { in: payments.map((p) => p.tokenPackageId) } } });
    }
  });

  test('19. amount ascending has stable id tie-breaker', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const payments: Awaited<ReturnType<typeof createTestPayment>>[] = [];

    try {
      for (let i = 0; i < 3; i++) {
        const payment = await createTestPayment({
          id: ids[i],
          amount: '50.00',
        });
        payments.push(payment);
      }

      const params = new URLSearchParams({
        userId: TEST_PAYMENT_USER_ID,
        sortBy: 'amount',
        sortOrder: 'asc',
        limit: '100',
      });

      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);

      const found = body.data.items.filter(
        (p: { id: string }) => ids.includes(p.id),
      );

      assert.equal(found.length, 3);

      const expectedOrder = [...ids].sort();
      for (let i = 0; i < 3; i++) {
        assert.equal(found[i].id, expectedOrder[i]);
      }
    } finally {
      await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
      await prisma.tokenPackage.deleteMany({ where: { id: { in: payments.map((p) => p.tokenPackageId) } } });
    }
  });

  test('20. Currency filter normalizes and excludes', async () => {
    const payments: Awaited<ReturnType<typeof createTestPayment>>[] = [];

    try {
      const egpPayment = await createTestPayment({ currency: 'EGP' });
      payments.push(egpPayment);

      const usdPayment = await createTestPayment({ currency: 'USD' });
      payments.push(usdPayment);

      const params = new URLSearchParams({
        userId: TEST_PAYMENT_USER_ID,
        currency: 'usd',
        limit: '100',
      });

      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);

      const foundUsd = body.data.items.find(
        (p: { id: string }) => p.id === usdPayment.id,
      );
      assert.ok(foundUsd);

      const foundEgp = body.data.items.find(
        (p: { id: string }) => p.id === egpPayment.id,
      );
      assert.equal(foundEgp, undefined);

      for (const item of body.data.items) {
        assert.equal(item.currency, 'USD');
      }

      assert.equal(body.data.pagination.total, 1);
    } finally {
      await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
      await prisma.tokenPackage.deleteMany({ where: { id: { in: payments.map((p) => p.tokenPackageId) } } });
    }
  });

  test('21. tokenPackageId filter is exact', async () => {
    const payments: Awaited<ReturnType<typeof createTestPayment>>[] = [];

    try {
      for (let i = 0; i < 2; i++) {
        const p = await createTestPayment();
        payments.push(p);
      }

      const params = new URLSearchParams({
        userId: TEST_PAYMENT_USER_ID,
        tokenPackageId: payments[0].tokenPackageId.toString(),
        limit: '100',
      });

      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );

      assert.equal(status, 200);

      const foundFirst = body.data.items.find(
        (p: { id: string }) => p.id === payments[0].id,
      );
      assert.ok(foundFirst);

      const foundSecond = body.data.items.find(
        (p: { id: string }) => p.id === payments[1].id,
      );
      assert.equal(foundSecond, undefined);

      for (const item of body.data.items) {
        assert.equal(item.tokenPackageId, payments[0].tokenPackageId);
      }

      assert.equal(body.data.pagination.total, 1);
    } finally {
      await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
      await prisma.tokenPackage.deleteMany({ where: { id: { in: payments.map((p) => p.tokenPackageId) } } });
    }
  });

  test('22. createdAt date filters are inclusive', async () => {
    const payments: Awaited<ReturnType<typeof createTestPayment>>[] = [];

    try {
      const timestamps = [
        { label: 'before',    createdAt: new Date('2026-06-30T23:59:59.999Z') },
        { label: 'start',     createdAt: new Date('2026-07-01T00:00:00.000Z') },
        { label: 'inside',    createdAt: new Date('2026-07-15T12:00:00.000Z') },
        { label: 'end',       createdAt: new Date('2026-07-31T23:59:59.999Z') },
        { label: 'after',     createdAt: new Date('2026-08-01T00:00:00.000Z') },
      ];

      for (const ts of timestamps) {
        const p = await createTestPayment({ createdAt: ts.createdAt });
        payments.push(p);
      }

      const dateFrom = new Date('2026-07-01T00:00:00.000Z');
      const dateTo = new Date('2026-07-31T23:59:59.999Z');

      function findLabel(label: string): string {
        const idx = timestamps.findIndex((t) => t.label === label);
        return payments[idx].id;
      }

      // Request A: dateFrom only
      {
        const params = new URLSearchParams({
          userId: TEST_PAYMENT_USER_ID,
          dateFrom: dateFrom.toISOString(),
          limit: '100',
          sortBy: 'createdAt',
          sortOrder: 'asc',
        });

        const { status, body } = await fetchJson(
          `${baseUrl}/api/admin/payments?${params.toString()}`,
          { headers: adminHeaders() },
        );

        assert.equal(status, 200);

        const ids = body.data.items.map((item: { id: string }) => item.id);
        assert.equal(ids.includes(findLabel('before')), false);
        assert.ok(ids.includes(findLabel('start')));
        assert.ok(ids.includes(findLabel('inside')));
        assert.ok(ids.includes(findLabel('end')));
        assert.ok(ids.includes(findLabel('after')));
        assert.equal(body.data.pagination.total, 4);

        for (const item of body.data.items) {
          assert.ok(new Date(item.createdAt) >= dateFrom);
        }
      }

      // Request B: dateTo only
      {
        const params = new URLSearchParams({
          userId: TEST_PAYMENT_USER_ID,
          dateTo: dateTo.toISOString(),
          limit: '100',
          sortBy: 'createdAt',
          sortOrder: 'asc',
        });

        const { status, body } = await fetchJson(
          `${baseUrl}/api/admin/payments?${params.toString()}`,
          { headers: adminHeaders() },
        );

        assert.equal(status, 200);

        const ids = body.data.items.map((item: { id: string }) => item.id);
        assert.ok(ids.includes(findLabel('before')));
        assert.ok(ids.includes(findLabel('start')));
        assert.ok(ids.includes(findLabel('inside')));
        assert.ok(ids.includes(findLabel('end')));
        assert.equal(ids.includes(findLabel('after')), false);
        assert.equal(body.data.pagination.total, 4);

        for (const item of body.data.items) {
          assert.ok(new Date(item.createdAt) <= dateTo);
        }
      }

      // Request C: both dateFrom and dateTo
      {
        const params = new URLSearchParams({
          userId: TEST_PAYMENT_USER_ID,
          dateFrom: dateFrom.toISOString(),
          dateTo: dateTo.toISOString(),
          limit: '100',
          sortBy: 'createdAt',
          sortOrder: 'asc',
        });

        const { status, body } = await fetchJson(
          `${baseUrl}/api/admin/payments?${params.toString()}`,
          { headers: adminHeaders() },
        );

        assert.equal(status, 200);

        const ids = body.data.items.map((item: { id: string }) => item.id);
        assert.equal(ids.includes(findLabel('before')), false);
        assert.ok(ids.includes(findLabel('start')));
        assert.ok(ids.includes(findLabel('inside')));
        assert.ok(ids.includes(findLabel('end')));
        assert.equal(ids.includes(findLabel('after')), false);
        assert.equal(body.data.pagination.total, 3);

        const expectedIds = [
          findLabel('start'),
          findLabel('inside'),
          findLabel('end'),
        ];
        assert.deepEqual(ids, expectedIds);
      }
    } finally {
      await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
      await prisma.tokenPackage.deleteMany({ where: { id: { in: payments.map((p) => p.tokenPackageId) } } });
    }
  });

  /* ========== Validation error tests ========== */

  test('23. Invalid pagination values return 400', async () => {
    async function expectValidationError(params: URLSearchParams): Promise<void> {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
    }

    for (const pageValue of ['0', '-1', '1.5', 'abc', '', '   ']) {
      await expectValidationError(new URLSearchParams({ page: pageValue }));
    }

    for (const limitValue of ['0', '-1', '101', '1.5', 'abc', '', '   ']) {
      await expectValidationError(new URLSearchParams({ limit: limitValue }));
    }
  });

  test('24. Invalid status and currency values return 400', async () => {
    async function expectValidationError(params: URLSearchParams): Promise<void> {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
    }

    for (const statusValue of ['pending', 'completed', 'SUCCESS', 'PAID', 'REFUND', '', '   ']) {
      await expectValidationError(new URLSearchParams({ status: statusValue }));
    }

    for (const currencyValue of ['EG', 'EGP1', '123', 'E$P', '', '   ', 'EURO']) {
      await expectValidationError(new URLSearchParams({ currency: currencyValue }));
    }

    {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?currency=egp`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
    }
  });

  test('25. Invalid tokenPackageId and userId return 400', async () => {
    async function expectValidationError(params: URLSearchParams): Promise<void> {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
    }

    for (const tpIdValue of ['0', '-1', '1.5', 'abc', '', '   ']) {
      await expectValidationError(new URLSearchParams({ tokenPackageId: tpIdValue }));
    }

    for (const userIdValue of ['not-a-uuid', '123', '', '   ', '550e8400-e29b-41d4-a716', 'ZZZZZZZZ-ZZZZ-4ZZZ-8ZZZ-ZZZZZZZZZZZZ']) {
      await expectValidationError(new URLSearchParams({ userId: userIdValue }));
    }

    {
      const params = new URLSearchParams({ userId: TEST_PAYMENT_USER_ID });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
    }
  });

  test('26. Invalid date filters return 400', async () => {
    async function expectValidationError(params: URLSearchParams): Promise<void> {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
    }

    for (const dateValue of ['', '   ', '2026-07-01', '2026-13-01T00:00:00.000Z', '2026-02-30T00:00:00.000Z', 'July 1 2026', '2026-07-01T00:00:00']) {
      await expectValidationError(new URLSearchParams({ dateFrom: dateValue }));
    }

    for (const dateValue of ['', '   ', '2026-07-01']) {
      await expectValidationError(new URLSearchParams({ dateTo: dateValue }));
    }

    {
      const params = new URLSearchParams({
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-07-01T00:00:00.000Z',
      });
      await expectValidationError(params);
    }

    {
      const params = new URLSearchParams({ dateFrom: '2026-07-01T00:00:00.000Z' });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
    }

    {
      const params = new URLSearchParams({ dateFrom: '2026-07-01T03:00:00+03:00' });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
    }
  });

  test('27. Invalid sorting and unknown fields return 400', async () => {
    async function expectValidationError(params: URLSearchParams): Promise<void> {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');
    }

    for (const sortByValue of ['id', 'status', 'currency', 'userId', 'tokenPackageId', 'provider', 'providerData', 'failureReason', 'passwordHash', '']) {
      await expectValidationError(new URLSearchParams({ sortBy: sortByValue }));
    }

    for (const sortOrderValue of ['ASC', 'DESC', 'ascending', 'descending', 'random', '']) {
      await expectValidationError(new URLSearchParams({ sortOrder: sortOrderValue }));
    }

    for (const [key, value] of [['search', 'test'], ['unknownField', 'x'], ['includeProviderData', 'true'], ['paymentStatus', 'COMPLETED']]) {
      await expectValidationError(new URLSearchParams({ [key]: value }));
    }

    for (const [sortBy, sortOrder] of [['createdAt', 'desc'], ['amount', 'asc'], ['updatedAt', 'desc'], ['paidAt', 'asc']]) {
      const params = new URLSearchParams({ sortBy, sortOrder });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/payments?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
    }
  });

  test('28. List and detail requests do not modify payment or token data', async () => {
    const payment = await createTestPayment({
      providerIntentionId: crypto.randomUUID(),
      providerOrderId: 'ORD-READONLY-28',
      providerTransactionId: crypto.randomUUID(),
      failureReason: null,
      providerData: { rawResponse: 'test_payload', processedAt: '2026-08-01T00:00:00.000Z' },
      paidAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    try {
      async function captureReadOnlyState() {
        const paymentRecord = await prisma.payment.findUnique({ where: { id: payment.id } });
        if (!paymentRecord) throw new Error(`Payment ${payment.id} not found`);

        return {
          payment: {
            id: paymentRecord.id,
            status: paymentRecord.status,
            amount: paymentRecord.amount.toString(),
            currency: paymentRecord.currency,
            provider: paymentRecord.provider,
            providerIntentionId: paymentRecord.providerIntentionId,
            providerOrderId: paymentRecord.providerOrderId,
            providerTransactionId: paymentRecord.providerTransactionId,
            failureReason: paymentRecord.failureReason,
            providerData: paymentRecord.providerData === null ? null : JSON.stringify(paymentRecord.providerData),
            paidAt: paymentRecord.paidAt?.toISOString() ?? null,
            updatedAt: paymentRecord.updatedAt.toISOString(),
            tokenPackageId: paymentRecord.tokenPackageId,
            userId: paymentRecord.userId,
          },
          wallets: (await prisma.tokenWallet.findMany({
            where: { userId: TEST_PAYMENT_USER_ID },
            orderBy: { id: 'asc' },
          })).map(w => ({
            id: w.id,
            userId: w.userId,
            tokenBalance: w.tokenBalance,
            status: w.status,
            createdAt: w.createdAt.toISOString(),
            updatedAt: w.updatedAt.toISOString(),
          })),
          transactions: (await prisma.tokenTransaction.findMany({
            where: { userId: TEST_PAYMENT_USER_ID },
            orderBy: { id: 'asc' },
          })).map(t => ({
            id: t.id,
            walletId: t.walletId,
            userId: t.userId,
            type: t.type,
            tokens: t.tokens,
            source: t.source,
            paymentId: t.paymentId,
            referenceId: t.referenceId,
            metadata: t.metadata === null ? null : JSON.stringify(t.metadata),
            createdAt: t.createdAt.toISOString(),
          })),
          auditLogCount: await prisma.auditLog.count({ where: { actorId: ADMIN_USER_ID } }),
          paymentCount: await prisma.payment.count({ where: { userId: TEST_PAYMENT_USER_ID } }),
          tokenPackageCount: await prisma.tokenPackage.count({ where: { id: payment.tokenPackageId } }),
        };
      }

      const before = await captureReadOnlyState();

      // List request
      {
        const params = new URLSearchParams({ userId: TEST_PAYMENT_USER_ID, limit: '100' });
        const { status, body } = await fetchJson(
          `${baseUrl}/api/admin/payments?${params.toString()}`,
          { headers: adminHeaders() },
        );

        assert.equal(status, 200);

        const itemIds: string[] = body.data.items.map((i: { id: string }) => i.id);
        assert.ok(itemIds.includes(payment.id));

        const listItem = body.data.items.find((i: { id: string }) => i.id === payment.id);
        assert.ok(listItem);
        assert.equal(listItem.providerData, undefined);
      }

      const afterList = await captureReadOnlyState();
      assert.deepEqual(afterList, before);

      // Detail request
      {
        const { status, body } = await fetchJson(
          `${baseUrl}/api/admin/payments/${payment.id}`,
          { headers: adminHeaders() },
        );

        assert.equal(status, 200);
        assert.equal(body.data.id, payment.id);
        assert.equal(body.data.providerData, undefined);
        assert.equal(body.data.providerIntentionId, payment.providerIntentionId);
        assert.equal(body.data.providerOrderId, payment.providerOrderId);
        assert.equal(body.data.providerTransactionId, payment.providerTransactionId);
        assert.equal(body.data.failureReason, payment.failureReason);
      }

      const afterDetail = await captureReadOnlyState();
      assert.deepEqual(afterDetail, before);
    } finally {
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: payment.tokenPackageId } });
    }
  });
});
