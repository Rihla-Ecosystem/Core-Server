import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AIExecutionContractError,
  parseAIExecutionOutcome,
  validateAIExecutionRequest,
} from '../src/utils/ai-execution-contract.js';
import type { AIExecutionContractErrorCode } from '../src/utils/ai-execution-contract.js';
import type {
  AIExecutionOutcome,
  AIExecutionRequest,
  AIExecutionStreamEvent,
} from '../src/types/ai-execution.js';
import type { AIChatHistoryMessage } from '../src/types/ai.js';

const USAGE = {
  provider: 'fake-provider',
  model: 'fake-model',
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
} as const;

function baseRequest(): unknown {
  return {
    operationId: 'op-1',
    feature: 'AI_CHAT_QUERY',
    input: { message: 'Where should I go?' },
    limits: { maxInputTokens: 12000, maxOutputTokens: 1200 },
  };
}

function validSuccess(): unknown {
  return {
    kind: 'SUCCESS',
    data: { response: 'ok' },
    execution: { provider: 'fake-provider', model: 'fake-model' },
    usage: { ...USAGE },
  };
}

function nonBillable(): unknown {
  return {
    kind: 'NON_BILLABLE_FAILURE',
    code: 'INPUT_REJECTED',
    message: 'message blocked by guardrails',
    providerRequestSent: false,
    retryable: false,
  };
}

function indeterminate(): unknown {
  return {
    kind: 'INDETERMINATE_FAILURE',
    code: 'TIMEOUT',
    message: 'provider did not respond in time',
    providerRequestSent: true,
    retryable: true,
  };
}

function expectContractError(
  fn: () => unknown,
  code: AIExecutionContractErrorCode,
): AIExecutionContractError {
  let captured: AIExecutionContractError | undefined;
  assert.throws(fn, (err: unknown) => {
    assert.ok(
      err instanceof AIExecutionContractError,
      `expected AIExecutionContractError, got ${(err as Error)?.message}`,
    );
    assert.equal((err as AIExecutionContractError).code, code);
    captured = err as AIExecutionContractError;
    return true;
  });
  return captured as AIExecutionContractError;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test('1. Valid provider-neutral request', () => {
  const result = validateAIExecutionRequest(baseRequest());
  assert.equal(result.operationId, 'op-1');
  assert.equal(result.feature, 'AI_CHAT_QUERY');
  assert.equal(result.input.message, 'Where should I go?');
  assert.equal(result.limits.maxInputTokens, 12000);
  assert.equal(result.limits.maxOutputTokens, 1200);
  assert.equal(result.provider, undefined);
  assert.equal(result.model, undefined);
});

test('2. Valid request without provider/model', () => {
  const result = validateAIExecutionRequest(baseRequest());
  assert.equal('provider' in result, false);
  assert.equal('model' in result, false);
});

test('3. Provider/model are trimmed', () => {
  const result = validateAIExecutionRequest({
    ...baseRequest(),
    provider: '  fake-provider  ',
    model: ' fake-model ',
  });
  assert.equal(result.provider, 'fake-provider');
  assert.equal(result.model, 'fake-model');
});

test('4. Empty provider is rejected', () => {
  for (const provider of ['', '   ']) {
    expectContractError(
      () => validateAIExecutionRequest({ ...baseRequest(), provider }),
      'INVALID_REQUEST',
    );
  }
});

test('5. Empty model is rejected', () => {
  for (const model of ['', '   ']) {
    expectContractError(
      () => validateAIExecutionRequest({ ...baseRequest(), model }),
      'INVALID_REQUEST',
    );
  }
});

test('6. Missing operationId is rejected', () => {
  const { operationId: _omitted, ...rest } = baseRequest() as {
    operationId: string;
    [key: string]: unknown;
  };
  expectContractError(() => validateAIExecutionRequest(rest), 'INVALID_REQUEST');
});

test('7. Empty operationId is rejected', () => {
  expectContractError(
    () => validateAIExecutionRequest({ ...baseRequest(), operationId: '   ' }),
    'INVALID_REQUEST',
  );
});

test('8. Missing feature is rejected', () => {
  const { feature: _omitted, ...rest } = baseRequest() as {
    feature: string;
    [key: string]: unknown;
  };
  expectContractError(() => validateAIExecutionRequest(rest), 'INVALID_REQUEST');
});

test('9. Empty message is rejected', () => {
  expectContractError(
    () =>
      validateAIExecutionRequest({
        ...baseRequest(),
        input: { message: '   ' },
      }),
    'INVALID_REQUEST',
  );
});

test('10. maxInputTokens must be a safe positive integer', () => {
  for (const bad of [0, -1]) {
    expectContractError(
      () =>
        validateAIExecutionRequest({
          ...baseRequest(),
          limits: { maxInputTokens: bad, maxOutputTokens: 1200 },
        }),
      'INVALID_REQUEST',
    );
  }
});

test('11. maxOutputTokens must be a safe positive integer', () => {
  for (const bad of [0, -1]) {
    expectContractError(
      () =>
        validateAIExecutionRequest({
          ...baseRequest(),
          limits: { maxInputTokens: 12000, maxOutputTokens: bad },
        }),
      'INVALID_REQUEST',
    );
  }
});

test('12. NaN/Infinity/decimal/unsafe limits are rejected', () => {
  const badValues: unknown[] = [
    NaN,
    Infinity,
    -Infinity,
    10.5,
    Number.MAX_SAFE_INTEGER + 1,
    '12000',
    null,
    undefined,
  ];
  for (const bad of badValues) {
    expectContractError(
      () =>
        validateAIExecutionRequest({
          ...baseRequest(),
          limits: { maxInputTokens: bad, maxOutputTokens: 1200 },
        }),
      'INVALID_REQUEST',
    );
    expectContractError(
      () =>
        validateAIExecutionRequest({
          ...baseRequest(),
          limits: { maxInputTokens: 12000, maxOutputTokens: bad },
        }),
      'INVALID_REQUEST',
    );
  }
});

test('13. Valid history is preserved in order', () => {
  const history: AIChatHistoryMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ];
  const result = validateAIExecutionRequest({
    ...baseRequest(),
    input: { message: 'now', history },
  });
  assert.deepEqual(result.input.history, history);
  assert.deepEqual(
    result.input.history?.map((item) => item.content),
    ['first', 'second', 'third'],
  );
});

