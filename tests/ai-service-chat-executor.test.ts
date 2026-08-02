import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AIChatHistoryMessage } from '../src/types/ai.js';
import type { AIExecutionOutcome } from '../src/types/ai-execution.js';
import type { ChatExecutionData } from '../src/types/ai-service-execution.js';
import { executeAIServiceChat } from '../src/services/ai-service-chat-executor.js';

const BASE_URL = 'http://ai-service.test:3003';
const API_KEY = 'test-internal-api-key-with-at-least-32-chars';
const OP_ID = 'op-test-1';
const PROVIDER = 'fake-provider';
const MODEL = 'fake-model';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function makeFetch(handler: (url: string, init: RequestInit) => Promise<unknown>) {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const captured: CapturedRequest = { url: String(url), init: init ?? {} };
    calls.push(captured);
    return handler(captured.url, captured.init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status: number, text: string): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  };
}

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operationId: OP_ID,
    outcome: {
      kind: 'SUCCESS',
      data: { text: 'Luxor' },
      execution: { provider: PROVIDER, model: MODEL },
      usage: { provider: PROVIDER, model: MODEL, inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    },
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof executeAIServiceChat>[0]> = {}) {
  return {
    operationId: OP_ID,
    provider: PROVIDER,
    model: MODEL,
    message: 'Tell me about Luxor',
    transport: { baseUrl: BASE_URL, apiKey: API_KEY },
    ...overrides,
  };
}

function expectNonBillable(result: AIExecutionOutcome<ChatExecutionData>): {
  code: string;
  message: string;
} {
  assert.equal(result.kind, 'NON_BILLABLE_FAILURE');
  if (result.kind !== 'NON_BILLABLE_FAILURE') throw new Error('expected NON_BILLABLE_FAILURE');
  assert.equal(result.providerRequestSent, false);
  assert.equal(result.retryable, false);
  return { code: result.code, message: result.message };
}

function expectIndeterminate(result: AIExecutionOutcome<ChatExecutionData>): {
  code: string;
  message: string;
} {
  assert.equal(result.kind, 'INDETERMINATE_FAILURE');
  if (result.kind !== 'INDETERMINATE_FAILURE') throw new Error('expected INDETERMINATE_FAILURE');
  assert.equal(result.providerRequestSent, true);
  assert.equal(result.retryable, false);
  return { code: result.code, message: result.message };
}

function expectSuccess(result: AIExecutionOutcome<ChatExecutionData>) {
  assert.equal(result.kind, 'SUCCESS');
  if (result.kind !== 'SUCCESS') throw new Error('expected SUCCESS');
  return result;
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

test('1. Builds schemaVersion=1', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
  assert.equal(body.schemaVersion, 1);
});

test('2. Preserves operationId', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
  assert.equal(body.operationId, OP_ID);
});

test('3. Sends provider unchanged except allowed trimming', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ provider: '  fake-provider  ', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
  assert.equal(body.provider, 'fake-provider');
});

test('4. Sends model unchanged except allowed trimming', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ model: '  fake-model  ', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
  assert.equal(body.model, 'fake-model');
});

test('5. Sends the current message exactly once', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as { message: string };
  assert.equal(body.message, 'Tell me about Luxor');
});

test('6. Sends empty history when none is provided', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ history: undefined, transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as { history: unknown };
  assert.deepEqual(body.history, []);
});

test('7. Preserves history chronological order', async () => {
  const history: AIChatHistoryMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ];
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ history, transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as { history: AIChatHistoryMessage[] };
  assert.deepEqual(body.history, history);
});

test('8. Preserves user and assistant roles', async () => {
  const history: AIChatHistoryMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
  ];
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ history, transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as { history: AIChatHistoryMessage[] };
  assert.deepEqual(body.history.map((m) => m.role), ['user', 'assistant']);
});

test('9. Does not insert the current message into history', async () => {
  const history: AIChatHistoryMessage[] = [{ role: 'user', content: 'older message' }];
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ history, transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as { message: string; history: AIChatHistoryMessage[] };
  assert.equal(body.message, 'Tell me about Luxor');
  assert.deepEqual(body.history, history);
  assert.ok(!body.history.some((m) => m.content === body.message));
});

test('10. Supports optional conversationSummary', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ conversationSummary: 'summary so far', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
  assert.equal(body.conversationSummary, 'summary so far');
});

