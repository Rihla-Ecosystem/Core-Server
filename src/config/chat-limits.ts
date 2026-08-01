import type { ChatContextLimits } from '../types/chat-context.js';

/**
 * Rihla application-level chat limits configuration.
 *
 * The default values in this module are provisional Rihla application-level
 * defaults. They are not claimed to be official Gemini model limits and can be
 * adjusted later after provider and product validation.
 */
export interface ChatLimitsConfig {
  maxInputTokens: number;
  maxCurrentMessageTokens: number;
  maxMessageCharacters: number;
  maxRecentMessages: number;
  historyTokenBudget: number;
  summaryTokenBudget: number;
  maxOutputTokens: number;
  inputHeadroomTokens: number;
}

export class ChatLimitsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatLimitsConfigurationError';
  }
}

/**
 * The exact environment variable names supported by this configuration.
 *
 * `inputHeadroomTokens` is intentionally absent: it is always calculated from
 * `maxInputTokens`, `maxCurrentMessageTokens`, `historyTokenBudget`, and
 * `summaryTokenBudget` and is never supplied as an environment variable.
 */
export const CHAT_LIMITS_ENV_VARS: Readonly<
  Record<keyof Omit<ChatLimitsConfig, 'inputHeadroomTokens'>, string>
> = Object.freeze({
  maxInputTokens: 'CHAT_MAX_INPUT_TOKENS',
  maxCurrentMessageTokens: 'CHAT_MAX_CURRENT_MESSAGE_TOKENS',
  maxMessageCharacters: 'CHAT_MAX_MESSAGE_CHARACTERS',
  maxRecentMessages: 'CHAT_MAX_RECENT_MESSAGES',
  historyTokenBudget: 'CHAT_HISTORY_TOKEN_BUDGET',
  summaryTokenBudget: 'CHAT_SUMMARY_TOKEN_BUDGET',
  maxOutputTokens: 'CHAT_MAX_OUTPUT_TOKENS',
});

export const CHAT_LIMITS_DEFAULTS: Readonly<ChatLimitsConfig> = Object.freeze({
  maxInputTokens: 12000,
  maxCurrentMessageTokens: 3000,
  maxMessageCharacters: 10000,
  maxRecentMessages: 10,
  historyTokenBudget: 5500,
  summaryTokenBudget: 1000,
  maxOutputTokens: 1200,
  inputHeadroomTokens: 12000 - 3000 - 5500 - 1000,
});

const POSITIVE_INTEGER_FIELDS: ReadonlySet<string> = new Set([
  'maxInputTokens',
  'maxCurrentMessageTokens',
  'maxMessageCharacters',
  'maxOutputTokens',
]);

const NON_NEGATIVE_INTEGER_FIELDS: ReadonlySet<string> = new Set([
  'maxRecentMessages',
  'historyTokenBudget',
  'summaryTokenBudget',
]);

const DECIMAL_INTEGER_PATTERN = /^[+-]?\d+$/;

export type ChatLimitsEnv = Record<string, string | undefined>;

function parseIntegerField(
  env: ChatLimitsEnv,
  field: keyof Omit<ChatLimitsConfig, 'inputHeadroomTokens'>,
): number {
  const envName = CHAT_LIMITS_ENV_VARS[field];
  const raw = env[envName];

  if (raw === undefined) {
    return CHAT_LIMITS_DEFAULTS[field];
  }

  if (typeof raw !== 'string') {
    throw new ChatLimitsConfigurationError(
      `${field} (${envName}) must be a decimal integer string`,
    );
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ChatLimitsConfigurationError(`${field} (${envName}) must not be empty`);
  }

  if (!DECIMAL_INTEGER_PATTERN.test(trimmed)) {
    throw new ChatLimitsConfigurationError(
      `${field} (${envName}) must be a decimal integer string, got "${trimmed}"`,
    );
  }

  const value = Number.parseInt(trimmed, 10);

  if (!Number.isSafeInteger(value)) {
    throw new ChatLimitsConfigurationError(
      `${field} (${envName}) must be a finite integer within the safe integer range`,
    );
  }

  if (POSITIVE_INTEGER_FIELDS.has(field) && value <= 0) {
    throw new ChatLimitsConfigurationError(
      `${field} (${envName}) must be greater than zero`,
    );
  }

  if (NON_NEGATIVE_INTEGER_FIELDS.has(field) && value < 0) {
    throw new ChatLimitsConfigurationError(
      `${field} (${envName}) must be a non-negative integer`,
    );
  }

  return value;
}

function validateCrossFieldRelationships(config: ChatLimitsConfig): void {
  if (config.maxCurrentMessageTokens > config.maxInputTokens) {
    throw new ChatLimitsConfigurationError(
      `maxCurrentMessageTokens (${config.maxCurrentMessageTokens}) must not exceed ` +
        `maxInputTokens (${config.maxInputTokens})`,
    );
  }

  const contextSum =
    config.maxCurrentMessageTokens + config.historyTokenBudget + config.summaryTokenBudget;

  if (contextSum > config.maxInputTokens) {
    throw new ChatLimitsConfigurationError(
      `maxCurrentMessageTokens (${config.maxCurrentMessageTokens}) + ` +
        `historyTokenBudget (${config.historyTokenBudget}) + ` +
        `summaryTokenBudget (${config.summaryTokenBudget}) must not exceed ` +
        `maxInputTokens (${config.maxInputTokens})`,
    );
  }

  if (config.inputHeadroomTokens < 0) {
    throw new ChatLimitsConfigurationError('inputHeadroomTokens must be zero or greater');
  }
}

/**
 * Pure parser that reads a chat limits configuration from an environment-like
 * object without depending on `process.env` and without mutating the input.
 *
 * Missing variables fall back to the documented defaults. Explicitly supplied
 * values must be decimal integer strings; malformed, empty, and out-of-range
 * values are rejected instead of silently converted.
 *
 * The returned configuration is a fresh, frozen object with `inputHeadroomTokens`
 * computed from the input budgets. `maxOutputTokens` is an output limit and is
 * never added to `maxInputTokens`.
 */
export function parseChatLimitsConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ChatLimitsConfig {
  const config: ChatLimitsConfig = {
    maxInputTokens: parseIntegerField(env, 'maxInputTokens'),
    maxCurrentMessageTokens: parseIntegerField(env, 'maxCurrentMessageTokens'),
    maxMessageCharacters: parseIntegerField(env, 'maxMessageCharacters'),
    maxRecentMessages: parseIntegerField(env, 'maxRecentMessages'),
    historyTokenBudget: parseIntegerField(env, 'historyTokenBudget'),
    summaryTokenBudget: parseIntegerField(env, 'summaryTokenBudget'),
    maxOutputTokens: parseIntegerField(env, 'maxOutputTokens'),
    inputHeadroomTokens: 0,
  };

  config.inputHeadroomTokens =
    config.maxInputTokens -
    config.maxCurrentMessageTokens -
    config.historyTokenBudget -
    config.summaryTokenBudget;

  validateCrossFieldRelationships(config);

  return Object.freeze(config);
}

/**
 * Converts a chat limits configuration into the `ChatContextLimits` subset
 * consumed by the Chat Context Builder. Returns a new, frozen object.
 */
export function toChatContextLimits(config: ChatLimitsConfig): ChatContextLimits {
  return Object.freeze({
    maxRecentMessages: config.maxRecentMessages,
    historyTokenBudget: config.historyTokenBudget,
    summaryTokenBudget: config.summaryTokenBudget,
  });
}
