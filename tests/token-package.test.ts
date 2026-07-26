import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';

describe('GET /api/token-packages - Public Token Package Listing API', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    // Clean up any lingering test packages
    await prisma.tokenPackage.deleteMany({
      where: { code: { startsWith: 'TEST_' } },
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await prisma.$disconnect();
  });

  test('1. GET /api/token-packages returns HTTP 200 without JWT', async () => {
    const res = await fetch(`${baseUrl}/api/token-packages`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
  });

  test('2 & 3. Only active packages are returned; inactive packages are excluded', async () => {
    const activePkg = await prisma.tokenPackage.create({
      data: {
        name: 'Test Active Package',
        description: 'Active test package',
        code: 'TEST_ACTIVE_PKG_1',
        price: '49.99',
        currency: 'EGP',
        tokens: 50,
        sortOrder: 10,
        isActive: true,
      },
    });

    const inactivePkg = await prisma.tokenPackage.create({
      data: {
        name: 'Test Inactive Package',
        description: 'Inactive test package',
        code: 'TEST_INACTIVE_PKG_1',
        price: '99.99',
        currency: 'EGP',
        tokens: 100,
        sortOrder: 5,
        isActive: false,
      },
    });

    try {
      const res = await fetch(`${baseUrl}/api/token-packages`);
      assert.equal(res.status, 200);

      const body = await res.json();
      const codes = body.data.map((pkg: any) => pkg.code);

      assert.ok(codes.includes('TEST_ACTIVE_PKG_1'));
      assert.ok(!codes.includes('TEST_INACTIVE_PKG_1'));
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: [activePkg.id, inactivePkg.id] } },
      });
    }
  });

  test('4. Packages are sorted by sortOrder ascending', async () => {
    const pkgOrder20 = await prisma.tokenPackage.create({
      data: {
        name: 'Test Package Order 20',
        code: 'TEST_ORDER_20',
        price: '200.00',
        currency: 'EGP',
        tokens: 200,
        sortOrder: 900,
        isActive: true,
      },
    });

    const pkgOrder10 = await prisma.tokenPackage.create({
      data: {
        name: 'Test Package Order 10',
        code: 'TEST_ORDER_10',
        price: '100.00',
        currency: 'EGP',
        tokens: 100,
        sortOrder: 800,
        isActive: true,
      },
    });

    try {
      const res = await fetch(`${baseUrl}/api/token-packages`);
      assert.equal(res.status, 200);

      const body = await res.json();
      const testPkgs = body.data.filter((pkg: any) => pkg.code.startsWith('TEST_ORDER_'));

      assert.equal(testPkgs.length, 2);
      assert.equal(testPkgs[0].code, 'TEST_ORDER_10');
      assert.equal(testPkgs[1].code, 'TEST_ORDER_20');
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: [pkgOrder20.id, pkgOrder10.id] } },
      });
    }
  });

  test('5. Packages with the same sortOrder are sorted by id ascending', async () => {
    // Create first package
    const pkgFirst = await prisma.tokenPackage.create({
      data: {
        name: 'Test Same Order First',
        code: 'TEST_SAME_ORDER_1',
        price: '10.00',
        currency: 'EGP',
        tokens: 10,
        sortOrder: 999,
        isActive: true,
      },
    });

    // Create second package (will get higher id)
    const pkgSecond = await prisma.tokenPackage.create({
      data: {
        name: 'Test Same Order Second',
        code: 'TEST_SAME_ORDER_2',
        price: '20.00',
        currency: 'EGP',
        tokens: 20,
        sortOrder: 999,
        isActive: true,
      },
    });

    try {
      assert.ok(pkgFirst.id < pkgSecond.id);

      const res = await fetch(`${baseUrl}/api/token-packages`);
      assert.equal(res.status, 200);

      const body = await res.json();
      const testPkgs = body.data.filter((pkg: any) => pkg.code.startsWith('TEST_SAME_ORDER_'));

      assert.equal(testPkgs.length, 2);
      assert.equal(testPkgs[0].id, pkgFirst.id);
      assert.equal(testPkgs[1].id, pkgSecond.id);
    } finally {
      await prisma.tokenPackage.deleteMany({
        where: { id: { in: [pkgFirst.id, pkgSecond.id] } },
      });
    }
  });

  test('6. Empty active-package result returns HTTP 200 with data: []', async () => {
    // Temporarily set all active packages to isActive = false for this assertion
    const activePackages = await prisma.tokenPackage.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    const activeIds = activePackages.map((p) => p.id);

    try {
      if (activeIds.length > 0) {
        await prisma.tokenPackage.updateMany({
          where: { id: { in: activeIds } },
          data: { isActive: false },
        });
      }

      const res = await fetch(`${baseUrl}/api/token-packages`);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.success, true);
      assert.deepEqual(body.data, []);
    } finally {
      // Restore active packages
      if (activeIds.length > 0) {
        await prisma.tokenPackage.updateMany({
          where: { id: { in: activeIds } },
          data: { isActive: true },
        });
      }
    }
  });

  test('7. Response contains only allowed safe fields and excludes internal fields', async () => {
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Safe Fields Test Package',
        description: 'Testing safe fields filter',
        code: 'TEST_SAFE_FIELDS',
        price: '75.50',
        currency: 'USD',
        tokens: 150,
        sortOrder: 1,
        isActive: true,
      },
    });

    try {
      const res = await fetch(`${baseUrl}/api/token-packages`);
      assert.equal(res.status, 200);

      const body = await res.json();
      const testPkg = body.data.find((p: any) => p.code === 'TEST_SAFE_FIELDS');
      assert.ok(testPkg);

      const allowedKeys = [
        'id',
        'name',
        'description',
        'code',
        'price',
        'currency',
        'tokens',
        'sortOrder',
      ].sort();

      const receivedKeys = Object.keys(testPkg).sort();
      assert.deepEqual(receivedKeys, allowedKeys);

      // Explicitly check excluded fields
      assert.equal(testPkg.isActive, undefined);
      assert.equal(testPkg.createdAt, undefined);
      assert.equal(testPkg.updatedAt, undefined);
      assert.equal(testPkg.payments, undefined);
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('8. Price is serialized consistently without precision loss', async () => {
    const pkg = await prisma.tokenPackage.create({
      data: {
        name: 'Precision Test Package',
        code: 'TEST_PRECISION_PRICE',
        price: '1234.56',
        currency: 'EGP',
        tokens: 500,
        sortOrder: 1,
        isActive: true,
      },
    });

    try {
      const res = await fetch(`${baseUrl}/api/token-packages`);
      assert.equal(res.status, 200);

      const body = await res.json();
      const testPkg = body.data.find((p: any) => p.code === 'TEST_PRECISION_PRICE');

      assert.ok(testPkg);
      assert.equal(typeof testPkg.price, 'string');
      assert.equal(testPkg.price, '1234.56');
    } finally {
      await prisma.tokenPackage.delete({ where: { id: pkg.id } });
    }
  });

  test('9. No Payment, TokenWallet, or TokenTransaction records are created or modified', async () => {
    const initialPaymentCount = await prisma.payment.count();
    const initialWalletCount = await prisma.tokenWallet.count();
    const initialTxCount = await prisma.tokenTransaction.count();

    const res = await fetch(`${baseUrl}/api/token-packages`);
    assert.equal(res.status, 200);

    const finalPaymentCount = await prisma.payment.count();
    const finalWalletCount = await prisma.tokenWallet.count();
    const finalTxCount = await prisma.tokenTransaction.count();

    assert.equal(finalPaymentCount, initialPaymentCount);
    assert.equal(finalWalletCount, initialWalletCount);
    assert.equal(finalTxCount, initialTxCount);
  });

  test('10. Route ignores Authorization header state and remains publicly accessible', async () => {
    // 1. With invalid Bearer token
    const resInvalid = await fetch(`${baseUrl}/api/token-packages`, {
      headers: { Authorization: 'Bearer invalid_garbage_token_999' },
    });
    assert.equal(resInvalid.status, 200);
    const bodyInvalid = await resInvalid.json();
    assert.equal(bodyInvalid.success, true);

    // 2. With malformed Authorization header
    const resMalformed = await fetch(`${baseUrl}/api/token-packages`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(resMalformed.status, 200);
    const bodyMalformed = await resMalformed.json();
    assert.equal(bodyMalformed.success, true);
  });
});
