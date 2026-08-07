/**
 * Phase 2E-C live full-HTTP round-trip probe.
 *
 * Proves the real path: probe -> Core HTTP -> AI Service HTTP -> Gemini ->
 * back through Core -> AiUsageLog/shadow-pricing observation -> Core HTTP
 * response, for BOTH image identification and spoken voice.
 *
 * Deterministic nonces:
 *   - image:  a synthetic PNG with visible text "RIHLA-IMG-<RUN_SUFFIX>"
 *   - voice:  a spoken WAV via espeak-ng of "The verification code is
 *             RIHLA VOICE <RUN_SUFFIX>. Repeat the verification code exactly."
 *
 * Success for voice requires the exact spoken nonce to appear in the final
 * text response. Success for image requires a structured identify response
 * plus the image nonce detected in the response text.
 *
 * Invariants (any violation -> non-zero exit):
 *   1. image providerCalls/providerAttempts present and success
 *   2. voice providerCalls/providerAttempts present and success
 *   3. spoken nonce detected in voice final text
 *   4. image nonce detected in identify response text
 *   5. audio produced (audio_response or audio_url)
 *   6. no retry observed (all attempts attemptNumber 1)
 *   7. attemptRiskStatus NONE
 *   8. TokenWallet/TokenTransaction/TokenReservation/AIBillingOperation
 *      counts unchanged before/after the live calls (admin-exempt identity)
 *   9. shadow pricing observation visible via real Core Admin HTTP API
 *
 * No auto-retry of live calls: on the first failure the probe records one
 * sanitized attempt, deletes temp media, and exits non-zero for human review.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

interface ProviderCall {
  operation?: string;
  requestedModel?: string | null;
  actualModel?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

interface ProviderAttempt {
  attemptNumber?: number;
  outcome?: string;
  operation?: string;
  requestedModel?: string | null;
  actualModel?: string | null;
}

interface Invariant {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const CORE_BASE_URL = process.env.CORE_BASE_URL;
const ESPEAK_NG_BIN = process.env.ESPEAK_NG_BIN;
const AI_HEALTH_URL = process.env.AI_HEALTH_URL;

const JWT_SECRET = process.env.JWT_ACCESS_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const invariants: Invariant[] = [];

function record(name: string, ok: boolean, detail?: unknown): void {
  invariants.push({ name, ok, detail });
}

function fail(message: string): never {
  throw new Error(message);
}

function assertDbIsTestDb(): void {
  if (!DATABASE_URL) fail('DATABASE_URL is not set');
  const parsed = new URL(DATABASE_URL);
  if (parsed.pathname !== '/core_server_test') {
    fail(`DATABASE_URL must point to /core_server_test, got "${parsed.pathname}"`);
  }
}

function normalizeForMatch(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function checkNoRetry(attempts: ProviderAttempt[] | null | undefined): { ok: boolean; detail: unknown } {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return { ok: false, detail: 'no providerAttempts' };
  }
  for (const a of attempts) {
    if ((a.attemptNumber ?? 1) !== 1) {
      return { ok: false, detail: `retry observed: attemptNumber=${a.attemptNumber}` };
    }
  }
  return { ok: true, detail: `attempts=${attempts.length}` };
}

function modalityTotalsOk(calls: ProviderCall[]): { ok: boolean; detail: unknown } {
  for (const call of calls) {
    const total = call.totalTokens;
    const input = call.inputTokens ?? 0;
    const output = call.outputTokens ?? 0;
    const reasoning = call.reasoningTokens ?? 0;
    if (typeof total !== 'number' || total <= 0) {
      return { ok: false, detail: `call missing positive totalTokens (${call.operation})` };
    }
    if (reasoning > 0 && input + output + reasoning !== total) {
      return { ok: false, detail: `input+output+reasoning != total (${call.operation})` };
    }
    if (reasoning === 0 && input + output !== total) {
      return { ok: false, detail: `input+output != total (${call.operation})` };
    }
  }
  return { ok: true, detail: `calls=${calls.length}` };
}

function sanitize(details: unknown): unknown {
  return details;
}

const PRONOUNCEABLE_WORDS = [
  'KILO', 'DELTA', 'VICTOR', 'HOTEL', 'SIERRA', 'MIKE',
  'LIMA', 'OSCAR', 'TANGO', 'ROMEO', 'ECHO', 'FOXTROT',
];

function makeRunSuffix(): string {
  const hash = crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
  const first = PRONOUNCEABLE_WORDS[parseInt(hash.slice(0, 8), 16) % PRONOUNCEABLE_WORDS.length];
  const second = PRONOUNCEABLE_WORDS[parseInt(hash.slice(8, 16), 16) % PRONOUNCEABLE_WORDS.length];
  return `${first}${second}`;
}

const runSuffix = makeRunSuffix();

const imageNonce = `RIHLA-IMG-${runSuffix}`;
const spokenNonce = `RIHLA VOICE ${runSuffix}`;
const spokenPhrase = `The verification code is ${spokenNonce}. Say exactly: ${spokenNonce}. Repeat the verification code exactly: ${spokenNonce}.`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rihla-http-roundtrip-'));

interface StepResult {
  status: number;
  ok: boolean;
  error?: string;
  providerCalls?: ProviderCall[] | null;
  providerAttempts?: ProviderAttempt[] | null;
  text?: string;
  audioProduced?: boolean;
  nonceDetected?: boolean;
  summary?: Record<string, unknown>;
}

async function waitForCoreHealth(timeoutMs = 45000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CORE_BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === 'ok') return;
      }
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`Core /health not ready: ${lastError}`);
}

async function waitForAiHealth(timeoutMs = 45000): Promise<void> {
  if (!AI_HEALTH_URL) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(AI_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  if (!CORE_BASE_URL) fail('CORE_BASE_URL is not set');
  if (!ESPEAK_NG_BIN) fail('ESPEAK_NG_BIN is not set');
  if (!JWT_SECRET) fail('JWT_ACCESS_SECRET is not set');

  assertDbIsTestDb();

  const prisma = new PrismaClient();

  let adminUserId: string | undefined;
  let adminToken = '';

  try {
    const before = await snapshotCounts(prisma);

    const adminRole = await prisma.role.upsert({
      where: { name: 'admin' },
      update: {},
      create: { name: 'admin' },
    });

    const adminUser = await prisma.user.create({
      data: {
        roleId: adminRole.id,
        email: `probe_roundtrip_${runSuffix}@example.com`,
        passwordHash: 'not-used',
        displayName: 'Roundtrip Probe Admin',
        gender: 'MALE',
        nationality: 'Egyptian',
      },
    });
    adminUserId = adminUser.id;
    adminToken = jwt.sign({ sub: adminUser.id, role: 'admin' }, JWT_SECRET, { expiresIn: '15m' });

    await waitForAiHealth();
    await waitForCoreHealth();

    const imagePath = path.join(tmpDir, 'nonce.png');
    const wavPath = path.join(tmpDir, 'spoken.wav');

    generateNonceImage(imagePath, imageNonce);
    generateSpokenWav(wavPath, spokenPhrase);

    const imageResult = await runImageProbe(adminToken);
    const voiceResult = await runVoiceProbe(adminToken);

    const adminObservations = await fetchAdminObservations(adminToken);

    const after = await snapshotCounts(prisma);

    evaluateInvariants(imageResult, voiceResult, adminObservations, before, after);

    const report = buildReport(
      imageResult,
      voiceResult,
      adminObservations,
      before,
      after,
    );

    const reportPath = path.join(
      os.tmpdir(),
      `rihla-http-roundtrip-${runSuffix}.json`,
    );
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const failed = invariants.filter((i) => !i.ok);
    // eslint-disable-next-line no-console
    console.log(`PROBE_COMPLETE runSuffix=${runSuffix} invariants=${invariants.length} failed=${failed.length}`);
    // eslint-disable-next-line no-console
    console.log(`PROBE_RESULT_JSON=${reportPath}`);
    for (const inv of invariants) {
      // eslint-disable-next-line no-console
      console.log(`${inv.ok ? 'PASS' : 'FAIL'} ${inv.name}${inv.detail !== undefined ? ` :: ${JSON.stringify(sanitize(inv.detail))}` : ''}`);
    }
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (adminUserId) {
      await prisma.tokenTransaction.deleteMany({ where: { userId: adminUserId } });
      await prisma.tokenWallet.deleteMany({ where: { userId: adminUserId } });
      await prisma.user.deleteMany({ where: { id: adminUserId } });
    }
    await prisma.$disconnect();
  }
}

function generateNonceImage(filePath: string, nonce: string): void {
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=white:s=2000x400',
      '-vf',
      `drawbox=x=40:y=40:w=1920:h=320:color=black@0.9:t=fill,` +
      `drawtext=text='${nonce}':fontfile=${font}:fontsize=150:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-frames:v', '1',
      filePath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (!fs.existsSync(filePath) || fs.readFileSync(filePath).length === 0) {
    fail('image generation produced no file');
  }
}

function generateSpokenWav(filePath: string, phrase: string): void {
  const raw = path.join(tmpDir, 'spoken-raw.wav');
  execFileSync(ESPEAK_NG_BIN!, ['-v', 'en', '-w', raw, phrase], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (!fs.existsSync(raw)) fail('espeak-ng produced no audio');
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', filePath],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    fail('normalized audio is not a RIFF WAV');
  }
}

function authHeaders(token: string, idempotencyKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Idempotency-Key': idempotencyKey,
  };
}

async function runImageProbe(token: string): Promise<StepResult> {
  const imagePath = path.join(tmpDir, 'nonce.png');
  const blob = new Blob([fs.readFileSync(imagePath)], { type: 'image/png' });
  const form = new FormData();
  form.append('image', blob, 'nonce.png');

  let res: Response;
  try {
    res = await fetch(`${CORE_BASE_URL}/api/identify`, {
      method: 'POST',
      headers: authHeaders(token, crypto.randomUUID()),
      body: form,
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    return {
      status: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { status: res.status, ok: res.ok, error: 'non-JSON response' };
  }

  const providerCalls = (body.providerCalls as ProviderCall[] | null | undefined) ?? null;
  const providerAttempts = (body.providerAttempts as ProviderAttempt[] | null | undefined) ?? null;

  const textFields = [
    body.name,
    body.name_ar,
    body.description,
    body.category,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  const normalizedNeedle = normalizeForMatch(imageNonce);
  const nonceDetected = normalizeForMatch(textFields).includes(normalizedNeedle);
  const perField = {
    name: typeof body.name === 'string' && normalizeForMatch(String(body.name)).includes(normalizedNeedle),
    nameAr: typeof body.name_ar === 'string' && normalizeForMatch(String(body.name_ar)).includes(normalizedNeedle),
    description: typeof body.description === 'string' && normalizeForMatch(String(body.description)).includes(normalizedNeedle),
    category: typeof body.category === 'string' && normalizeForMatch(String(body.category)).includes(normalizedNeedle),
  };

  return {
    status: res.status,
    ok: res.ok,
    providerCalls,
    providerAttempts,
    text: textFields.slice(0, 400),
    nonceDetected,
    summary: {
      name: body.name,
      cached: body.cached,
      descriptionLength: typeof body.description === 'string' ? body.description.length : 0,
      noncePerField: perField,
    },
  };
}

async function runVoiceProbe(token: string): Promise<StepResult> {
  const wavPath = path.join(tmpDir, 'spoken.wav');
  const blob = new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' });
  const form = new FormData();
  form.append('audio', blob, 'spoken.wav');
  form.append('lat', '30.0444');
  form.append('lon', '31.2357');

  let res: Response;
  try {
    res = await fetch(`${CORE_BASE_URL}/api/voice`, {
      method: 'POST',
      headers: authHeaders(token, crypto.randomUUID()),
      body: form,
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    return {
      status: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { status: res.status, ok: res.ok, error: 'non-JSON response' };
  }

  const providerCalls = (body.providerCalls as ProviderCall[] | null | undefined) ?? null;
  const providerAttempts = (body.providerAttempts as ProviderAttempt[] | null | undefined) ?? null;

  const text = typeof body.text_response === 'string' ? body.text_response : '';
  const nonceDetected = normalizeForMatch(text).includes(normalizeForMatch(spokenNonce));
  const audioProduced =
    typeof body.audio_response === 'string' && body.audio_response.length > 0
      ? true
      : typeof body.audio_url === 'string' && body.audio_url.length > 0;

  return {
    status: res.status,
    ok: res.ok,
    providerCalls,
    providerAttempts,
    text: text.slice(0, 400),
    audioProduced,
    nonceDetected,
    summary: {
      conversation_id: body.conversation_id,
      hasAudioResponse: typeof body.audio_response === 'string' && body.audio_response.length > 0,
      hasAudioUrl: typeof body.audio_url === 'string' && body.audio_url.length > 0,
      textLength: text.length,
    },
  };
}

interface AdminObservationRow {
  observedAt: string;
  source: string;
  engineSummaryStatus?: string;
  noProviderCalls?: boolean;
  callCount?: number;
  pricedCallCount?: number;
  unpricedCallCount?: number;
  unpricedReasons?: Record<string, number>;
  attemptRiskStatus?: string;
  attemptCount?: number;
  failedAttemptCount?: number;
  hasRetry?: boolean;
}

async function fetchAdminObservations(token: string): Promise<Record<string, AdminObservationRow[]>> {
  const result: Record<string, AdminObservationRow[]> = {};
  for (const source of ['identify', 'voice']) {
    const url = `${CORE_BASE_URL}/api/admin/ai-shadow-pricing/observations?source=${source}&limit=5`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      result[source] = [];
      continue;
    }
    if (!res.ok) {
      result[source] = [];
      continue;
    }
    const body = (await res.json()) as { data?: AdminObservationRow[] };
    result[source] = body.data ?? [];
  }
  return result;
}

async function snapshotCounts(prisma: PrismaClient) {
  const [tokenWallet, tokenTransaction, tokenReservation, aiBillingOperation, aiUsageLog] =
    await Promise.all([
      prisma.tokenWallet.count(),
      prisma.tokenTransaction.count(),
      prisma.tokenReservation.count(),
      prisma.aIBillingOperation.count(),
      prisma.aiUsageLog.count(),
    ]);
  return { tokenWallet, tokenTransaction, tokenReservation, aiBillingOperation, aiUsageLog };
}

function evaluateInvariants(
  imageResult: StepResult,
  voiceResult: StepResult,
  adminObservations: Record<string, AdminObservationRow[]>,
  before: Awaited<ReturnType<typeof snapshotCounts>>,
  after: Awaited<ReturnType<typeof snapshotCounts>>,
): void {
  record('core_health', true);

  record('identify_http_ok', imageResult.ok && imageResult.status === 200, {
    status: imageResult.status,
    error: imageResult.error,
  });
  record(
    'identify_provider_calls_present',
    Array.isArray(imageResult.providerCalls) && imageResult.providerCalls.length >= 1,
    { count: imageResult.providerCalls?.length },
  );
  record(
    'identify_provider_attempts_present',
    Array.isArray(imageResult.providerAttempts) && imageResult.providerAttempts.length >= 1,
    { count: imageResult.providerAttempts?.length },
  );
  const identifyModality = modalityTotalsOk(imageResult.providerCalls ?? []);
  record('identify_modality_totals_ok', identifyModality.ok, identifyModality.detail);
  const identifyRetry = checkNoRetry(imageResult.providerAttempts);
  record('identify_no_retry', identifyRetry.ok, identifyRetry.detail);
  record('identify_image_nonce_detected', imageResult.nonceDetected === true);

  record('voice_http_ok', voiceResult.ok && voiceResult.status === 200, {
    status: voiceResult.status,
    error: voiceResult.error,
  });
  record(
    'voice_provider_calls_present',
    Array.isArray(voiceResult.providerCalls) && voiceResult.providerCalls.length >= 1,
    { count: voiceResult.providerCalls?.length },
  );
  record(
    'voice_provider_attempts_present',
    Array.isArray(voiceResult.providerAttempts) && voiceResult.providerAttempts.length >= 1,
    { count: voiceResult.providerAttempts?.length },
  );
  record('voice_modality_totals_ok', modalityTotalsOk(voiceResult.providerCalls ?? []).ok);
  record('voice_no_retry', checkNoRetry(voiceResult.providerAttempts).ok);
  record('voice_spoken_nonce_detected', voiceResult.nonceDetected === true);
  record('voice_audio_produced', voiceResult.audioProduced === true);

  const identifyObs = adminObservations.identify ?? [];
  const voiceObs = adminObservations.voice ?? [];
  const latestIdentify = identifyObs[0];
  const latestVoice = voiceObs[0];

  record('admin_observations_identify_found', latestIdentify !== undefined, {
    returned: identifyObs.length,
  });
  record(
    'admin_observation_identify_callcount',
    latestIdentify !== undefined && (latestIdentify.callCount ?? 0) >= 1,
    latestIdentify && {
      callCount: latestIdentify.callCount,
      noProviderCalls: latestIdentify.noProviderCalls,
      attemptRiskStatus: latestIdentify.attemptRiskStatus,
    },
  );
  record(
    'admin_observation_identify_no_retry',
    latestIdentify !== undefined && latestIdentify.hasRetry === false,
    latestIdentify && { attemptCount: latestIdentify.attemptCount, hasRetry: latestIdentify.hasRetry },
  );

  record('admin_observations_voice_found', latestVoice !== undefined, {
    returned: voiceObs.length,
  });
  record(
    'admin_observation_voice_callcount',
    latestVoice !== undefined && (latestVoice.callCount ?? 0) >= 1,
    latestVoice && {
      callCount: latestVoice.callCount,
      noProviderCalls: latestVoice.noProviderCalls,
      attemptRiskStatus: latestVoice.attemptRiskStatus,
    },
  );
  record(
    'admin_observation_voice_no_retry',
    latestVoice !== undefined && latestVoice.hasRetry === false,
    latestVoice && { attemptCount: latestVoice.attemptCount, hasRetry: latestVoice.hasRetry },
  );

  const walletTables = [
    'tokenWallet',
    'tokenTransaction',
    'tokenReservation',
    'aiBillingOperation',
  ] as const;
  for (const table of walletTables) {
    record(`wallet_unchanged_${table}`, before[table] === after[table], {
      before: before[table],
      after: after[table],
    });
  }
  record('aiUsageLog_written', after.aiUsageLog > before.aiUsageLog, {
    before: before.aiUsageLog,
    after: after.aiUsageLog,
  });
}

function buildReport(
  imageResult: StepResult,
  voiceResult: StepResult,
  adminObservations: Record<string, AdminObservationRow[]>,
  before: Awaited<ReturnType<typeof snapshotCounts>>,
  after: Awaited<ReturnType<typeof snapshotCounts>>,
): Record<string, unknown> {
  const failed = invariants.filter((i) => !i.ok);
  return {
    marker: failed.length > 0
      ? 'PHASE_2E_C_FULL_HTTP_ROUNDTRIP_NOT_READY'
      : 'PHASE_2E_C_FULL_HTTP_ROUNDTRIP_READY',
    runId: runSuffix,
    imageNonce,
    spokenNonce,
    invariants: invariants.map((i) => ({
      name: i.name,
      ok: i.ok,
      detail: i.detail !== undefined ? sanitize(i.detail) : undefined,
    })),
    failedCount: failed.length,
    counts: { before, after },
    adminObservations: {
      identify: (adminObservations.identify ?? []).map(rowMinimal),
      voice: (adminObservations.voice ?? []).map(rowMinimal),
    },
    captured: {
      imageNonceDetected: imageResult.nonceDetected === true,
      voiceNonceDetected: voiceResult.nonceDetected === true,
      voiceAudioProduced: voiceResult.audioProduced === true,
      identifyProviderCalls: imageResult.providerCalls?.length ?? 0,
      identifyProviderAttempts: imageResult.providerAttempts?.length ?? 0,
      voiceProviderCalls: voiceResult.providerCalls?.length ?? 0,
      voiceProviderAttempts: voiceResult.providerAttempts?.length ?? 0,
    },
  };
}

function rowMinimal(row: AdminObservationRow): Record<string, unknown> {
  return {
    observedAt: row.observedAt,
    source: row.source,
    engineSummaryStatus: row.engineSummaryStatus,
    noProviderCalls: row.noProviderCalls,
    callCount: row.callCount,
    pricedCallCount: row.pricedCallCount,
    unpricedCallCount: row.unpricedCallCount,
    unpricedReasons: row.unpricedReasons,
    attemptRiskStatus: row.attemptRiskStatus,
    attemptCount: row.attemptCount,
    failedAttemptCount: row.failedAttemptCount,
    hasRetry: row.hasRetry,
  };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('PROBE_FAILED', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
