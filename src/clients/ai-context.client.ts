// ------------------------------------------------+
// AI Context Analysis Client
// ------------------------------------------------+
// Thin HTTP client that POSTs a single complete Context Object to the AI
// Service's `/analyze` endpoint. The AI only analyzes the received context; it
// never searches for additional information.
import { env } from '../config/env.js';
import { post } from '../utils/http-client.js';
import { getAIExecutionBudget } from '../config/ai-execution-budget.js';
import type {
  ContextAnalysisResult,
  ContextObject,
} from '../types/context-notification.js';

export const CONTEXT_ANALYZE_ENDPOINT = '/analyze';

export interface ContextAnalysisResponse {
  summary: Record<string, unknown>;
  report: ContextAnalysisResult;
  generatedNotifications: Array<{
    rule?: string;
    title?: string;
    message?: string;
    priority?: string;
    category?: string;
  }>;
  model?: string;
  usage?: Record<string, unknown>;
  providerCalls?: unknown;
  providerAttempts?: unknown;
}

export async function analyzeContext(
  context: ContextObject,
  operationId: string,
  timeoutMs = 30_000,
): Promise<ContextAnalysisResponse> {
  const result = await post<ContextAnalysisResponse>(
    `${env.AI_SERVICE_URL}${CONTEXT_ANALYZE_ENDPOINT}`,
    {
      context,
      operationId,
      executionBudget: getAIExecutionBudget('AI_CONTEXT_ANALYZE'),
    },
    { 'X-Internal-Api-Key': env.INTERNAL_API_KEY },
    timeoutMs,
  );
  return result;
}
