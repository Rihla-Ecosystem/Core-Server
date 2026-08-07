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
  providerCalls?: unknown;
  providerAttempts?: unknown;
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

const CHAT_LIMITS = parseChatLimitsConfig(process.env);

async function generateItinerary(input: GenerateItineraryInput): Promise<ItineraryResult> {
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
    providerCalls: result.providerCalls,
    providerAttempts: result.providerAttempts,
  });

  return result;
}

export async function generateItineraryWithTokens(
  input: GenerateItineraryInput,
): Promise<ItineraryResult> {
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

  const result = await runUsageBasedAIBilling<ItineraryResult>({
    operationId: `usage:AI_TRIP_ITINERARY:${input.businessRequestId}`,
    userId: input.userId,
    feature: 'AI_TRIP_ITINERARY',
    source: 'ITINERARY',
    idempotencyKey: input.businessRequestId,
    adminExempt: isTokenExemptUser(input.user),
    chatLimits: CHAT_LIMITS,
    rateCard: resolved.card,
    pricingSource: resolved.source,
    walletPolicy: walletPolicyConfig,
    execute: async () => {
      try {
        const itinerary = await generateItinerary(input);
        return buildSuccessOutcome(itinerary, itinerary.usage);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 502) {
          return aiUnavailableOutcome('AI itinerary service unavailable');
        }
        throw err;
      }
    },
  });
  return resolveUsageBasedBillingResult(result, {
    feature: 'AI_TRIP_ITINERARY',
    replayMessage: 'Itinerary request already processed',
    aiUnavailableMessage: 'AI itinerary service unavailable',
  });
}
