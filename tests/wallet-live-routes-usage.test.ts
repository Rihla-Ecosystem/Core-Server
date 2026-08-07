/**
 * Phase 2G-B live HTTP route cutover tests.
 *
 * Covers the five live routes (chat, chat-stream, identify, voice, itinerary)
 * and the admin-exempt path. Usage-based Wallet billing is the only live
 * billing mode (legacy FIXED billing was removed in Phase 2G-B), so no billing
 * mode env var is forced. The app modules are loaded via dynamic imports so
 * this file runs in its own isolated process.
 *
 * All fixtures use the `test_wallet_route_` email prefix and `core_server_test`.
 */

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
import { Gender, TokenTransactionSource, TokenTransactionType, WalletStatus } from '@prisma/client';

const { default: app } = await import('../src/app.js');
const { env } = await import('../src/config/env.js');
const { prisma } = await import('../src/config/prisma.js');
const { ensureUserRole } = await import('./helpers/test-role-fixtures.js');
const { signAccessToken } = await import('../src/utils/token.js');

const EMAIL_PREFIX = 'test_wallet_route_';

const USAGE = {
  model: 'gemini-3.5-flash-lite',
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
};

const PROVIDER_CALLS = [
  {
    provider: 'google',
    providerCallMade: true,
    providerCallId: 'live-call-1',
    actualModel: 'gemini-3.5-flash-lite',
    inputTokens: 100,
    outputTokens: 50,
  },
];

const MOCK_CHAT = { response: 'hello from ai', persona: 'auto', usage: USAGE, providerCalls: PROVIDER_CALLS };
const MOCK_IDENTIFY = {
  name: 'Mock Landmark',
  name_ar: 'مَعلم',
  description: 'Mock description',
  category: 'historical',
  historical_period: 'Ottoman',
  wikipedia_url: 'https://example.org/wiki/Mock',
  image_url: 'https://example.org/mock.jpg',
  nearby_sites: [{ name: 'Site A' }],
  cached: false,
  usage: USAGE,
  providerCalls: PROVIDER_CALLS,
};
const MOCK_VOICE = {
  text_response: 'أهلاً',
  audio_url: null,
  conversation_id: null,
  usage: USAGE,
  providerCalls: PROVIDER_CALLS,
};
const MOCK_ITINERARY = { itinerary: 'Day 1: Cairo Museum', usage: USAGE, providerCalls: PROVIDER_CALLS };

