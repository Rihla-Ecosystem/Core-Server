import type { AIChatHistoryMessage } from '../types/ai.js';
import type {
  AIExecutionIndeterminateFailure,
  AIExecutionNonBillableFailure,
  AIExecutionOutcome,
} from '../types/ai-execution.js';
import type {
  AIWireChatRequest,
  ChatExecutionData,
} from '../types/ai-service-execution.js';
import {
  AIExecutionContractError,
  parseAIExecutionOutcome,
} from '../utils/ai-execution-contract.js';
import {
  sendAIExecutionRequest,
  type AIServiceExecutionClientDependencies,
} from '../clients/ai-service-execution.client.js';

/**
 * Thin non-streaming Chat executor for the future durable AI execution path.
 *
 * It validates local input, builds the wire request, calls the isolated
 * transport client exactly once, validates the response envelope, extracts the
 * canonical Step 10 outcome payload, and passes it through the existing
 * parseAIExecutionOutcome().
 *
 * It performs no billing, no Wallet access, no Prisma access, no history
 * loading, no context building, no provider/model selection, no retry, and no
 * second usage normalizer.
 */

export type AIServiceChatExecutorFailureCode =
  | 'INVALID_OPERATION_ID'
  | 'INVALID_PROVIDER'
  | 'INVALID_MODEL'
  | 'INVALID_MESSAGE'
  | 'INVALID_HISTORY_ROLE'
  | 'INVALID_HISTORY_CONTENT'
  | 'INVALID_CONVERSATION_SUMMARY'
  | 'INVALID_BASE_URL'
  | 'MISSING_INTERNAL_API_KEY'
  | 'INVALID_TIMEOUT'
  | 'REQUEST_SERIALIZATION_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'FETCH_REJECTED'
  | 'INVALID_RESPONSE_JSON'
  | 'INVALID_RESPONSE_ENVELOPE'
  | 'INVALID_SCHEMA_VERSION'
  | 'MISSING_OPERATION_ID'
  | 'OPERATION_ID_MISMATCH'
  | 'MISSING_OUTCOME'
  | 'INVALID_OUTCOME'
  | 'INVALID_CHAT_SUCCESS_DATA'
  | 'HTTP_STATUS_OUTCOME_CONFLICT';

export interface AIServiceChatExecutorInput {
  operationId: string;
  provider: string;
  model: string;
  message: string;
  history?: AIChatHistoryMessage[];
  conversationSummary?: string;
  transport?: AIServiceExecutionClientDependencies;
}

export async function executeAIServiceChat(
  input: AIServiceChatExecutorInput,
): Promise<AIExecutionOutcome<ChatExecutionData>> {
  const validated = validateInput(input);
  if (!validated.ok) return validated.failure;

  const request: AIWireChatRequest = validated.request;

  const transport = await sendAIExecutionRequest(request, input.transport);

  if (transport.status === 'FAILURE') {
    if (!transport.providerRequestSent) {
      return nonBillable(transport.code, transport.message);
    }
    return indeterminate(transport.code, transport.message, request);
  }

  const envelope = validateEnvelope(transport.body, request);
  if (!envelope.ok) return envelope.failure;

  let outcome: AIExecutionOutcome<ChatExecutionData>;
  try {
    outcome = parseAIExecutionOutcome<ChatExecutionData>(envelope.outcome);
  } catch {
    return indeterminate('INVALID_OUTCOME', 'AI execution outcome is invalid', request);
  }

  if (outcome.kind === 'SUCCESS') {
    if (!isHttpSuccess(transport.httpStatus)) {
      return indeterminate(
        'HTTP_STATUS_OUTCOME_CONFLICT',
        'AI execution HTTP status conflicts with a successful outcome',
        request,
      );
    }
    if (!isValidChatSuccessData(outcome.data)) {
      return indeterminate(
        'INVALID_CHAT_SUCCESS_DATA',
        'AI execution success data is invalid',
        request,
      );
    }
  }

  return outcome;
}

