import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AI_SERVICE_EXECUTION_DEFAULT_TIMEOUT_MS,
  AI_SERVICE_EXECUTION_ENDPOINT,
  sendAIExecutionRequest,
  type AIExecutionTransportResult,
} from '../src/clients/ai-service-execution.client.js';

const BASE_URL = 'http://ai-service.test:3003';
const API_KEY = 'test-internal-api-key-with-at-least-32-chars';

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

function expectSuccess(result: AIExecutionTransportResult): { httpStatus: number; body: unknown } {
  assert.equal(result.status, 'SUCCESS');
  if (result.status !== 'SUCCESS') throw new Error('expected SUCCESS');
  return { httpStatus: result.httpStatus, body: result.body };
}

function expectFailure(result: AIExecutionTransportResult): {
  code: string;
  message: string;
  providerRequestSent: boolean;
} {
  assert.equal(result.status, 'FAILURE');
  if (result.status !== 'FAILURE') throw new Error('expected FAILURE');
  return { code: result.code, message: result.message, providerRequestSent: result.providerRequestSent };
}

// ---------------------------------------------------------------------------
// Request construction / transport behavior
// ---------------------------------------------------------------------------

test('1. Uses POST with application/json and X-Internal-Api-Key', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  const result = await sendAIExecutionRequest(
    { hello: 'world' },
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl },
  );
  expectSuccess(result);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers && (init.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal(init.headers && (init.headers as Record<string, string>)['X-Internal-Api-Key'], API_KEY);
  assert.equal(url, `${BASE_URL}${AI_SERVICE_EXECUTION_ENDPOINT}`);
});

test('2. Sends the serialized request body', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  const body = { schemaVersion: 1, message: 'hello' };
  await sendAIExecutionRequest(body, { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl });
  assert.equal(calls[0].init.body, JSON.stringify(body));
});

test('3. Uses the default endpoint path', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  await sendAIExecutionRequest({}, { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl });
  assert.ok(calls[0].url.endsWith(AI_SERVICE_EXECUTION_ENDPOINT));
});

test('4. Allows an injected endpoint path', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, endpointPath: '/custom/execute', fetchImpl },
  );
  assert.ok(calls[0].url.endsWith('/custom/execute'));
});

test('5. Normalizes trailing slashes on the base URL', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  await sendAIExecutionRequest({}, { baseUrl: 'http://ai-service.test:3003/', apiKey: API_KEY, fetchImpl });
  assert.ok(calls[0].url.endsWith(`${AI_SERVICE_EXECUTION_ENDPOINT}`));
  assert.equal(calls[0].url, `${BASE_URL}${AI_SERVICE_EXECUTION_ENDPOINT}`);
});

test('6. Applies a finite timeout via AbortController signal', async () => {
  let capturedSignal: AbortSignal | undefined;
  const { fetchImpl, calls } = makeFetch(async (_url, init) => {
    capturedSignal = init.signal;
    return jsonResponse(200, { ok: true });
  });
  await sendAIExecutionRequest({}, { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl });
  assert.ok(capturedSignal instanceof AbortSignal);
  assert.ok(AI_SERVICE_EXECUTION_DEFAULT_TIMEOUT_MS > 0);
  assert.ok(Number.isFinite(AI_SERVICE_EXECUTION_DEFAULT_TIMEOUT_MS));
  assert.equal(calls.length, 1);
});

test('7. Timeout aborts the request and returns a FAILURE result', async () => {
  let abortCount = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const signal = init.signal;
    signal.addEventListener('abort', () => {
      abortCount += 1;
    });
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as typeof fetch;
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl, timeoutMs: 10 },
  );
  const failure = expectFailure(result);
  assert.equal(failure.code, 'TIMEOUT');
  assert.equal(failure.providerRequestSent, true);
  assert.ok(abortCount >= 1);
});

test('8. Abort from the signal (non-timeout) is reported as ABORTED', async () => {
  const fetchImpl = (async (_url: string, _init: RequestInit) => {
    const err = new Error('aborted externally');
    err.name = 'AbortError';
    throw err;
  }) as typeof fetch;
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl },
  );
  const failure = expectFailure(result);
  assert.equal(failure.code, 'ABORTED');
  assert.equal(failure.providerRequestSent, true);
});

test('9. Fetch rejection is reported as FETCH_REJECTED without raw details', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED connect 10.0.0.1:9999');
  }) as typeof fetch;
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl },
  );
  const failure = expectFailure(result);
  assert.equal(failure.code, 'FETCH_REJECTED');
  assert.equal(failure.providerRequestSent, true);
  assert.ok(!failure.message.includes('ECONNREFUSED'));
  assert.ok(!failure.message.includes('10.0.0.1'));
});

test('10. Invalid JSON response is reported as INVALID_RESPONSE_JSON', async () => {
  const { fetchImpl } = makeFetch(async () => textResponse(200, '{not json'));
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl },
  );
  const failure = expectFailure(result);
  assert.equal(failure.code, 'INVALID_RESPONSE_JSON');
  assert.equal(failure.providerRequestSent, true);
});

test('11. Non-2xx HTTP response still returns a SUCCESS result with httpStatus', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(500, { error: 'boom' }));
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl },
  );
  const success = expectSuccess(result);
  assert.equal(success.httpStatus, 500);
  assert.deepEqual(success.body, { error: 'boom' });
});

