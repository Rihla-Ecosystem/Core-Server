import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  consumeBusinessTokens,
  reverseBusinessTokens,
} from './business-token-consumption.service.js';

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
}

export async function identifyLandmark(
  imageBuffer: Buffer,
  imageMimeType: string,
  options?: {
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
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new AppError(502, 'AI identification service unavailable');
  }

  return response.json() as Promise<IdentifyResponse>;
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
}

async function revertAndRethrow(
  userId: string,
  businessRequestId: string,
  originalError: unknown,
): Promise<never> {
  try {
    await reverseBusinessTokens({
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
  const consumption = await consumeBusinessTokens({
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
      lat: input.lat,
      lon: input.lon,
      radius: input.radius,
      authorization: input.authorization,
    });
  } catch (err) {
    return revertAndRethrow(input.userId, input.businessRequestId, err);
  }
}