test('11. Does not mutate the caller input', async () => {
  const history: AIChatHistoryMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
  ];
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const input = baseInput({ history, conversationSummary: 'sum', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } });
  const snapshot = structuredClone({
    operationId: input.operationId,
    provider: input.provider,
    model: input.model,
    message: input.message,
    history: input.history,
    conversationSummary: input.conversationSummary,
  });
  await executeAIServiceChat(input);
  assert.equal(input.operationId, snapshot.operationId);
  assert.equal(input.provider, snapshot.provider);
  assert.equal(input.model, snapshot.model);
  assert.equal(input.message, snapshot.message);
  assert.deepEqual(input.history, snapshot.history);
  assert.equal(input.conversationSummary, snapshot.conversationSummary);
});

test('12. Does not send userId, walletId, reservationId, balances, pricing, or API keys', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
  const forbidden = [
    'userId', 'walletId', 'reservationId', 'tokenBalance', 'reservedBalance',
    'rateCard', 'price', 'markup', 'providerCost', 'walletTokens', 'cost',
    'apiKey', 'API_KEY', 'internalApiKey',
  ];
  for (const key of forbidden) {
    assert.ok(!(key in body), `request must not contain ${key}`);
  }
  const allowed = new Set(['schemaVersion', 'operationId', 'provider', 'model', 'message', 'history', 'conversationSummary']);
  for (const key of Object.keys(body)) {
    assert.ok(allowed.has(key), `request contains unexpected key ${key}`);
  }
});

test('13. Empty history sent as empty array and does not add current message', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ history: [], transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const body = JSON.parse(calls[0].init.body as string) as { message: string; history: AIChatHistoryMessage[] };
  assert.deepEqual(body.history, []);
  assert.equal(body.message, 'Tell me about Luxor');
});

// ---------------------------------------------------------------------------
// Local validation (pre-dispatch)
// ---------------------------------------------------------------------------

test('14. Blank operationId returns NON_BILLABLE_FAILURE', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ operationId: '   ', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const failure = expectNonBillable(result);
  assert.equal(failure.code, 'INVALID_OPERATION_ID');
  assert.equal(calls.length, 0);
});

test('15. Blank provider returns NON_BILLABLE_FAILURE', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ provider: '   ', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const failure = expectNonBillable(result);
  assert.equal(failure.code, 'INVALID_PROVIDER');
  assert.equal(calls.length, 0);
});

test('16. Blank model returns NON_BILLABLE_FAILURE', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ model: '   ', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const failure = expectNonBillable(result);
  assert.equal(failure.code, 'INVALID_MODEL');
  assert.equal(calls.length, 0);
});

test('17. Blank message returns NON_BILLABLE_FAILURE', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ message: '   ', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const failure = expectNonBillable(result);
  assert.equal(failure.code, 'INVALID_MESSAGE');
  assert.equal(calls.length, 0);
});

test('18. Invalid history role returns NON_BILLABLE_FAILURE', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const badHistory = [{ role: 'system', content: 'nope' }] as unknown as AIChatHistoryMessage[];
  const result = await executeAIServiceChat(baseInput({ history: badHistory, transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const failure = expectNonBillable(result);
  assert.equal(failure.code, 'INVALID_HISTORY_ROLE');
  assert.equal(calls.length, 0);
});

test('19. Blank history content returns NON_BILLABLE_FAILURE', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const badHistory = [{ role: 'user', content: '   ' }] as unknown as AIChatHistoryMessage[];
  const result = await executeAIServiceChat(baseInput({ history: badHistory, transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const failure = expectNonBillable(result);
  assert.equal(failure.code, 'INVALID_HISTORY_CONTENT');
  assert.equal(calls.length, 0);
});

test('20. Missing required local configuration returns NON_BILLABLE_FAILURE', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: '', fetchImpl } }),
  );
  const failure = expectNonBillable(result);
  assert.equal(failure.code, 'MISSING_INTERNAL_API_KEY');
  assert.equal(calls.length, 0);
});

test('21. Fetch is never called after local validation failure', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ operationId: '', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  assert.equal(calls.length, 0);
});

