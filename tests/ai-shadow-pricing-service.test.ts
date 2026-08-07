import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiShadowPricingService } from '../src/services/ai-shadow-pricing.service.js';
import { AiShadowPricingObservationService } from '../src/services/ai-shadow-pricing-observation.service.js';
import type { ShadowPricingLogger } from '../src/services/ai-shadow-pricing.service.js';
import type { ShadowPricingResult } from '../src/types/provider-pricing.js';
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';

/** In-memory logger that captures payloads. */
function captureLogger(): {
  logger: ShadowPricingLogger;
  infos: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
} {
  const infos: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  return {
    infos,
    errors,
    logger: {
      info: (_event, payload) => infos.push(payload),
      error: (_event, payload) => errors.push(payload),
    },
  };
}

function assertNoBigint(value: unknown, path = 'root'): void {
  if (typeof value === 'bigint') assert.fail(`bigint at ${path}`);
  if (Array.isArray(value)) value.forEach((v, i) => assertNoBigint(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoBigint(v, `${path}.${k}`);
  }
}

const VALID_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'call-1',
  actualModel: 'gemini-3.6-flash',
  inputTokens: 1500,
  outputTokens: 200,
  cachedInputTokens: 500,
};

const MIXED_CALLS = [
  { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 10 },
  { provider: 'google', providerCallMade: true, providerCallId: 'b', actualModel: 'gemini-2.5-flash-lite', inputTokens: 1 },
];

function aggregateResult(input: Parameters<typeof aggregateProviderCalls>[0]): ShadowPricingResult {
  return aggregateProviderCalls(input);
}

