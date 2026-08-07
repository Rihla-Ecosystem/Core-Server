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
import { ensureUserRole } from './helpers/test-role-fixtures.js';

let USER_ROLE_ID: number;
import { signAccessToken } from '../src/utils/token.js';
import { Gender, TokenTransactionType, WalletStatus } from '@prisma/client';

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
    providerCallId: 'chat-call-1',
    actualModel: 'gemini-3.5-flash-lite',
    inputTokens: 100,
    outputTokens: 50,
  },
];

describe('Chat usage-based billing HTTP contracts - AI_CHAT_QUERY integration', () => {
  let appServer: Server;
  let aiServer: Server;
  let baseUrl: string;
  let aiCallCount = 0;
  const originalAiServiceUrl = env.AI_SERVICE_URL;

  async function waitForCondition(
    condition: () => Promise<boolean>,
    timeoutMs = 5000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for condition');
  }

  before(async () => {
    USER_ROLE_ID = (await ensureUserRole()).id;
    await cleanupSuiteData();

    await new Promise<void>((resolve) => {
      aiServer = http.createServer(async (req, res) => {
        res.on('error', () => {});
        let body = '';
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body || '{}');
        aiCallCount += 1;

        if (payload.message === 'AI_ERROR') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'boom' }));
          return;
        }

        if (req.url === '/chat') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              response: 'hello from ai',
              persona: 'auto',
              usage: USAGE,
              providerCalls: PROVIDER_CALLS,
            }),
          );
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
          if (payload.message === 'STREAM_ERROR') {
            setTimeout(() => {
              res.socket?.destroy(new Error('upstream exploded'));
            }, 150);
            return;
          }
          res.end();
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
    const emailFilter = { email: { startsWith: 'test_chat_token_' } };
    const userIds = (await prisma.user.findMany({ where: emailFilter, select: { id: true } })).map(
      (u) => u.id,
    );
    if (userIds.length > 0) {
      await prisma.aIBillingOperation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.tokenReservation.deleteMany({ where: { userId: { in: userIds } } });
    }
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.conversation.deleteMany({ where: { user: emailFilter } });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function createChatUser(
    balance: number,
  ): Promise<{ userId: string; walletId: string; token: string }> {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_chat_token_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Chat Token User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: { userId: user.id, tokenBalance: balance, status: WalletStatus.ACTIVE },
    });
    const token = signAccessToken({ sub: user.id, role: 'USER' });
    return { userId: user.id, walletId: wallet.id, token };
  }

  function chatHeaders(token: string, idempotencyKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    };
  }

  async function cleanupUser(userId: string): Promise<void> {
    await prisma.aIBillingOperation.deleteMany({ where: { userId } });
    await prisma.tokenReservation.deleteMany({ where: { userId } });
    await prisma.tokenTransaction.deleteMany({ where: { userId } });
    await prisma.tokenWallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }


  test('1. POST /api/chat charges priced usage tokens and persists the exchange', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'hello world' }),
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.response, 'hello from ai');
      assert.equal(body.persona, 'auto');
      assert.equal(typeof body.conversation_id, 'string');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998);

      const consumeRows = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(consumeRows.length, 1);
      assert.equal(consumeRows[0].tokens, 2);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId, type: TokenTransactionType.REFUND },
        }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 1);

      const conversation = await prisma.conversation.findFirst({
        where: { userId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
      assert.ok(conversation);
      assert.equal(conversation.messages.length, 2);
      assert.equal(conversation.messages[0].role, 'user');
      assert.equal(conversation.messages[0].content, 'hello world');
      assert.equal(conversation.messages[1].role, 'assistant');
      assert.equal(conversation.messages[1].content, 'hello from ai');
    } finally {
      await cleanupUser(userId);
    }
  });

  test('2. POST /api/chat with insufficient balance returns 402 and writes nothing', async () => {
    const { userId, walletId, token } = await createChatUser(0);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'hello' }),
      });
      assert.equal(res.status, 402);

      const body = await res.json();
      assert.equal(body.error, 'Insufficient token balance');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 0);

      assert.equal(await prisma.conversation.count({ where: { userId } }), 0);
      assert.equal(await prisma.message.count({ where: { conversation: { userId } } }), 0);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(aiCallCount, callsBefore);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('3. POST /api/chat releases the reservation when the AI service fails', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'AI_ERROR' }),
      });
      assert.equal(res.status, 502);

      const body = await res.json();
      assert.equal(body.error, 'AI service unavailable');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1000);
      assert.equal(wallet.reservedBalance, 0);

      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('4. POST /api/chat/stream charges priced usage tokens and a completed stream stays charged', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'stream me' }),
      });
      assert.equal(res.status, 200);

      const text = await res.text();
      assert.ok(text.includes('data:'));

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998);

      const consumeRows = await prisma.tokenTransaction.findMany({
        where: { userId, type: TokenTransactionType.CONSUME },
      });
      assert.equal(consumeRows.length, 1);
      assert.equal(consumeRows[0].tokens, 2);
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId, type: TokenTransactionType.REFUND },
        }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('5. POST /api/chat/stream with an upstream pre-stream failure returns 502 and keeps the reservation pending for recovery', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'AI_ERROR' }),
      });
      assert.equal(res.status, 502);

      const body = await res.json();
      assert.equal(body.error, 'AI service unavailable');

      // The reservation is created BEFORE the upstream dispatch; a pre-stream
      // failure must never auto-release it. It stays pending for recovery.
      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(wallet.reservedBalance, 1000);

      const reservation = await prisma.tokenReservation.findFirst({ where: { userId } });
      assert.ok(reservation);
      assert.equal(reservation.status, 'PENDING');
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('6. Missing Idempotency-Key returns 400 with the required-header message and writes nothing', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: 'hello' }),
      });
      assert.equal(res.status, 400);

      const body = await res.json();
      assert.equal(body.error, 'Idempotency-Key header is required');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1000);

      assert.equal(await prisma.conversation.count({ where: { userId } }), 0);
      assert.equal(await prisma.message.count({ where: { conversation: { userId } } }), 0);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(aiCallCount, callsBefore);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('7. Invalid Idempotency-Key returns 400 with the valid-UUID message and writes nothing', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'not-a-valid-uuid',
        },
        body: JSON.stringify({ message: 'hello' }),
      });
      assert.equal(res.status, 400);

      const body = await res.json();
      assert.equal(body.error, 'Idempotency-Key header must be a valid UUID');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1000);

      assert.equal(await prisma.conversation.count({ where: { userId } }), 0);
      assert.equal(await prisma.message.count({ where: { conversation: { userId } } }), 0);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(aiCallCount, callsBefore);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('8. Sequential retry with the same Idempotency-Key returns 409 and is not re-executed', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;
    const idempotencyKey = crypto.randomUUID();

    try {
      const first = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders(token, idempotencyKey),
        body: JSON.stringify({ message: 'retry me' }),
      });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders(token, idempotencyKey),
        body: JSON.stringify({ message: 'retry me' }),
      });
      assert.equal(second.status, 409);

      const secondBody = await second.json();
      assert.equal(secondBody.error, 'Chat request already processed');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998);

      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId, type: TokenTransactionType.CONSUME },
        }),
        1,
      );
      assert.equal(aiCallCount, callsBefore + 1);

      const conversations = await prisma.conversation.findMany({
        where: { userId },
        include: { messages: true },
      });
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0].messages.length, 2);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('9. A different Idempotency-Key is treated as a new business request', async () => {
    const { userId, walletId, token } = await createChatUser(2000);
    const callsBefore = aiCallCount;

    try {
      const first = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'first request' }),
      });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'second request' }),
      });
      assert.equal(second.status, 200);

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1996);
      assert.equal(wallet.reservedBalance, 0);

      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId, type: TokenTransactionType.CONSUME },
        }),
        2,
      );
      assert.equal(aiCallCount, callsBefore + 2);

      const conversations = await prisma.conversation.findMany({ where: { userId } });
      assert.equal(conversations.length, 2);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('10. Mid-stream upstream failure records INDETERMINATE and never auto-releases', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'STREAM_ERROR' }),
      });
      assert.equal(res.status, 200);

      try {
        await res.text();
      } catch {
        // connection reset mid-stream is expected
      }

      await waitForCondition(async () => {
        const op = await prisma.aIBillingOperation.findFirst({ where: { userId } });
        return op?.status === 'INDETERMINATE';
      });

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(wallet.reservedBalance, 1000);

      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);

      const reservation = await prisma.tokenReservation.findFirst({ where: { userId } });
      assert.ok(reservation);
      assert.equal(reservation.status, 'PENDING');

      const operation = await prisma.aIBillingOperation.findFirst({ where: { userId } });
      assert.ok(operation);
      assert.equal(operation.status, 'INDETERMINATE');
      assert.equal(operation.failureCode, 'STREAM_INTERRUPTED');
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('11. Same Idempotency-Key on /api/chat/stream is not re-executed', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;
    const idempotencyKey = crypto.randomUUID();

    try {
      const first = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: chatHeaders(token, idempotencyKey),
        body: JSON.stringify({ message: 'stream retry' }),
      });
      assert.equal(first.status, 200);
      await first.text();

      const second = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: chatHeaders(token, idempotencyKey),
        body: JSON.stringify({ message: 'stream retry' }),
      });
      assert.equal(second.status, 409);

      const secondBody = await second.json();
      assert.equal(secondBody.error, 'Chat request already processed');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998);

      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId, type: TokenTransactionType.CONSUME },
        }),
        1,
      );
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId, type: TokenTransactionType.REFUND },
        }),
        0,
      );
      assert.equal(aiCallCount, callsBefore + 1);

      const conversations = await prisma.conversation.findMany({
        where: { userId },
        include: { messages: true },
      });
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0].messages.length, 2);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('12. Missing Idempotency-Key on /api/chat/stream returns 400 and writes nothing', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: 'hello' }),
      });
      assert.equal(res.status, 400);

      const body = await res.json();
      assert.equal(body.error, 'Idempotency-Key header is required');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1000);

      assert.equal(await prisma.conversation.count({ where: { userId } }), 0);
      assert.equal(await prisma.message.count({ where: { conversation: { userId } } }), 0);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(aiCallCount, callsBefore);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('13. Invalid Idempotency-Key on /api/chat/stream returns 400 and writes nothing', async () => {
    const { userId, walletId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'not-a-valid-uuid',
        },
        body: JSON.stringify({ message: 'hello' }),
      });
      assert.equal(res.status, 400);

      const body = await res.json();
      assert.equal(body.error, 'Idempotency-Key header must be a valid UUID');

      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1000);

      assert.equal(await prisma.conversation.count({ where: { userId } }), 0);
      assert.equal(await prisma.message.count({ where: { conversation: { userId } } }), 0);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
      assert.equal(aiCallCount, callsBefore);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('14. Mid-stream upstream failure records recovery-required evidence without a refund row', async () => {
    const { userId, token } = await createChatUser(1000);
    const callsBefore = aiCallCount;

    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: chatHeaders(token, crypto.randomUUID()),
        body: JSON.stringify({ message: 'STREAM_ERROR' }),
      });
      assert.equal(res.status, 200);

      try {
        await res.text();
      } catch {
        // connection reset mid-stream is expected
      }

      await waitForCondition(async () => {
        const op = await prisma.aIBillingOperation.findFirst({ where: { userId } });
        return op?.status === 'INDETERMINATE';
      });

      // A mid-stream failure is never auto-released and never refunded: the
      // reservation stays pending and no REFUND transaction row is created.
      assert.equal(
        await prisma.tokenTransaction.count({
          where: { userId, type: TokenTransactionType.REFUND },
        }),
        0,
      );

      const reservation = await prisma.tokenReservation.findFirst({ where: { userId } });
      assert.ok(reservation);
      assert.equal(reservation.status, 'PENDING');
      assert.equal(aiCallCount, callsBefore + 1);
    } finally {
      await cleanupUser(userId);
    }
  });
});
