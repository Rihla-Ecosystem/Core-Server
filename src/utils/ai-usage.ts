import type {
  AIProviderUsage,
  ProviderCallUsage,
  RawAIProviderUsage,
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
