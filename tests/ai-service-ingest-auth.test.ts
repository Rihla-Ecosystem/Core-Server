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

import { test, describe, before, after, beforeEach } from 'node:test';
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
import { Gender } from '@prisma/client';

describe('AI Service /ingest security boundary', () => {
  let appServer: Server;
  let aiServer: Server;
  let baseUrl: string;
  let aiCallCount = 0;
  let receivedInternalKey = '';
  const originalAiServiceUrl = env.AI_SERVICE_URL;
  const EMAIL_PREFIX = 'test_ingest_auth_';

  let adminToken: string;
  let userToken: string;

  before(async () => {
    await ensureAdminRole();
    await ensureUserRole();
    await cleanupSuiteData();

    // Setup mock AI service server
    await new Promise<void>((resolve) => {
      aiServer = http.createServer(async (req, res) => {
        res.on('error', () => {});
        for await (const _chunk of req) {
          // drain the request body
        }
        aiCallCount += 1;
        receivedInternalKey = String(req.headers['x-internal-api-key'] ?? '');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: req.url, method: req.method }));
      });
      aiServer.listen(0, () => {
        const address = aiServer.address() as AddressInfo;
        env.AI_SERVICE_URL = `http://localhost:${address.port}`;
        resolve();
      });
    });

    // Setup Express Core Server
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, () => {
        const address = appServer.address() as AddressInfo;
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });

    // Create admin user and normal user fixtures
    const adminRole = await prisma.role.findUnique({ where: { name: 'admin' } });
    assert.ok(adminRole);
    const adminUser = await prisma.user.create({
      data: {
        roleId: adminRole.id,
        email: `${EMAIL_PREFIX}admin_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Test Admin',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    adminToken = signAccessToken({ sub: adminUser.id, role: 'admin' });

    const userRole = await prisma.role.findUnique({ where: { name: 'user' } });
    assert.ok(userRole);
    const normalUser = await prisma.user.create({
      data: {
        roleId: userRole.id,
        email: `${EMAIL_PREFIX}user_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Test User',
        gender: Gender.FEMALE,
        nationality: 'Egyptian',
      },
    });
    userToken = signAccessToken({ sub: normalUser.id, role: 'user' });
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

  beforeEach(() => {
    aiCallCount = 0;
    receivedInternalKey = '';
  });

  async function cleanupSuiteData(): Promise<void> {
    const emailFilter = { email: { startsWith: EMAIL_PREFIX } };
    await prisma.user.deleteMany({ where: emailFilter });
  }

  test('POST /api/ai-service/ingest - unauthenticated => 401 (no upstream contact)', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: 'test' }),
    });

    assert.equal(res.status, 401);
    assert.equal(aiCallCount, 0, 'Must NOT contact the AI Service when unauthenticated');
  });

  test('POST /api/ai-service/ingest - non-admin => 403 (no upstream contact)', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ document: 'test' }),
    });

    assert.equal(res.status, 403);
    assert.equal(aiCallCount, 0, 'Must NOT contact the AI Service when user is non-admin');
  });

  test('POST /api/ai-service/ingest - admin => 200 (reaches proxy & forwards internal key)', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ document: 'test' }),
    });

    assert.equal(res.status, 200);
    assert.equal(aiCallCount, 1, 'Must reach AI Service when authenticated as admin');
    assert.equal(receivedInternalKey, env.INTERNAL_API_KEY, 'Must forward X-Internal-Api-Key to AI Service');
  });

  test('GET /api/ai-service/ingest/collections - unauthenticated => 401 (no upstream contact)', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest/collections`, {
      method: 'GET',
    });

    assert.equal(res.status, 401);
    assert.equal(aiCallCount, 0, 'Must NOT contact the AI Service when unauthenticated');
  });

  test('GET /api/ai-service/ingest/collections - non-admin => 403 (no upstream contact)', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest/collections`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${userToken}`,
      },
    });

    assert.equal(res.status, 403);
    assert.equal(aiCallCount, 0, 'Must NOT contact the AI Service when user is non-admin');
  });

  test('GET /api/ai-service/ingest/collections - admin => 200 (reaches proxy)', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest/collections`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(aiCallCount, 1, 'Must reach AI Service for descendant route when admin');
    assert.equal(receivedInternalKey, env.INTERNAL_API_KEY);
  });

  test('DELETE /api/ai-service/ingest/collections/test-coll - unauthenticated => 401', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest/collections/test-coll`, {
      method: 'DELETE',
    });

    assert.equal(res.status, 401);
    assert.equal(aiCallCount, 0);
  });

  test('DELETE /api/ai-service/ingest/collections/test-coll - non-admin => 403', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest/collections/test-coll`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${userToken}`,
      },
    });

    assert.equal(res.status, 403);
    assert.equal(aiCallCount, 0);
  });

  test('DELETE /api/ai-service/ingest/collections/test-coll - admin => 200', async () => {
    const res = await fetch(`${baseUrl}/api/ai-service/ingest/collections/test-coll`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(aiCallCount, 1);
  });
});
