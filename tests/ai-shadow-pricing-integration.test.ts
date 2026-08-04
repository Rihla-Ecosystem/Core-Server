import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAiUsage } from '../src/services/ai-usage.service.js';
import { recordAiUsageWith } from '../src/services/ai-usage.service.js';
import type { RecordAiUsageDeps, AiUsageLogRow } from '../src/services/ai-usage.service.js';
import type { ShadowPricingRequestContext, ShadowPricingOutcome } from '../src/services/ai-shadow-pricing.service.js';
import {
  shadowPricingService,
  DEFAULT_OBSERVATION_BUFFER,
} from '../src/services/ai-shadow-pricing.service.js';
import { computeAiCost } from '../src/config/ai-pricing.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(TESTS_DIR, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/** Build fake dependencies for recordAiUsageWith (the injectable variant). */
function fakeDeps(overrides?: {
  writeCount?: number;
  onRows?: (rows: AiUsageLogRow[]) => void;
  shadowRecord?: (calls: unknown, ctx: ShadowPricingRequestContext) => ShadowPricingOutcome;
  throwOnShadow?: Error;
}): RecordAiUsageDeps {
  return {
    writeAiUsageLogRows: async (rows) => {
      if (overrides?.onRows) overrides.onRows(rows);
      return overrides?.writeCount ?? rows.length;
    },
    writeAiUsageLog: async () => {},
    runShadowPricing: (calls, ctx) => {
      if (overrides?.throwOnShadow) throw overrides.throwOnShadow;
      if (overrides?.shadowRecord) return overrides.shadowRecord(calls, ctx);
      return shadowPricingService.record(calls, ctx);
    },
  };
}

function validCall(id: string, totalTokens: number) {
  return {
    provider: 'google',
    providerCallMade: true,
    providerCallId: id,
    requestedModel: 'gemini-3.6-flash',
    actualModel: 'gemini-3.6-flash',
    operation: 'TEXT_CHAT',
    inputTokens: 100,
    outputTokens: 40,
    totalTokens,
  };
}