test('14. Invalid history role is rejected', () => {
  expectContractError(
    () =>
      validateAIExecutionRequest({
        ...baseRequest(),
        input: {
          message: 'hi',
          history: [{ role: 'system', content: 'not allowed' }],
        },
      }),
    'INVALID_REQUEST',
  );
});

test('15. Empty history content is rejected', () => {
  for (const content of ['', '   ']) {
    expectContractError(
      () =>
        validateAIExecutionRequest({
          ...baseRequest(),
          input: {
            message: 'hi',
            history: [{ role: 'user', content }],
          },
        }),
      'INVALID_REQUEST',
    );
  }
});

test('16. Input is not mutated', () => {
  const raw = {
    ...baseRequest(),
    provider: ' fake-provider ',
    input: {
      message: 'hi',
      history: [{ role: 'user', content: 'first' }],
      context: ' c ',
    },
    metadata: { userId: ' u ', conversationId: ' c1 ', requestId: ' r1 ' },
  };
  const snapshot = structuredClone(raw);
  validateAIExecutionRequest(raw);
  assert.deepEqual(raw, snapshot);
});

test('17. Unknown fields are stripped', () => {
  const result = validateAIExecutionRequest({
    ...baseRequest(),
    extra_top: 1,
    input: { message: 'hi', extra_nested: true },
    limits: { maxInputTokens: 12000, maxOutputTokens: 1200, extra_limit: 9 },
  });
  assert.equal('extra_top' in result, false);
  assert.equal('extra_nested' in result.input, false);
  assert.equal('extra_limit' in result.limits, false);
});

