import { prisma } from '../config/prisma.js';
import { env, walletPolicyConfig } from '../config/env.js';
import { post } from '../utils/http-client.js';
import { fetchEnvContext } from './env.service.js';
import { fetchPois } from './geo.service.js';
import { fetchSafetyContext } from './risk.service.js';
import { getExchangeRates, isSupportedCurrency } from './currency.service.js';
import { getJourneyProgress } from './internal.service.js';
import { AppError } from '../middleware/errorHandler.js';
import { runUsageBasedAIBilling } from './usage-based-ai-billing.service.js';
import { recordAiUsage } from './ai-usage.service.js';
import { isTokenExemptUser } from '../utils/token-exempt.js';
import { buildSuccessOutcome, aiUnavailableOutcome, resolveUsageBasedBillingResult } from '../utils/usage-billing.js';
import {
  BillingRateCardUnavailableError,
  resolveBillingRateCard,
} from './billing-rate-card.service.js';
import { parseChatLimitsConfig } from '../config/chat-limits.js';
import { getAIExecutionBudget } from '../config/ai-execution-budget.js';
import type { AIExecutionBudget } from '../config/ai-execution-budget.js';
import { detectPromptInjection } from '../utils/prompt-injection.js';

const CHAT_LIMITS = parseChatLimitsConfig(process.env);

const AI_CHAT_TIMEOUT_MS = 120_000;

export type ChatPersona = 'auto' | 'tour_guide' | 'local_expert' | 'safety_guru';

interface ChatUserContext {
  displayName: string | null;
  gender: string | null;
  nationality: string | null;
  language: unknown;
  budgetLevel: string | null;
  travelStyle: string | null;
  interests: unknown;
  accommodationType: string | null;
}

interface ChatOptions {
  businessRequestId: string;
  lat?: number;
  lon?: number;
  conversationId?: string;
  authorization?: string;
  baseCurrency?: string;
  persona?: ChatPersona;
  context?: Record<string, unknown>;
  title?: string;
  executionBudget?: AIExecutionBudget;
}

type ChatCoreResult =
  | {
      ok: true;
      result: Record<string, unknown>;
      providerCalls: unknown;
      providerAttempts: unknown;
      usage: {
        model?: string | null;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      } | null;
    }
  | { ok: false };

async function performChatCore(
  userId: string,
  message: string,
  options: ChatOptions,
  user: ChatUserContext,
): Promise<ChatCoreResult> {
  const injection = detectPromptInjection(message);
  if (injection) {
    throw new AppError(400, 'Message blocked: looks like a prompt-injection attempt');
  }

  const preferences = await prisma.userPreference.findMany({
    where: { userId },
    select: { key: true, value: true },
  });
  const prefs: Record<string, unknown> = {};
  for (const p of preferences) prefs[p.key] = p.value;

  let envContext: unknown = null;
  let geoContext: unknown = null;
  let safetyContext: unknown = null;
  let currencyContext: unknown = null;

  if (options?.lat !== undefined && options?.lon !== undefined) {
    [envContext, geoContext, safetyContext, currencyContext] = await Promise.all([
      fetchEnvContext(options.lat, options.lon, options.authorization).catch(() => null),
      fetchPois(options.lat, options.lon, undefined, undefined, options.authorization).catch(() => null),
      fetchSafetyContext(options.lat, options.lon, options.authorization),
      options.baseCurrency && isSupportedCurrency(options.baseCurrency) ? getExchangeRates(options.baseCurrency) : Promise.resolve(null),
    ]);
  }

  // Always fetch journey progress for gamification context (Task 8.6)
  const journeyProgress = await getJourneyProgress(userId).catch(() => null);

  let conversationId = options?.conversationId;
  if (conversationId) {
    const existing = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!existing) conversationId = undefined;
  }
  if (!conversationId) {
    const conv = await prisma.conversation.create({
      data: {
        userId,
        title: options?.title?.trim() ? options.title.trim().slice(0, 100) : message.slice(0, 100),
      },
    });
    conversationId = conv.id;
  }
  const cid = conversationId!;

  const conversation = await prisma.conversation.findFirst({
    where: { id: cid, userId },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 20, select: { role: true, content: true } } },
  });
  if (!conversation) throw new AppError(404, 'Conversation not found');

  await prisma.message.create({
    data: { conversationId: cid, role: 'user', content: message },
  });

  const aiPayload: Record<string, unknown> = {
    message,
    conversation_id: cid,
    persona: options?.persona ?? 'auto',
    user_id: userId,
    user: {
      display_name: user.displayName,
      gender: user.gender,
      nationality: user.nationality,
      language: user.language,
      budget_level: user.budgetLevel,
      travel_style: user.travelStyle,
      interests: user.interests,
      accommodation_type: user.accommodationType,
      preferences: prefs,
    },
    history: conversation.messages.reverse().map((item) => ({ role: item.role, content: item.content })),
    executionBudget: options.executionBudget ?? getAIExecutionBudget('AI_CHAT_QUERY'),
  };
  if (options?.lat !== undefined) aiPayload.lat = options.lat;
  if (options?.lon !== undefined) aiPayload.lon = options.lon;
  if (envContext) aiPayload.environment = envContext;
  if (geoContext) aiPayload.geography = geoContext;
  if (safetyContext) aiPayload.safety = safetyContext;
  if (currencyContext) aiPayload.currency = currencyContext;
  if (journeyProgress) aiPayload.user_journeys = journeyProgress;
  if (options?.context) aiPayload.context = options.context;

  let aiResponse: {
    response: string;
    context?: unknown;
    persona?: string;
    blocked?: boolean;
    reason?: string | null;
    usage?: { model?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
    providerCalls?: unknown;
    providerAttempts?: unknown;
  };
  try {
    aiResponse = await post<{
      response: string;
      context?: unknown;
      persona?: string;
      blocked?: boolean;
      reason?: string | null;
      usage?: { model?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
      providerCalls?: unknown;
      providerAttempts?: unknown;
    }>(
      `${env.AI_SERVICE_URL}/chat`,
      aiPayload,
      {
        ...(options?.authorization ? { Authorization: options.authorization } : {}),
        'X-Internal-Api-Key': env.INTERNAL_API_KEY,
      },
      AI_CHAT_TIMEOUT_MS,
    ).catch(() => {
      throw new AppError(502, 'AI service unavailable');
    });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 502) {
      return { ok: false };
    }
    throw err;
  }

  await recordAiUsage({
    userId,
    conversationId: cid,
    source: 'chat',
    usage: aiResponse.usage,
    providerCalls: aiResponse.providerCalls,
    providerAttempts: aiResponse.providerAttempts,
  });

  await prisma.message.create({
    data: {
      conversationId: cid,
      role: 'assistant',
      content: aiResponse.response,
    },
  });

  const result: Record<string, unknown> = {
    response: aiResponse.response,
    conversation_id: cid,
    persona: aiResponse.persona ?? options?.persona ?? 'auto',
  };
  if (aiResponse.blocked != null) result.blocked = aiResponse.blocked;
  if (aiResponse.reason != null) result.reason = aiResponse.reason;
  if (envContext) result.environment = envContext;
  if (geoContext) result.geography = geoContext;
  if (safetyContext) result.safety = safetyContext;
  if (currencyContext) result.currency = currencyContext;
  if (journeyProgress) result.user_journeys = journeyProgress;

  return {
    ok: true,
    result,
    providerCalls: aiResponse.providerCalls,
    providerAttempts: aiResponse.providerAttempts,
    usage: aiResponse.usage ?? null,
  };
}

