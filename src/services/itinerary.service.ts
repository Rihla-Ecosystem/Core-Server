import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  consumeBusinessTokensOrExempt,
  reverseBusinessTokensOrExempt,
} from './business-token-consumption.service.js';
import { recordAiUsage } from './ai-usage.service.js';
import { upstreamError } from '../utils/http-client.js';
import type { TokenExemptUser } from '../utils/token-exempt.js';

export interface ItineraryResult {
  itinerary: string;
  blocked?: boolean;
  reason?: string | null;
  usage?: {
    model?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
}

export interface GenerateItineraryInput {
  userId: string;
  businessRequestId: string;
  interests: string[];
  days: number;
  budget: string;
  style?: string;
  cities?: string[];
  baseCurrency?: string;
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
      feature: 'AI_TRIP_ITINERARY',
      source: 'ITINERARY',
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

export async function generateItineraryWithTokens(
  input: GenerateItineraryInput,
): Promise<ItineraryResult> {
  const consumption = await consumeBusinessTokensOrExempt(input.user, {
    userId: input.userId,
    feature: 'AI_TRIP_ITINERARY',
    source: 'ITINERARY',
    businessRequestId: input.businessRequestId,
  });

  if (consumption.idempotentReplay) {
    throw new AppError(409, 'Itinerary request already processed');
  }

  try {
    const response = await fetch(`${env.AI_SERVICE_URL}/itinerary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.authorization ? { Authorization: input.authorization } : {}),
        'X-Internal-Api-Key': env.INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        interests: input.interests,
        days: input.days,
        budget: input.budget,
        style: input.style ?? 'cultural',
        cities: input.cities,
        base_currency: input.baseCurrency,
      }),
    });

    if (!response.ok) {
      throw new AppError(502, await upstreamError('AI itinerary service unavailable', response));
    }

    const result = (await response.json()) as ItineraryResult;

    await recordAiUsage({
      userId: input.userId,
      source: 'itinerary',
      usage: result.usage,
    });

    return result;
  } catch (err) {
    return revertAndRethrow(input.userId, input.user, input.businessRequestId, err);
  }
}
