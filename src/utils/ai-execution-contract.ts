import type { AIProviderUsage, AIChatHistoryMessage } from '../types/ai.js';
import type {
  AIExecutionIdentity,
  AIExecutionIndeterminateFailure,
  AIExecutionNonBillableFailure,
  AIExecutionOutcome,
  AIExecutionRequest,
  AIExecutionSuccess,
} from '../types/ai-execution.js';
import { normalizeAIProviderUsage } from './ai-usage.js';

export type AIExecutionContractErrorCode =
  | 'INVALID_OUTCOME'
  | 'INVALID_SUCCESS'
  | 'INVALID_EXECUTION_IDENTITY'
  | 'INVALID_USAGE'
  | 'IDENTITY_USAGE_MISMATCH'
  | 'INVALID_FAILURE'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_KIND';

/**
 * Non-HTTP error thrown by the execution contract parser. Never includes the
 * raw payload, never implies an HTTP status, and never mutates the input.
 */
export class AIExecutionContractError extends Error {
  readonly code: AIExecutionContractErrorCode;

  constructor(code: AIExecutionContractErrorCode, message: string) {
    super(message);
    this.name = 'AIExecutionContractError';
    this.code = code;
  }
}

function contractError(
  code: AIExecutionContractErrorCode,
  message: string,
): AIExecutionContractError {
  return new AIExecutionContractError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseExecutionIdentity(raw: unknown): AIExecutionIdentity {
  if (!isRecord(raw)) {
    throw contractError(
      'INVALID_EXECUTION_IDENTITY',
      'AI execution identity must be an object',
    );
  }
  const provider = trimNonEmptyString(raw.provider);
  if (provider === undefined) {
    throw contractError(
      'INVALID_EXECUTION_IDENTITY',
      'AI execution identity provider is missing or empty',
    );
  }
  const model = trimNonEmptyString(raw.model);
  if (model === undefined) {
    throw contractError(
      'INVALID_EXECUTION_IDENTITY',
      'AI execution identity model is missing or empty',
    );
  }
  let providerRequestId: string | undefined;
  if (raw.providerRequestId !== undefined) {
    const trimmed = trimNonEmptyString(raw.providerRequestId);
    if (trimmed === undefined) {
      throw contractError(
        'INVALID_EXECUTION_IDENTITY',
        'AI execution providerRequestId must be a non-empty string when present',
      );
    }
    providerRequestId = trimmed;
  }
  return {
    provider,
    model,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}

function parsePartialExecutionIdentity(
  raw: unknown,
): Partial<AIExecutionIdentity> | undefined {
  if (!isRecord(raw)) {
    throw contractError(
      'INVALID_EXECUTION_IDENTITY',
      'AI execution identity must be an object when provided',
    );
  }
  const identity: Partial<AIExecutionIdentity> = {};
  if (raw.provider !== undefined) {
    const provider = trimNonEmptyString(raw.provider);
    if (provider === undefined) {
      throw contractError(
        'INVALID_EXECUTION_IDENTITY',
        'AI execution identity provider must be a non-empty string when present',
      );
    }
    identity.provider = provider;
  }
  if (raw.model !== undefined) {
    const model = trimNonEmptyString(raw.model);
    if (model === undefined) {
      throw contractError(
        'INVALID_EXECUTION_IDENTITY',
        'AI execution identity model must be a non-empty string when present',
      );
    }
    identity.model = model;
  }
  if (raw.providerRequestId !== undefined) {
    const providerRequestId = trimNonEmptyString(raw.providerRequestId);
    if (providerRequestId === undefined) {
      throw contractError(
        'INVALID_EXECUTION_IDENTITY',
        'AI execution providerRequestId must be a non-empty string when present',
      );
    }
    identity.providerRequestId = providerRequestId;
  }
  return Object.keys(identity).length === 0 ? undefined : identity;
}

function parseSuccess<TData>(raw: Record<string, unknown>): AIExecutionSuccess<TData> {
  if (!hasOwn(raw, 'data') || raw.data === undefined) {
    throw contractError('INVALID_SUCCESS', 'AI execution success requires a data property');
  }
  if (hasOwn(raw, 'providerRequestSent')) {
    throw contractError(
      'INVALID_SUCCESS',
      'AI execution success must not contain providerRequestSent',
    );
  }
  if (hasOwn(raw, 'retryable')) {
    throw contractError('INVALID_SUCCESS', 'AI execution success must not contain retryable');
  }
  if (hasOwn(raw, 'code')) {
    throw contractError('INVALID_SUCCESS', 'AI execution success must not contain a failure code');
  }
  const data = raw.data as TData;
  const execution = parseExecutionIdentity(raw.execution);
  const usage = normalizeAIProviderUsage(raw.usage);
  if (usage === undefined) {
    throw contractError('INVALID_USAGE', 'AI execution success usage is missing or invalid');
  }
  if (execution.provider !== usage.provider) {
    throw contractError(
      'IDENTITY_USAGE_MISMATCH',
      'AI execution identity provider does not match usage provider',
    );
  }
  if (execution.model !== usage.model) {
    throw contractError(
      'IDENTITY_USAGE_MISMATCH',
      'AI execution identity model does not match usage model',
    );
  }
  return { kind: 'SUCCESS', data, execution, usage };
}

function parseFailureCodeMessageRetryable(
  raw: Record<string, unknown>,
): { code: string; message: string; retryable: boolean } {
  const code = trimNonEmptyString(raw.code);
  if (code === undefined) {
    throw contractError('INVALID_FAILURE', 'AI execution failure code is missing or empty');
  }
  const message = trimNonEmptyString(raw.message);
  if (message === undefined) {
    throw contractError('INVALID_FAILURE', 'AI execution failure message is missing or empty');
  }
  if (typeof raw.retryable !== 'boolean') {
    throw contractError('INVALID_FAILURE', 'AI execution failure retryable must be a boolean');
  }
  return { code, message, retryable: raw.retryable };
}

function assertNoSuccessPayload(raw: Record<string, unknown>): void {
  if (hasOwn(raw, 'usage')) {
    throw contractError('INVALID_FAILURE', 'AI execution failure must not contain usage');
  }
  if (hasOwn(raw, 'data')) {
    throw contractError('INVALID_FAILURE', 'AI execution failure must not contain success data');
  }
}

function parseNonBillableFailure(raw: Record<string, unknown>): AIExecutionNonBillableFailure {
  if (raw.providerRequestSent !== false) {
    throw contractError(
      'INVALID_FAILURE',
      'AI execution non-billable failure must confirm the provider request was not sent',
    );
  }
  if (hasOwn(raw, 'execution')) {
    throw contractError(
      'INVALID_FAILURE',
      'AI execution non-billable failure must not contain an execution identity',
    );
  }
  assertNoSuccessPayload(raw);
  const { code, message, retryable } = parseFailureCodeMessageRetryable(raw);
  return {
    kind: 'NON_BILLABLE_FAILURE',
    code,
    message,
    providerRequestSent: false,
    retryable,
  };
}

function parseIndeterminateFailure(raw: Record<string, unknown>): AIExecutionIndeterminateFailure {
  if (raw.providerRequestSent !== true) {
    throw contractError(
      'INVALID_FAILURE',
      'AI execution indeterminate failure must confirm the provider request was sent',
    );
  }
  assertNoSuccessPayload(raw);
  const { code, message, retryable } = parseFailureCodeMessageRetryable(raw);
  const execution =
    raw.execution === undefined ? undefined : parsePartialExecutionIdentity(raw.execution);
  return {
    kind: 'INDETERMINATE_FAILURE',
    code,
    message,
    providerRequestSent: true,
    retryable,
    ...(execution === undefined ? {} : { execution }),
  };
}

/**
 * Pure parser that converts an arbitrary AI execution outcome value into the
 * canonical `AIExecutionOutcome` contract, or throws `AIExecutionContractError`.
 *
 * Never mutates the input, returns fresh objects, strips unknown fields, trims
 * recognized identifier strings, and reuses `normalizeAIProviderUsage()` for
 * usage normalization. Does not calculate pricing, does not call AI, does not
 * perform HTTP, and does not access Prisma.
 */
export function parseAIExecutionOutcome<TData = unknown>(raw: unknown): AIExecutionOutcome<TData> {
  if (!isRecord(raw)) {
    throw contractError('INVALID_OUTCOME', 'AI execution outcome must be an object');
  }
  if (typeof raw.kind !== 'string' || raw.kind.trim().length === 0) {
    throw contractError('INVALID_OUTCOME', 'AI execution outcome kind is missing or empty');
  }
  switch (raw.kind) {
    case 'SUCCESS':
      return parseSuccess<TData>(raw);
    case 'NON_BILLABLE_FAILURE':
      return parseNonBillableFailure(raw);
    case 'INDETERMINATE_FAILURE':
      return parseIndeterminateFailure(raw);
    default:
      throw contractError('UNSUPPORTED_KIND', 'AI execution outcome kind is not supported');
  }
}

function parseHistoryMessage(raw: unknown): AIChatHistoryMessage {
  if (!isRecord(raw)) {
    throw contractError(
      'INVALID_REQUEST',
      'AI execution request history message must be an object',
    );
  }
  if (raw.role !== 'user' && raw.role !== 'assistant') {
    throw contractError(
      'INVALID_REQUEST',
      'AI execution request history role must be user or assistant',
    );
  }
  const content = raw.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw contractError(
      'INVALID_REQUEST',
      'AI execution request history content must be a non-empty string',
    );
  }
  return { role: raw.role, content };
}

/**
 * Pure validator that converts an arbitrary AI execution request value into the
 * canonical `AIExecutionRequest` contract, or throws `AIExecutionContractError`.
 *
 * Never mutates the input, returns a fresh sanitized object, trims identifiers,
 * validates limits as safe positive integers, validates history using the
 * existing role/content rules, and preserves the supplied chronological order.
 * Does not sort history, does not count tokens, and does not require
 * provider/model while the production provider choice is unresolved.
 */
export function validateAIExecutionRequest(raw: unknown): AIExecutionRequest {
  if (!isRecord(raw)) {
    throw contractError('INVALID_REQUEST', 'AI execution request must be an object');
  }
  const operationId = trimNonEmptyString(raw.operationId);
  if (operationId === undefined) {
    throw contractError('INVALID_REQUEST', 'AI execution request operationId is missing or empty');
  }
  const feature = trimNonEmptyString(raw.feature);
  if (feature === undefined) {
    throw contractError('INVALID_REQUEST', 'AI execution request feature is missing or empty');
  }

  let provider: string | undefined;
  if (raw.provider !== undefined) {
    provider = trimNonEmptyString(raw.provider);
    if (provider === undefined) {
      throw contractError(
        'INVALID_REQUEST',
        'AI execution request provider must be a non-empty string when present',
      );
    }
  }
  let model: string | undefined;
  if (raw.model !== undefined) {
    model = trimNonEmptyString(raw.model);
    if (model === undefined) {
      throw contractError(
        'INVALID_REQUEST',
        'AI execution request model must be a non-empty string when present',
      );
    }
  }

  if (!isRecord(raw.input)) {
    throw contractError('INVALID_REQUEST', 'AI execution request input must be an object');
  }
  const message = raw.input.message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw contractError(
      'INVALID_REQUEST',
      'AI execution request input message must be a non-empty string',
    );
  }

  let history: AIChatHistoryMessage[] | undefined;
  if (raw.input.history !== undefined) {
    if (!Array.isArray(raw.input.history)) {
      throw contractError('INVALID_REQUEST', 'AI execution request input history must be an array');
    }
    history = raw.input.history.map(parseHistoryMessage);
  }

  let context: string | undefined;
  if (raw.input.context !== undefined) {
    if (typeof raw.input.context !== 'string' || raw.input.context.trim().length === 0) {
      throw contractError(
        'INVALID_REQUEST',
        'AI execution request input context must be a non-empty string when present',
      );
    }
    context = raw.input.context;
  }

  if (!isRecord(raw.limits)) {
    throw contractError('INVALID_REQUEST', 'AI execution request limits must be an object');
  }
  const maxInputTokens = raw.limits.maxInputTokens;
  if (!isSafePositiveInteger(maxInputTokens)) {
    throw contractError(
      'INVALID_REQUEST',
      'AI execution request maxInputTokens must be a safe positive integer',
    );
  }
  const maxOutputTokens = raw.limits.maxOutputTokens;
  if (!isSafePositiveInteger(maxOutputTokens)) {
    throw contractError(
      'INVALID_REQUEST',
      'AI execution request maxOutputTokens must be a safe positive integer',
    );
  }

  let metadata: AIExecutionRequest['metadata'];
  if (raw.metadata !== undefined) {
    if (!isRecord(raw.metadata)) {
      throw contractError('INVALID_REQUEST', 'AI execution request metadata must be an object');
    }
    metadata = {};
    if (raw.metadata.userId !== undefined) {
      const userId = trimNonEmptyString(raw.metadata.userId);
      if (userId === undefined) {
        throw contractError(
          'INVALID_REQUEST',
          'AI execution request metadata userId must be a non-empty string when present',
        );
      }
      metadata.userId = userId;
    }
    if (raw.metadata.conversationId !== undefined) {
      const conversationId = trimNonEmptyString(raw.metadata.conversationId);
      if (conversationId === undefined) {
        throw contractError(
          'INVALID_REQUEST',
          'AI execution request metadata conversationId must be a non-empty string when present',
        );
      }
      metadata.conversationId = conversationId;
    }
    if (raw.metadata.requestId !== undefined) {
      const requestId = trimNonEmptyString(raw.metadata.requestId);
      if (requestId === undefined) {
        throw contractError(
          'INVALID_REQUEST',
          'AI execution request metadata requestId must be a non-empty string when present',
        );
      }
      metadata.requestId = requestId;
    }
  }

  return {
    operationId,
    feature,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    input: {
      message,
      ...(history === undefined ? {} : { history }),
      ...(context === undefined ? {} : { context }),
    },
    limits: { maxInputTokens, maxOutputTokens },
    ...(metadata === undefined ? {} : { metadata }),
  };
}
