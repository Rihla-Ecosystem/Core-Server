import { normalizeProviderAttempts } from './ai-usage.js';

type ProviderAttempt = NonNullable<ReturnType<typeof normalizeProviderAttempts>>[number];

/** JSON-safe evidence only. It is never input to provider pricing or Wallet settlement. */
export interface ProviderAttemptExposure {
  totalAttempts: number;
  successfulAttempts: number;
  retryCount: number;
  timeoutCount: number;
  rateLimitCount: number;
  providerErrorCount: number;
  indeterminateAttempts: number;
  hasIndeterminateCostExposure: boolean;
  attempts: ProviderAttempt[];
}

export function summarizeProviderAttemptExposure(raw: unknown): ProviderAttemptExposure | undefined {
  const normalizedAttempts = normalizeProviderAttempts(raw);
  if (normalizedAttempts === undefined) return undefined;
  const attempts: ProviderAttempt[] = normalizedAttempts ?? [];
  const count = (predicate: (attempt: ProviderAttempt) => boolean) => attempts.filter(predicate).length;
  const indeterminateAttempts = count((attempt) => attempt.outcome === 'INDETERMINATE');
  return {
    totalAttempts: attempts.length,
    successfulAttempts: count((attempt) => attempt.outcome === 'SUCCEEDED'),
    retryCount: count((attempt) => attempt.attemptNumber > 1),
    timeoutCount: count((attempt) => attempt.errorCategory === 'TIMEOUT'),
    rateLimitCount: count((attempt) => attempt.errorCategory === 'RATE_LIMIT'),
    providerErrorCount: count((attempt) => attempt.errorCategory === 'SERVER_ERROR'),
    indeterminateAttempts,
    hasIndeterminateCostExposure: indeterminateAttempts > 0,
    attempts,
  };
}