test('18. Fresh objects are returned', () => {
  const raw = {
    ...baseRequest(),
    input: { message: 'hi', history: [{ role: 'user', content: 'first' }] },
    metadata: { userId: 'u1' },
  };
  const first = validateAIExecutionRequest(raw);
  const second = validateAIExecutionRequest(raw);
  assert.notEqual(first, raw);
  assert.notEqual(first.input, raw.input);
  assert.notEqual(first.limits, raw.limits);
  assert.notEqual(first.metadata, raw.metadata);
  assert.notEqual(first.input.history, raw.input.history);
  first.input.message = 'CHANGED';
  first.limits.maxInputTokens = 1;
  assert.equal(second.input.message, 'hi');
  assert.equal(second.limits.maxInputTokens, 12000);
});

// ---------------------------------------------------------------------------
// Success parsing
// ---------------------------------------------------------------------------

test('19. Valid canonical SUCCESS', () => {
  const result = parseAIExecutionOutcome(validSuccess());
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.deepEqual(result.data, { response: 'ok' });
  assert.deepEqual(result.execution, { provider: 'fake-provider', model: 'fake-model' });
  assert.deepEqual(result.usage, { ...USAGE });
});

test('20. Valid snake_case usage is normalized', () => {
  const raw = {
    kind: 'SUCCESS',
    data: 'ok',
    execution: { provider: 'fake-provider', model: 'fake-model' },
    usage: {
      provider: 'fake-provider',
      model: 'fake-model',
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    },
  };
  const result = parseAIExecutionOutcome(raw);
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.totalTokens, 30);
});

test('21. Valid mixed-case usage is normalized', () => {
  const raw = {
    kind: 'SUCCESS',
    data: 'ok',
    execution: { provider: 'fake-provider', model: 'fake-model' },
    usage: {
      provider: 'fake-provider',
      model: 'fake-model',
      inputTokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    },
  };
  const result = parseAIExecutionOutcome(raw);
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.deepEqual(result.usage, { ...USAGE });
});

test('22. Missing usage is rejected', () => {
  const { usage: _omitted, ...rest } = validSuccess() as Record<string, unknown>;
  const err = expectContractError(() => parseAIExecutionOutcome(rest), 'INVALID_USAGE');
  assert.ok(err.message.length > 0);
});

test('23. Invalid usage is rejected', () => {
  expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...validSuccess(),
        usage: { provider: 'fake-provider', model: 'fake-model', inputTokens: -5, outputTokens: 10, totalTokens: 5 },
      }),
    'INVALID_USAGE',
  );
});

test('24. Missing execution is rejected', () => {
  const { execution: _omitted, ...rest } = validSuccess() as Record<string, unknown>;
  expectContractError(() => parseAIExecutionOutcome(rest), 'INVALID_EXECUTION_IDENTITY');
});

test('25. Missing provider is rejected', () => {
  expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...validSuccess(),
        execution: { model: 'fake-model' },
      }),
    'INVALID_EXECUTION_IDENTITY',
  );
});

test('26. Missing model is rejected', () => {
  expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...validSuccess(),
        execution: { provider: 'fake-provider' },
      }),
    'INVALID_EXECUTION_IDENTITY',
  );
});

test('27. Empty providerRequestId is rejected', () => {
  for (const providerRequestId of ['', '   ']) {
    expectContractError(
      () =>
        parseAIExecutionOutcome({
          ...validSuccess(),
          execution: { provider: 'fake-provider', model: 'fake-model', providerRequestId },
        }),
      'INVALID_EXECUTION_IDENTITY',
    );
  }
});

test('28. Execution provider mismatch with usage provider is rejected', () => {
  expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...validSuccess(),
        execution: { provider: 'other-provider', model: 'fake-model' },
      }),
    'IDENTITY_USAGE_MISMATCH',
  );
});

test('29. Execution model mismatch with usage model is rejected', () => {
  expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...validSuccess(),
        execution: { provider: 'fake-provider', model: 'other-model' },
      }),
    'IDENTITY_USAGE_MISMATCH',
  );
});

