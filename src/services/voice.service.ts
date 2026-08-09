import { prisma } from '../config/prisma.js';
import { env, walletPolicyConfig } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { recordAiUsage } from './ai-usage.service.js';
import { runUsageBasedAIBilling } from './usage-based-ai-billing.service.js';
import { upstreamError } from '../utils/http-client.js';
import { isTokenExemptUser } from '../utils/token-exempt.js';
import { buildSuccessOutcome, aiUnavailableOutcome, resolveUsageBasedBillingResult } from '../utils/usage-billing.js';
import {
  BillingRateCardUnavailableError,
  resolveBillingRateCard,
} from './billing-rate-card.service.js';
import { parseChatLimitsConfig } from '../config/chat-limits.js';
import type { TokenExemptUser } from '../utils/token-exempt.js';

export interface VoiceResponse {
  text_response: string;
  audio_response?: string | null;
  audio_url?: string | null;
  conversation_id?: string | null;
  usage?: { model?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  providerCalls?: unknown;
  providerAttempts?: unknown;
}

interface VoiceOptions {
  userId: string;
  lat?: number;
  lon?: number;
  conversationId?: string;
  authorization?: string;
  persona?: string;
  context?: Record<string, unknown>;
  title?: string;
  transcript?: string;
}

async function callAiVoice(
  audioBuffer: Buffer,
  audioMimeType: string,
  options: VoiceOptions & { history: { role: string; content: string }[] },
): Promise<VoiceResponse> {
  const formData = new FormData();
  const ext = audioMimeType.split('/')[1] ?? 'webm';
  const blob = new Blob([audioBuffer], { type: audioMimeType });
  formData.append('audio', blob, `audio.${ext}`);
  if (options?.lat !== undefined) formData.append('lat', String(options.lat));
  if (options?.lon !== undefined) formData.append('lon', String(options.lon));
  if (options?.conversationId) formData.append('conversation_id', options.conversationId);
  if (options?.persona) formData.append('persona', options.persona);
  if (options?.context && Object.keys(options.context).length > 0) {
    formData.append('context', JSON.stringify(options.context));
  }
  if (options.history.length > 0) {
    formData.append('history', JSON.stringify(options.history));
  }
  if (options?.transcript) formData.append('transcript', options.transcript);

  const headers: Record<string, string> = {
    'X-Internal-Api-Key': env.INTERNAL_API_KEY,
  };
  if (options?.authorization) headers['Authorization'] = options.authorization;

  let response: Response;
  try {
    response = await fetch(`${env.AI_SERVICE_URL}/voice`, {
      method: 'POST',
      headers,
      body: formData,
      signal: AbortSignal.timeout(150_000),
    });
  } catch (err) {
    throw new AppError(502, `AI voice service unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {

  if (!response.ok) {
    throw new AppError(502, await upstreamError('AI voice service unavailable', response));
  }

  const result = (await response.json()) as VoiceResponse;
  // The frontend streams audio through the Core /api/voice/audio proxy via audio_url.
  // Drop the large base64 copy from the JSON response to keep the payload light.
  delete (result as { audio_response?: unknown }).audio_response;
  return result;
}

export async function processVoice(
  audioBuffer: Buffer,
  audioMimeType: string,
  options?: VoiceOptions,
): Promise<VoiceResponse> {
  const opts: Partial<VoiceOptions> = options ?? {};
  const userId = opts.userId;
  if (!userId) throw new AppError(401, 'Unauthorized');

  let conversationId = opts.conversationId;
  if (conversationId) {
    const existing = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!existing) conversationId = undefined;
  }
  if (!conversationId) {
    const title =
      opts.title?.trim()
      || opts.transcript?.trim()?.slice(0, 100)
      || 'Voice conversation';
    const conv = await prisma.conversation.create({
      data: { userId, title },
    });
    conversationId = conv.id;
  }

  const priorMessages = await prisma.message.findMany({
    where: { conversationId: conversationId! },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { role: true, content: true },
  });
  const history = priorMessages
    .filter((item) => item.role === 'assistant' || item.role === 'user')
    .map((item) => ({ role: item.role, content: item.content }));

  const userContent = opts.transcript?.trim() || '[voice message]';
  await prisma.message.create({
    data: { conversationId: conversationId!, role: 'user', content: userContent },
  });

  const result = await callAiVoice(audioBuffer, audioMimeType, {
    userId,
    lat: opts.lat,
    lon: opts.lon,
    conversationId,
    authorization: opts.authorization,
    persona: opts.persona,
    context: opts.context,
    title: opts.title,
    transcript: opts.transcript,
    history,
  });
  if (!conversationId) throw new AppError(500, 'Conversation creation failed');

  await prisma.message.create({
    data: {
      conversationId: conversationId!,
      role: 'assistant',
      content: result.text_response || '',
    },
  });

  await recordAiUsage({
    userId,
    conversationId: conversationId!,
    source: 'voice',
    usage: result.usage,
    providerCalls: result.providerCalls,
    providerAttempts: result.providerAttempts,
  });

  return { ...result, conversation_id: conversationId };
}

export interface ProcessVoiceWithTokensInput {
  userId: string;
  businessRequestId: string;
  audioBuffer: Buffer;
  audioMimeType: string;
  lat?: number;
  lon?: number;
  conversationId?: string;
  authorization?: string;
  persona?: string;
  context?: Record<string, unknown>;
  title?: string;
  transcript?: string;
  user?: TokenExemptUser;
}

const CHAT_LIMITS = parseChatLimitsConfig(process.env);

function voiceCore(input: ProcessVoiceWithTokensInput) {
  return processVoice(input.audioBuffer, input.audioMimeType, {
    userId: input.userId,
    lat: input.lat,
    lon: input.lon,
    conversationId: input.conversationId,
    authorization: input.authorization,
    persona: input.persona,
    context: input.context,
    title: input.title,
    transcript: input.transcript,
  });
}

export async function processVoiceWithTokens(
  input: ProcessVoiceWithTokensInput,
): Promise<VoiceResponse> {
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

  const result = await runUsageBasedAIBilling<VoiceResponse>({
    operationId: `usage:REAL_TIME_TRANSLATION:${input.businessRequestId}`,
    userId: input.userId,
    feature: 'REAL_TIME_TRANSLATION',
    source: 'VOICE',
    idempotencyKey: input.businessRequestId,
    adminExempt: isTokenExemptUser(input.user),
    chatLimits: CHAT_LIMITS,
    rateCard: resolved.card,
    pricingSource: resolved.source,
    walletPolicy: walletPolicyConfig,
    execute: async () => {
      try {
        const voice = await voiceCore(input);
        return buildSuccessOutcome(voice, voice.usage);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 502) {
          return aiUnavailableOutcome('AI voice service unavailable');
        }
        throw err;
      }
    },
  });
  return resolveUsageBasedBillingResult(result, {
    feature: 'REAL_TIME_TRANSLATION',
    replayMessage: 'Voice request already processed',
    aiUnavailableMessage: 'AI voice service unavailable',
  });
}
