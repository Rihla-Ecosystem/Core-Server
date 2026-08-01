import type { AIChatHistoryMessage } from '../types/ai.js';
import type {
  BuildChatContextInput,
  BuildChatContextResult,
  ChatContextLimits,
  TokenEstimator,
} from '../types/chat-context.js';

export class ChatContextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatContextValidationError';
  }
}

interface EstimatedMessage {
  message: AIChatHistoryMessage;
  tokens: number;
}

interface HistoryUnit {
  messages: EstimatedMessage[];
  tokens: number;
  isCompleteTurn: boolean;
}

interface ResolvedSummary {
  included: boolean;
  content: string | undefined;
  tokens: number;
  excludedReason: 'EMPTY' | 'BUDGET_EXCEEDED' | undefined;
}

/**
 * Pure, deterministic Chat Context Builder.
 *
 * It selects the most recent useful chat history under a message-count limit
 * and a token budget, preserves complete user + assistant turns where possible,
 * returns history in chronological order, and optionally carries an existing
 * conversation summary. It never calls the AI Service, the database, HTTP, or
 * any pricing logic; all token estimation is injected.
 *
 * Turn-grouping algorithm:
 * A complete turn is a user message immediately followed by an assistant
 * message in the chronological history. Adjacent (user, assistant) pairs are
 * grouped into a single complete-turn unit. Every other message becomes its
 * own single-message unit. Messages are never reordered, never split, and
 * never duplicated.
 *
 * Selection algorithm (newest to oldest):
 * Units are considered from newest to oldest. An assistant-only unit is an
 * orphan assistant message (its user turn is absent) and is skipped, but a
 * valid unit is selected only when both the remaining message count and the
 * remaining token budget fit the whole unit. A latest unmatched user message
 * may be selected on its own. Once a valid unit does not fit, selection stops:
 * the returned history is always a contiguous recent suffix, so an older valid
 * unit is never selected while a newer valid unit has been omitted. Selected
 * units are prepended so the returned history stays in chronological order.
 */
export function buildChatContext(input: BuildChatContextInput): BuildChatContextResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ChatContextValidationError('buildChatContext input must be an object');
  }

  if (typeof input.estimateTokens !== 'function') {
    throw new ChatContextValidationError('estimateTokens must be a function');
  }

  validateLimits(input.limits);

  if (typeof input.currentMessage !== 'string' || input.currentMessage.trim().length === 0) {
    throw new ChatContextValidationError('currentMessage must be a non-empty string');
  }

  validateHistory(input.history);

  const currentMessageTokens = estimateOrThrow(input.estimateTokens, input.currentMessage);

  const units = groupHistoryUnits(input.history, input.estimateTokens);
  const selectedUnits = selectUnits(units, input.limits);

  const selectedHistory = selectedUnits.flatMap((unit) => unit.messages).map((m) => m.message);
  const historyTokens = selectedUnits.reduce((sum, unit) => sum + unit.tokens, 0);

  const summary = resolveSummary(
    input.conversationSummary,
    input.limits.summaryTokenBudget,
    input.estimateTokens,
  );

  const totalTokens =
    currentMessageTokens + historyTokens + (summary.included ? summary.tokens : 0);

  return {
    currentMessage: input.currentMessage,
    history: selectedHistory,
    selectedMessageCount: selectedHistory.length,
    droppedMessageCount: input.history.length - selectedHistory.length,
    summaryIncluded: summary.included,
    ...(summary.excludedReason === undefined ? {} : { summaryExcludedReason: summary.excludedReason }),
    ...(summary.included && summary.content !== undefined
      ? { conversationSummary: summary.content }
      : {}),
    estimatedTokens: {
      currentMessageTokens,
      historyTokens,
      summaryTokens: summary.tokens,
      totalTokens,
    },
  };
}

function validateLimits(limits: ChatContextLimits): void {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new ChatContextValidationError('limits must be an object');
  }
  validateNonNegativeInteger(limits.maxRecentMessages, 'maxRecentMessages');
  validateNonNegativeInteger(limits.historyTokenBudget, 'historyTokenBudget');
  validateNonNegativeInteger(limits.summaryTokenBudget, 'summaryTokenBudget');
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new ChatContextValidationError(`${name} must be a finite, non-negative integer`);
  }
}

function validateHistory(history: AIChatHistoryMessage[]): void {
  if (!Array.isArray(history)) {
    throw new ChatContextValidationError('history must be an array');
  }
  for (const message of history) {
    if (!isValidChatMessage(message)) {
      throw new ChatContextValidationError('history contains an invalid chat message');
    }
  }
}

function isValidChatMessage(value: unknown): value is AIChatHistoryMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.role === 'user' || record.role === 'assistant') &&
    typeof record.content === 'string'
  );
}

function estimateOrThrow(estimateTokens: TokenEstimator, text: string): number {
  const tokens = estimateTokens(text);
  if (
    typeof tokens !== 'number' ||
    !Number.isFinite(tokens) ||
    !Number.isInteger(tokens) ||
    tokens < 0
  ) {
    throw new ChatContextValidationError(
      'estimateTokens must return a finite, non-negative integer',
    );
  }
  return tokens;
}

function groupHistoryUnits(
  history: AIChatHistoryMessage[],
  estimateTokens: TokenEstimator,
): HistoryUnit[] {
  const estimated: EstimatedMessage[] = history.map((message) => ({
    message,
    tokens: estimateOrThrow(estimateTokens, message.content),
  }));

  const units: HistoryUnit[] = [];
  let index = 0;
  while (index < estimated.length) {
    const current = estimated[index];
    const next = estimated[index + 1];
    if (
      current.message.role === 'user' &&
      next !== undefined &&
      next.message.role === 'assistant'
    ) {
      units.push({
        messages: [current, next],
        tokens: current.tokens + next.tokens,
        isCompleteTurn: true,
      });
      index += 2;
    } else {
      units.push({
        messages: [current],
        tokens: current.tokens,
        isCompleteTurn: false,
      });
      index += 1;
    }
  }
  return units;
}

function selectUnits(units: HistoryUnit[], limits: ChatContextLimits): HistoryUnit[] {
  const selected: HistoryUnit[] = [];
  let remainingMessages = limits.maxRecentMessages;
  let remainingTokens = limits.historyTokenBudget;

  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index];

    if (!unit.isCompleteTurn && unit.messages[0].message.role === 'assistant') {
      continue;
    }

    if (unit.messages.length > remainingMessages || unit.tokens > remainingTokens) {
      break;
    }

    selected.unshift(unit);
    remainingMessages -= unit.messages.length;
    remainingTokens -= unit.tokens;
  }

  return selected;
}

function resolveSummary(
  conversationSummary: string | undefined,
  summaryTokenBudget: number,
  estimateTokens: TokenEstimator,
): ResolvedSummary {
  if (conversationSummary === undefined) {
    return { included: false, content: undefined, tokens: 0, excludedReason: undefined };
  }

  if (typeof conversationSummary !== 'string') {
    throw new ChatContextValidationError('conversationSummary must be a string when provided');
  }

  if (conversationSummary.trim().length === 0) {
    return { included: false, content: undefined, tokens: 0, excludedReason: 'EMPTY' };
  }

  const tokens = estimateOrThrow(estimateTokens, conversationSummary);

  if (tokens <= summaryTokenBudget) {
    return { included: true, content: conversationSummary, tokens, excludedReason: undefined };
  }

  return { included: false, content: undefined, tokens, excludedReason: 'BUDGET_EXCEEDED' };
}