test('30. Unknown success fields are stripped', () => {
  const raw = {
    ...validSuccess(),
    junk: 123,
    execution: { provider: 'fake-provider', model: 'fake-model', junk_identity: 'x' },
    usage: { ...USAGE, junk_usage: 'y' },
  };
  const result = parseAIExecutionOutcome(raw);
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.equal('junk' in result, false);
  assert.equal('junk_identity' in result.execution, false);
  assert.equal('junk_usage' in result.usage, false);
});

test('31. Input is not mutated', () => {
  const raw = {
    ...validSuccess(),
    execution: { provider: ' fake-provider ', model: ' fake-model ' },
    usage: { provider: ' fake-provider ', model: ' fake-model ', inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  };
  const snapshot = structuredClone(raw);
  parseAIExecutionOutcome(raw);
  assert.deepEqual(raw, snapshot);
});

test('32. Fresh identity and usage objects are returned', () => {
  const raw = validSuccess() as Record<string, unknown>;
  const first = parseAIExecutionOutcome(raw);
  const second = parseAIExecutionOutcome(raw);
  assert.equal(first.kind, 'SUCCESS');
  if (first.kind !== 'SUCCESS') return;
  assert.notEqual(first.execution, raw.execution);
  assert.notEqual(first.usage, raw.usage);
  assert.notEqual(first.execution, second.execution);
  assert.notEqual(first.usage, second.usage);
});

test('33. null data is preserved', () => {
  const result = parseAIExecutionOutcome({ ...validSuccess(), data: null });
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.equal(result.data, null);
});

test('34. totalTokens is preserved diagnostically', () => {
  const result = parseAIExecutionOutcome({
    ...validSuccess(),
    usage: { ...USAGE, totalTokens: 99 },
  });
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 20);
  assert.equal(result.usage.totalTokens, 99);
});

// ---------------------------------------------------------------------------
// Failure parsing
// ---------------------------------------------------------------------------

test('35. Valid NON_BILLABLE_FAILURE', () => {
  const result = parseAIExecutionOutcome(nonBillable());
  assert.equal(result.kind, 'NON_BILLABLE_FAILURE');
  if (result.kind !== 'NON_BILLABLE_FAILURE') return;
  assert.equal(result.providerRequestSent, false);
  assert.equal(result.code, 'INPUT_REJECTED');
  assert.equal(result.retryable, false);
});

test('36. Valid INDETERMINATE_FAILURE', () => {
  const result = parseAIExecutionOutcome(indeterminate());
  assert.equal(result.kind, 'INDETERMINATE_FAILURE');
  if (result.kind !== 'INDETERMINATE_FAILURE') return;
  assert.equal(result.providerRequestSent, true);
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.retryable, true);
});

test('37. NON_BILLABLE with providerRequestSent true is rejected', () => {
  expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...nonBillable(),
        providerRequestSent: true,
      }),
    'INVALID_FAILURE',
  );
});

test('38. INDETERMINATE with providerRequestSent false is rejected', () => {
  expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...indeterminate(),
        providerRequestSent: false,
      }),
    'INVALID_FAILURE',
  );
});

test('39. Missing providerRequestSent is rejected', () => {
  const { providerRequestSent: _omitted, ...rest } = nonBillable() as Record<string, unknown>;
  expectContractError(() => parseAIExecutionOutcome(rest), 'INVALID_FAILURE');
  const { providerRequestSent: _omitted2, ...rest2 } = indeterminate() as Record<string, unknown>;
  expectContractError(() => parseAIExecutionOutcome(rest2), 'INVALID_FAILURE');
});

test('40. Empty failure code is rejected', () => {
  for (const kind of ['NON_BILLABLE_FAILURE', 'INDETERMINATE_FAILURE']) {
    const base = kind === 'NON_BILLABLE_FAILURE' ? nonBillable() : indeterminate();
    expectContractError(
      () => parseAIExecutionOutcome({ ...base, code: '   ' }),
      'INVALID_FAILURE',
    );
  }
});

