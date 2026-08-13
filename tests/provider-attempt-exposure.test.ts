import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProviderAttemptExposure } from '../src/utils/provider-attempt-exposure.js';

const attempt = (overrides: Record<string, unknown>) => ({
  attemptId: 'attempt-1', provider: 'google', attemptNumber: 1, outcome: 'SUCCEEDED',
  providerCallStarted: true, providerCallStartedAt: '2026-08-13T00:00:00.000Z',
  providerCompletedAt: '2026-08-13T00:00:01.000Z', providerResponseReceived: true,
  usageConfirmed: true, ...overrides,
});

test('timeout followed by confirmed retry records exposure but only the retry usage is confirmable', () => {
  const result = summarizeProviderAttemptExposure([
    attempt({ outcome: 'INDETERMINATE', providerResponseReceived: false, usageConfirmed: false, errorCategory: 'TIMEOUT' }),
    attempt({ attemptId: 'attempt-2', attemptNumber: 2, providerCallId: 'call-1' }),
  ]);
  assert.ok(result);
  assert.equal(result.totalAttempts, 2);
  assert.equal(result.successfulAttempts, 1);
  assert.equal(result.retryCount, 1);
  assert.equal(result.timeoutCount, 1);
  assert.equal(result.indeterminateAttempts, 1);
  assert.equal(result.hasIndeterminateCostExposure, true);
  assert.equal(result.attempts[0].usageConfirmed, false);
  assert.equal(result.attempts[1].usageConfirmed, true);
});

test('rate limit and provider 5xx remain observable without a fabricated cost', () => {
  const result = summarizeProviderAttemptExposure([
    attempt({ outcome: 'INDETERMINATE', providerResponseReceived: false, usageConfirmed: false, errorCategory: 'RATE_LIMIT', httpStatus: 429 }),
    attempt({ attemptId: 'attempt-2', attemptNumber: 2, outcome: 'INDETERMINATE', providerResponseReceived: false, usageConfirmed: false, errorCategory: 'SERVER_ERROR', httpStatus: 503 }),
  ]);
  assert.ok(result);
  assert.equal(result.rateLimitCount, 1);
  assert.equal(result.providerErrorCount, 1);
  assert.equal(result.successfulAttempts, 0);
  assert.equal(result.indeterminateAttempts, 2);
});

test('malformed attempt entries are discarded rather than manufacturing exposure', () => {
  const result = summarizeProviderAttemptExposure([{ attemptId: 'bad' }]);
  assert.ok(result);
  assert.equal(result.totalAttempts, 0);
});