test('22. Local failure messages do not expose configuration values', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(
    baseInput({ operationId: '   ', transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectNonBillable(result);
  assert.ok(!failure.message.includes(BASE_URL));
  assert.ok(!failure.message.includes(API_KEY));
  assert.ok(!failure.message.includes('SECRET_OP_ID'));
});

// ---------------------------------------------------------------------------
// Transport behavior
// ---------------------------------------------------------------------------

test('23. Uses POST, application/json, X-Internal-Api-Key, configured URL and endpoint', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers && (init.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal(init.headers && (init.headers as Record<string, string>)['X-Internal-Api-Key'], API_KEY);
  assert.ok(url.startsWith(BASE_URL));
  assert.ok(url.endsWith('/v1/execute/chat'));
});

test('24. Performs exactly one fetch attempt with no automatic retry', async () => {
  let attempts = 0;
  const { fetchImpl, calls } = makeFetch(async () => {
    attempts += 1;
    return jsonResponse(500, { error: 'boom' });
  });
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  expectIndeterminate(result);
  assert.equal(attempts, 1);
  assert.equal(calls.length, 1);
});

test('25. Does not contact a real external service (injected fetch only)', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(BASE_URL));
});

// ---------------------------------------------------------------------------
// Successful canonical response
// ---------------------------------------------------------------------------

test('26. Valid schemaVersion is accepted', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  expectSuccess(result);
});

test('27. Matching operationId is accepted', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  expectSuccess(result);
});

test('28. Valid SUCCESS passes through parseAIExecutionOutcome()', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  expectSuccess(result);
});

test('29. Success data is preserved', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const success = expectSuccess(result);
  assert.deepEqual(success.data, { text: 'Luxor' });
});

test('30. Execution identity is preserved', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const success = expectSuccess(result);
  assert.deepEqual(success.execution, { provider: PROVIDER, model: MODEL });
});

test('31. Usage is preserved', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const success = expectSuccess(result);
  assert.deepEqual(success.usage, { provider: PROVIDER, model: MODEL, inputTokens: 10, outputTokens: 20, totalTokens: 30 });
});

test('32. Optional providerRequestId remains optional', async () => {
  const withRequestId = validEnvelope();
  (withRequestId.outcome as Record<string, unknown>).execution = {
    provider: PROVIDER, model: MODEL, providerRequestId: 'req-abc',
  };
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, withRequestId));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const success = expectSuccess(result);
  assert.equal(success.execution.providerRequestId, 'req-abc');
});

test('33. operationId is not inserted into outcome.data', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const success = expectSuccess(result);
  assert.ok(!('operationId' in (success.data as Record<string, unknown>)));
  assert.ok(!('schemaVersion' in (success.data as Record<string, unknown>)));
});

test('34. Envelope fields are not added to usage or execution evidence', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  const success = expectSuccess(result);
  assert.ok(!('operationId' in success.usage));
  assert.ok(!('schemaVersion' in success.usage));
  assert.ok(!('operationId' in success.execution));
  assert.ok(!('schemaVersion' in success.execution));
});

// ---------------------------------------------------------------------------
// Canonical failures
// ---------------------------------------------------------------------------

test('35. Valid NON_BILLABLE_FAILURE is preserved', async () => {
  const envelope = validEnvelope({
    outcome: {
      kind: 'NON_BILLABLE_FAILURE',
      code: 'INPUT_REJECTED',
      message: 'blocked by guardrails',
      providerRequestSent: false,
      retryable: false,
    },
  });
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  assert.equal(result.kind, 'NON_BILLABLE_FAILURE');
  if (result.kind !== 'NON_BILLABLE_FAILURE') return;
  assert.equal(result.code, 'INPUT_REJECTED');
  assert.equal(result.message, 'blocked by guardrails');
  assert.equal(result.providerRequestSent, false);
  assert.equal(result.retryable, false);
});

test('36. Valid INDETERMINATE_FAILURE is preserved', async () => {
  const envelope = validEnvelope({
    outcome: {
      kind: 'INDETERMINATE_FAILURE',
      code: 'TIMEOUT',
      message: 'provider timeout',
      providerRequestSent: true,
      retryable: true,
      execution: { provider: PROVIDER },
    },
  });
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }));
  assert.equal(result.kind, 'INDETERMINATE_FAILURE');
  if (result.kind !== 'INDETERMINATE_FAILURE') return;
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.message, 'provider timeout');
  assert.equal(result.providerRequestSent, true);
  assert.equal(result.retryable, true);
  assert.deepEqual(result.execution, { provider: PROVIDER });
});

// ---------------------------------------------------------------------------
// Ambiguous failures (post-dispatch)
// ---------------------------------------------------------------------------

test('37. Timeout returns INDETERMINATE_FAILURE', async () => {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as typeof fetch;
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl, timeoutMs: 10 } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'TIMEOUT');
});

