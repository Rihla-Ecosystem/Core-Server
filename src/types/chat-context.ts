import type { AIChatHistoryMessage } from './ai.js';

export interface ChatContextLimits {
  maxRecentMessages: number;
  historyTokenBudget: number;
  summaryTokenBudget: number;
}

export type TokenEstimator = (text: string) => number;

export interface BuildChatContextInput {
  currentMessage: string;
  history: AIChatHistoryMessage[];
  conversationSummary?: string;
  limits: ChatContextLimits;
  estimateTokens: TokenEstimator;
}

export interface ChatContextTokenEstimate {
  currentMessageTokens: number;
  historyTokens: number;
  summaryTokens: number;
  totalTokens: number;
}

export interface BuildChatContextResult {
  currentMessage: string;
  history: AIChatHistoryMessage[];

  selectedMessageCount: number;
  droppedMessageCount: number;

  summaryIncluded: boolean;
  summaryExcludedReason?: 'EMPTY' | 'BUDGET_EXCEEDED';

  estimatedTokens: ChatContextTokenEstimate;
  conversationSummary?: string;
}