test('41. Empty failure message is rejected', () => {
  for (const kind of ['NON_BILLABLE_FAILURE', 'INDETERMINATE_FAILURE']) {
    const base = kind === 'NON_BILLABLE_FAILURE' ? nonBillable() : indeterminate();
    expectContractError(
      () => parseAIExecutionOutcome({ ...base, message: '   ' }),
      'INVALID_FAILURE',
    );
  }
});

test('42. Missing retryable is rejected', () => {
  const { retryable: _omitted, ...rest } = nonBillable() as Record<string, unknown>;
  expectContractError(() => parseAIExecutionOutcome(rest), 'INVALID_FAILURE');
  const { retryable: _omitted2, ...rest2 } = indeterminate() as Record<string, unknown>;
  expectContractError(() => parseAIExecutionOutcome(rest2), 'INVALID_FAILURE');
});

test('43. Non-boolean retryable is rejected', () => {
  for (const retryable of ['true', 1, null, {}, []]) {
    expectContractError(
      () => parseAIExecutionOutcome({ ...nonBillable(), retryable }),
      'INVALID_FAILURE',
    );
    expectContractError(
      () => parseAIExecutionOutcome({ ...indeterminate(), retryable }),
      'INVALID_FAILURE',
    );
  }
});

test('44. Failure containing usage is rejected', () => {
  expectContractError(
    () => parseAIExecutionOutcome({ ...nonBillable(), usage: { ...USAGE } }),
    'INVALID_FAILURE',
  );
  expectContractError(
    () => parseAIExecutionOutcome({ ...indeterminate(), usage: { ...USAGE } }),
    'INVALID_FAILURE',
  );
});

test('45. Failure containing data is rejected', () => {
  expectContractError(
    () => parseAIExecutionOutcome({ ...nonBillable(), data: 'should not be here' }),
    'INVALID_FAILURE',
  );
  expectContractError(
    () => parseAIExecutionOutcome({ ...indeterminate(), data: 'should not be here' }),
    'INVALID_FAILURE',
  );
});

test('46. Unknown kind is rejected', () => {
  expectContractError(
    () => parseAIExecutionOutcome({ ...validSuccess(), kind: 'FAILED' }),
    'UNSUPPORTED_KIND',
  );
});

test('47. Missing kind is rejected', () => {
  const { kind: _omitted, ...rest } = validSuccess() as Record<string, unknown>;
  expectContractError(() => parseAIExecutionOutcome(rest), 'INVALID_OUTCOME');
});

test('48. Optional partial execution identity is sanitized', () => {
  const result = parseAIExecutionOutcome({
    ...indeterminate(),
    execution: { provider: ' fake-provider ', junk: 1 },
  });
  assert.equal(result.kind, 'INDETERMINATE_FAILURE');
  if (result.kind !== 'INDETERMINATE_FAILURE') return;
  assert.deepEqual(result.execution, { provider: 'fake-provider' });
});

test('49. Raw error payload is never included in thrown error messages', () => {
  const raw = {
    ...validSuccess(),
    secret: 'SUPER_SECRET_XYZ',
    execution: { provider: 'fake-provider', model: 'fake-model', token: 'SUPER_SECRET_XYZ' },
    usage: { ...USAGE, secret: 'SUPER_SECRET_XYZ' },
  };
  const err = expectContractError(
    () => parseAIExecutionOutcome({ ...raw, usage: undefined, secret: 'SUPER_SECRET_XYZ' }),
    'INVALID_USAGE',
  );
  assert.ok(!err.message.includes('SUPER_SECRET_XYZ'));
  assert.ok(!err.message.includes('fake-provider'));

  const requestErr = expectContractError(
    () =>
      validateAIExecutionRequest({
        ...baseRequest(),
        operationId: undefined,
        secret: 'SUPER_SECRET_XYZ',
      }),
    'INVALID_REQUEST',
  );
  assert.ok(!requestErr.message.includes('SUPER_SECRET_XYZ'));
});

// ---------------------------------------------------------------------------
// Streaming types / contracts
// ---------------------------------------------------------------------------

