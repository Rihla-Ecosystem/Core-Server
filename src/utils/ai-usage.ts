import type {
  AIProviderUsage,
  AttemptRiskStatus,
  ProviderAttempt,
  ProviderAttemptOutcome,
  ProviderCallUsage,
  RawAIProviderUsage,
  RawProviderAttempt,
  RawProviderCall,
} from '../types/ai.js';

const PROVIDER_CALL_TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cachedOutputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens',
  'imageInputTokens',
  'imageOutputTokens',
  'audioInputTokens',
  'audioOutputTokens',
  'cachedAudioInputTokens',
  'cachedAudioOutputTokens',
  'audioInputSeconds',
  'audioOutputSeconds',
  'transcriptionSeconds',
  'inputCharacters',
  'outputCharacters',
  'generatedImageCount',
] as const;

interface FieldRead {
  present: boolean;
  value: unknown;
}

/**
 * Pure adapter that normalizes an arbitrary AI provider usage object into the
 * internal AIProviderUsage contract, or undefined when the input is unusable.
 *
 * Documented rules:
 * - Accepts camelCase, snake_case, or a mix of both.
 * - camelCase wins when both forms are present for the same field.
 * - Property presence means the property exists on the object, even when its
 *   value is undefined. A present-but-invalid value is never replaced by the
 *   snake_case form and makes the usage object invalid.
 * - Token counts must be finite, non-negative integers; audioSeconds must be a
 *   finite, non-negative number.
 * - provider and model are trimmed and must be non-empty strings.
 * - Invalid values for optional fields (cached, audioSeconds) reject the whole
 *   usage object rather than being silently dropped.
 * - Never throws, never mutates the input, ignores unknown fields, preserves
 *   a provided totalTokens without recalculating it.
 */
export function normalizeAIProviderUsage(raw: unknown): AIProviderUsage | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as RawAIProviderUsage;

  if (!isNonEmptyString(record.provider)) return undefined;
  if (!isNonEmptyString(record.model)) return undefined;
  const provider = record.provider.trim();
  const model = record.model.trim();

  const inputField = readField(record, 'inputTokens', 'input_tokens');
  const inputTokens = inputField.value;
  if (!isTokenCount(inputTokens)) return undefined;

  const outputField = readField(record, 'outputTokens', 'output_tokens');
  const outputTokens = outputField.value;
  if (!isTokenCount(outputTokens)) return undefined;

  const totalField = readField(record, 'totalTokens', 'total_tokens');
  const totalTokens = totalField.value;
  if (!isTokenCount(totalTokens)) return undefined;

  let cached: boolean | undefined;
  if (hasOwn(record, 'cached')) {
    const cachedValue = record.cached;
    if (typeof cachedValue !== 'boolean') return undefined;
    cached = cachedValue;
  }

  let audioSeconds: number | undefined;
  const audioField = readField(record, 'audioSeconds', 'audio_seconds');
  if (audioField.present) {
    const audioValue = audioField.value;
    if (!isNonNegativeSeconds(audioValue)) return undefined;
    audioSeconds = audioValue;
  }

  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cached === undefined ? {} : { cached }),
    ...(audioSeconds === undefined ? {} : { audioSeconds }),
  };
}

