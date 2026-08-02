import type { AIChatHistoryMessage } from './ai.js';

/**
 * Wire contract between the Core Server and the future non-streaming AI
 * Service execution endpoint.
 *
 * This is a transport-level contract only. It never carries Wallet data,
 * pricing data, API keys, or raw database records, and it never duplicates the
 * Step 10 outcome contract (see `ai-execution.ts`).
 */
export const AI_SERVICE_EXECUTION_SCHEMA_VERSION = 1;

export interface AIWireChatRequest {
  schemaVersion: 1;
  operationId: string;
  provider: string;
  model: string;
  message: string;
  history: AIChatHistoryMessage[];
  conversationSummary?: string;
}

export interface AIWireChatResponse {
  schemaVersion: number;
  operationId: string;
  outcome: unknown;
}

/**
 * Smallest transport-specific success payload for a non-streaming Chat
 * execution. Success data produced by the AI Service is preserved verbatim.
 */
export interface ChatExecutionData {
  text: string;
}