describe('Wallet usage-based live route cutover (USAGE_BASED mode)', () => {
  let USER_ROLE_ID: number;
  let appServer: Server;
  let aiServer: Server;
  let baseUrl: string;
  const originalAiServiceUrl = env.AI_SERVICE_URL;

  before(async () => {
    USER_ROLE_ID = (await ensureUserRole()).id;
    await cleanupSuiteData();

    await new Promise<void>((resolve) => {
      aiServer = http.createServer(async (req, res) => {
        res.on('error', () => {});
        for await (const _chunk of req) {
          // drain the request body
        }
        if (req.url === '/chat') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(MOCK_CHAT));
          return;
        }
        if (req.url === '/chat/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"delta":"streamed reply"}\n\n');
          res.write(
            `data: ${JSON.stringify({
              usage: USAGE,
              providerCalls: PROVIDER_CALLS,
              providerAttempts: [],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ done: true, full_response: 'streamed reply' })}\n\n`,
          );
          res.end();
          return;
        }
        if (req.url === '/identify') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(MOCK_IDENTIFY));
          return;
        }
        if (req.url === '/voice') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(MOCK_VOICE));
          return;
        }
        if (req.url === '/itinerary') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(MOCK_ITINERARY));
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
    const userIds = (await prisma.user.findMany({ where: emailFilter, select: { id: true } })).map(
      (u) => u.id,
    );
    if (userIds.length > 0) {
      await prisma.aIBillingOperation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.tokenReservation.deleteMany({ where: { userId: { in: userIds } } });
    }
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function cleanupUser(userId: string): Promise<void> {
    await prisma.aIBillingOperation.deleteMany({ where: { userId } });
    await prisma.tokenReservation.deleteMany({ where: { userId } });
    await prisma.tokenTransaction.deleteMany({ where: { userId } });
    await prisma.tokenWallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  async function createUser(
    opts: { balance?: number; roleName?: string } = {},
  ): Promise<{ userId: string; walletId: string | null; token: string }> {
    const role = await ensureUserRole();
    const roleId = opts.roleName
      ? (
          await prisma.role.upsert({
            where: { name: opts.roleName },
            update: {},
            create: { name: opts.roleName },
          })
        ).id
      : role.id;
    const user = await prisma.user.create({
      data: {
        roleId,
        email: `${EMAIL_PREFIX}${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Wallet Route User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    let walletId: string | null = null;
    if (opts.balance !== undefined) {
      const wallet = await prisma.tokenWallet.create({
        data: { userId: user.id, tokenBalance: opts.balance, status: WalletStatus.ACTIVE },
      });
      walletId = wallet.id;
    }
    const token = signAccessToken({ sub: user.id, role: 'USER' });
    return { userId: user.id, walletId, token };
  }

  async function balance(userId: string): Promise<number | null> {
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
    return wallet ? wallet.tokenBalance : null;
  }

  function authHeaders(token: string, idempotencyKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    };
  }

  test('1. POST /api/chat charges priced usage tokens (not the fixed cost) and settles', async () => {
    const { userId, walletId, token } = await createUser({ balance: 1000 });
    const idempotencyKey = crypto.randomUUID();
    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: authHeaders(token, idempotencyKey),
        body: JSON.stringify({ message: 'hello world' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.response, 'hello from ai');

      // Usage-based: 155000 nano-USD -> 2 Wallet Tokens (fixed cost was 1).
      assert.equal(await balance(userId), 998);

      const consume = await prisma.tokenTransaction.findFirst({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.ok(consume);
      assert.equal(consume.tokens, 2);
      assert.equal(consume.source, TokenTransactionSource.CHAT);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: `usage:AI_CHAT_QUERY:${idempotencyKey}` },
      });
      assert.ok(operation);
      assert.equal(operation.status, 'SETTLED');
      assert.equal(operation.actualWalletTokens, 2);
      assert.equal(operation.reservedTokens, 1000);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: operation.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, 'COMPLETED');
      assert.ok(walletId);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('2. POST /api/chat/stream reserves before dispatch and settles once from final usage', async () => {
    const { userId, token } = await createUser({ balance: 1000 });
    const idempotencyKey = crypto.randomUUID();
    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: authHeaders(token, idempotencyKey),
        body: JSON.stringify({ message: 'stream me' }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('streamed reply'));

      assert.equal(await balance(userId), 998);

      const consumeRows = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(consumeRows.length, 1);
      assert.equal(consumeRows[0].tokens, 2);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: `usage:AI_CHAT_QUERY:${idempotencyKey}` },
      });
      assert.ok(operation);
      assert.equal(operation.status, 'SETTLED');
      assert.equal(operation.actualWalletTokens, 2);
      assert.equal(
        await prisma.tokenTransaction.count({ where: { userId, type: TokenTransactionType.REFUND } }),
        0,
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('3. POST /api/identify charges priced image-analysis usage and settles', async () => {
    const { userId, token } = await createUser({ balance: 1000 });
    const idempotencyKey = crypto.randomUUID();
    try {
      const jpeg = new Blob(
        [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])],
        { type: 'image/jpeg' },
      );
      const form = new FormData();
      form.append('image', jpeg, 'test.jpg');
      const res = await fetch(`${baseUrl}/api/identify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
        body: form,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.name, MOCK_IDENTIFY.name);

      assert.equal(await balance(userId), 998);

      const consume = await prisma.tokenTransaction.findFirst({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.ok(consume);
      assert.equal(consume.tokens, 2);
      assert.equal(consume.source, TokenTransactionSource.IMAGE);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: `usage:AI_IMAGE_ANALYSIS:${idempotencyKey}` },
      });
      assert.ok(operation);
      assert.equal(operation.status, 'SETTLED');
      assert.equal(operation.actualWalletTokens, 2);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('4. POST /api/voice charges priced real-time-translation usage and settles', async () => {
    const { userId, token } = await createUser({ balance: 1000 });
    const idempotencyKey = crypto.randomUUID();
    try {
      const audio = new Blob([Buffer.from([0x52, 0x49, 0x46, 0x46])], { type: 'audio/wav' });
      const form = new FormData();
      form.append('audio', audio, 'test.wav');
      const res = await fetch(`${baseUrl}/api/voice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
        body: form,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.text_response, MOCK_VOICE.text_response);

      assert.equal(await balance(userId), 998);

      const consume = await prisma.tokenTransaction.findFirst({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.ok(consume);
      assert.equal(consume.tokens, 2);
      assert.equal(consume.source, TokenTransactionSource.VOICE);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: `usage:REAL_TIME_TRANSLATION:${idempotencyKey}` },
      });
      assert.ok(operation);
      assert.equal(operation.status, 'SETTLED');
      assert.equal(operation.actualWalletTokens, 2);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('5. POST /api/itinerary charges priced itinerary usage and settles', async () => {
    const { userId, token } = await createUser({ balance: 1000 });
    const idempotencyKey = crypto.randomUUID();
    try {
      const res = await fetch(`${baseUrl}/api/itinerary`, {
        method: 'POST',
        headers: authHeaders(token, idempotencyKey),
        body: JSON.stringify({ interests: ['history'], days: 3, budget: 'mid' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.itinerary, MOCK_ITINERARY.itinerary);

      assert.equal(await balance(userId), 998);

      const consume = await prisma.tokenTransaction.findFirst({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.ok(consume);
      assert.equal(consume.tokens, 2);
      assert.equal(consume.source, TokenTransactionSource.ITINERARY);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: `usage:AI_TRIP_ITINERARY:${idempotencyKey}` },
      });
      assert.ok(operation);
      assert.equal(operation.status, 'SETTLED');
      assert.equal(operation.actualWalletTokens, 2);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('6. Admin users execute normally but are never charged (admin exempt)', async () => {
    const { userId, token } = await createUser({ roleName: 'admin' });
    const idempotencyKey = crypto.randomUUID();
    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: authHeaders(token, idempotencyKey),
        body: JSON.stringify({ message: 'admin hello' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.response, 'hello from ai');

      assert.equal(await balance(userId), null);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(await prisma.tokenReservation.count({ where: { userId } }), 0);
      assert.equal(await prisma.aIBillingOperation.count({ where: { userId } }), 0);
    } finally {
      await cleanupUser(userId);
    }
  });
});