test('50. START supports operationId', () => {
  const event: AIExecutionStreamEvent = { type: 'START', operationId: 'op-1' };
  assert.equal(event.type, 'START');
  assert.equal(event.operationId, 'op-1');
  const withIdentity: AIExecutionStreamEvent = {
    type: 'START',
    operationId: 'op-1',
    execution: { provider: 'fake-provider' },
  };
  assert.equal(withIdentity.type, 'START');
});

test('51. DELTA contains text only', () => {
  const event: AIExecutionStreamEvent = { type: 'DELTA', text: 'Luxor' };
  assert.equal(event.type, 'DELTA');
  assert.equal(event.text, 'Luxor');
  assert.deepEqual(Object.keys(event), ['type', 'text']);
});

test('52. USAGE requires identity and usage', () => {
  const event: AIExecutionStreamEvent = {
    type: 'USAGE',
    execution: { provider: 'fake-provider', model: 'fake-model' },
    usage: { ...USAGE },
  };
  assert.equal(event.type, 'USAGE');
  assert.equal(event.execution.provider, 'fake-provider');
  assert.equal(event.usage.totalTokens, 30);
});

test('53. DONE contains no implicit usage', () => {
  const event: AIExecutionStreamEvent = { type: 'DONE' };
  assert.equal(event.type, 'DONE');
  assert.deepEqual(Object.keys(event), ['type']);
});

test('54. FAILURE uses the canonical failure contract', () => {
  const nonBillableEvent: AIExecutionStreamEvent = {
    type: 'FAILURE',
    failure: {
      kind: 'NON_BILLABLE_FAILURE',
      code: 'INPUT_REJECTED',
      message: 'blocked',
      providerRequestSent: false,
      retryable: false,
    },
  };
  assert.equal(nonBillableEvent.type, 'FAILURE');
  if (nonBillableEvent.type !== 'FAILURE') return;
  assert.equal(nonBillableEvent.failure.providerRequestSent, false);

  const indeterminateEvent: AIExecutionStreamEvent = {
    type: 'FAILURE',
    failure: {
      kind: 'INDETERMINATE_FAILURE',
      code: 'TIMEOUT',
      message: 'timeout',
      providerRequestSent: true,
      retryable: true,
    },
  };
  assert.equal(indeterminateEvent.type, 'FAILURE');
  if (indeterminateEvent.type !== 'FAILURE') return;
  assert.equal(indeterminateEvent.failure.providerRequestSent, true);
});

const executionTypesSource = readFileSync(
  new URL('../src/types/ai-execution.ts', import.meta.url),
  'utf8',
);
const executionContractSource = readFileSync(
  new URL('../src/utils/ai-execution-contract.ts', import.meta.url),
  'utf8',
);

test('55. Streaming contract contains no provider SDK fields', () => {
  assert.ok(!executionTypesSource.includes('google'));
  assert.ok(!executionTypesSource.includes('genai'));
  assert.ok(!executionTypesSource.includes('api_key'));
  assert.ok(!executionTypesSource.includes('temperature'));
  assert.ok(!executionTypesSource.includes('systemPrompt'));
  assert.ok(!executionTypesSource.includes('GenerateContent'));
});

test('56. No streaming integration is added', () => {
  assert.ok(!executionContractSource.includes('node:stream/web'));
  assert.ok(!executionContractSource.includes('chat-stream.service'));
  assert.ok(!executionContractSource.includes('ReadableStream'));
  assert.ok(!executionContractSource.includes('SSE'));
  assert.ok(!executionContractSource.includes('text/event-stream'));
});

// ---------------------------------------------------------------------------
// Separation
// ---------------------------------------------------------------------------

test('57. Contract utility performs no HTTP', () => {
  assert.ok(!executionContractSource.includes('fetch('));
  assert.ok(!executionContractSource.includes('node:http'));
  assert.ok(!executionContractSource.includes('node:https'));
  assert.ok(!executionContractSource.includes('HttpClientError'));
  assert.ok(!executionContractSource.includes('AI_SERVICE_URL'));
});

