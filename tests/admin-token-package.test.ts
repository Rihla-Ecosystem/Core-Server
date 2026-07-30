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

const ADMIN_TOKEN = signAccessToken({ sub: '11111111-1111-4111-8111-111111111111', role: 'admin' });
const USER_TOKEN = signAccessToken({ sub: '22222222-2222-4222-8222-222222222222', role: 'USER' });

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
  await prisma.user.deleteMany({
    where: { email: { startsWith: 'test_admin_tp_' } },
  });
  await prisma.tokenPackage.deleteMany({
    where: { code: { startsWith: 'TEST_ADMIN_TP_' } },
  });
}

describe('GET /api/admin/token-packages — Admin Token Package API', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await cleanupTestData();
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
});
