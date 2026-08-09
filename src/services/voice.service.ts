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

export async function processVoice(
  audioBuffer: Buffer,
  audioMimeType: string,
  options?: {
    userId: string;
    lat?: number;
    lon?: number;
    conversationId?: string;
    authorization?: string;
  },
): Promise<VoiceResponse> {
  const formData = new FormData();
  const ext = audioMimeType.split('/')[1] ?? 'webm';
  const blob = new Blob([audioBuffer], { type: audioMimeType });
  formData.append('audio', blob, `audio.${ext}`);
  if (options?.lat !== undefined) formData.append('lat', String(options.lat));
  if (options?.lon !== undefined) formData.append('lon', String(options.lon));
  if (options?.conversationId) formData.append('conversation_id', options.conversationId);

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
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new AppError(502, `AI voice service unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    throw new AppError(502, await upstreamError('AI voice service unavailable', response));
  }

  const result = (await response.json()) as VoiceResponse;

  await recordAiUsage({
    userId: options!.userId,
    conversationId: options?.conversationId,
    source: 'voice',
    usage: result.usage,
    providerCalls: result.providerCalls,
    providerAttempts: result.providerAttempts,
  });

  return result;
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
