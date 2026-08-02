import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  consumeBusinessTokensOrExempt,
  reverseBusinessTokensOrExempt,
} from './business-token-consumption.service.js';
import { recordAiUsage } from './ai-usage.service.js';
import { upstreamError } from '../utils/http-client.js';
import type { TokenExemptUser } from '../utils/token-exempt.js';

export interface IdentifyResponse {
  name: string;
  name_ar?: string | null;
  description: string;
  category?: string | null;
  historical_period?: string | null;
  wikipedia_url?: string | null;
  image_url?: string | null;
  nearby_sites?: unknown[] | null;
  cached: boolean;
  usage?: { model?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
}

export async function identifyLandmark(
  imageBuffer: Buffer,
  imageMimeType: string,
  options?: {
    userId: string;
    lat?: number;
    lon?: number;
    radius?: number;
    authorization?: string;
  },
): Promise<IdentifyResponse> {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: imageMimeType });
  formData.append('image', blob, `image.${imageMimeType.split('/')[1] ?? 'jpg'}`);
  if (options?.lat !== undefined) formData.append('lat', String(options.lat));
  if (options?.lon !== undefined) formData.append('lon', String(options.lon));
  if (options?.radius !== undefined) formData.append('radius', String(options.radius));

  const headers: Record<string, string> = {
    'X-Internal-Api-Key': env.INTERNAL_API_KEY,
  };
  if (options?.authorization) headers['Authorization'] = options.authorization;

  const response = await fetch(`${env.AI_SERVICE_URL}/identify`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new AppError(502, await upstreamError('AI identification service unavailable', response));
  }

  const result = (await response.json()) as IdentifyResponse;

  if (!result.cached) {
    await recordAiUsage({
      userId: options!.userId,
      source: 'identify',
      usage: result.usage,
    });
  }

  return result;
}

export interface IdentifyLandmarkWithTokensInput {
  userId: string;
  businessRequestId: string;
  image: Buffer;
  mimeType: string;
  lat?: number;
  lon?: number;
  radius?: number;
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
      feature: 'AI_IMAGE_ANALYSIS',
      source: 'IMAGE',
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

export async function identifyLandmarkWithTokens(
  input: IdentifyLandmarkWithTokensInput,
): Promise<IdentifyResponse> {
  const consumption = await consumeBusinessTokensOrExempt(input.user, {
    userId: input.userId,
    feature: 'AI_IMAGE_ANALYSIS',
    source: 'IMAGE',
    businessRequestId: input.businessRequestId,
  });

  if (consumption.idempotentReplay) {
    throw new AppError(409, 'Image analysis request already processed');
  }

  try {
    return await identifyLandmark(input.image, input.mimeType, {
      userId: input.userId,
      lat: input.lat,
      lon: input.lon,
      radius: input.radius,
      authorization: input.authorization,
    });
  } catch (err) {
    return revertAndRethrow(input.userId, input.user, input.businessRequestId, err);
  }
}
