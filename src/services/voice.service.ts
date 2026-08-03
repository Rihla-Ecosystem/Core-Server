import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { recordAiUsage } from './ai-usage.service.js';
import { upstreamError } from '../utils/http-client.js';
import {
  consumeBusinessTokensOrExempt,
  reverseBusinessTokensOrExempt,
} from './business-token-consumption.service.js';
import type { TokenExemptUser } from '../utils/token-exempt.js';

export interface VoiceResponse {
  text_response: string;
  audio_response?: string | null;
  audio_url?: string | null;
  conversation_id?: string | null;
  usage?: { model?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  providerCalls?: unknown;
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

  const response = await fetch(`${env.AI_SERVICE_URL}/voice`, {
    method: 'POST',
    headers,
    body: formData,
  });

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

async function revertAndRethrow(
  userId: string,
  user: TokenExemptUser | undefined,
  businessRequestId: string,
  originalError: unknown,
): Promise<never> {
  try {
    await reverseBusinessTokensOrExempt(user, {
      userId,
      feature: 'AI_CHAT_QUERY',
      source: 'VOICE',
      businessRequestId,
    });
  } catch (refundError) {
    console.error(
      'Failed to restore consumed tokens',
      {
        userId,
        businessRequestId,
        originalError: originalError instanceof Error ? originalError.message : String(originalError),
        refundError: refundError instanceof Error ? refundError.message : String(refundError),
      },
    );
    throw new AppError(500, 'Unable to restore consumed tokens');
  }
  throw originalError;
}

export async function processVoiceWithTokens(
  input: ProcessVoiceWithTokensInput,
): Promise<VoiceResponse> {
  const consumption = await consumeBusinessTokensOrExempt(input.user, {
    userId: input.userId,
    feature: 'AI_CHAT_QUERY',
    source: 'VOICE',
    businessRequestId: input.businessRequestId,
  });

  if (consumption.idempotentReplay) {
    throw new AppError(409, 'Voice request already processed');
  }

  try {
    return await processVoice(input.audioBuffer, input.audioMimeType, {
      userId: input.userId,
      lat: input.lat,
      lon: input.lon,
      conversationId: input.conversationId,
      authorization: input.authorization,
    });
  } catch (err) {
    return revertAndRethrow(input.userId, input.user, input.businessRequestId, err);
  }
}