test('22. shadow service invoked exactly once for authoritative non-empty providerCalls', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let shadowInvoked = 0;
  const deps = fakeDeps({
    writeCount: 2,
    shadowRecord: (calls, ctx) => {
      shadowInvoked += 1;
      return shadowPricingService.record(calls, ctx);
    },
  });
  const result = await recordAiUsageWith(
    {
      userId: 'u1',
      conversationId: 'c1',
      source: 'chat',
      providerCalls: [validCall('call-1', 140), validCall('call-2', 90)],
    },
    deps,
  );
  assert.equal(shadowInvoked, 1, 'shadow invoked exactly once');
  assert.equal(result, 2, 'two telemetry rows recorded');
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('23. explicit empty providerCalls invokes once as a zero-call observation', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let shadowInvoked = 0;
  const deps = fakeDeps({
    shadowRecord: (calls, ctx) => {
      shadowInvoked += 1;
      return shadowPricingService.record(calls, ctx);
    },
  });
  const result = await recordAiUsageWith(
    { userId: 'u1', conversationId: 'c1', source: 'identify', providerCalls: [] },
    deps,
  );
  assert.equal(shadowInvoked, 1);
  assert.equal(result, null, 'empty providerCalls → no telemetry rows');
  const snap = DEFAULT_OBSERVATION_BUFFER.snapshot();
  assert.ok(snap.length >= 1);
  assert.equal(snap[snap.length - 1].report.noProviderCalls, true);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('24. missing providerCalls skips shadow pricing', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let shadowInvoked = 0;
  const deps = fakeDeps({
    shadowRecord: () => {
      shadowInvoked += 1;
      return { kind: 'skipped', reason: 'NOT_AUTHORITATIVE' } as const;
    },
  });
  const result = await recordAiUsageWith({ userId: 'u1', source: 'chat' }, deps);
  assert.equal(shadowInvoked, 1);
  assert.equal(result, null);
  // The shadow service internally decides to skip; no observation stored.
  assert.equal(DEFAULT_OBSERVATION_BUFFER.size(), 0);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('25. invalid providerCalls skips shadow pricing', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let shadowInvoked = 0;
  const deps = fakeDeps({
    shadowRecord: () => {
      shadowInvoked += 1;
      return { kind: 'skipped', reason: 'INVALID' } as const;
    },
  });
  const result = await recordAiUsageWith(
    { userId: 'u1', source: 'chat', providerCalls: [{ provider: 'google' }] },
    deps,
  );
  assert.equal(shadowInvoked, 1);
  assert.equal(result, null);
  assert.equal(DEFAULT_OBSERVATION_BUFFER.size(), 0);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('26. legacy usage/model alone never enters the pricing engine', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let shadowInvoked = 0;
  const deps = fakeDeps({
    shadowRecord: () => {
      shadowInvoked += 1;
      return { kind: 'skipped', reason: 'NOT_AUTHORITATIVE' } as const;
    },
  });
  const result = await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      usage: { model: 'gemini-3.6-flash', inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    },
    deps,
  );
  assert.equal(shadowInvoked, 1);
  assert.equal(result, 1, 'legacy path returns 1');
  assert.equal(DEFAULT_OBSERVATION_BUFFER.size(), 0);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('27. existing AiUsageLog write behavior is unchanged', async () => {
  let capturedRows: AiUsageLogRow[] | undefined;
  const deps = fakeDeps({
    onRows: (rows) => {
      capturedRows = rows;
    },
  });
  const result = await recordAiUsageWith(
    {
      userId: 'u1',
      conversationId: 'c1',
      source: 'chat',
      providerCalls: [validCall('call-1', 140), validCall('call-2', 90)],
    },
    deps,
  );
  assert.equal(result, 2);
  assert.ok(capturedRows !== undefined);
  const expectedCost = computeAiCost('gemini-3.6-flash', 100, 40);
  for (const row of capturedRows!) {
    assert.equal(row.userId, 'u1');
    assert.equal(row.conversationId, 'c1');
    assert.equal(row.source, 'chat');
    assert.equal(row.model, 'gemini-3.6-flash');
    assert.equal(row.inputTokens, 100);
    assert.equal(row.outputTokens, 40);
    assert.equal(row.cost, expectedCost);
  }
});

test('28. shadow failure does not stop existing AiUsageLog writes', async () => {
  const deps = fakeDeps({ writeCount: 2, throwOnShadow: new Error('shadow exploded') });
  const result = await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-1', 140), validCall('call-2', 90)],
    },
    deps,
  );
  assert.equal(result, 2, 'AiUsageLog writes must continue after shadow failure');
});

test('29. no Wallet/token service is called', async () => {
  const source = readFileSync(join(SRC_ROOT, 'services/ai-usage.service.ts'), 'utf8');
  const imports = source.split('\n').filter((l) => l.trim().startsWith('import'));
  assert.ok(
    !imports.some((l) => /wallet|TokenTransaction|business-token|tokenized-service|billing/i.test(l)),
    'ai-usage.service must not import Wallet/token/billing modules',
  );
  assert.ok(
    !/reverseBusinessToken|beginBusinessTokenCharge|consumeBusinessTokens|executeWithBusinessTokenCharge/.test(source),
  );
});

test('30. existing recordAiUsage return/throw behavior remains unchanged', async () => {
  assert.equal(
    await recordAiUsageWith({ userId: '' }, fakeDeps()),
    undefined,
    'no userId → undefined',
  );
  assert.equal(
    await recordAiUsageWith(
      { userId: 'u1', source: 'chat', providerCalls: [validCall('c', 140)] },
      fakeDeps({ writeCount: 5 }),
    ),
    5,
    'per-call path returns write count',
  );
  assert.equal(
    await recordAiUsageWith(
      { userId: 'u1', source: 'chat', providerCalls: [validCall('c', 0)] },
      fakeDeps(),
    ),
    null,
    'zero-token calls produce no rows → null',
  );
  assert.equal(
    await recordAiUsageWith(
      { userId: 'u1', source: 'chat', usage: { model: 'm', inputTokens: 100, outputTokens: 40, totalTokens: 140 } },
      fakeDeps(),
    ),
    1,
    'legacy path returns 1',
  );
  assert.equal(
    await recordAiUsageWith({ userId: 'u1', source: 'chat', usage: { model: 'm' } }, fakeDeps()),
    null,
    'usage without totalTokens → null',
  );
  assert.equal(
    await recordAiUsageWith({ userId: 'u1', source: 'chat', usage: { model: 'm', totalTokens: 0 } }, fakeDeps()),
    null,
    'usage with zero totalTokens → null',
  );
});

test('31. multiple provider calls are not priced once per database row', async () => {
  let shadowInvoked = 0;
  const deps = fakeDeps({
    shadowRecord: (calls, ctx) => {
      shadowInvoked += 1;
      return shadowPricingService.record(calls, ctx);
    },
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('a', 1), validCall('b', 2), validCall('c', 3)],
    },
    deps,
  );
  assert.equal(shadowInvoked, 1, 'one invocation despite three telemetry rows');
});

test('32. no route or feature service receives a new pricing call', () => {
  const importers: string[] = [];
  for (const file of walkTs(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    // Match imports of the shadow-pricing service module (not the observation buffer).
    if (/from.*\/ai-shadow-pricing\.service\.js/.test(text)) {
      importers.push(relativePath(file));
    }
  }
  assert.deepEqual(
    importers.sort(),
    [
      // Phase 2D-B: read-only admin consumer importing only the shared
      // DEFAULT_OBSERVATION_BUFFER for metrics; it never calls pricing.
      'src/controllers/ai-shadow-pricing-admin.controller.ts',
      // recordAiUsage is the only producer that invokes the pricing service.
      'src/services/ai-usage.service.ts',
    ],
    'only recordAiUsage may invoke pricing; the admin controller only reads the buffer',
  );
});

test('33. missing userId + authoritative non-empty providerCalls: shadow invoked, DB not called', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let shadowCalled = false;
  let dbWritesRequested = false;
  const deps = fakeDeps({
    onRows: () => { dbWritesRequested = true; },
    shadowRecord: (calls, ctx) => {
      shadowCalled = true;
      return shadowPricingService.record(calls, ctx);
    },
  });
  const result = await recordAiUsageWith(
    {
      userId: '',
      conversationId: 'c1',
      source: 'chat',
      providerCalls: [validCall('call-1', 140)],
    },
    deps,
  );
  assert.equal(result, undefined, 'empty userId must return undefined');
  assert.equal(shadowCalled, true, 'shadow service must still be invoked');
  assert.equal(dbWritesRequested, false, 'no DB write when userId absent');
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('34. missing userId + explicit providerCalls=[]: shadow invoked, DB not called', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let shadowCalled = false;
  let dbWritesRequested = false;
  const deps = fakeDeps({
    onRows: () => { dbWritesRequested = true; },
    shadowRecord: (calls, ctx) => {
      shadowCalled = true;
      return shadowPricingService.record(calls, ctx);
    },
  });
  const result = await recordAiUsageWith(
    { userId: '', source: 'identify', providerCalls: [] },
    deps,
  );
  assert.equal(result, undefined);
  assert.equal(shadowCalled, true, 'shadow still invoked for explicit empty array');
  assert.equal(dbWritesRequested, false);
  const snap = DEFAULT_OBSERVATION_BUFFER.snapshot();
  assert.ok(snap.length >= 1);
  assert.equal(snap[snap.length - 1].report.noProviderCalls, true);

  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('35. missing userId + providerCalls absent: shadow receives undefined, no DB write', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let shadowCalled = false;
  let dbWritesRequested = false;
  const deps = fakeDeps({
    onRows: () => { dbWritesRequested = true; },
    shadowRecord: () => {
      shadowCalled = true;
      return { kind: 'skipped', reason: 'NOT_AUTHORITATIVE' } as const;
    },
  });
  const result = await recordAiUsageWith(
    { userId: '', source: 'chat' },
    deps,
  );
  assert.equal(result, undefined);
  assert.equal(shadowCalled, true, 'shadow always invoked once per recordAiUsage');
  assert.equal(dbWritesRequested, false);
  assert.equal(DEFAULT_OBSERVATION_BUFFER.size(), 0);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('36. no raw bigint reaches JSON.stringify in the integration path', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-1', 140), validCall('call-2', 90)],
    },
    deps,
  );
  const snap = DEFAULT_OBSERVATION_BUFFER.snapshot();
  for (const obs of snap) {
    JSON.stringify(obs.report);
    assertNoBigint(obs.report);
  }
  DEFAULT_OBSERVATION_BUFFER.reset();
});

function assertNoBigint(value: unknown): void {
  if (typeof value === 'bigint') assert.fail('raw bigint leaked into structured log');
  if (Array.isArray(value)) value.forEach(assertNoBigint);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) assertNoBigint(v);
  }
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...walkTs(full));
    } else if (extname(full) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

function relativePath(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}