function hasOwn(record: RawAIProviderUsage, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readField(
  record: RawAIProviderUsage,
  preferred: string,
  fallback: string,
): FieldRead {
  if (hasOwn(record, preferred)) {
    return { present: true, value: record[preferred] };
  }
  if (hasOwn(record, fallback)) {
    return { present: true, value: record[fallback] };
  }
  return { present: false, value: undefined };
}

function isTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isNonNegativeSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Pure adapter that normalizes an arbitrary array of ProviderCallUsage records
 * into the internal ProviderCallUsage[] contract, or undefined when the input
 * is unusable.
 *
 * Documented rules:
 * - Input must be a non-empty array of objects; otherwise undefined.
 * - Every element must be a plain object with a non-empty `provider` string and
 *   a boolean `providerCallMade`; otherwise the whole array is rejected.
 * - Optional string fields (requestedModel, actualModel, operation, ...) are
 *   trimmed when present and dropped when empty/whitespace.
 * - Optional token/seconds counts must be finite non-negative integers (or
 *   finite non-negative numbers for the seconds fields); a present-but-invalid
 *   value rejects the whole array (no silent coercion, never fabricated zeros).
 * - Unknown values are left absent; input is never mutated.
 */
export function normalizeProviderCalls(
  raw: unknown,
): ProviderCallUsage[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const normalized: ProviderCallUsage[] = [];
  for (const element of raw) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      return undefined;
    }
    const record = element as RawProviderCall;
    if (!isNonEmptyString(record.provider)) return undefined;
    const provider = record.provider.trim();
    if (typeof record.providerCallMade !== 'boolean') return undefined;
    const providerCallMade = record.providerCallMade;

    const call: ProviderCallUsage = { provider, providerCallMade };

    const optionalString: Array<keyof RawProviderCall> = [
      'providerCallId',
      'providerRequestId',
      'requestedModel',
      'actualModel',
      'operation',
      'usageSource',
      'usageCompleteness',
      'accountingSemantics',
    ];
    for (const key of optionalString) {
      const value = record[key];
      if (value === undefined) continue;
      if (!isNonEmptyString(value)) return undefined;
      (call as unknown as Record<string, string | boolean | number | undefined>)[key] = value.trim();
    }

    for (const field of PROVIDER_CALL_TOKEN_FIELDS) {
      const value = record[field];
      if (value === undefined) continue;
      const isSecondsField =
        field === 'audioInputSeconds' ||
        field === 'audioOutputSeconds' ||
        field === 'transcriptionSeconds';
      if (isSecondsField ? !isNonNegativeSeconds(value) : !isTokenCount(value)) {
        return undefined;
      }
      (call as unknown as Record<string, string | boolean | number | undefined>)[field] = value as number;
    }

    normalized.push(call);
  }
  return normalized;
}

const ATTEMPT_OUTCOMES: readonly ProviderAttemptOutcome[] = [
  'SUCCEEDED',
  'FAILED',
  'INDETERMINATE',
];

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

/**
 * True when `value` is a plausible ISO-8601 timestamp (broad date-time form
 * with an optional fractional seconds and a UTC/offset suffix). Used to accept
 * `providerCallStartedAt` and the legacy `providerCallStarted` timestamp form.
 */
