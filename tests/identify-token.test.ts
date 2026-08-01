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
import {
  Gender,
  TokenTransactionSource,
  TokenTransactionType,
  WalletStatus,
} from '@prisma/client';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

describe('Identify token consumption - AI_IMAGE_ANALYSIS integration', () => {
  let appServer: Server;
  let aiServer: Server;
  let baseUrl: string;
  let aiCallCount = 0;
  let providerError = false;
  let delayedProviderError = false;
  const originalAiServiceUrl = env.AI_SERVICE_URL;
  const EMAIL_PREFIX = 'test_identify_token_';

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

  async function waitForCondition(
    condition: () => Promise<boolean>,
    timeoutMs = 5000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for condition');
  }

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
        if (req.url !== '/identify') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        if (delayedProviderError) {
          setTimeout(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
          }, 400);
          return;
        }
        if (providerError) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'boom' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockIdentifyResponse));
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

  async function createUser(balance?: number): Promise<{ userId: string; token: string }> {
    const user = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Identify Token User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    if (balance !== undefined) {
      await prisma.tokenWallet.create({
        data: { userId: user.id, tokenBalance: balance, status: WalletStatus.ACTIVE },
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

  function validJpegBlob(): Blob {
    return new Blob([JPEG_SIGNATURE], { type: 'image/jpeg' });
  }

  function identifyRequest(token: string, idempotencyKey: string): Promise<Response> {
    const form = new FormData();
    form.append('image', validJpegBlob(), 'test.jpg');
    return fetch(`${baseUrl}/api/identify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
      body: form,
    });
  }

  test('1. Successful image analysis consumes 5 tokens and preserves the response', async () => {
    const { userId, token } = await createUser(10);
    const key = crypto.randomUUID();
    const callsBefore = aiCallCount;
    try {
      const res = await identifyRequest(token, key);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.name, mockIdentifyResponse.name);
      assert.equal(body.description, mockIdentifyResponse.description);
      assert.equal(body.cached, false);
      assert.deepEqual(body.nearby_sites, mockIdentifyResponse.nearby_sites);

      assert.equal(await getBalance(userId), 5);

      const consumeRows = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(consumeRows.length, 1);
      const consumeRow = consumeRows[0];
      assert.equal(consumeRow.tokens, 5);
      assert.equal(consumeRow.type, TokenTransactionType.CONSUME);
      assert.equal(consumeRow.source, TokenTransactionSource.IMAGE);
      assert.deepEqual(consumeRow.metadata, {
        feature: 'AI_IMAGE_ANALYSIS',
        businessRequestId: key,
      });

      const metadataText = JSON.stringify(consumeRow.metadata);
      assert.ok(metadataText.includes('AI_IMAGE_ANALYSIS'));
      assert.ok(metadataText.includes(key));
      assert.ok(!metadataText.includes('image/jpeg'));
      assert.ok(!metadataText.includes('base64'));
      assert.ok(!metadataText.includes('authorization'));
      assert.ok(!metadataText.includes('response'));

      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('2. Insufficient balance returns 402, deducts nothing, and does not reach the AI provider', async () => {
    const { userId, token } = await createUser(4);
    const callsBefore = aiCallCount;
    try {
      const res = await identifyRequest(token, crypto.randomUUID());
      assert.equal(res.status, 402);
      const body = await res.json();
      assert.equal(body.error, 'Insufficient token balance');

      assert.equal(await getBalance(userId), 4);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(aiCallCount, callsBefore);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('3. Missing wallet returns 402, creates no wallet, and does not reach the AI provider', async () => {
    const { userId, token } = await createUser();
    const callsBefore = aiCallCount;
    try {
      const res = await identifyRequest(token, crypto.randomUUID());
      assert.equal(res.status, 402);
      const body = await res.json();
      assert.equal(body.error, 'Insufficient token balance');

      assert.equal(await prisma.tokenWallet.count({ where: { userId } }), 0);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(aiCallCount, callsBefore);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('4. Sequential duplicate Idempotency-Key returns 409 and is not re-executed', async () => {
    const { userId, token } = await createUser(10);
    const key = crypto.randomUUID();
    const callsBefore = aiCallCount;
    try {
      const first = await identifyRequest(token, key);
      assert.equal(first.status, 200);
      assert.equal(await getBalance(userId), 5);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.CONSUME } }),
        1,
      );

      const second = await identifyRequest(token, key);
      assert.equal(second.status, 409);
      const body = await second.json();
      assert.equal(body.error, 'Image analysis request already processed');

      assert.equal(await getBalance(userId), 5);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.CONSUME } }),
        1,
      );
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('5. Different keys for the same image consume independently', async () => {
    const { userId, token } = await createUser(10);
    const callsBefore = aiCallCount;
    try {
      const first = await identifyRequest(token, crypto.randomUUID());
      assert.equal(first.status, 200);
      const second = await identifyRequest(token, crypto.randomUUID());
      assert.equal(second.status, 200);

      assert.equal(await getBalance(userId), 0);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.CONSUME } }),
        2,
      );
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 2);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('6. Provider failure refunds the full consumption', async () => {
    const { userId, token } = await createUser(10);
    const key = crypto.randomUUID();
    const callsBefore = aiCallCount;
    providerError = true;
    try {
      const res = await identifyRequest(token, key);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, 'AI identification service unavailable: boom');

      assert.equal(await getBalance(userId), 10);

      const consumeRows = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(consumeRows.length, 1);
      const refundRows = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.REFUND },
      });
      assert.equal(refundRows.length, 1);
      assert.equal(refundRows[0].tokens, consumeRows[0].tokens);
      assert.equal(refundRows[0].source, TokenTransactionSource.IMAGE);
      assert.deepEqual(refundRows[0].metadata, {
        feature: 'AI_IMAGE_ANALYSIS',
        businessRequestId: key,
        refundedTransactionId: consumeRows[0].id,
      });
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      providerError = false;
      await deleteUserWithRelated(userId);
    }
  });

  test('7. Retry with the same key after a refunded failure returns 409 without re-execution', async () => {
    const { userId, token } = await createUser(10);
    const key = crypto.randomUUID();
    const callsBefore = aiCallCount;
    providerError = true;
    try {
      const first = await identifyRequest(token, key);
      assert.equal(first.status, 502);
      assert.equal(await getBalance(userId), 10);

      providerError = false;
      const second = await identifyRequest(token, key);
      assert.equal(second.status, 409);
      const body = await second.json();
      assert.equal(body.error, 'Image analysis request already processed');

      assert.equal(await getBalance(userId), 10);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.CONSUME } }),
        1,
      );
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        1,
      );
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      providerError = false;
      await deleteUserWithRelated(userId);
    }
  });

  test('8. Concurrent duplicate requests charge and execute once', async () => {
    const { userId, token } = await createUser(10);
    const key = crypto.randomUUID();
    const callsBefore = aiCallCount;
    try {
      const [resA, resB] = await Promise.all([
        identifyRequest(token, key),
        identifyRequest(token, key),
      ]);
      const statuses = [resA.status, resB.status].sort();
      assert.deepEqual(statuses, [200, 409]);

      const successRes = resA.status === 200 ? resA : resB;
      const duplicateRes = resA.status === 409 ? resA : resB;
      const successBody = await successRes.json();
      assert.equal(successBody.name, mockIdentifyResponse.name);
      const duplicateBody = await duplicateRes.json();
      assert.equal(duplicateBody.error, 'Image analysis request already processed');

      assert.equal(await getBalance(userId), 5);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.CONSUME } }),
        1,
      );
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('9. Concurrent distinct requests cannot overspend', async () => {
    const { userId, token } = await createUser(5);
    const callsBefore = aiCallCount;
    try {
      const [resA, resB] = await Promise.all([
        identifyRequest(token, crypto.randomUUID()),
        identifyRequest(token, crypto.randomUUID()),
      ]);
      const statuses = [resA.status, resB.status].sort();
      assert.deepEqual(statuses, [200, 402]);

      const successRes = resA.status === 200 ? resA : resB;
      const insufficientRes = resA.status === 402 ? resA : resB;
      const successBody = await successRes.json();
      assert.equal(successBody.name, mockIdentifyResponse.name);
      const insufficientBody = await insufficientRes.json();
      assert.equal(insufficientBody.error, 'Insufficient token balance');

      assert.equal(await getBalance(userId), 0);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.CONSUME } }),
        1,
      );
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await deleteUserWithRelated(userId);
    }
  });

  test('10. Refund failure is surfaced with a safe log and no refund row', async () => {
    const { userId, token } = await createUser(10);
    const key = crypto.randomUUID();
    const callsBefore = aiCallCount;
    delayedProviderError = true;
    const originalConsoleError = console.error;
    const capturedLogs: string[] = [];
    console.error = (...args: unknown[]) => {
      capturedLogs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    try {
      const pending = identifyRequest(token, key);

      await waitForCondition(async () => {
        const count = await prisma.tokenTransaction.count({
          where: { userId, type: TokenTransactionType.CONSUME },
        });
        return count === 1;
      });

      const consumeRow = await prisma.tokenTransaction.findFirst({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.ok(consumeRow);
      await prisma.tokenTransaction.delete({ where: { id: consumeRow.id } });

      const res = await pending;
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'Unable to restore consumed tokens');

      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 1);

      const logs = capturedLogs.join('\n');
      assert.ok(logs.includes('Failed to restore consumed tokens'));
      assert.ok(logs.includes('"userId"'));
      assert.ok(logs.includes('"businessRequestId"'));
      assert.ok(logs.includes('"originalError"'));
      assert.ok(logs.includes('"refundError"'));
      assert.ok(!logs.includes('"image"'));
      assert.ok(!logs.includes('"filename"'));
      assert.ok(!logs.includes('"authorization"'));
      assert.ok(!logs.includes('image/jpeg'));
      assert.ok(!logs.includes('base64'));
    } finally {
      delayedProviderError = false;
      console.error = originalConsoleError;
      await deleteUserWithRelated(userId);
    }
  });
});