test('38. Abort returns INDETERMINATE_FAILURE', async () => {
  const fetchImpl = (async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }) as typeof fetch;
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'ABORTED');
});

test('39. Fetch rejection returns INDETERMINATE_FAILURE', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:9');
  }) as typeof fetch;
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'FETCH_REJECTED');
  assert.ok(!failure.message.includes('ECONNREFUSED'));
});

test('40. Invalid JSON returns INDETERMINATE_FAILURE', async () => {
  const { fetchImpl } = makeFetch(async () => textResponse(200, '{nope'));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_RESPONSE_JSON');
});

test('41. Wrong schemaVersion returns INDETERMINATE_FAILURE', async () => {
  const envelope = validEnvelope({ schemaVersion: 2 });
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_SCHEMA_VERSION');
});

test('42. Missing operationId returns INDETERMINATE_FAILURE', async () => {
  const envelope = validEnvelope();
  delete envelope.operationId;
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'MISSING_OPERATION_ID');
});

test('43. Mismatching operationId returns INDETERMINATE_FAILURE', async () => {
  const envelope = validEnvelope({ operationId: 'op-different' });
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'OPERATION_ID_MISMATCH');
});

test('44. Missing outcome returns INDETERMINATE_FAILURE', async () => {
  const envelope = validEnvelope();
  delete envelope.outcome;
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'MISSING_OUTCOME');
});

test('45. Malformed outcome returns INDETERMINATE_FAILURE', async () => {
  const envelope = validEnvelope({ outcome: { kind: 'FAILED' } });
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_OUTCOME');
});

test('46. SUCCESS missing usage returns INDETERMINATE_FAILURE', async () => {
  const envelope = validEnvelope();
  const outcome = envelope.outcome as Record<string, unknown>;
  delete outcome.usage;
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_OUTCOME');
});

test('47. Non-canonical non-2xx response returns INDETERMINATE_FAILURE', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(500, { error: 'internal' }));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.ok(
    ['INVALID_RESPONSE_ENVELOPE', 'INVALID_SCHEMA_VERSION'].includes(failure.code),
    `unexpected code ${failure.code}`,
  );
});

test('48. No ambiguous failure causes a retry', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    throw new Error('boom');
  }) as typeof fetch;
  await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  assert.equal(attempts, 1);
});

test('49. No raw transport error is returned', async () => {
  const fetchImpl = (async () => {
    throw new Error('CONNECTION_RESET_RAW_DETAIL');
  }) as typeof fetch;
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.ok(!failure.message.includes('CONNECTION_RESET_RAW_DETAIL'));
});

// ---------------------------------------------------------------------------
// Architecture separation
// ---------------------------------------------------------------------------

const executorSource = readFileSync(
  new URL('../src/services/ai-service-chat-executor.ts', import.meta.url),
  'utf8',
);
const contractSource = readFileSync(
  new URL('../src/utils/ai-execution-contract.ts', import.meta.url),
  'utf8',
);
const usageSource = readFileSync(
  new URL('../src/utils/ai-usage.ts', import.meta.url),
  'utf8',
);
const clientSource = readFileSync(
  new URL('../src/clients/ai-service-execution.client.ts', import.meta.url),
  'utf8',
);
const chatServiceSource = readFileSync(
  new URL('../src/services/chat.service.ts', import.meta.url),
  'utf8',
);

test('50. Existing parseAIExecutionOutcome() is reused', () => {
  assert.ok(executorSource.includes('parseAIExecutionOutcome'));
  assert.ok(executorSource.includes("from '../utils/ai-execution-contract.js'"));
});

test('51. No second AIExecutionOutcome union is created', () => {
  assert.ok(!executorSource.includes("kind: 'SUCCESS' |"));
  assert.ok(!executorSource.includes('AIExecutionOutcome =\n'));
  assert.ok(executorSource.includes("from '../types/ai-execution.js'"));
});

test('52. No second provider-usage normalizer is created', () => {
  assert.ok(!executorSource.includes('normalizeAIProviderUsage'));
  assert.ok(!clientSource.includes('normalizeAIProviderUsage'));
});

test('53. Executor performs no Prisma access', () => {
  assert.ok(!executorSource.includes('@prisma/client'));
  assert.ok(!executorSource.includes('prisma.'));
});