function isIso8601Timestamp(value: string): boolean {
  const iso =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
  return iso.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Normalize one raw provider attempt into the internal ProviderAttempt
 * contract, or undefined when the element is unusable.
 *
 * Required fields (attemptId, provider, attemptNumber, outcome,
 * providerCallStarted, providerResponseReceived) must be present and valid; a
 * present-but-invalid required field rejects the element (no silent coercion).
 * `providerCallStarted` is a BOOLEAN. For backward compatibility the legacy
 * string form (`providerCallStarted: "<ISO timestamp>"`) is accepted and
 * normalized to `providerCallStarted: true` with the timestamp moved into
 * `providerCallStartedAt`; the legacy string shape is never exposed after
 * normalization. `providerCallStartedAt` is an optional ISO-8601 timestamp that
 * is kept when valid and dropped when invalid. Optional string fields are
 * trimmed and dropped when empty; httpStatus must be an integer.
 */
function normalizeProviderAttempt(raw: unknown): ProviderAttempt | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as RawProviderAttempt;

  if (!isNonEmptyString(record.attemptId)) return undefined;
  if (!isNonEmptyString(record.provider)) return undefined;
  if (!isPositiveInteger(record.attemptNumber)) return undefined;
  if (
    typeof record.outcome !== 'string' ||
    !(ATTEMPT_OUTCOMES as readonly string[]).includes(record.outcome)
  ) {
    return undefined;
  }
  if (typeof record.providerResponseReceived !== 'boolean') return undefined;

  // providerCallStarted: required boolean. The legacy string form (an ISO-8601
  // timestamp) is accepted and normalized to true + providerCallStartedAt.
  let providerCallStarted: boolean;
  let legacyStartedAt: string | undefined;
  if (typeof record.providerCallStarted === 'boolean') {
    providerCallStarted = record.providerCallStarted;
  } else if (typeof record.providerCallStarted === 'string') {
    if (!isIso8601Timestamp(record.providerCallStarted)) return undefined;
    providerCallStarted = true;
    legacyStartedAt = record.providerCallStarted;
  } else {
    return undefined;
  }

  const attempt: ProviderAttempt = {
    attemptId: record.attemptId.trim(),
    provider: record.provider.trim(),
    attemptNumber: record.attemptNumber,
    outcome: record.outcome as ProviderAttemptOutcome,
    providerCallStarted,
    providerResponseReceived: record.providerResponseReceived,
  };

  // providerCallStartedAt: optional ISO-8601 timestamp; kept when valid,
  // otherwise dropped. A legacy string moved from providerCallStarted also
  // lands here.
  let startedAt: string | undefined = legacyStartedAt;
  if (record.providerCallStartedAt !== undefined) {
    if (
      typeof record.providerCallStartedAt !== 'string' ||
      !isIso8601Timestamp(record.providerCallStartedAt)
    ) {
      startedAt = undefined;
    } else {
      startedAt = record.providerCallStartedAt.trim();
    }
  }
  if (startedAt !== undefined) {
    attempt.providerCallStartedAt = startedAt;
  }

  const optionalString: Array<keyof RawProviderAttempt> = [
    'operation',
    'requestedModel',
    'actualModel',
    'providerCallId',
    'errorCategory',
  ];
  for (const key of optionalString) {
    const value = record[key];
    if (value === undefined) continue;
    if (!isNonEmptyString(value)) return undefined;
    (attempt as unknown as Record<string, string | number | boolean | undefined>)[key] = value.trim();
  }

  if (record.httpStatus !== undefined) {
    if (
      typeof record.httpStatus !== 'number' ||
      !Number.isInteger(record.httpStatus)
    ) {
      return undefined;
    }
    attempt.httpStatus = record.httpStatus;
  }

  return attempt;
}

/**
 * Pure adapter that normalizes an arbitrary array of provider attempts into
 * the internal ProviderAttempt[] contract.
 *
 * Documented rules:
 * - Input must be an array; otherwise undefined. An explicit empty array is
 *   valid and normalizes to `[]` (the "no attempts" representation).
 * - Invalid elements are ignored safely (never throw, never mutate); valid
 *   elements keep their original relative order.
 * - No content payloads (prompts, responses, media, secrets) are ever kept.
 */
export function normalizeProviderAttempts(raw: unknown): ProviderAttempt[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized: ProviderAttempt[] = [];
  for (const element of raw) {
    const attempt = normalizeProviderAttempt(element);
    if (attempt) normalized.push(attempt);
  }
  return normalized;
}

/**
 * Derive the billing-safety `attemptRiskStatus` from normalized attempts.
 *
 * INDETERMINATE_COST_RISK takes precedence over FAILED_ATTEMPT_PRESENT: a call
 * that may have executed with unknown cost is the most conservative state.
 * Attempts never influence the pricing summaryStatus.
 */
export function computeAttemptRiskStatus(
  attempts: ProviderAttempt[] | undefined,
): AttemptRiskStatus {
  if (!attempts || attempts.length === 0) return 'NONE';
  let hasFailed = false;
  for (const attempt of attempts) {
    if (attempt.outcome === 'INDETERMINATE') return 'INDETERMINATE_COST_RISK';
    if (attempt.outcome === 'FAILED') hasFailed = true;
  }
  return hasFailed ? 'FAILED_ATTEMPT_PRESENT' : 'NONE';
}

/** True when any attempt is a retry (attemptNumber > 1). */
export function attemptsIncludeRetry(attempts: ProviderAttempt[] | undefined): boolean {
  if (!attempts) return false;
  return attempts.some((a) => a.attemptNumber > 1);
}
