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
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/config/prisma.js';
import { signAccessToken } from '../src/utils/token.js';
import { Gender, TokenTransactionType, WalletStatus } from '@prisma/client';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const IDENTIFICATION_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

describe('Identify validation - pre-charge request identity and image validation', () => {
  let appServer: Server;
  let aiServer: Server;
  let baseUrl: string;
  let aiCallCount = 0;
  const originalAiServiceUrl = env.AI_SERVICE_URL;
  const EMAIL_PREFIX = 'test_identify_validation_';

  const mockIdentifyResponse = {
    name: 'Mock Landmark',
    name_ar: 'مَعلم',
    description: 'Mock description',
    category: 'historical',
    historical_period: 'Ottoman',
    wikipedia_url: 'https://example.org/wiki/Mock',
    image_url: 'https://example.org/mock.jpg',
    nearby_sites: [{ name: 'Site A' }],
    cached: false,
  };

  before(async () => {
    await prisma.role.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, name: 'USER' },
    });
    await cleanupSuiteData();

    await new Promise<void>((resolve) => {
      aiServer = http.createServer(async (req, res) => {
        res.on('error', () => {});
        for await (const _chunk of req) {
          // drain the request body
        }
        aiCallCount += 1;
        if (req.url === '/identify') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockIdentifyResponse));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
      aiServer.listen(0, () => {
        const address = aiServer.address() as AddressInfo;
        env.AI_SERVICE_URL = `http://localhost:${address.port}`;
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      appServer = app.listen(0, () => {
        const address = appServer.address() as AddressInfo;
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    try {
      await cleanupSuiteData();
    } finally {
      env.AI_SERVICE_URL = originalAiServiceUrl;
    }
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => aiServer.close(() => resolve()));
    await prisma.$disconnect();
  });

  async function cleanupSuiteData(): Promise<void> {
    const emailFilter = { email: { startsWith: EMAIL_PREFIX } };
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.conversation.deleteMany({ where: { user: emailFilter } });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function createUser(walletBalance?: number): Promise<{ userId: string; token: string }> {
    const user = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Identify Validation User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    if (walletBalance !== undefined) {
      await prisma.tokenWallet.create({
        data: { userId: user.id, tokenBalance: walletBalance, status: WalletStatus.ACTIVE },
      });
    }
    const token = signAccessToken({ sub: user.id, role: 'USER' });
    return { userId: user.id, token };
  }

  async function deleteUserWithRelated(userId: string): Promise<void> {
    await prisma.tokenTransaction.deleteMany({ where: { userId } });
    await prisma.tokenWallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  async function getBalance(userId: string): Promise<number | null> {
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
    return wallet ? wallet.tokenBalance : null;
  }

  async function assertNoCharge(userId: string, expectedBalance: number): Promise<void> {
    assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
    assert.equal(await getBalance(userId), expectedBalance);
  }

  function buildForm(
    fieldName: string,
    blob: Blob,
    filename: string,
    textFields?: Record<string, string>,
  ): FormData {
    const form = new FormData();
    form.append(fieldName, blob, filename);
    if (textFields) {
      for (const [key, value] of Object.entries(textFields)) form.append(key, value);
    }
    return form;
  }

  function authHeaders(token: string, idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    return headers;
  }

  function validJpegBlob(): Blob {
    return new Blob([JPEG_SIGNATURE], { type: 'image/jpeg' });
  }

  function validPngBlob(): Blob {
    return new Blob([PNG_SIGNATURE], { type: 'image/png' });
  }

  test('1. Valid JPEG request succeeds, charges the wallet, and preserves the response shape', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', validJpegBlob(), 'test.jpg'),
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.name, mockIdentifyResponse.name);
      assert.equal(body.name_ar, mockIdentifyResponse.name_ar);
      assert.equal(body.description, mockIdentifyResponse.description);
      assert.equal(body.category, mockIdentifyResponse.category);
      assert.equal(body.historical_period, mockIdentifyResponse.historical_period);
      assert.equal(body.wikipedia_url, mockIdentifyResponse.wikipedia_url);
      assert.equal(body.image_url, mockIdentifyResponse.image_url);
      assert.equal(body.cached, false);
      assert.deepEqual(body.nearby_sites, mockIdentifyResponse.nearby_sites);
      assert.equal(aiCallCount, callsBefore + 1);
      assert.equal(await getBalance(userId), 5);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('2. Valid PNG request succeeds and calls the AI provider once', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', validPngBlob(), 'test.png'),
      });
      assert.equal(res.status, 200);
      assert.equal(aiCallCount, callsBefore + 1);
      assert.equal(await getBalance(userId), 5);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('3. Missing Idempotency-Key returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token),
        body: buildForm('image', validJpegBlob(), 'test.jpg'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Idempotency-Key header is required');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('4. Blank Idempotency-Key returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, '   '),
        body: buildForm('image', validJpegBlob(), 'test.jpg'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Idempotency-Key header is required');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('5. Invalid Idempotency-Key returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, 'not-a-uuid'),
        body: buildForm('image', validJpegBlob(), 'test.jpg'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Idempotency-Key header must be a valid UUID');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('6. Missing image returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: new FormData(),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Image file is required');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('7. Unsupported MIME type returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const webp = new Blob([Buffer.from([0x52, 0x49, 0x46, 0x46])], { type: 'image/webp' });
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', webp, 'test.webp'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Only JPEG and PNG image files are allowed');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('8. Image larger than 5 MB returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const oversized = new Blob([Buffer.alloc(IDENTIFICATION_IMAGE_MAX_BYTES + 1)], {
        type: 'image/jpeg',
      });
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', oversized, 'big.jpg'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Image file must not exceed 5 MB');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('9. Fake JPEG MIME with arbitrary content returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const fakeJpeg = new Blob(['this is not an image at all'], { type: 'image/jpeg' });
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', fakeJpeg, 'fake.jpg'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid image file');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('10. Fake PNG MIME with arbitrary content returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const fakePng = new Blob(['this is not an image at all'], { type: 'image/png' });
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', fakePng, 'fake.png'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid image file');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('11. JPEG bytes declared as PNG returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const jpegAsPng = new Blob([JPEG_SIGNATURE], { type: 'image/png' });
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', jpegAsPng, 'fake.png'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid image file');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('12. PNG bytes declared as JPEG returns 400, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const pngAsJpeg = new Blob([PNG_SIGNATURE], { type: 'image/jpeg' });
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', pngAsJpeg, 'fake.jpg'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid image file');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('13. Invalid latitude returns the existing 400 message, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', validJpegBlob(), 'test.jpg', { lat: '91' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid latitude');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('14. Invalid longitude returns the existing 400 message, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', validJpegBlob(), 'test.jpg', { lon: '181' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid longitude');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('15. Invalid radius returns the existing 400 message, does not reach the AI provider, and charges nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', validJpegBlob(), 'test.jpg', { radius: '-1' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid radius');
      assert.equal(aiCallCount, callsBefore);
      await assertNoCharge(userId, 10);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('16. An invalid pre-charge request charges nothing and persists nothing', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const fakeJpeg = new Blob(['this is not an image at all'], { type: 'image/jpeg' });
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: authHeaders(token, crypto.randomUUID()),
        body: buildForm('image', fakeJpeg, 'fake.jpg'),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Invalid image file');
      assert.equal(aiCallCount, callsBefore);

      assert.equal(await getBalance(userId), 10);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.CONSUME } }),
        0,
      );
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );
      assert.equal(await prisma.conversation.count({ where: { userId } }), 0);
      assert.equal(await prisma.message.count({ where: { conversation: { userId } } }), 0);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });
});
