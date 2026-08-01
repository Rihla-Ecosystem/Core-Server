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
      action: {
        in: ['token_package_created', 'token_package_updated', 'token_package_status_changed', 'token_package_deleted'],
      },
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

    const userRole = await prisma.role.findUnique({ where: { name: 'user' } });

    await prisma.user.upsert({
      where: { id: USER_TOKEN_SUB },
      update: {},
      create: {
        id: USER_TOKEN_SUB,
        email: 'test_admin_tp_user@example.com',
        passwordHash: 'hash',
        displayName: 'Admin Token Package USER Test User',
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

  async function patchPackage(id: number | string, body: Record<string, unknown>, token: string = ADMIN_TOKEN) {
    const res = await fetch(`${baseUrl}/api/admin/token-packages/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders(token),
      body: JSON.stringify(body),
    });
    const responseBody = await res.json();
    return { status: res.status, body: responseBody };
  }

  async function patchPackageStatus(id: number | string, body: Record<string, unknown>, token: string = ADMIN_TOKEN) {
    const res = await fetch(`${baseUrl}/api/admin/token-packages/${id}/status`, {
      method: 'PATCH',
      headers: jsonHeaders(token),
      body: JSON.stringify(body),
    });
    const responseBody = await res.json();
    return { status: res.status, body: responseBody };
  }

  async function deletePackage(id: number | string, token: string = ADMIN_TOKEN) {
    const res = await fetch(`${baseUrl}/api/admin/token-packages/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const responseBody = await res.json();
    return { status: res.status, body: responseBody };
  }

  function isJsonObject(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
  }

  function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
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

    assert.equal(status, 401);
    assert.equal(body.error, 'Authenticated user not found');

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

  /* ---------- PATCH /api/admin/token-packages/:id ---------- */

  test('34. PATCH without JWT returns 401', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_PATCHNOAUTH_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Patch No Auth', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1 },
    });

    try {
      const res = await fetch(`${baseUrl}/api/admin/token-packages/${pkg.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hacked' }),
      });
      const body = await res.json();

      assert.equal(res.status, 401);
      assert.ok(body.error);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.name, 'Patch No Auth');

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_updated', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('35. PATCH with USER role returns 403', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_PATCHFORBID_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Patch Forbid', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1 },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, { name: 'Forbidden Update' }, USER_TOKEN);

      assert.equal(status, 403);
      assert.equal(body.error, 'Insufficient permissions');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.name, 'Patch Forbid');

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_updated', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('36. Successful partial update returns 200', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_PARTIAL_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Original Name',
        description: 'Original description',
        code,
        price: '25.00',
        currency: 'EGP',
        tokens: 100,
        sortOrder: 5,
        isActive: false,
      },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, { name: '  Updated Package  ', tokens: 250 });

      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.id, pkg.id);
      assert.equal(body.data.name, 'Updated Package');
      assert.equal(body.data.tokens, 250);
      assert.equal(body.data.code, code);
      assert.equal(body.data.description, 'Original description');
      assert.equal(typeof body.data.price, 'string');
      assert.equal(body.data.currency, 'EGP');
      assert.equal(body.data.sortOrder, 5);
      assert.equal(body.data.isActive, false);
      assert.equal(body.data.paymentCount, 0);
      assert.ok(body.data.createdAt);
      assert.ok(body.data.updatedAt);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.name, 'Updated Package');
      assert.equal(dbPkg?.tokens, 250);
      assert.equal(dbPkg?.code, code);
      assert.equal(dbPkg?.description, 'Original description');
      assert.equal(dbPkg?.isActive, false);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('37. Description can be cleared using null', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_CLEARDESC_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Clear Desc', description: 'Will be cleared', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1,
      },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, { description: null });

      assert.equal(status, 200);
      assert.equal(body.data.description, null);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.description, null);
      assert.equal(dbPkg?.name, 'Clear Desc');
      assert.equal(dbPkg?.tokens, 10);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('38. Whitespace-only description becomes null', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_WHITESPACEDESC_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Whitespace Desc', description: 'Will be cleared', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1,
      },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, { description: '   ' });

      assert.equal(status, 200);
      assert.equal(body.data.description, null);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.description, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('39. sortOrder zero and multiple updates work', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_SORTZERO_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Sort Zero', description: 'Original', code, price: '10.00', currency: 'EGP', tokens: 10, sortOrder: 5, isActive: true,
      },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, {
        price: '59.99',
        currency: 'egp',
        tokens: 500,
        sortOrder: 0,
      });

      assert.equal(status, 200);
      assert.equal(typeof body.data.price, 'string');
      assert.equal(parseFloat(body.data.price), 59.99);
      assert.equal(body.data.currency, 'EGP');
      assert.equal(body.data.tokens, 500);
      assert.equal(body.data.sortOrder, 0);
      assert.equal(body.data.code, code);
      assert.equal(body.data.isActive, true);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('40. Empty body returns 400', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_EMPTYBODY_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Empty Body', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1 },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, {});

      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.name, 'Empty Body');

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_updated', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('41. Forbidden fields are rejected', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_FORBIDDEN_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Forbidden Fields', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1 },
    });

    const forbiddenCases: { name: string; body: Record<string, unknown> }[] = [
      { name: 'code', body: { code: 'NEW_CODE' } },
      { name: 'isActive', body: { isActive: false } },
      { name: 'id', body: { id: 1 } },
      { name: 'createdAt', body: { createdAt: '2025-01-01' } },
      { name: 'updatedAt', body: { updatedAt: '2025-01-01' } },
      { name: 'unknownField', body: { unknownField: 'x' } },
    ];

    try {
      for (const { name, body } of forbiddenCases) {
        const res = await fetch(`${baseUrl}/api/admin/token-packages/${pkg.id}`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify(body),
        });
        const responseBody = await res.json();
        assert.equal(res.status, 400, `Expected 400 for: ${name}`);
        assert.equal(responseBody.error, 'Validation error', `Expected Validation error for: ${name}`);
      }

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.code, code);
      assert.equal(dbPkg?.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_updated', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('42. Invalid update values return 400', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_INVALVALUES_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Invalid Values', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1 },
    });

    const invalidCases: { name: string; body: Record<string, unknown> }[] = [
      { name: 'name with one character', body: { name: 'A' } },
      { name: 'whitespace-only name', body: { name: '   ' } },
      { name: 'description longer than 500', body: { description: 'x'.repeat(501) } },
      { name: 'price zero', body: { price: 0 } },
      { name: 'negative price', body: { price: -5 } },
      { name: 'price with three decimal places', body: { price: 10.999 } },
      { name: 'price string "1e3"', body: { price: '1e3' } },
      { name: 'currency USD', body: { currency: 'USD' } },
      { name: 'tokens zero', body: { tokens: 0 } },
      { name: 'tokens fraction', body: { tokens: 1.5 } },
      { name: 'negative sortOrder', body: { sortOrder: -1 } },
    ];

    const initialAuditCount = await prisma.auditLog.count({
      where: { actorId: ADMIN_USER_ID, action: 'token_package_updated' },
    });

    try {
      for (const { name, body } of invalidCases) {
        const { status, body: responseBody } = await patchPackage(pkg.id, body);
        assert.equal(status, 400, `Expected 400 for: ${name}`);
        assert.equal(responseBody.error, 'Validation error', `Expected Validation error for: ${name}`);
      }

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.name, 'Invalid Values');
      assert.equal(dbPkg?.tokens, 10);
      assert.equal(dbPkg?.sortOrder, 1);

      const finalAuditCount = await prisma.auditLog.count({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_updated' },
      });
      assert.equal(finalAuditCount, initialAuditCount);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('43. Invalid IDs return 400', async () => {
    const validBody = { name: 'Should Not Update' };

    for (const id of ['abc', '0', '-1']) {
      const { status, body } = await patchPackage(id, validBody);
      assert.equal(status, 400, `Expected 400 for ID: ${id}`);
      assert.equal(body.error, 'Validation error', `Expected Validation error for ID: ${id}`);
    }
  });

  test('44. Missing package returns 404', async () => {
    const { status, body } = await patchPackage(999999999, { name: 'Missing Package' });

    assert.equal(status, 404);
    assert.equal(body.error, 'Token package not found');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'token_package_updated', metadata: { path: ['tokenPackageId'], equals: 999999999 } },
    });
    assert.equal(audit, null);
  });

  test('45. Successful update writes exact AuditLog metadata', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_AUDITPATCH_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Audit Patch Original',
        description: 'Original audit description',
        code,
        price: '10.00',
        currency: 'EGP',
        tokens: 50,
        sortOrder: 3,
        isActive: true,
      },
    });

    try {
      const { status } = await patchPackage(pkg.id, {
        name: 'Audit Updated',
        description: null,
        price: '75.25',
        tokens: 750,
        sortOrder: 0,
      });

      assert.equal(status, 200);

      const audits = await prisma.auditLog.findMany({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_updated' },
        orderBy: { createdAt: 'desc' },
      });

      const audit = audits.find((a) => {
        if (!isJsonObject(a.metadata)) return false;
        return a.metadata.tokenPackageId === pkg.id;
      });

      assert.ok(audit, 'AuditLog not found');

      const metadata = audit.metadata;
      assert.ok(isJsonObject(metadata));

      assert.deepEqual(
        Object.keys(metadata).sort(),
        ['tokenPackageId', 'code', 'changedFields', 'before', 'after'].sort(),
      );

      assert.equal(metadata.tokenPackageId, pkg.id);
      assert.equal(metadata.code, code);

      const changedFields = metadata.changedFields;
      assert.ok(isStringArray(changedFields));
      assert.deepEqual(
        changedFields.sort(),
        ['name', 'description', 'price', 'tokens', 'sortOrder'].sort(),
      );

      const before = metadata.before;
      const after = metadata.after;
      assert.ok(isJsonObject(before));
      assert.ok(isJsonObject(after));

      assert.deepEqual(
        Object.keys(before).sort(),
        ['name', 'description', 'price', 'currency', 'tokens', 'sortOrder'].sort(),
      );
      assert.deepEqual(
        Object.keys(after).sort(),
        ['name', 'description', 'price', 'currency', 'tokens', 'sortOrder'].sort(),
      );

      assert.equal(before.name, 'Audit Patch Original');
      assert.equal(before.description, 'Original audit description');
      assert.equal(typeof before.price, 'string');
      assert.equal(before.currency, 'EGP');
      assert.equal(before.tokens, 50);
      assert.equal(before.sortOrder, 3);

      assert.equal(after.name, 'Audit Updated');
      assert.equal(after.description, null);
      assert.equal(typeof after.price, 'string');
      assert.equal(after.currency, 'EGP');
      assert.equal(after.tokens, 750);
      assert.equal(after.sortOrder, 0);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('46. Same-value update still writes an AuditLog', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_SAMEVALUE_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Same Value Package', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1,
      },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, { name: 'Same Value Package' });

      assert.equal(status, 200);
      assert.equal(body.data.name, 'Same Value Package');

      const audits = await prisma.auditLog.findMany({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_updated' },
        orderBy: { createdAt: 'desc' },
      });

      const matching = audits.filter((a) => {
        if (!isJsonObject(a.metadata)) return false;
        return a.metadata.tokenPackageId === pkg.id;
      });

      assert.equal(matching.length, 1);

      const m = matching[0];
      const metadata = m.metadata;
      assert.ok(isJsonObject(metadata));

      const changedFields = metadata.changedFields;
      assert.ok(isStringArray(changedFields));
      assert.deepEqual(changedFields, ['name']);

      const before = metadata.before;
      const after = metadata.after;
      assert.ok(isJsonObject(before));
      assert.ok(isJsonObject(after));

      assert.equal(before.name, 'Same Value Package');
      assert.equal(after.name, 'Same Value Package');
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('47. Missing AuditLog actor rolls back the update', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_MISSACTOR_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Rollback Original', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1,
      },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, { name: 'Rollback Update' }, MISSING_ADMIN_USER_TOKEN);

      assert.equal(status, 401);
      assert.equal(body.error, 'Authenticated user not found');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.name, 'Rollback Original');

      const audit = await prisma.auditLog.findFirst({
        where: { actorId: MISSING_ADMIN_USER_ID, action: 'token_package_updated' },
      });
      assert.equal(audit, null);

      const missingUser = await prisma.user.findUnique({ where: { id: MISSING_ADMIN_USER_ID } });
      assert.equal(missingUser, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('48. Update does not modify unrelated records', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_UNREL2_${suffix}`;
    const unrelatedSuffix = uniqueSuffix();
    const unrelatedCode = `UNRELATED_PKG_${unrelatedSuffix}`;

    const target = await prisma.tokenPackage.create({
      data: {
        name: 'Target Package', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1,
      },
    });

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

      const { status, body } = await patchPackage(target.id, { name: 'Target Updated', tokens: 200 });

      assert.equal(status, 200);
      assert.equal(body.data.name, 'Target Updated');
      assert.equal(body.data.tokens, 200);

      const unrelatedAfter = await prisma.tokenPackage.findUnique({ where: { id: unrelated.id } });
      assert.deepEqual(unrelatedBefore, unrelatedAfter);

      const globalPaymentCountAfter = await prisma.payment.count();
      const globalWalletCountAfter = await prisma.tokenWallet.count();
      const globalTxCountAfter = await prisma.tokenTransaction.count();

      assert.equal(globalPaymentCountAfter, globalPaymentCountBefore);
      assert.equal(globalWalletCountAfter, globalWalletCountBefore);
      assert.equal(globalTxCountAfter, globalTxCountBefore);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: unrelated.id } });
      await prisma.tokenPackage.delete({ where: { id: target.id } });
    }
  });

  /* ---------- Status PATCH ---------- */

  test('49. Status PATCH without JWT returns 401', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_ST401_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Status 401', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const res = await fetch(`${baseUrl}/api/admin/token-packages/${pkg.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      });
      const body = await res.json();

      assert.equal(res.status, 401);
      assert.ok(body.error);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_status_changed', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('50. Status PATCH with USER role returns 403', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_ST403_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Status 403', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const { status, body } = await patchPackageStatus(pkg.id, { isActive: false }, USER_TOKEN);

      assert.equal(status, 403);
      assert.equal(body.error, 'Insufficient permissions');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_status_changed', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('51. Admin can deactivate an active package', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DEACTIVATE_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Deactivate Me',
        description: 'Will be deactivated',
        code,
        price: '49.99',
        currency: 'EGP',
        tokens: 100,
        sortOrder: 5,
        isActive: true,
      },
    });

    try {
      const { status, body } = await patchPackageStatus(pkg.id, { isActive: false });

      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.id, pkg.id);
      assert.equal(body.data.isActive, false);
      assert.equal(body.data.code, code);
      assert.equal(body.data.name, 'Deactivate Me');
      assert.equal(body.data.description, 'Will be deactivated');
      assert.equal(typeof body.data.price, 'string');
      assert.equal(body.data.price, '49.99');
      assert.equal(body.data.currency, 'EGP');
      assert.equal(body.data.tokens, 100);
      assert.equal(body.data.sortOrder, 5);
      assert.equal(body.data.paymentCount, 0);
      assert.ok(body.data.createdAt);
      assert.ok(body.data.updatedAt);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.isActive, false);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('52. Admin can activate an inactive package', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_ACTIVATE_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Activate Me',
        description: 'Will be activated',
        code,
        price: '29.99',
        currency: 'EGP',
        tokens: 50,
        sortOrder: 3,
        isActive: false,
      },
    });

    try {
      const { status, body } = await patchPackageStatus(pkg.id, { isActive: true });

      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.id, pkg.id);
      assert.equal(body.data.isActive, true);
      assert.equal(body.data.code, code);
      assert.equal(body.data.name, 'Activate Me');
      assert.equal(body.data.description, 'Will be activated');
      assert.equal(typeof body.data.price, 'string');
      assert.equal(body.data.price, '29.99');
      assert.equal(body.data.currency, 'EGP');
      assert.equal(body.data.tokens, 50);
      assert.equal(body.data.sortOrder, 3);
      assert.equal(body.data.paymentCount, 0);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.isActive, true);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('53. Same-value status request still succeeds and writes AuditLog', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_SAMEST_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Same Status', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const { status, body } = await patchPackageStatus(pkg.id, { isActive: true });

      assert.equal(status, 200);
      assert.equal(body.data.isActive, true);

      const audits = await prisma.auditLog.findMany({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_status_changed' },
        orderBy: { createdAt: 'desc' },
      });

      const matching = audits.filter((a) => {
        if (!isJsonObject(a.metadata)) return false;
        return a.metadata.tokenPackageId === pkg.id;
      });

      assert.equal(matching.length, 1);

      const m = matching[0];
      assert.ok(isJsonObject(m.metadata));

      const before = m.metadata.before;
      const after = m.metadata.after;
      assert.ok(isJsonObject(before));
      assert.ok(isJsonObject(after));

      assert.equal(before.isActive, true);
      assert.equal(after.isActive, true);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('54. Empty body returns 400', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_EMPTYST_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Empty Status', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const { status, body } = await patchPackageStatus(pkg.id, {});

      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_status_changed', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('55. Non-boolean isActive values return 400', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_NONBOOL_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Non-Bool', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    const invalidBodies: Record<string, unknown>[] = [
      { isActive: 'true' },
      { isActive: 'false' },
      { isActive: 1 },
      { isActive: 0 },
      { isActive: null },
    ];

    try {
      for (const body of invalidBodies) {
        const { status, body: responseBody } = await patchPackageStatus(pkg.id, body);
        assert.equal(status, 400, `Expected 400 for body: ${JSON.stringify(body)}`);
        assert.equal(responseBody.error, 'Validation error');
      }

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_status_changed', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('56. Unknown and forbidden fields return 400', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_FORBIDST_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Forbid Status', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    const forbiddenBodies: Record<string, unknown>[] = [
      { isActive: false, name: 'Not allowed' },
      { isActive: false, code: 'NEW_CODE' },
      { isActive: false, tokens: 500 },
      { status: false },
      { isActive: false, unknownField: 'x' },
    ];

    try {
      for (const body of forbiddenBodies) {
        const { status, body: responseBody } = await patchPackageStatus(pkg.id, body);
        assert.equal(status, 400, `Expected 400 for body: ${JSON.stringify(body)}`);
        assert.equal(responseBody.error, 'Validation error');
      }

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.name, 'Forbid Status');
      assert.equal(dbPkg?.code, code);
      assert.equal(dbPkg?.tokens, 10);
      assert.equal(dbPkg?.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_status_changed', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('57. Invalid IDs return 400', async () => {
    for (const id of ['abc', '0', '-1']) {
      const { status, body } = await patchPackageStatus(id, { isActive: false });
      assert.equal(status, 400, `Expected 400 for ID: ${id}`);
      assert.equal(body.error, 'Validation error');
    }
  });

  test('58. Missing package returns 404', async () => {
    const { status, body } = await patchPackageStatus(999999999, { isActive: false });

    assert.equal(status, 404);
    assert.equal(body.error, 'Token package not found');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'token_package_status_changed', metadata: { path: ['tokenPackageId'], equals: 999999999 } },
    });
    assert.equal(audit, null);
  });

  test('59. Successful status change writes exact AuditLog metadata', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_META_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Audit Status Meta',
        description: 'Checking metadata shape',
        code,
        price: '15.50',
        currency: 'EGP',
        tokens: 30,
        sortOrder: 2,
        isActive: true,
      },
    });

    try {
      const { status } = await patchPackageStatus(pkg.id, { isActive: false });
      assert.equal(status, 200);

      const audits = await prisma.auditLog.findMany({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_status_changed' },
        orderBy: { createdAt: 'desc' },
      });

      const audit = audits.find((a) => {
        if (!isJsonObject(a.metadata)) return false;
        return a.metadata.tokenPackageId === pkg.id;
      });

      assert.ok(audit, 'AuditLog not found');
      assert.equal(audit.actorId, ADMIN_USER_ID);
      assert.equal(audit.action, 'token_package_status_changed');

      const metadata = audit.metadata;
      assert.ok(isJsonObject(metadata));

      assert.deepEqual(
        Object.keys(metadata).sort(),
        ['tokenPackageId', 'code', 'before', 'after'].sort(),
      );

      assert.equal(metadata.tokenPackageId, pkg.id);
      assert.equal(metadata.code, code);

      const before = metadata.before;
      const after = metadata.after;
      assert.ok(isJsonObject(before));
      assert.ok(isJsonObject(after));

      assert.deepEqual(Object.keys(before).sort(), ['isActive']);
      assert.deepEqual(Object.keys(after).sort(), ['isActive']);

      assert.equal(before.isActive, true);
      assert.equal(after.isActive, false);

      assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'changedFields'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'name'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'price'), false);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('60. Missing AuditLog actor rolls back status change', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_MISSACTORST_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Status Rollback', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const { status, body } = await patchPackageStatus(pkg.id, { isActive: false }, MISSING_ADMIN_USER_TOKEN);

      assert.equal(status, 401);
      assert.equal(body.error, 'Authenticated user not found');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { actorId: MISSING_ADMIN_USER_ID, action: 'token_package_status_changed' },
      });
      assert.equal(audit, null);

      const missingUser = await prisma.user.findUnique({ where: { id: MISSING_ADMIN_USER_ID } });
      assert.equal(missingUser, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('61. Status change does not modify unrelated records', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_UNREL3_${suffix}`;
    const unrelatedSuffix = uniqueSuffix();
    const unrelatedCode = `UNRELATED_PKG_${unrelatedSuffix}`;

    const target = await prisma.tokenPackage.create({
      data: {
        name: 'Status Target', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true,
      },
    });

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

      const { status, body } = await patchPackageStatus(target.id, { isActive: false });

      assert.equal(status, 200);
      assert.equal(body.data.isActive, false);

      const targetAfter = await prisma.tokenPackage.findUnique({ where: { id: target.id } });
      assert.equal(targetAfter?.name, 'Status Target');
      assert.equal(targetAfter?.code, code);
      assert.equal(targetAfter?.tokens, 10);
      assert.equal(targetAfter?.sortOrder, 1);

      const unrelatedAfter = await prisma.tokenPackage.findUnique({ where: { id: unrelated.id } });
      assert.deepEqual(unrelatedBefore, unrelatedAfter);

      const globalPaymentCountAfter = await prisma.payment.count();
      const globalWalletCountAfter = await prisma.tokenWallet.count();
      const globalTxCountAfter = await prisma.tokenTransaction.count();

      assert.equal(globalPaymentCountAfter, globalPaymentCountBefore);
      assert.equal(globalWalletCountAfter, globalWalletCountBefore);
      assert.equal(globalTxCountAfter, globalTxCountBefore);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: unrelated.id } });
      await prisma.tokenPackage.delete({ where: { id: target.id } });
    }
  });

  test('62. General update route still rejects isActive', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_GENREJ_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'General Reject', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const { status, body } = await patchPackage(pkg.id, { isActive: false });

      assert.equal(status, 400);
      assert.equal(body.error, 'Validation error');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg?.isActive, true);

      const statusAudit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_status_changed', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(statusAudit, null);

      const updateAudit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_updated', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(updateAudit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  /* ---------- Delete ---------- */

  test('63. DELETE without JWT returns 401', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DEL401_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Delete 401', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const res = await fetch(`${baseUrl}/api/admin/token-packages/${pkg.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json();

      assert.equal(res.status, 401);
      assert.ok(body.error);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.ok(dbPkg);
      assert.equal(dbPkg.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_deleted', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('64. DELETE with USER role returns 403', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DEL403_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Delete 403', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const { status, body } = await deletePackage(pkg.id, USER_TOKEN);

      assert.equal(status, 403);
      assert.equal(body.error, 'Insufficient permissions');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.ok(dbPkg);
      assert.equal(dbPkg.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_deleted', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('65. Admin can delete a package without Payments', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DELOK_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Delete Me', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true,
      },
    });

    try {
      const { status, body } = await deletePackage(pkg.id);

      assert.equal(status, 200);
      assert.equal(body.success, true);

      assert.deepEqual(Object.keys(body).sort(), ['data', 'success']);
      assert.deepEqual(Object.keys(body.data).sort(), ['code', 'deleted', 'id']);

      assert.equal(body.data.id, pkg.id);
      assert.equal(body.data.code, code);
      assert.equal(body.data.deleted, true);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg, null);
    } finally {
      await prisma.tokenPackage.deleteMany({ where: { id: pkg.id } });
    }
  });

  test('66. Invalid IDs return 400', async () => {
    for (const id of ['abc', '0', '-1']) {
      const { status, body } = await deletePackage(id);
      assert.equal(status, 400, `Expected 400 for ID: ${id}`);
      assert.equal(body.error, 'Validation error');
    }
  });

  test('67. Missing package returns 404', async () => {
    const { status, body } = await deletePackage(999999999);

    assert.equal(status, 404);
    assert.equal(body.error, 'Token package not found');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'token_package_deleted', metadata: { path: ['tokenPackageId'], equals: 999999999 } },
    });
    assert.equal(audit, null);
  });

  test('68. Package with a related Payment returns 409', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DEL409_${suffix}`;

    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Protected from delete', code, price: '50.00', currency: 'EGP', tokens: 100, sortOrder: 2, isActive: true,
      },
    });

    const user = await prisma.user.create({
      data: {
        email: `test_del409_${suffix}@example.com`,
        passwordHash: 'hash',
        displayName: 'Delete 409 User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });

    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        tokenPackageId: pkg.id,
        amount: '50.00',
        currency: 'EGP',
        packageNameSnapshot: pkg.name,
        tokensSnapshot: pkg.tokens,
        priceSnapshot: pkg.price.toString(),
        currencySnapshot: 'EGP',
      },
    });

    try {
      const pkgBefore = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      const paymentBefore = await prisma.payment.findUnique({ where: { id: payment.id } });

      const { status, body } = await deletePackage(pkg.id);

      assert.equal(status, 409);
      assert.equal(body.error, 'Token package has related payments; deactivate it instead');

      const pkgAfter = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      const paymentAfter = await prisma.payment.findUnique({ where: { id: payment.id } });

      assert.deepEqual(pkgBefore, pkgAfter);
      assert.deepEqual(paymentBefore, paymentAfter);

      assert.equal(pkgAfter?.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'token_package_deleted', metadata: { path: ['tokenPackageId'], equals: pkg.id } },
      });
      assert.equal(audit, null);
    } finally {
      await prisma.payment.delete({ where: { id: payment.id } });
      await prisma.auditLog.deleteMany({ where: { actorId: ADMIN_USER_ID, action: 'token_package_deleted', metadata: { path: ['tokenPackageId'], equals: pkg.id } } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('69. Successful deletion writes exact AuditLog metadata', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DELMETA_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Audit Delete Meta',
        description: 'Checking metadata',
        code,
        price: '35.50',
        currency: 'EGP',
        tokens: 75,
        sortOrder: 4,
        isActive: false,
      },
    });

    try {
      const { status } = await deletePackage(pkg.id);
      assert.equal(status, 200);

      const audits = await prisma.auditLog.findMany({
        where: { actorId: ADMIN_USER_ID, action: 'token_package_deleted' },
        orderBy: { createdAt: 'desc' },
      });

      const audit = audits.find((a) => {
        if (!isJsonObject(a.metadata)) return false;
        return a.metadata.tokenPackageId === pkg.id;
      });

      assert.ok(audit, 'AuditLog not found');
      assert.equal(audit.actorId, ADMIN_USER_ID);
      assert.equal(audit.targetUserId, null);
      assert.equal(audit.action, 'token_package_deleted');

      const metadata = audit.metadata;
      assert.ok(isJsonObject(metadata));

      const expectedMetaKeys = [
        'tokenPackageId', 'name', 'description', 'code', 'price',
        'currency', 'tokens', 'sortOrder', 'isActive',
      ].sort();
      assert.deepEqual(Object.keys(metadata).sort(), expectedMetaKeys);

      assert.equal(metadata.tokenPackageId, pkg.id);
      assert.equal(metadata.name, 'Audit Delete Meta');
      assert.equal(metadata.description, 'Checking metadata');
      assert.equal(metadata.code, code);
      assert.equal(metadata.currency, 'EGP');
      assert.equal(metadata.tokens, 75);
      assert.equal(metadata.sortOrder, 4);
      assert.equal(metadata.isActive, false);

      {
        const price = metadata.price;
        if (typeof price !== 'string') throw new Error('metadata price not string');
        if (parseFloat(price) !== 35.5) throw new Error('metadata price wrong');
      }

      assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'paymentCount'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(metadata, '_count'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'createdAt'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'updatedAt'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'deleted'), false);

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.equal(dbPkg, null);
    } finally {
      await prisma.auditLog.deleteMany({ where: { actorId: ADMIN_USER_ID, action: 'token_package_deleted', metadata: { path: ['tokenPackageId'], equals: pkg.id } } });
      await prisma.tokenPackage.deleteMany({ where: { id: pkg.id } });
    }
  });

  test('70. Missing AuditLog actor rolls back deletion', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DELROLL_${suffix}`;
    const pkg = await prisma.tokenPackage.create({
      data: { name: 'Delete Rollback', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true },
    });

    try {
      const { status, body } = await deletePackage(pkg.id, MISSING_ADMIN_USER_TOKEN);

      assert.equal(status, 401);
      assert.equal(body.error, 'Authenticated user not found');

      const dbPkg = await prisma.tokenPackage.findUnique({ where: { id: pkg.id } });
      assert.ok(dbPkg);
      assert.equal(dbPkg.name, 'Delete Rollback');
      assert.equal(dbPkg.isActive, true);

      const audit = await prisma.auditLog.findFirst({
        where: { actorId: MISSING_ADMIN_USER_ID, action: 'token_package_deleted' },
      });
      assert.equal(audit, null);

      const missingUser = await prisma.user.findUnique({ where: { id: MISSING_ADMIN_USER_ID } });
      assert.equal(missingUser, null);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('71. Deletion does not modify unrelated records', async () => {
    const suffix = uniqueSuffix();
    const code = `TEST_ADMIN_TP_DELUNREL_${suffix}`;
    const unrelatedSuffix = uniqueSuffix();
    const unrelatedCode = `UNRELATED_PKG_${unrelatedSuffix}`;

    const target = await prisma.tokenPackage.create({
      data: {
        name: 'Delete Target', code, price: '10', currency: 'EGP', tokens: 10, sortOrder: 1, isActive: true,
      },
    });

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

      const { status, body } = await deletePackage(target.id);

      assert.equal(status, 200);
      assert.equal(body.data.deleted, true);

      const targetAfter = await prisma.tokenPackage.findUnique({ where: { id: target.id } });
      assert.equal(targetAfter, null);

      const unrelatedAfter = await prisma.tokenPackage.findUnique({ where: { id: unrelated.id } });
      assert.deepEqual(unrelatedBefore, unrelatedAfter);

      const globalPaymentCountAfter = await prisma.payment.count();
      const globalWalletCountAfter = await prisma.tokenWallet.count();
      const globalTxCountAfter = await prisma.tokenTransaction.count();

      assert.equal(globalPaymentCountAfter, globalPaymentCountBefore);
      assert.equal(globalWalletCountAfter, globalWalletCountBefore);
      assert.equal(globalTxCountAfter, globalTxCountBefore);
    } finally {
      await prisma.auditLog.deleteMany({ where: { actorId: ADMIN_USER_ID, action: 'token_package_deleted', metadata: { path: ['tokenPackageId'], equals: target.id } } });
      await prisma.tokenPackage.delete({ where: { id: unrelated.id } });
      await prisma.tokenPackage.deleteMany({ where: { id: target.id } });
    }
  });
});
