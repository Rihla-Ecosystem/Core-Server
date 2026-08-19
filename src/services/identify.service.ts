import { env, walletPolicyConfig } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { runUsageBasedAIBilling } from './usage-based-ai-billing.service.js';
import { recordAiUsage } from './ai-usage.service.js';
import { upstreamError } from '../utils/http-client.js';
import { isTokenExemptUser } from '../utils/token-exempt.js';
import {
  buildExplicitCacheHitOutcome,
  buildSuccessOutcome,
  aiUnavailableOutcome,
  resolveUsageBasedBillingResultAsync,
} from '../utils/usage-billing.js';
import { repairConversationContextEvent } from '../utils/conversation-context.js';
import {
  BillingRateCardUnavailableError,
  resolveBillingRateCard,
} from './billing-rate-card.service.js';
import { parseChatLimitsConfig } from '../config/chat-limits.js';
import { getAIExecutionBudget } from '../config/ai-execution-budget.js';
import type { AIExecutionBudget } from '../config/ai-execution-budget.js';
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
  providerCalls?: unknown;
  providerAttempts?: unknown;
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
    executionBudget?: AIExecutionBudget;
  },
): Promise<IdentifyResponse> {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: imageMimeType });
  formData.append('image', blob, `image.${imageMimeType.split('/')[1] ?? 'jpg'}`);
  if (options?.lat !== undefined) formData.append('lat', String(options.lat));
  if (options?.lon !== undefined) formData.append('lon', String(options.lon));
  if (options?.radius !== undefined) formData.append('radius', String(options.radius));
  formData.append('executionBudget', JSON.stringify(options?.executionBudget ?? getAIExecutionBudget('AI_IMAGE_ANALYSIS')));

  const headers: Record<string, string> = {
    'X-Internal-Api-Key': env.INTERNAL_API_KEY,
  };
  if (options?.authorization) headers['Authorization'] = options.authorization;

  const response = await fetch(`${env.AI_SERVICE_URL}/identify`, {
    method: 'POST',
    headers,
    body: formData,
    signal: AbortSignal.timeout(150_000),
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
      providerCalls: result.providerCalls,
      providerAttempts: result.providerAttempts,
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
  conversationId?: string;
}

const CHAT_LIMITS = parseChatLimitsConfig(process.env);

function identifyCore(input: IdentifyLandmarkWithTokensInput, executionBudget?: AIExecutionBudget) {
  return identifyLandmark(input.image, input.mimeType, {
    userId: input.userId,
    lat: input.lat,
    lon: input.lon,
    radius: input.radius,
    authorization: input.authorization,
    executionBudget,
  });
}

export async function identifyLandmarkWithTokens(
  input: IdentifyLandmarkWithTokensInput,
): Promise<IdentifyResponse> {
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

  const result = await runUsageBasedAIBilling<IdentifyResponse>({
    operationId: `usage:AI_IMAGE_ANALYSIS:${input.businessRequestId}`,
    userId: input.userId,
    feature: 'AI_IMAGE_ANALYSIS',
    source: 'IMAGE',
    idempotencyKey: input.businessRequestId,
    adminExempt: isTokenExemptUser(input.user),
    chatLimits: CHAT_LIMITS,
    executionBudget: getAIExecutionBudget('AI_IMAGE_ANALYSIS'),
    // Image bytes are not tokens. The quote utility prices the bounded Phase 2
    // image-token exposure using the database card's token modality semantics.
    estimatedInputTokens: 0,
    rateCard: resolved.card,
    pricingSource: resolved.source,
    walletPolicy: walletPolicyConfig,
    execute: async ({ executionBudget }) => {
      try {
        const identified = await identifyCore(input, executionBudget);
        // This is the AI-service's explicit cache contract. It is the sole
        // path allowed to omit usage evidence and settle as zero cost.
        if (identified.cached === true && Array.isArray(identified.providerCalls) && identified.providerCalls.length === 0) {
          return buildExplicitCacheHitOutcome(identified);
        }
        return buildSuccessOutcome(identified, identified.usage);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 502) {
          return aiUnavailableOutcome('AI identification service unavailable');
        }
        throw err;
      }
    },
  });

  return resolveUsageBasedBillingResultAsync(result, {
    feature: 'AI_IMAGE_ANALYSIS',
    replayMessage: 'Image analysis request already processed',
    aiUnavailableMessage: 'AI identification service unavailable',
    onReplay: async () => {
      if (input.conversationId) {
        try {
          await repairConversationContextEvent({
            conversationId: input.conversationId,
            businessRequestId: input.businessRequestId,
            feature: 'AI_IMAGE_ANALYSIS',
          });
        } catch (err) {
          console.error('[identify] replay context repair error:', err);
        }
      }
    },
  });
}