test('54. Executor performs no Wallet arithmetic', () => {
  assert.ok(!executorSource.includes('reserveBusinessToken'));
  assert.ok(!executorSource.includes('settleBusinessToken'));
  assert.ok(!executorSource.includes('releaseBusinessToken'));
  assert.ok(!executorSource.includes('tokenWallet'));
});

test('55. No token transaction is created', () => {
  assert.ok(!executorSource.includes('tokenTransaction'));
  assert.ok(!executorSource.includes('consumeTransaction'));
});

test('56. No Billing Orchestrator call exists', () => {
  assert.ok(!executorSource.includes('runAIBillingOrchestration'));
  assert.ok(!executorSource.includes('ai-billing-orchestrator'));
});

test('57. No live Chat integration exists', () => {
  assert.ok(!chatServiceSource.includes('ai-service-chat-executor'));
  assert.ok(!chatServiceSource.includes('executeAIServiceChat'));
});

test('58. No Streaming integration exists', () => {
  assert.ok(!executorSource.includes('node:stream/web'));
  assert.ok(!executorSource.includes('ReadableStream'));
  assert.ok(!executorSource.includes('SSE'));
});

test('59. No Image or Voice integration exists', () => {
  assert.ok(!executorSource.includes('identify'));
  assert.ok(!executorSource.includes('voice'));
});

test('60. No Python AI Service file is modified (no python reference)', () => {
  assert.ok(!executorSource.includes('.py'));
  assert.ok(!clientSource.includes('.py'));
  assert.ok(!executorSource.includes('ai-service/app'));
});

test('61. package.json remains untouched (no new import of it)', () => {
  assert.ok(!executorSource.includes('package.json'));
  assert.ok(!clientSource.includes('package.json'));
});

test('62. scripts/ remains untouched', () => {
  assert.ok(!executorSource.includes('scripts/'));
  assert.ok(!clientSource.includes('scripts/'));
});

test('63. Contract and usage parsers remain authoritative and untouched', () => {
  assert.ok(contractSource.includes('parseAIExecutionOutcome'));
  assert.ok(usageSource.includes('normalizeAIProviderUsage'));
});

test('64. Executor calls the isolated transport client', () => {
  assert.ok(executorSource.includes('sendAIExecutionRequest'));
  assert.ok(executorSource.includes("from '../clients/ai-service-execution.client.js'"));
});

test('65. Executor validates the response envelope before parsing', () => {
  assert.ok(executorSource.includes('schemaVersion'));
  assert.ok(executorSource.includes('OPERATION_ID_MISMATCH'));
  assert.ok(executorSource.includes('MISSING_OUTCOME'));
});

// ---------------------------------------------------------------------------
// Exact operationId matching (Correction 1)
// ---------------------------------------------------------------------------

test('66. Request-side operationId trimming is preserved while response matching is strict', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(
    baseInput({ operationId: `  ${OP_ID}  `, transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  expectSuccess(result);
});

test('67. Response operationId with surrounding whitespace is OPERATION_ID_MISMATCH', async () => {
  const envelope = validEnvelope({ operationId: `  ${OP_ID}  ` });
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'OPERATION_ID_MISMATCH');
});

test('68. Response operationId with a different case is OPERATION_ID_MISMATCH', async () => {
  const envelope = validEnvelope({ operationId: OP_ID.toUpperCase() });
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'OPERATION_ID_MISMATCH');
});

test('69. Response operationId that is whitespace only is MISSING_OPERATION_ID', async () => {
  const envelope = validEnvelope({ operationId: '   ' });
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'MISSING_OPERATION_ID');
});

// ---------------------------------------------------------------------------
// Chat SUCCESS data validation (Correction 3)
// ---------------------------------------------------------------------------

test('70. SUCCESS data that is null returns INVALID_CHAT_SUCCESS_DATA', async () => {
  const envelope = validEnvelope();
  (envelope.outcome as Record<string, unknown>).data = null;
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_CHAT_SUCCESS_DATA');
});

test('71. SUCCESS data that is an array returns INVALID_CHAT_SUCCESS_DATA', async () => {
  const envelope = validEnvelope();
  (envelope.outcome as Record<string, unknown>).data = [];
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_CHAT_SUCCESS_DATA');
});

test('72. SUCCESS data without text returns INVALID_CHAT_SUCCESS_DATA', async () => {
  const envelope = validEnvelope();
  (envelope.outcome as Record<string, unknown>).data = {};
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_CHAT_SUCCESS_DATA');
});

