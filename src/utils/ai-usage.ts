import type { AIProviderUsage, RawAIProviderUsage } from '../types/ai.js';

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
