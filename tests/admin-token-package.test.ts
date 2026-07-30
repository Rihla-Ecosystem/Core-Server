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
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { signAccessToken } from '../src/utils/token.js';
import { Gender, Prisma } from '@prisma/client';

const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111';
const USER_TOKEN_SUB = '22222222-2222-4222-8222-222222222222';
const MISSING_ADMIN_USER_ID = '33333333-3333-4333-8333-333333333333';

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
  await prisma.payment.deleteMany({
    where: { tokenPackage: { code: { startsWith: 'TEST_ADMIN_TP_' } } },
  });
  await prisma.auditLog.deleteMany({
    where: {
      action: 'token_package_created',
      actorId: { in: [ADMIN_USER_ID, MISSING_ADMIN_USER_ID] },
    },
  });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { id: { in: [ADMIN_USER_ID, MISSING_ADMIN_USER_ID] } },
        { email: { startsWith: 'test_admin_tp_' } },
      ],
    },
  });
  await prisma.tokenPackage.deleteMany({
    where: { code: { startsWith: 'TEST_ADMIN_TP_' } },
  });
}

describe('Admin Token Package API', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await cleanupTestData();

    const adminRole = await prisma.role.upsert({
      where: { name: 'admin' },
      update: {},
      create: { id: 9999, name: 'admin', permissions: [] },
    });

    await prisma.user.upsert({
      where: { id: ADMIN_USER_ID },
      update: {},
      create: {
        id: ADMIN_USER_ID,
        email: 'test_admin_tp_admin@example.com',
        passwordHash: 'hash',
        displayName: 'Admin Token Package Test User',
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
      await cleanupTestData();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await prisma.$disconnect();
    }
  });

  /* ---------- helpers ---------- */

type TestTokenPackageOverrides = Partial<
  Pick<
    Prisma.TokenPackageUncheckedCreateInput,
    | 'name'
    | 'description'
    | 'code'
    | 'price'
    | 'currency'
    | 'tokens'
    | 'sortOrder'
    | 'isActive'
    | 'createdAt'
  >
>;

  async function createTestPackage(overrides: TestTokenPackageOverrides = {}) {
    const suffix = uniqueSuffix();
    return prisma.tokenPackage.create({
      data: {
        name: `Test Package ${suffix}`,
        description: `Description for ${suffix}`,
        code: `TEST_ADMIN_TP_${suffix}`,
        price: '10.00',
        currency: 'EGP',
        tokens: 10,
        sortOrder: 1,
        isActive: true,
        ...overrides,
      },
    });
  }

  async function fetchJson(url: string, opts: RequestInit = {}) {
    const res = await fetch(url, opts);
    const body = await res.json();
    return { status: res.status, body };
  }

  function jsonHeaders(token: string = ADMIN_TOKEN): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async function postPackage(body: Record<string, unknown>, token: string = ADMIN_TOKEN) {
    const res = await fetch(`${baseUrl}/api/admin/token-packages`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify(body),
    });
    const responseBody = await res.json();
    return { status: res.status, body: responseBody };
  }

  function isJsonObject(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
  }

  /* ---------- Auth & Authorization ---------- */

  test('1. Request without Authorization header returns 401', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/admin/token-packages`);
    assert.equal(status, 401);
    assert.ok(body.error);
  });

  test('2. Invalid JWT returns 401', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages`,
      { headers: { Authorization: 'Bearer invalid.jwt.token' } },
    );
    assert.equal(status, 401);
    assert.ok(body.error);
  });

  test('3. A valid JWT with role USER returns 403', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages`,
      { headers: userHeaders() },
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'Insufficient permissions');
  });

  /* ---------- Empty result & response shape ---------- */

  test('4. A search that matches no package returns 200 with empty items', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages?search=ZZZZ_NONEXISTENT_${uniqueSuffix()}`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data, {
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  /* ---------- Admin visibility ---------- */

  test('5. Admin list includes both active and inactive packages when no isActive filter', async () => {
    const prefix = `VIS_${uniqueSuffix()}`;

    const active = await createTestPackage({ code: `TEST_ADMIN_TP_${prefix}_A`, isActive: true });
    const inactive = await createTestPackage({ code: `TEST_ADMIN_TP_${prefix}_I`, isActive: false });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?search=${prefix}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const codes = body.data.items.map((p: Record<string, unknown>) => p.code);
      assert.ok(codes.includes(active.code));
      assert.ok(codes.includes(inactive.code));
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { code: { startsWith: `TEST_ADMIN_TP_${prefix}` } },
      });
    }
  });

  /* ---------- Pagination ---------- */

  test('6. Pagination returns correct metadata', async () => {
    const prefix = `PAG_${uniqueSuffix()}`;
    const created = await Promise.all([
      createTestPackage({ code: `TEST_ADMIN_TP_${prefix}_1` }),
      createTestPackage({ code: `TEST_ADMIN_TP_${prefix}_2` }),
      createTestPackage({ code: `TEST_ADMIN_TP_${prefix}_3` }),
    ]);

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?page=2&limit=2&search=${prefix}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.data.items.length, 1);
      assert.equal(body.data.pagination.page, 2);
      assert.equal(body.data.pagination.limit, 2);
      assert.equal(body.data.pagination.total, 3);
      assert.equal(body.data.pagination.totalPages, 2);
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: created.map((p) => p.id) } },
      });
    }
  });

  /* ---------- Stable sorting ---------- */

  test('7. Default sortOrder sorting is stable', async () => {
    const prefix = `SORT_${uniqueSuffix()}`;
    const baseDate = new Date('2025-06-01T00:00:00.000Z');

    const pB = await prisma.tokenPackage.create({
      data: {
        name: `Sort B ${prefix}`,
        code: `TEST_ADMIN_TP_${prefix}_B`,
        price: '5.00',
        currency: 'EGP',
        tokens: 5,
        sortOrder: 5,
        isActive: true,
        createdAt: baseDate,
      },
    });
    const pA = await prisma.tokenPackage.create({
      data: {
        name: `Sort A ${prefix}`,
        code: `TEST_ADMIN_TP_${prefix}_A`,
        price: '50.00',
        currency: 'EGP',
        tokens: 50,
        sortOrder: 10,
        isActive: true,
        createdAt: baseDate,
      },
    });
    const pC = await prisma.tokenPackage.create({
      data: {
        name: `Sort C ${prefix}`,
        code: `TEST_ADMIN_TP_${prefix}_C`,
        price: '20.00',
        currency: 'EGP',
        tokens: 20,
        sortOrder: 10,
        isActive: true,
        createdAt: baseDate,
      },
    });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?search=${prefix}&sortBy=sortOrder&sortOrder=asc`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const codes = body.data.items.map((p: Record<string, unknown>) => p.code);
      assert.equal(codes.length, 3);
      assert.equal(codes[0], pB.code);
      assert.equal(codes[1], pA.code);
      assert.equal(codes[2], pC.code);
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: [pA.id, pB.id, pC.id] } },
      });
    }
  });

  test('8. Explicit price descending sorting works', async () => {
    const prefix = `PRICE_${uniqueSuffix()}`;

    const low = await createTestPackage({
      code: `TEST_ADMIN_TP_${prefix}_LOW`,
      price: '25.00',
      tokens: 25,
      sortOrder: 1,
    });
    const high = await createTestPackage({
      code: `TEST_ADMIN_TP_${prefix}_HIGH`,
      price: '100.00',
      tokens: 100,
      sortOrder: 2,
    });
    const mid = await createTestPackage({
      code: `TEST_ADMIN_TP_${prefix}_MID`,
      price: '50.00',
      tokens: 50,
      sortOrder: 3,
    });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?search=${prefix}&sortBy=price&sortOrder=desc`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const codes = body.data.items.map((p: Record<string, unknown>) => p.code);
      assert.equal(codes.length, 3);
      assert.equal(codes[0], high.code);
      assert.equal(codes[1], mid.code);
      assert.equal(codes[2], low.code);
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: [low.id, high.id, mid.id] } },
      });
    }
  });

  /* ---------- Search ---------- */

  test('9. Search matches package name case-insensitively', async () => {
    const suffix = uniqueSuffix();
    const matchCode = `TEST_ADMIN_TP_NAME_${suffix}`;
    const otherCode = `TEST_ADMIN_TP_OTHER_${suffix}`;

    const match = await createTestPackage({
      code: matchCode,
      name: `SearchNameExact_${suffix}`,
    });
    const other = await createTestPackage({
      code: otherCode,
      name: `OtherPackage_${suffix}`,
    });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?search=searchnameexact_${suffix}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const codes = body.data.items.map((p: Record<string, unknown>) => p.code);
      assert.ok(codes.includes(matchCode));
      assert.ok(!codes.includes(otherCode));
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: [match.id, other.id] } },
      });
    }
  });

  test('10. Search matches package code case-insensitively', async () => {
    const suffix = uniqueSuffix();
    const matchCode = `TEST_ADMIN_TP_CODE_MATCH_${suffix}`;
    const otherCode = `TEST_ADMIN_TP_CODE_OTHER_${suffix}`;

    const match = await createTestPackage({ code: matchCode });
    const other = await createTestPackage({ code: otherCode });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?search=code_match_${suffix}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const codes = body.data.items.map((p: Record<string, unknown>) => p.code);
      assert.ok(codes.includes(matchCode));
      assert.ok(!codes.includes(otherCode));
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: [match.id, other.id] } },
      });
    }
  });

  test('11. Search matches package description case-insensitively', async () => {
    const suffix = uniqueSuffix();
    const matchCode = `TEST_ADMIN_TP_DESC_${suffix}`;
    const otherCode = `TEST_ADMIN_TP_DESC_OTHER_${suffix}`;

    const match = await createTestPackage({
      code: matchCode,
      description: `SearchDescExact_${suffix} some extra text`,
    });
    const other = await createTestPackage({
      code: otherCode,
      description: `OtherDesc_${suffix}`,
    });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?search=searchdescexact_${suffix}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const codes = body.data.items.map((p: Record<string, unknown>) => p.code);
      assert.ok(codes.includes(matchCode));
      assert.ok(!codes.includes(otherCode));
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: [match.id, other.id] } },
      });
    }
  });

  /* ---------- Filters ---------- */

  test('12. isActive=false returns inactive packages and excludes active packages', async () => {
    const prefix = `ACT_${uniqueSuffix()}`;

    const active = await createTestPackage({
      code: `TEST_ADMIN_TP_${prefix}_A`,
      isActive: true,
    });
    const inactive = await createTestPackage({
      code: `TEST_ADMIN_TP_${prefix}_I`,
      isActive: false,
    });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?search=${prefix}&isActive=false`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const codes = body.data.items.map((p: Record<string, unknown>) => p.code);
      assert.ok(codes.includes(inactive.code));
      assert.ok(!codes.includes(active.code));
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { code: { startsWith: `TEST_ADMIN_TP_${prefix}` } },
      });
    }
  });

  test('13. currency=egp is transformed to EGP and returns only EGP packages', async () => {
    const prefix = `CUR_${uniqueSuffix()}`;

    const egp = await createTestPackage({
      code: `TEST_ADMIN_TP_${prefix}_EGP`,
      currency: 'EGP',
    });
    const usd = await createTestPackage({
      code: `TEST_ADMIN_TP_${prefix}_USD`,
      currency: 'USD',
    });

    try {
      const params = new URLSearchParams({ search: prefix, currency: 'egp' });
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages?${params.toString()}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      const codes = body.data.items.map((p: Record<string, unknown>) => p.code);
      assert.ok(codes.includes(egp.code));
      assert.ok(!codes.includes(usd.code));
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { code: { startsWith: `TEST_ADMIN_TP_${prefix}` } },
      });
    }
  });

  /* ---------- Query validation ---------- */

  test('14. page=0 returns 400', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages?page=0`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Validation error');
  });

  test('15. limit=101 returns 400', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages?limit=101`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Validation error');
  });

  test('16. isActive=yes returns 400', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages?isActive=yes`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Validation error');
  });

  test('17. sortBy=passwordHash returns 400', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages?sortBy=passwordHash`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Validation error');
  });

  test('18. An unknown query field returns 400', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages?unknownField=test`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Validation error');
  });

  /* ---------- Package details ---------- */

  test('19. GET /api/admin/token-packages/:id returns the package details', async () => {
    const pkg = await createTestPackage();

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages/${pkg.id}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.id, pkg.id);
      assert.equal(typeof body.data.price, 'string');
      assert.ok(body.data.isActive !== undefined);
      assert.ok(body.data.createdAt !== undefined);
      assert.ok(body.data.updatedAt !== undefined);
      assert.ok(body.data.paymentCount !== undefined);

      const expectedKeys = [
        'id', 'name', 'description', 'code', 'price', 'currency',
        'tokens', 'sortOrder', 'isActive', 'paymentCount', 'createdAt', 'updatedAt',
      ].sort();
      const receivedKeys = Object.keys(body.data).sort();
      assert.deepEqual(receivedKeys, expectedKeys);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('20. paymentCount reflects the number of related Payment records', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_PAYCNT_${suffix}`;

    await prisma.role.upsert({
      where: { id: 1 },
      update: { name: 'USER' },
      create: { id: 1, name: 'USER', permissions: [] },
    });

    const user = await prisma.user.create({
      data: {
        email: `test_admin_tp_paycnt_${suffix}@example.com`,
        passwordHash: 'hash',
        displayName: 'Payment Count Test User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const pkg = await createTestPackage({ code });

    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        tokenPackageId: pkg.id,
        amount: '10.00',
        currency: 'EGP',
        packageNameSnapshot: pkg.name,
        tokensSnapshot: pkg.tokens,
        priceSnapshot: pkg.price.toString(),
        currencySnapshot: 'EGP',
      },
    });

    try {
      const { status, body } = await fetchJson(
        `${baseUrl}/api/admin/token-packages/${pkg.id}`,
        { headers: adminHeaders() },
      );
      assert.equal(status, 200);
      assert.equal(body.data.paymentCount, 1);
    } finally {
      await prisma.payment.delete({ where: { id: payment.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  /* ---------- ID validation & not found ---------- */

  test('21. A non-numeric ID such as abc returns 400', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages/abc`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Validation error');
  });

  test('22. ID 0 returns 400', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages/0`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Validation error');
  });

  test('23. A valid positive ID that does not exist returns 404', async () => {
    const { status, body } = await fetchJson(
      `${baseUrl}/api/admin/token-packages/999999999`,
      { headers: adminHeaders() },
    );
    assert.equal(status, 404);
    assert.equal(body.error, 'Token package not found');
  });

  /* ---------- Read-only behavior ---------- */

  test('24. GET list and GET details do not modify TokenPackage or Payment records', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_RO_${suffix}`;

    const pkg = await createTestPackage({ code });

    const initialPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
    const initialPkgCount = await prisma.tokenPackage.count({
      where: { code: { startsWith: `TEST_ADMIN_TP_RO_${suffix}` } },
    });
    const initialPaymentCount = await prisma.payment.count({
      where: { tokenPackage: { code: { startsWith: `TEST_ADMIN_TP_RO_${suffix}` } } },
    });

    try {
      await fetchJson(
        `${baseUrl}/api/admin/token-packages?search=TEST_ADMIN_TP_RO_${suffix}`,
        { headers: adminHeaders() },
      );
      await fetchJson(
        `${baseUrl}/api/admin/token-packages/${pkg.id}`,
        { headers: adminHeaders() },
      );

      const finalPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      const finalPkgCount = await prisma.tokenPackage.count({
        where: { code: { startsWith: `TEST_ADMIN_TP_RO_${suffix}` } },
      });
      const finalPaymentCount = await prisma.payment.count({
        where: { tokenPackage: { code: { startsWith: `TEST_ADMIN_TP_RO_${suffix}` } } },
      });

      assert.deepEqual(initialPkg, finalPkg);
      assert.equal(finalPkgCount, initialPkgCount);
      assert.equal(finalPaymentCount, initialPaymentCount);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  /* ---------- POST /api/admin/token-packages ---------- */

  test('25. POST without JWT returns 401', async () => {
    const code = `TEST_ADMIN_TP_NOAUTH_${uniqueSuffix()}`;
    const res = await fetch(`${baseUrl}/api/admin/token-packages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.ok(body.error);

    const pkg = await prisma.tokenPackage.findUnique({ where: { code } });
    assert.equal(pkg, null);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'token_package_created', metadata: { path: ['code'], equals: code } },
    });
    assert.equal(audit, null);
  });

  test('26. POST with USER role returns 403', async () => {
    const code = `TEST_ADMIN_TP_USERFORBID_${uniqueSuffix()}`;
    const { status, body } = await postPackage(
      { name: 'Test', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1 },
      USER_TOKEN,
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'Insufficient permissions');

    const pkg = await prisma.tokenPackage.findUnique({ where: { code } });
    assert.equal(pkg, null);
  });

  test('27. Successful creation returns 201 and persists normalized data', async () => {
    const suffix = uniqueSuffix();
    const lowercaseCode = `test_admin_tp_create_${suffix}`;
    const uppercaseCode = lowercaseCode.toUpperCase();

    const { status, body } = await postPackage({
      name: '  Starter Package  ',
      description: '  Starter description  ',
      code: lowercaseCode,
      price: '49.99',
      currency: 'egp',
      tokens: 100,
      sortOrder: 0,
      isActive: false,
    });

    try {
      assert.equal(status, 201);
      assert.equal(body.success, true);
      assert.ok(Number.isInteger(body.data.id) && body.data.id > 0);
      assert.equal(body.data.name, 'Starter Package');
      assert.equal(body.data.description, 'Starter description');
      assert.equal(body.data.code, uppercaseCode);
      assert.equal(typeof body.data.price, 'string');
      assert.equal(body.data.price, '49.99');
      assert.equal(body.data.currency, 'EGP');
      assert.equal(body.data.tokens, 100);
      assert.equal(body.data.sortOrder, 0);
      assert.equal(body.data.isActive, false);
      assert.equal(body.data.paymentCount, 0);
      assert.ok(body.data.createdAt);
      assert.ok(body.data.updatedAt);

      const expectedKeys = [
        'id', 'name', 'description', 'code', 'price', 'currency',
        'tokens', 'sortOrder', 'isActive', 'paymentCount', 'createdAt', 'updatedAt',
      ].sort();
      assert.deepEqual(Object.keys(body.data).sort(), expectedKeys);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { code: uppercaseCode } });
      assert.ok(dbPkg);
      assert.equal(dbPkg.name, 'Starter Package');
      assert.equal(dbPkg.description, 'Starter description');
      assert.equal(dbPkg.isActive, false);
      assert.equal(dbPkg.sortOrder, 0);
    } finally {
      await prisma.tokenPackage.deleteMany({ where: { code: uppercaseCode } });
    }
  });

  test('28. Defaults and optional description work', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DEFAULTS_${suffix}`;

    const { status, body } = await postPackage({
      name: 'Defaults Test',
      description: '   ',
      code,
      price: 25.5,
      currency: 'EGP',
      tokens: 50,
      sortOrder: 0,
    });

    try {
      assert.equal(status, 201);
      assert.equal(body.data.isActive, true);
      assert.equal(body.data.description, null);
      assert.equal(body.data.price, '25.5');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { code } });
      assert.ok(dbPkg);
      assert.equal(dbPkg.isActive, true);
      assert.equal(dbPkg.description, null);
    } finally {
      await prisma.tokenPackage.deleteMany({ where: { code } });
    }
  });

  test('29. Successful creation writes the expected AuditLog', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_AUDIT_${suffix}`;

    const { status, body } = await postPackage({
      name: 'Audit Test',
      code,
      price: '30.00',
      currency: 'EGP',
      tokens: 30,
      sortOrder: 5,
    });

    try {
      assert.equal(status, 201);
      const packageId = body.data.id;

      const audits = await prisma.auditLog.findMany({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_created' },
        orderBy: { createdAt: 'desc' },
      });

      const audit = audits.find((a) => {
        if (!isJsonObject(a.metadata)) return false;
        return a.metadata.tokenPackageId === packageId;
      });

      assert.ok(audit, 'AuditLog not found');
      assert.equal(audit.actorId, ADMIN_USER_ID);
      assert.equal(audit.targetUserId, null);
      assert.equal(audit.action, 'token_package_created');
      assert.ok(isJsonObject(audit.metadata));

      const metadata = audit.metadata;
      assert.ok(isJsonObject(metadata));

      assert.equal(metadata.tokenPackageId, packageId);
      assert.equal(metadata.name, 'Audit Test');
      assert.equal(metadata.code, code);
      assert.equal(metadata.description, null);
      assert.equal(metadata.price, '30');
      assert.equal(typeof metadata.price, 'string');
      assert.equal(metadata.currency, 'EGP');
      assert.equal(metadata.tokens, 30);
      assert.equal(metadata.sortOrder, 5);
      assert.equal(metadata.isActive, true);

      assert.deepEqual(
        Object.keys(metadata).sort(),
        [
          'tokenPackageId',
          'name',
          'code',
          'description',
          'price',
          'currency',
          'tokens',
          'sortOrder',
          'isActive',
        ].sort(),
      );
    } finally {
      await prisma.tokenPackage.deleteMany({ where: { code } });
      await prisma.auditLog.deleteMany({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_created', metadata: { path: ['code'], equals: code } },
      });
    }
  });

  test('30. Duplicate normalized code returns 409', async () => {
    const suffix = uniqueSuffix();
    const lowercaseCode = `test_admin_tp_dup_${suffix}`;
    const uppercaseCode = lowercaseCode.toUpperCase();

    await postPackage({
      name: 'First', code: lowercaseCode, price: '10', currency: 'EGP', tokens: 10, sortOrder: 0,
    });

    const auditCountBefore = await prisma.auditLog.count({
      where: { actorId: ADMIN_USER_ID, action: 'token_package_created' },
    });

    const { status, body } = await postPackage({
      name: 'Second', code: uppercaseCode, price: '20', currency: 'EGP', tokens: 20, sortOrder: 1,
    });

    try {
      assert.equal(status, 409);
      assert.equal(body.error, 'Token package code already exists');

      const pkgs = await prisma.tokenPackage.findMany({ where: { code: uppercaseCode } });
      assert.equal(pkgs.length, 1);

      const auditCountAfter = await prisma.auditLog.count({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_created' },
      });
      assert.equal(auditCountAfter, auditCountBefore);
    } finally {
      await prisma.tokenPackage.deleteMany({ where: { code: uppercaseCode } });
    }
  });

  test('31. Invalid request bodies return 400 and create no records', async () => {
    const prefix = `TEST_ADMIN_TP_INV_${uniqueSuffix()}`;

    const cases: { name: string; body: Record<string, unknown> }[] = [
      { name: 'missing name', body: { code: `${prefix}_1`, price: '10', currency: 'EGP', tokens: 10, sortOrder: 0 } },
      { name: 'name with one character', body: { name: 'A', code: `${prefix}_2`, price: '10', currency: 'EGP', tokens: 10, sortOrder: 0 } },
      { name: 'code containing a hyphen', body: { name: 'Test', code: `${prefix}-WITH-HYPHEN`, price: '10', currency: 'EGP', tokens: 10, sortOrder: 0 } },
      { name: 'code containing a space', body: { name: 'Test', code: `${prefix} SPACE`, price: '10', currency: 'EGP', tokens: 10, sortOrder: 0 } },
      { name: 'price zero', body: { name: 'Test', code: `${prefix}_3`, price: 0, currency: 'EGP', tokens: 10, sortOrder: 0 } },
      { name: 'negative price', body: { name: 'Test', code: `${prefix}_4`, price: -5, currency: 'EGP', tokens: 10, sortOrder: 0 } },
      { name: 'price with three decimal places', body: { name: 'Test', code: `${prefix}_5`, price: 10.999, currency: 'EGP', tokens: 10, sortOrder: 0 } },
      { name: 'string scientific notation "1e3"', body: { name: 'Test', code: `${prefix}_6`, price: '1e3', currency: 'EGP', tokens: 10, sortOrder: 0 } },
      { name: 'currency USD', body: { name: 'Test', code: `${prefix}_7`, price: '10', currency: 'USD', tokens: 10, sortOrder: 0 } },
      { name: 'tokens zero', body: { name: 'Test', code: `${prefix}_8`, price: '10', currency: 'EGP', tokens: 0, sortOrder: 0 } },
      { name: 'tokens fraction', body: { name: 'Test', code: `${prefix}_9`, price: '10', currency: 'EGP', tokens: 1.5, sortOrder: 0 } },
      { name: 'negative sortOrder', body: { name: 'Test', code: `${prefix}_10`, price: '10', currency: 'EGP', tokens: 10, sortOrder: -1 } },
      { name: 'unknown body field', body: { name: 'Test', code: `${prefix}_11`, price: '10', currency: 'EGP', tokens: 10, sortOrder: 0, unknownField: 'x' } },
    ];

    const initialPkgCount = await prisma.tokenPackage.count({
      where: { code: { startsWith: prefix } },
    });
    const initialAuditCount = await prisma.auditLog.count({
      where: { actorId: ADMIN_USER_ID, action: 'token_package_created' },
    });

    for (const { name, body } of cases) {
      const res = await fetch(`${baseUrl}/api/admin/token-packages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      const responseBody = await res.json();
      assert.equal(res.status, 400, `Expected 400 for: ${name}`);
      assert.equal(responseBody.error, 'Validation error', `Expected Validation error for: ${name}`);
    }

    const finalPkgCount = await prisma.tokenPackage.count({
      where: { code: { startsWith: prefix } },
    });
    const finalAuditCount = await prisma.auditLog.count({
      where: { actorId: ADMIN_USER_ID, action: 'token_package_created' },
    });

    assert.equal(finalPkgCount, initialPkgCount);
    assert.equal(finalAuditCount, initialAuditCount);
  });

  test('32. Missing AuditLog actor causes transaction rollback', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_ROLLBACK_${suffix}`;

    const { status, body } = await postPackage(
      { name: 'Rollback Test', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 0 },
      MISSING_ADMIN_USER_TOKEN,
    );

    assert.equal(status, 500);
    assert.equal(body.error, 'Internal server error');

    const pkg = await prisma.tokenPackage.findUnique({ where: { code } });
    assert.equal(pkg, null);

    const audit = await prisma.auditLog.findFirst({
      where: { actorId: MISSING_ADMIN_USER_ID, action: 'token_package_created' },
    });
    assert.equal(audit, null);

    const missingUser = await prisma.user.findUnique({ where: { id: MISSING_ADMIN_USER_ID } });
    assert.equal(missingUser, null);
  });

  test('33. Creating a package does not modify unrelated records', async () => {
    const suffix = uniqueSuffix();
    const unrelatedCode = `UNRELATED_ADMIN_PACKAGE_${suffix}`;

    const unrelated = await prisma.tokenPackage.create({
      data: {
        name: 'Unrelated Package',
        code: unrelatedCode,
        price: '5.00',
        currency: 'USD',
        tokens: 5,
        sortOrder: 99,
        isActive: true,
      },
    });

    try {
      const unrelatedBefore = await prisma.tokenPackage.findUnique({ where: { id: unrelated.id } });

      const globalPaymentCountBefore = await prisma.payment.count();
      const globalWalletCountBefore = await prisma.tokenWallet.count();
      const globalTxCountBefore = await prisma.tokenTransaction.count();

      const testCode = `TEST_ADMIN_TP_UNREL_${suffix}`;
      const { status, body } = await postPackage({
        name: 'Test unrelated', code: testCode, price: '10', currency: 'EGP', tokens: 10, sortOrder: 0,
      });

      assert.equal(status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.code, testCode);

      const newPkg = await prisma.tokenPackage.findUnique({ where: { code: testCode } });
      assert.ok(newPkg);

      const unrelatedAfter = await prisma.tokenPackage.findUnique({ where: { id: unrelated.id } });
      assert.deepEqual(unrelatedBefore, unrelatedAfter);

      const globalPaymentCountAfter = await prisma.payment.count();
      const globalWalletCountAfter = await prisma.tokenWallet.count();
      const globalTxCountAfter = await prisma.tokenTransaction.count();

      assert.equal(globalPaymentCountAfter, globalPaymentCountBefore);
      assert.equal(globalWalletCountAfter, globalWalletCountBefore);
      assert.equal(globalTxCountAfter, globalTxCountBefore);
    } finally {
      await prisma.tokenPackage.deleteMany({ where: { code: unrelatedCode } });
      await prisma.tokenPackage.deleteMany({ where: { code: `TEST_ADMIN_TP_UNREL_${suffix}` } });
    }
  });
});