test('73. SUCCESS data with non-string text returns INVALID_CHAT_SUCCESS_DATA', async () => {
  const envelope = validEnvelope();
  (envelope.outcome as Record<string, unknown>).data = { text: 42 };
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_CHAT_SUCCESS_DATA');
});

test('74. SUCCESS data with blank text returns INVALID_CHAT_SUCCESS_DATA', async () => {
  const envelope = validEnvelope();
  (envelope.outcome as Record<string, unknown>).data = { text: '   ' };
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_CHAT_SUCCESS_DATA');
});

test('75. Success text is preserved unchanged without trimming', async () => {
  const envelope = validEnvelope();
  (envelope.outcome as Record<string, unknown>).data = { text: '  Aswan  ' };
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const success = expectSuccess(result);
  assert.deepEqual(success.data, { text: '  Aswan  ' });
});

// ---------------------------------------------------------------------------
// HTTP status / outcome consistency (Correction 4)
// ---------------------------------------------------------------------------

test('76. HTTP 500 plus SUCCESS returns HTTP_STATUS_OUTCOME_CONFLICT with partial identity', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(500, validEnvelope()));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  assert.equal(result.kind, 'INDETERMINATE_FAILURE');
  if (result.kind !== 'INDETERMINATE_FAILURE') return;
  assert.equal(result.code, 'HTTP_STATUS_OUTCOME_CONFLICT');
  assert.equal(result.providerRequestSent, true);
  assert.equal(result.retryable, false);
  assert.deepEqual(result.execution, { provider: PROVIDER, model: MODEL });
});

test('77. HTTP 400 plus valid NON_BILLABLE_FAILURE is preserved', async () => {
  const envelope = validEnvelope({
    outcome: {
      kind: 'NON_BILLABLE_FAILURE',
      code: 'INPUT_REJECTED',
      message: 'blocked by guardrails',
      providerRequestSent: false,
      retryable: false,
    },
  });
  const { fetchImpl } = makeFetch(async () => jsonResponse(400, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  assert.equal(result.kind, 'NON_BILLABLE_FAILURE');
  if (result.kind !== 'NON_BILLABLE_FAILURE') return;
  assert.equal(result.code, 'INPUT_REJECTED');
  assert.equal(result.providerRequestSent, false);
});

test('78. HTTP 429 plus valid INDETERMINATE_FAILURE is preserved', async () => {
  const envelope = validEnvelope({
    outcome: {
      kind: 'INDETERMINATE_FAILURE',
      code: 'RATE_LIMITED',
      message: 'provider rate limited',
      providerRequestSent: true,
      retryable: true,
      execution: { provider: PROVIDER },
    },
  });
  const { fetchImpl } = makeFetch(async () => jsonResponse(429, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  assert.equal(result.kind, 'INDETERMINATE_FAILURE');
  if (result.kind !== 'INDETERMINATE_FAILURE') return;
  assert.equal(result.code, 'RATE_LIMITED');
  assert.equal(result.providerRequestSent, true);
  assert.equal(result.retryable, true);
});

test('79. HTTP 500 plus malformed outcome keeps existing outcome code', async () => {
  const envelope = validEnvelope({ outcome: { kind: 'FAILED' } });
  const { fetchImpl } = makeFetch(async () => jsonResponse(500, envelope));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'INVALID_OUTCOME');
});

test('80. HTTP 201 plus SUCCESS is accepted', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(201, validEnvelope()));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  expectSuccess(result);
});

test('81. HTTP 204 is a 2xx status, so SUCCESS is accepted', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(204, validEnvelope()));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  expectSuccess(result);
});

test('82. HTTP 502 plus SUCCESS returns HTTP_STATUS_OUTCOME_CONFLICT', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(502, validEnvelope()));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl } }),
  );
  const failure = expectIndeterminate(result);
  assert.equal(failure.code, 'HTTP_STATUS_OUTCOME_CONFLICT');
});

// ---------------------------------------------------------------------------
// Timeout validation via the thin executor (Correction 2)
// ---------------------------------------------------------------------------

test('83. Invalid timeout becomes NON_BILLABLE_FAILURE in the thin executor; fetch is never called', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, validEnvelope()));
  const result = await executeAIServiceChat(
    baseInput({ transport: { baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 0, fetchImpl } }),
  );
  const failure = expectNonBillable(result);
  assert.equal(failure.code, 'INVALID_TIMEOUT');
  assert.equal(calls.length, 0);
});
