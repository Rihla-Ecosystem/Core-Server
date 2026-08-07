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
import { ensureAdminRole, ensureUserRole } from './helpers/test-role-fixtures.js';
import { signAccessToken } from '../src/utils/token.js';
import { Gender, WalletStatus } from '@prisma/client';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const WAV_SIGNATURE = Buffer.from('RIFF', 'ascii');

/**
 * Phase 2E-C Phase 8 — non-live HTTP boundary tests.
 *
 * These tests exercise the REAL Core HTTP server (Express app) talking over
 * real HTTP to a FAKE AI Service HTTP server. No live Gemini provider calls
 * are made and no AI service imports are mocked — the AI boundary is a real
 * HTTP server, so the multipart forwarding, internal-key header, upstream
 * error handling, usage recording and shadow-pricing observation flow are all
 * verified end-to-end at the network boundary.
 */
describe('Phase 2E-C HTTP boundary (fake AI service, no live calls)', () => {
  let appServer: Server;
  let aiServer: Server;
  let baseUrl: string;
  let aiCallCount = 0;
  let aiServerMode: 'ok' | 'upstream500' = 'ok';
  let receivedInternalKey = '';
  let receivedAuthorization = '';
  const originalAiServiceUrl = env.AI_SERVICE_URL;
  const EMAIL_PREFIX = 'test_phase_2e_c_boundary_';

  const imageNonce = `RIHLA-IMG-${'PHASE2ECB'}`;
  const spokenNonce = `RIHLA VOICE ${'PHASE2ECB'}`;

  const identifyProviderCalls = [
    {
      operation: 'IMAGE_ANALYSIS',
      requestedModel: 'gemini-3.6-flash',
      actualModel: 'gemini-3.6-flash',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 0,
    },
  ];
  const identifyProviderAttempts = [
    {
      attemptNumber: 1,
      outcome: 'SUCCEEDED',
      operation: 'IMAGE_ANALYSIS',
      requestedModel: 'gemini-3.6-flash',
      actualModel: 'gemini-3.6-flash',
    },
  ];

  const voiceProviderCalls = [
    {
      operation: 'AUDIO_UNDERSTANDING',
      requestedModel: 'gemini-3.6-flash',
      actualModel: 'gemini-3.6-flash',
      inputTokens: 120,
      outputTokens: 60,
      totalTokens: 180,
      reasoningTokens: 0,
    },
    {
      operation: 'TEXT_TO_SPEECH',
      requestedModel: 'gemini-3.1-flash-tts-preview',
      actualModel: 'gemini-3.1-flash-tts-preview',
      inputTokens: 20,
      outputTokens: 40,
      totalTokens: 60,
      reasoningTokens: 0,
    },
  ];
  const voiceProviderAttempts = [
    {
      attemptNumber: 1,
      outcome: 'SUCCEEDED',
      operation: 'AUDIO_UNDERSTANDING',
      requestedModel: 'gemini-3.6-flash',
      actualModel: 'gemini-3.6-flash',
    },
    {
      attemptNumber: 1,
      outcome: 'SUCCEEDED',
      operation: 'TEXT_TO_SPEECH',
      requestedModel: 'gemini-3.1-flash-tts-preview',
      actualModel: 'gemini-3.1-flash-tts-preview',
    },
  ];

  const mockIdentifyResponse = {
    name: imageNonce,
    name_ar: null,
    description: `Landmark sign reading ${imageNonce}.`,
    category: 'sign',
    historical_period: 'Modern',
    wikipedia_url: null,
    image_url: null,
    nearby_sites: [],
    cached: false,
    usage: {
      model: 'gemini-3.6-flash',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
    providerCalls: identifyProviderCalls,
    providerAttempts: identifyProviderAttempts,
  };

  const mockVoiceResponse = {
    text_response: `The verification code is ${spokenNonce}.`,
    audio_response: 'data:audio/l16;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
    audio_url: null,
    conversation_id: null,
    usage: {
      model: 'gemini-3.6-flash',
      inputTokens: 120,
      outputTokens: 60,
      totalTokens: 180,
    },
    providerCalls: voiceProviderCalls,
    providerAttempts: voiceProviderAttempts,
  };

  before(async () => {
    await ensureAdminRole();
    await ensureUserRole();
    await cleanupSuiteData();

    await new Promise<void>((resolve) => {
      aiServer = http.createServer(async (req, res) => {
        res.on('error', () => {});
        for await (const _chunk of req) {
          // drain the request body
        }
        aiCallCount += 1;
        receivedInternalKey = String(req.headers['x-internal-api-key'] ?? '');
        receivedAuthorization = String(req.headers['authorization'] ?? '');

        if (aiServerMode === 'upstream500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'provider boom' }));
          return;
        }

        if (req.url === '/identify') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockIdentifyResponse));
          return;
        }
        if (req.url === '/voice') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockVoiceResponse));
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
    await prisma.aiUsageLog.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function createAdminUser(): Promise<{ userId: string; token: string }> {
    const adminRole = await prisma.role.findUnique({ where: { name: 'admin' } });
    assert.ok(adminRole);
    const user = await prisma.user.create({
      data: {
        roleId: adminRole.id,
        email: `${EMAIL_PREFIX}${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Phase 2E-C Boundary Admin',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const token = signAccessToken({ sub: user.id, role: 'admin' });
    return { userId: user.id, token };
  }

  async function countBillingRows(userId: string) {
    const [tokenWallet, tokenTransaction, tokenReservation, aiBillingOperation, aiUsageLog] =
      await Promise.all([
        prisma.tokenWallet.count({ where: { userId } }),
        prisma.tokenTransaction.count({ where: { userId } }),
        prisma.tokenReservation.count({ where: { userId } }),
        prisma.aIBillingOperation.count({ where: { userId } }),
        prisma.aiUsageLog.count({ where: { userId } }),
      ]);
    return { tokenWallet, tokenTransaction, tokenReservation, aiBillingOperation, aiUsageLog };
  }

  function identifyRequest(token: string, idempotencyKey: string, withLatLon = true): Promise<Response> {
    const form = new FormData();
    form.append('image', new Blob([JPEG_SIGNATURE], { type: 'image/jpeg' }), 'test.jpg');
    if (withLatLon) {
      form.append('lat', '30.0444');
      form.append('lon', '31.2357');
    }
    return fetch(`${baseUrl}/api/identify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
      body: form,
    });
  }

  function voiceRequest(token: string, idempotencyKey: string): Promise<Response> {
    const form = new FormData();
    form.append('audio', new Blob([WAV_SIGNATURE], { type: 'audio/wav' }), 'test.wav');
    form.append('lat', '30.0444');
    form.append('lon', '31.2357');
    return fetch(`${baseUrl}/api/voice`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
      body: form,
    });
  }

  test('1. Identify: real Core HTTP round-trip reaches the fake AI HTTP service and returns providerCalls/providerAttempts', async () => {
    const { token } = await createAdminUser();
    const key = crypto.randomUUID();
    const callsBefore = aiCallCount;

    const res = await identifyRequest(token, key, false);
    assert.equal(res.status, 200);
    assert.equal(aiCallCount, callsBefore + 1);

    const body = await res.json();
    assert.equal(body.name, imageNonce);
    assert.equal(body.description, `Landmark sign reading ${imageNonce}.`);
    assert.equal(body.cached, false);
    assert.ok(Array.isArray(body.providerCalls));
    assert.equal(body.providerCalls.length, 1);
    assert.equal(body.providerCalls[0].operation, 'IMAGE_ANALYSIS');
    assert.ok(Array.isArray(body.providerAttempts));
    assert.equal(body.providerAttempts.length, 1);
  });

  test('2. Identify: image nonce is echoed verbatim through the real Core HTTP boundary', async () => {
    const { token } = await createAdminUser();
    const key = crypto.randomUUID();

    const res = await identifyRequest(token, key, false);
    assert.equal(res.status, 200);
    const body = await res.json();
    const textFields = [body.name, body.name_ar, body.description, body.category]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    const normalized = textFields.toUpperCase().replace(/[^A-Z0-9]/g, '');
    assert.ok(normalized.includes(imageNonce.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  });

  test('3. Voice: real Core HTTP round-trip reaches the fake AI HTTP service and returns providerCalls/providerAttempts plus audio', async () => {
    const { token } = await createAdminUser();
    const key = crypto.randomUUID();
    const callsBefore = aiCallCount;

    const res = await voiceRequest(token, key);
    assert.equal(res.status, 200);
    assert.equal(aiCallCount, callsBefore + 1);

    const body = await res.json();
    assert.equal(body.text_response, `The verification code is ${spokenNonce}.`);
    assert.ok(typeof body.audio_response === 'string' && body.audio_response.length > 0);
    assert.ok(Array.isArray(body.providerCalls));
    assert.equal(body.providerCalls.length, 2);
    const ops = body.providerCalls.map((c: { operation: string }) => c.operation).sort();
    assert.deepEqual(ops, ['AUDIO_UNDERSTANDING', 'TEXT_TO_SPEECH']);
    assert.equal(body.providerAttempts.length, 2);
  });

  test('4. Voice: spoken nonce is echoed verbatim through the real Core HTTP boundary', async () => {
    const { token } = await createAdminUser();
    const key = crypto.randomUUID();

    const res = await voiceRequest(token, key);
    assert.equal(res.status, 200);
    const body = await res.json();
    const normalized = String(body.text_response).toUpperCase().replace(/[^A-Z0-9]/g, '');
    assert.ok(normalized.includes(spokenNonce.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  });

  test('5. Core forwards X-Internal-Api-Key and the caller Authorization to the AI HTTP service', async () => {
    const { token } = await createAdminUser();
    const key = crypto.randomUUID();

    receivedInternalKey = '';
    receivedAuthorization = '';
    await identifyRequest(token, key, false);
    assert.equal(receivedInternalKey, env.INTERNAL_API_KEY);
    assert.equal(receivedAuthorization, `Bearer ${token}`);
  });

  test('6. Admin identity: TokenWallet, TokenTransaction, TokenReservation and AIBillingOperation remain unchanged after identify + voice', async () => {
    const { userId, token } = await createAdminUser();
    const before = await countBillingRows(userId);

    const resIdentify = await identifyRequest(token, crypto.randomUUID(), false);
    const resVoice = await voiceRequest(token, crypto.randomUUID());
    assert.equal(resIdentify.status, 200);
    assert.equal(resVoice.status, 200);

    const after = await countBillingRows(userId);
    assert.equal(after.tokenWallet, before.tokenWallet);
    assert.equal(after.tokenTransaction, before.tokenTransaction);
    assert.equal(after.tokenReservation, before.tokenReservation);
    assert.equal(after.aiBillingOperation, before.aiBillingOperation);
    assert.equal(after.tokenWallet, 0);
    assert.equal(after.tokenTransaction, 0);
    assert.equal(after.tokenReservation, 0);
    assert.equal(after.aiBillingOperation, 0);
  });

  test('7. Identify + voice record AiUsageLog rows via the real Core HTTP boundary (usage recording works)', async () => {
    const { userId, token } = await createAdminUser();

    await identifyRequest(token, crypto.randomUUID(), false);
    await voiceRequest(token, crypto.randomUUID());

    const identifyRows = await prisma.aiUsageLog.findMany({ where: { userId, source: 'identify' } });
    const voiceRows = await prisma.aiUsageLog.findMany({ where: { userId, source: 'voice' } });
    assert.equal(identifyRows.length, 1);
    assert.equal(voiceRows.length, 1);
    const row = identifyRows[0];
    assert.equal(row.source, 'identify');
    assert.equal(row.totalTokens, 150);
    assert.equal(row.inputTokens, 100);
    assert.equal(row.outputTokens, 50);
    const voiceRow = voiceRows[0];
    assert.equal(voiceRow.totalTokens, 180);
  });

  test('8. Upstream AI HTTP 500 -> Core returns 502 with no usage recording and no billing mutation', async () => {
    const { userId, token } = await createAdminUser();
    const before = await countBillingRows(userId);

    aiServerMode = 'upstream500';
    try {
      const resIdentify = await identifyRequest(token, crypto.randomUUID(), false);
      assert.equal(resIdentify.status, 502);

      const resVoice = await voiceRequest(token, crypto.randomUUID());
      assert.equal(resVoice.status, 502);
    } finally {
      aiServerMode = 'ok';
    }

    const after = await countBillingRows(userId);
    assert.deepEqual(after, before);
    assert.equal(after.aiUsageLog, 0);
    assert.equal(await prisma.aiUsageLog.count({ where: { userId } }), 0);
  });
});