export async function chat(
  userId: string,
  message: string,
  options: ChatOptions,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      displayName: true,
      gender: true,
      nationality: true,
      language: true,
      budgetLevel: true,
      travelStyle: true,
      interests: true,
      accommodationType: true,
      role: { select: { name: true } },
    },
  });
  if (!user) throw new AppError(404, 'User not found');

  // Resolve the authoritative rate card ONCE per operation before executing AI.
  let resolved;
  try {
    resolved = await resolveBillingRateCard();
  } catch (err) {
    if (err instanceof BillingRateCardUnavailableError) {
      throw new AppError(502, `Rate card unavailable: ${err.message}`);
    }
    throw err;
  }

  const result = await runUsageBasedAIBilling<Record<string, unknown>>({
    operationId: `usage:AI_CHAT_QUERY:${options.businessRequestId}`,
    userId,
    feature: 'AI_CHAT_QUERY',
    source: 'CHAT',
    idempotencyKey: options.businessRequestId,
    adminExempt: isTokenExemptUser(user),
    chatLimits: CHAT_LIMITS,
    executionBudget: getAIExecutionBudget('AI_CHAT_QUERY'),
    // Current text plus the configured space for history, summaries and
    // provider-visible system/context headroom is a safe pre-dispatch bound.
    estimatedInputTokens: Math.min(CHAT_LIMITS.maxInputTokens, Math.ceil(message.length / 4) + CHAT_LIMITS.historyTokenBudget + CHAT_LIMITS.summaryTokenBudget + CHAT_LIMITS.inputHeadroomTokens),
    optionalHistoryInputTokens: CHAT_LIMITS.historyTokenBudget,
    rateCard: resolved.card,
    pricingSource: resolved.source,
    walletPolicy: walletPolicyConfig,
    execute: async ({ executionBudget }) => {
      const core = await performChatCore(userId, message, { ...options, executionBudget }, user);
      if (!core.ok) return aiUnavailableOutcome('AI service unavailable');
      return buildSuccessOutcome(
        {
          ...core.result,
          providerCalls: core.providerCalls,
          providerAttempts: core.providerAttempts,
        },
        core.usage,
      );
    },
  });
  return resolveUsageBasedBillingResult(result, {
    feature: 'AI_CHAT_QUERY',
    replayMessage: 'Chat request already processed',
    aiUnavailableMessage: 'AI service unavailable',
  });
}

export async function getConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true } } },
  });
}

export async function getMessages(userId: string, conversationId: string) {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!conv) throw new AppError(404, 'Conversation not found');
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, createdAt: true },
  });
}

export async function deleteConversation(userId: string, id: string) {
  const conv = await prisma.conversation.findFirst({
    where: { id, userId },
  });
  if (!conv) throw new AppError(404, 'Conversation not found');
  await prisma.conversation.delete({ where: { id } });
}