test('13. valid non-empty providerCalls are priced exactly once', async () => {
  const captured = captureLogger();
  let engineCalls = 0;
  const svc = new AiShadowPricingService({
    engine: (input) => {
      engineCalls += 1;
      return aggregateResult(input);
    },
    logger: captured.logger,
    buffer: new AiShadowPricingObservationService(),
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  assert.equal(engineCalls, 1);
  const result = (outcome as { kind: 'priced'; result: ShadowPricingResult }).result;
  assert.equal(result.totals.pricedCallCount, 1);
  assert.equal(result.totals.callCount, 1);
  assert.equal(result.totals.pricedCostNanoUsd, 3_825_000n);
  assert.equal(captured.infos.length, 1);
});

test('14. mixed-model calls remain independent', async () => {
  const captured = captureLogger();
  const svc = new AiShadowPricingService({
    logger: captured.logger,
    buffer: new AiShadowPricingObservationService(),
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const outcome = await svc.record(MIXED_CALLS, { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  const result = (outcome as { kind: 'priced'; result: ShadowPricingResult }).result;
  assert.equal(result.totals.callCount, 2);
  assert.equal(result.totals.pricedCallCount, 2);
  assert.equal(result.totals.pricedCostNanoUsd, 15_100n);
  const models = result.calls.map((c) => c.actualModel).sort();
  assert.deepEqual(models, ['gemini-2.5-flash-lite', 'gemini-3.6-flash']);
});

test('15. explicit empty providerCalls produces a noProviderCalls outcome', async () => {
  const captured = captureLogger();
  const buf = new AiShadowPricingObservationService();
  const svc = new AiShadowPricingService({
    logger: captured.logger,
    buffer: buf,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const outcome = await svc.record([], { source: 'identify', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'noProviderCalls');
  const result = (outcome as { kind: 'noProviderCalls'; result: ShadowPricingResult }).result;
  assert.equal(result.noProviderCalls, true);
  assert.equal(result.summaryStatus, 'UNPRICED');
  assert.equal(result.totals.callCount, 0);
  assert.equal(buf.size(), 1);
  assert.equal(buf.snapshot()[0].report.noProviderCalls, true);
});

test('16. providerCallMade=false records do not create calls', async () => {
  const captured = captureLogger();
  const svc = new AiShadowPricingService({
    logger: captured.logger,
    buffer: new AiShadowPricingObservationService(),
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const outcome = await svc.record(
    [{ provider: 'google', providerCallMade: false, providerCallId: 'c', actualModel: 'gemini-3.6-flash' }],
    { source: 'chat', pricingDate: '2026-08-03' },
  );
  assert.equal(outcome.kind, 'priced');
  const result = (outcome as { kind: 'priced'; result: ShadowPricingResult }).result;
  assert.equal(result.noProviderCalls, true);
  assert.equal(result.totals.callCount, 0);
});

test('17. structured success log contains no bigint', async () => {
  const captured = captureLogger();
  const svc = new AiShadowPricingService({
    logger: captured.logger,
    buffer: new AiShadowPricingObservationService(),
    now: () => '2026-08-03T00:00:00.000Z',
  });
  await svc.record([VALID_CALL], { source: 'chat', conversationId: 'conv-1', pricingDate: '2026-08-03' });
  assert.equal(captured.infos.length, 1);
  const payload = captured.infos[0];
  assert.equal(payload.event, 'ai_shadow_pricing');
  assert.equal(payload.summaryStatus, 'FULLY_PRICED');
  assert.equal(payload.callCount, 1);
  assert.equal(payload.pricedCallCount, 1);
  assert.equal(payload.pricedCostNanoUsd, '3825000');
  assert.equal(payload.pricedCostMicroUsd, '3825');
  assert.equal(payload.pricedCostUsd, '0.003825000');
  assertNoBigint(payload);
  JSON.stringify(payload);
});

test('18. unexpected engine error is caught, isolated, and reported', async () => {
  const captured = captureLogger();
  const buf = new AiShadowPricingObservationService();
  const svc = new AiShadowPricingService({
    engine: () => { throw new Error('raw error'); },
    logger: captured.logger,
    buffer: buf,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'error');
  assert.equal(buf.size(), 0, 'no observation on engine failure');
  assert.equal(captured.errors.length, 1, 'exactly one safe error log');
  const errPayload = captured.errors[0];
  assert.equal(errPayload.event, 'ai_shadow_pricing_error');
  assert.equal(errPayload.errorMessage, 'shadow pricing failed');
  assertNoBigint(errPayload);
});

test('19. logger failure is safely isolated', async () => {
  const throwingLogger: ShadowPricingLogger = {
    info: () => { throw new Error('logger down'); },
    error: () => { throw new Error('logger down'); },
  };
  const buf = new AiShadowPricingObservationService();
  const svc = new AiShadowPricingService({
    logger: throwingLogger,
    buffer: buf,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  let outcome: ReturnType<AiShadowPricingService['record']> = { kind: 'skipped', reason: 'NOT_AUTHORITATIVE' };
  try {
    outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  } catch {
    assert.fail('should not throw despite logger failure');
  }
  assert.equal(outcome.kind, 'priced');
  assert.equal(buf.size(), 1, 'observation still recorded despite logger failure');
});

test('20. observation-buffer error is isolated', async () => {
  const captured = captureLogger();
  const throwingBuffer = {
    record: () => { throw new Error('buffer full'); },
  } as unknown as AiShadowPricingObservationService;
  const svc = new AiShadowPricingService({
    logger: captured.logger,
    buffer: throwingBuffer,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  let outcome: ReturnType<AiShadowPricingService['record']> = { kind: 'skipped', reason: 'NOT_AUTHORITATIVE' };
  try {
    outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  } catch {
    assert.fail('should not throw despite buffer failure');
  }
  assert.equal(outcome.kind, 'priced');
  assert.equal(captured.errors.length, 1);
  const payload = captured.errors[0];
  assert.equal(payload.errorMessage, 'shadow pricing observation failed');
  assertNoBigint(payload);
});

test('21. no prompt/response/raw payload is logged or stored', async () => {
  const captured = captureLogger();
  const buf = new AiShadowPricingObservationService();
  const svc = new AiShadowPricingService({
    logger: captured.logger,
    buffer: buf,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const callWithJunk = {
    provider: 'google',
    providerCallMade: true,
    providerCallId: 'call-1',
    actualModel: 'gemini-3.6-flash',
    inputTokens: 1,
    prompt: 'TOP-SECRET-PROMPT',
    response: 'TOP-SECRET-RESPONSE',
    rawProviderPayload: { secret: 'TOP-SECRET-RAW' },
  };
  await svc.record([callWithJunk], { source: 'chat', pricingDate: '2026-08-03' });
  const serializedLog = JSON.stringify(captured.infos);
  const serializedObs = JSON.stringify(buf.snapshot());
  assert.ok(!serializedLog.includes('TOP-SECRET'));
  assert.ok(!serializedObs.includes('TOP-SECRET'));
});

test('skipped: absent providerCalls produces no observation and no log', async () => {
  const captured = captureLogger();
  const buf = new AiShadowPricingObservationService();
  const svc = new AiShadowPricingService({
    logger: captured.logger,
    buffer: buf,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const outcome = await svc.record(undefined, { source: 'chat' });
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'NOT_AUTHORITATIVE' });
  assert.equal(buf.size(), 0);
  assert.equal(captured.infos.length, 0);
  assert.equal(captured.errors.length, 0);
});

test('skipped: invalid (non-normalizable) array produces no observation and no log', async () => {
  const captured = captureLogger();
  const buf = new AiShadowPricingObservationService();
  const svc = new AiShadowPricingService({
    logger: captured.logger,
    buffer: buf,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const outcome = await svc.record([{ provider: 'google' }], { source: 'chat' });
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'INVALID' });
  assert.equal(buf.size(), 0);
  assert.equal(captured.infos.length, 0);
});