function validateInput(
  input: AIServiceChatExecutorInput,
):
  | { ok: false; failure: AIExecutionNonBillableFailure }
  | { ok: true; request: AIWireChatRequest } {
  const operationId = trimNonEmpty(input.operationId);
  if (operationId === undefined) {
    return { ok: false, failure: nonBillable('INVALID_OPERATION_ID', 'AI execution operationId is required') };
  }

  const provider = trimNonEmpty(input.provider);
  if (provider === undefined) {
    return { ok: false, failure: nonBillable('INVALID_PROVIDER', 'AI execution provider is required') };
  }

  const model = trimNonEmpty(input.model);
  if (model === undefined) {
    return { ok: false, failure: nonBillable('INVALID_MODEL', 'AI execution model is required') };
  }

  if (typeof input.message !== 'string' || input.message.trim().length === 0) {
    return { ok: false, failure: nonBillable('INVALID_MESSAGE', 'AI execution message is required') };
  }

  const history = input.history ?? [];
  if (!Array.isArray(history)) {
    return { ok: false, failure: nonBillable('INVALID_HISTORY_ROLE', 'AI execution history must be an array') };
  }
  const wireHistory: AIChatHistoryMessage[] = [];
  for (const entry of history) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        failure: nonBillable('INVALID_HISTORY_ROLE', 'AI execution history entry must be an object'),
      };
    }
    const record = entry as { role?: unknown; content?: unknown };
    if (record.role !== 'user' && record.role !== 'assistant') {
      return {
        ok: false,
        failure: nonBillable('INVALID_HISTORY_ROLE', 'AI execution history role must be user or assistant'),
      };
    }
    if (typeof record.content !== 'string' || record.content.trim().length === 0) {
      return {
        ok: false,
        failure: nonBillable('INVALID_HISTORY_CONTENT', 'AI execution history content is required'),
      };
    }
    wireHistory.push({ role: record.role, content: record.content });
  }

  let conversationSummary: string | undefined;
  if (input.conversationSummary !== undefined) {
    if (typeof input.conversationSummary !== 'string' || input.conversationSummary.trim().length === 0) {
      return {
        ok: false,
        failure: nonBillable(
          'INVALID_CONVERSATION_SUMMARY',
          'AI execution conversationSummary must be a non-empty string when provided',
        ),
      };
    }
    conversationSummary = input.conversationSummary;
  }

  return {
    ok: true,
    request: {
      schemaVersion: 1,
      operationId,
      provider,
      model,
      message: input.message,
      history: wireHistory,
      ...(conversationSummary === undefined ? {} : { conversationSummary }),
    },
  };
}

function validateEnvelope(
  body: unknown,
  request: AIWireChatRequest,
):
  | { ok: false; failure: AIExecutionIndeterminateFailure }
  | { ok: true; outcome: unknown } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      failure: indeterminate(
        'INVALID_RESPONSE_ENVELOPE',
        'AI execution response envelope is invalid',
        request,
      ),
    };
  }
  const record = body as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return {
      ok: false,
      failure: indeterminate(
        'INVALID_SCHEMA_VERSION',
        'AI execution response schemaVersion is invalid',
        request,
      ),
    };
  }
  if (typeof record.operationId !== 'string' || record.operationId.trim().length === 0) {
    return {
      ok: false,
      failure: indeterminate(
        'MISSING_OPERATION_ID',
        'AI execution response operationId is missing',
        request,
      ),
    };
  }
  if (record.operationId !== request.operationId) {
    return {
      ok: false,
      failure: indeterminate(
        'OPERATION_ID_MISMATCH',
        'AI execution response operationId does not match the request',
        request,
      ),
    };
  }
  if (!hasOwn(record, 'outcome') || record.outcome === undefined) {
    return {
      ok: false,
      failure: indeterminate(
        'MISSING_OUTCOME',
        'AI execution response outcome is missing',
        request,
      ),
    };
  }
  return { ok: true, outcome: record.outcome };
}

function isHttpSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isValidChatSuccessData(data: unknown): data is ChatExecutionData {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return typeof record.text === 'string' && record.text.trim().length > 0;
}

function nonBillable(
  code: AIServiceChatExecutorFailureCode,
  message: string,
): AIExecutionNonBillableFailure {
  return {
    kind: 'NON_BILLABLE_FAILURE',
    code,
    message,
    providerRequestSent: false,
    retryable: false,
  };
}

function indeterminate(
  code: AIServiceChatExecutorFailureCode,
  message: string,
  request: AIWireChatRequest,
): AIExecutionIndeterminateFailure {
  return {
    kind: 'INDETERMINATE_FAILURE',
    code,
    message,
    providerRequestSent: true,
    retryable: false,
    execution: { provider: request.provider, model: request.model },
  };
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