test('58. Contract utility performs no Prisma access', () => {
  assert.ok(!executionContractSource.includes('@prisma/client'));
  assert.ok(!executionContractSource.includes('prisma.'));
});

test('59. Contract utility performs no AI call', () => {
  assert.ok(!executionContractSource.includes('@google/generative-ai'));
  assert.ok(!executionContractSource.includes('genai'));
  assert.ok(!executionContractSource.includes('gemini'));
});

test('60. Contract utility performs no pricing', () => {
  assert.ok(!executionContractSource.includes('calculateAIUsagePrice'));
  assert.ok(!executionContractSource.includes('micros'));
  assert.ok(!executionContractSource.includes('rateCard'));
  assert.ok(!executionContractSource.includes('costMicros'));
});

test('61. Contract utility performs no Wallet mutation', () => {
  assert.ok(!executionContractSource.includes('reserveBusinessToken'));
  assert.ok(!executionContractSource.includes('settleBusinessToken'));
  assert.ok(!executionContractSource.includes('releaseBusinessToken'));
});

test('62. No production provider is hardcoded', () => {
  const combined = `${executionTypesSource}\n${executionContractSource}`.toLowerCase();
  for (const forbidden of ['gemini', 'openai', 'claude', 'gpt-', 'gemini-2.0-flash']) {
    assert.ok(!combined.includes(forbidden), `found forbidden provider token: ${forbidden}`);
  }
});

test('63. No provider prices are added', () => {
  const combined = `${executionTypesSource}\n${executionContractSource}`;
  assert.ok(!combined.includes('micros'));
  assert.ok(!combined.includes('walletTokenValueMicros'));
  assert.ok(!combined.includes('AIProviderTokenRate'));
});

test('64. Contract utility reuses the canonical usage normalizer and history contract', () => {
  assert.ok(executionContractSource.includes("from './ai-usage.js'"));
  assert.ok(executionContractSource.includes('normalizeAIProviderUsage'));
  assert.ok(executionTypesSource.includes("from './ai.js'"));
  assert.ok(executionTypesSource.includes('AIProviderUsage'));
  assert.ok(executionTypesSource.includes('AIChatHistoryMessage'));
  assert.ok(executionTypesSource.includes('AIExecutionOutcome'));
});

// ---------------------------------------------------------------------------
// Contract strictness and content-preservation fix round
// ---------------------------------------------------------------------------

test('65. NON_BILLABLE_FAILURE containing a complete execution identity is rejected', () => {
  const err = expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...nonBillable(),
        execution: { provider: 'fake-provider', model: 'fake-model' },
      }),
    'INVALID_FAILURE',
  );
  assert.ok(!err.message.includes('fake-provider'));
  assert.ok(!err.message.includes('fake-model'));
});

test('66. NON_BILLABLE_FAILURE containing a partial execution identity is rejected', () => {
  const err = expectContractError(
    () =>
      parseAIExecutionOutcome({
        ...nonBillable(),
        execution: { provider: 'fake-provider' },
      }),
    'INVALID_FAILURE',
  );
  assert.ok(!err.message.includes('fake-provider'));
});

test('67. Valid NON_BILLABLE_FAILURE without execution remains accepted', () => {
  const result = parseAIExecutionOutcome(nonBillable());
  assert.equal(result.kind, 'NON_BILLABLE_FAILURE');
  if (result.kind !== 'NON_BILLABLE_FAILURE') return;
  assert.equal(result.providerRequestSent, false);
  assert.equal(result.code, 'INPUT_REJECTED');
});

test('68. SUCCESS with missing data is rejected', () => {
  const { data: _omitted, ...rest } = validSuccess() as Record<string, unknown>;
  expectContractError(() => parseAIExecutionOutcome(rest), 'INVALID_SUCCESS');
});

test('69. SUCCESS with data undefined is rejected', () => {
  expectContractError(
    () => parseAIExecutionOutcome({ ...validSuccess(), data: undefined }),
    'INVALID_SUCCESS',
  );
});