test('12. Invalid base URL is a pre-dispatch failure; fetch is not invoked', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: 'not-a-url', apiKey: API_KEY, fetchImpl },
  );
  const failure = expectFailure(result);
  assert.equal(failure.code, 'INVALID_BASE_URL');
  assert.equal(failure.providerRequestSent, false);
  assert.equal(calls.length, 0);
});

test('13. Missing internal API key is a pre-dispatch failure; fetch is not invoked', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: '   ', fetchImpl },
  );
  const failure = expectFailure(result);
  assert.equal(failure.code, 'MISSING_INTERNAL_API_KEY');
  assert.equal(failure.providerRequestSent, false);
  assert.equal(calls.length, 0);
});

test('14. Unserializable body is a pre-dispatch failure; fetch is not invoked', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  const result = await sendAIExecutionRequest(
    circular,
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl },
  );
  const failure = expectFailure(result);
  assert.equal(failure.code, 'REQUEST_SERIALIZATION_FAILED');
  assert.equal(failure.providerRequestSent, false);
  assert.equal(calls.length, 0);
});

test('15. Performs exactly one fetch attempt and never retries', async () => {
  let attempt = 0;
  const { fetchImpl, calls } = makeFetch(async () => {
    attempt += 1;
    return jsonResponse(500, { error: 'boom' });
  });
  await sendAIExecutionRequest({}, { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl });
  assert.equal(attempt, 1);
  assert.equal(calls.length, 1);
});

test('16. Never logs or returns the API key or message content', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, { ok: true }));
  const result = await sendAIExecutionRequest(
    { message: 'SECRET_MESSAGE_CONTENT', operationId: 'SECRET_OP' },
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl },
  );
  const json = JSON.stringify(result);
  assert.ok(!json.includes(API_KEY));
  assert.ok(!json.includes('SECRET_MESSAGE_CONTENT'));
  assert.ok(!json.includes('SECRET_OP'));
});

test('17. Returns the parsed response body as unknown JSON', async () => {
  const payload = { schemaVersion: 1, operationId: 'op-1', outcome: { kind: 'SUCCESS' } };
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, payload));
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl },
  );
  const success = expectSuccess(result);
  assert.deepEqual(success.body, payload);
});

// ---------------------------------------------------------------------------
// Separation
// ---------------------------------------------------------------------------

const clientSource = readFileSync(
  new URL('../src/clients/ai-service-execution.client.ts', import.meta.url),
  'utf8',
);

test('18. Transport client does not parse AI execution outcomes', () => {
  assert.ok(!clientSource.includes('parseAIExecutionOutcome'));
  assert.ok(!clientSource.includes('kind ==='));
});

test('19. Transport client does not access Prisma or the Wallet', () => {
  assert.ok(!clientSource.includes('@prisma/client'));
  assert.ok(!clientSource.includes('prisma.'));
  assert.ok(!clientSource.includes('reserveBusinessToken'));
  assert.ok(!clientSource.includes('settleBusinessToken'));
  assert.ok(!clientSource.includes('releaseBusinessToken'));
});

test('20. Transport client performs no pricing', () => {
  assert.ok(!clientSource.includes('calculateAIUsagePrice'));
  assert.ok(!clientSource.includes('rateCard'));
  assert.ok(!clientSource.includes('costMicros'));
  assert.ok(!clientSource.includes('walletTokenValueMicros'));
});

test('21. Transport client contains no retry loop', () => {
  assert.ok(!clientSource.includes('for ('));
  assert.ok(!clientSource.includes('while ('));
  assert.ok(!clientSource.includes('MAX_RETRIES'));
  assert.ok(!clientSource.includes('retry'));
});

test('22. Transport client contains no logging statements', () => {
  assert.ok(!clientSource.includes('console.log'));
  assert.ok(!clientSource.includes('console.error'));
  assert.ok(!clientSource.includes('console.warn'));
});

// ---------------------------------------------------------------------------
// Timeout validation
// ---------------------------------------------------------------------------

test('23. Invalid timeout value is a pre-dispatch failure; fetch is not invoked', async () => {
  const invalidTimeouts = [0, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const timeoutMs of invalidTimeouts) {
    const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
    const result = await sendAIExecutionRequest(
      {},
      { baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs, fetchImpl },
    );
    const failure = expectFailure(result);
    assert.equal(failure.code, 'INVALID_TIMEOUT');
    assert.equal(failure.providerRequestSent, false);
    assert.equal(calls.length, 0);
  }
});

test('24. Undefined timeout falls back to the default and still dispatches', async () => {
  const { fetchImpl, calls } = makeFetch(async () => jsonResponse(200, { ok: true }));
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: undefined, fetchImpl },
  );
  expectSuccess(result);
  assert.equal(calls.length, 1);
});

test('25. A valid positive integer timeout is accepted and applied', async () => {
  let capturedSignal: AbortSignal | undefined;
  const { fetchImpl, calls } = makeFetch(async (_url, init) => {
    capturedSignal = init.signal;
    return jsonResponse(200, { ok: true });
  });
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 2500, fetchImpl },
  );
  expectSuccess(result);
  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(calls.length, 1);
});

test('26. Invalid timeout message does not expose raw values', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(200, { ok: true }));
  const result = await sendAIExecutionRequest(
    {},
    { baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: -999, fetchImpl },
  );
  const failure = expectFailure(result);
  assert.equal(failure.code, 'INVALID_TIMEOUT');
  assert.ok(!failure.message.includes('-999'));
});
