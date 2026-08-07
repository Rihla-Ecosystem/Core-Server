import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { getSystemHealth } from './system.service.js';
import { getAiUsageSummary } from './ai-usage.service.js';
import { getOverview, getEntityStatistics } from './admin-enterprise.service.js';
import { getApiMonitoringSummary } from './api-monitor.service.js';
import { detectPromptInjection } from '../utils/prompt-injection.js';

export const ADMIN_ASSISTANT_QUESTION_MAX_LENGTH = 4000;
export const ADMIN_ASSISTANT_TIMEOUT_MS = 60_000;

export interface AdminAssistantResult {
  answer: string;
  blocked: boolean;
  reason?: string;
  mode?: 'llm' | 'fallback';
}

function sanitizeQuestion(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(400, 'Question is required');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new AppError(400, 'Question is required');
  if (trimmed.length > ADMIN_ASSISTANT_QUESTION_MAX_LENGTH) {
    throw new AppError(400, `Question must be at most ${ADMIN_ASSISTANT_QUESTION_MAX_LENGTH} characters`);
  }
  return trimmed;
}

function summarizeAiUsage(value: unknown): unknown {
  if (!value || typeof value !== 'object') return { unavailable: true };
  const record = value as Record<string, unknown>;
  return {
    summary: record.summary,
    daily: Array.isArray(record.daily) ? (record.daily as unknown[]).slice(-14) : [],
    perModel: Array.isArray(record.perModel) ? (record.perModel as unknown[]).slice(0, 10) : [],
    perUser: Array.isArray(record.perUser) ? (record.perUser as unknown[]).slice(0, 10) : [],
    recent: Array.isArray(record.recent) ? (record.recent as unknown[]).slice(0, 10) : [],
  };
}

async function buildPlatformSnapshot() {
  const [health, aiUsage, overview, entityStats, apiSummary] = await Promise.allSettled([
    getSystemHealth(),
    getAiUsageSummary(),
    getOverview(),
    getEntityStatistics(),
    getApiMonitoringSummary(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    systemHealth: health.status === 'fulfilled' ? health.value : { unavailable: true },
    aiUsage: aiUsage.status === 'fulfilled' ? summarizeAiUsage(aiUsage.value) : { unavailable: true },
    overview: overview.status === 'fulfilled' ? overview.value : { unavailable: true },
    entityStatistics: entityStats.status === 'fulfilled' ? entityStats.value : { unavailable: true },
    apiMonitoring: apiSummary.status === 'fulfilled' ? apiSummary.value : { unavailable: true },
  };
}

async function callAiAssistant(question: string, platform: unknown): Promise<AdminAssistantResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_ASSISTANT_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.AI_SERVICE_URL}/admin/assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': env.INTERNAL_API_KEY,
      },
      body: JSON.stringify({ question, platform }),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as
      | (AdminAssistantResult & { detail?: string })
      | null;

    if (!response.ok) {
      console.error(
        `[admin-assistant] AI service returned ${response.status}:`,
        body?.detail ?? JSON.stringify(body) ?? 'no body',
      );
      throw new AppError(response.status, body?.detail ?? 'AI assistant unavailable');
    }

    return {
      answer: typeof body?.answer === 'string' ? body.answer : '',
      blocked: Boolean(body?.blocked),
      reason: typeof body?.reason === 'string' ? body.reason : undefined,
      mode: body?.mode === 'fallback' ? 'fallback' : 'llm',
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AppError(504, 'AI assistant request timed out');
    }
    console.error('[admin-assistant] AI service request failed:', err);
    throw new AppError(503, 'AI assistant unavailable');
  } finally {
    clearTimeout(timer);
  }
}

export async function runAdminAssistant(actorId: string, rawQuestion: unknown): Promise<AdminAssistantResult> {
  const question = sanitizeQuestion(rawQuestion);

  // Defense-in-depth: refuse obvious prompt-injection attempts before the LLM.
  const injection = detectPromptInjection(question);
  if (injection) {
    await prisma.auditLog.create({
      data: {
        actorId,
        action: 'admin_assistant_query',
        metadata: {
          blocked: true,
          reason: 'prompt_injection_attempt',
          question: question.slice(0, 160),
        },
      },
    });
    return {
      blocked: true,
      reason: 'prompt_injection_attempt',
      answer:
        "I couldn't process that request because it looks like a prompt-injection attempt. " +
        'Please ask a normal platform-analytics question about users, revenue, AI usage, system health, or security.',
    };
  }

  const platform = await buildPlatformSnapshot();
  const result = await callAiAssistant(question, platform);

  await prisma.auditLog.create({
    data: {
      actorId,
      action: 'admin_assistant_query',
      metadata: {
        blocked: result.blocked,
        reason: result.reason ?? null,
        mode: result.mode ?? 'llm',
        question: question.slice(0, 160),
      },
    },
  });

  return result;
}