test('70. SUCCESS with null data remains valid', () => {
  const result = parseAIExecutionOutcome({ ...validSuccess(), data: null });
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.equal(result.data, null);
});

test('71. SUCCESS with false, 0, or empty string data remains valid', () => {
  for (const data of [false, 0, '']) {
    const result = parseAIExecutionOutcome({ ...validSuccess(), data });
    assert.equal(result.kind, 'SUCCESS');
    if (result.kind !== 'SUCCESS') return;
    assert.equal(result.data, data);
  }
});

test('72. Request message content is preserved exactly', () => {
  const result = validateAIExecutionRequest({
    ...baseRequest(),
    input: { message: '  hello  ' },
  });
  assert.equal(result.input.message, '  hello  ');
});

test('73. Request context content is preserved exactly', () => {
  const result = validateAIExecutionRequest({
    ...baseRequest(),
    input: { message: 'hi', context: '  context  ' },
  });
  assert.equal(result.input.context, '  context  ');
});

test('74. Whitespace-only message is invalid', () => {
  expectContractError(
    () => validateAIExecutionRequest({ ...baseRequest(), input: { message: '   ' } }),
    'INVALID_REQUEST',
  );
});

test('75. Whitespace-only context is invalid', () => {
  expectContractError(
    () =>
      validateAIExecutionRequest({
        ...baseRequest(),
        input: { message: 'hi', context: '   ' },
      }),
    'INVALID_REQUEST',
  );
});

test('76. History message content is preserved exactly', () => {
  const result = validateAIExecutionRequest({
    ...baseRequest(),
    input: {
      message: 'hi',
      history: [{ role: 'user', content: '  padded  ' }],
    },
  });
  assert.equal(result.input.history?.[0].content, '  padded  ');
});

test('77. Content preservation does not mutate the input', () => {
  const raw = {
    ...baseRequest(),
    input: { message: '  hello  ', context: '  context  ' },
  };
  const snapshot = structuredClone(raw);
  validateAIExecutionRequest(raw);
  assert.deepEqual(raw, snapshot);
});

test('78. SUCCESS with a providerRequestSent field is rejected', () => {
  const err = expectContractError(
    () => parseAIExecutionOutcome({ ...validSuccess(), providerRequestSent: false }),
    'INVALID_SUCCESS',
  );
  assert.ok(!err.message.includes('fake-provider'));
});

test('79. SUCCESS with a retryable field is rejected', () => {
  expectContractError(
    () => parseAIExecutionOutcome({ ...validSuccess(), retryable: false }),
    'INVALID_SUCCESS',
  );
});

test('80. SUCCESS with a code field is rejected', () => {
  expectContractError(
    () => parseAIExecutionOutcome({ ...validSuccess(), code: 'SOMETHING' }),
    'INVALID_SUCCESS',
  );
});

test('81. INDETERMINATE_FAILURE keeps its optional execution identity', () => {
  const result = parseAIExecutionOutcome({
    ...indeterminate(),
    execution: { provider: 'fake-provider', model: 'fake-model' },
  });
  assert.equal(result.kind, 'INDETERMINATE_FAILURE');
  if (result.kind !== 'INDETERMINATE_FAILURE') return;
  assert.deepEqual(result.execution, { provider: 'fake-provider', model: 'fake-model' });
});

test('82. Unknown future success fields are stripped, not rejected', () => {
  const result = parseAIExecutionOutcome({
    ...validSuccess(),
    futureUnknownField: { deep: [1, 2] },
  });
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.equal('futureUnknownField' in result, false);
});

test('83. Harmless unknown field is stripped while contradictory recognized field is rejected', () => {
  const result = parseAIExecutionOutcome({ ...validSuccess(), futureUnknownField: 1 });
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') return;
  assert.equal('futureUnknownField' in result, false);

  expectContractError(
    () => parseAIExecutionOutcome({ ...validSuccess(), futureUnknownField: 1, code: 'X' }),
    'INVALID_SUCCESS',
  );
});
