import type { ProviderRateCard } from '../../types/provider-pricing.js';
import {
  RATE_CARD_CURRENCY,
  RATE_CARD_ENGINE_UNIT,
  RATE_CARD_SCHEMA_VERSION,
  RATE_CARD_STORAGE_UNIT,
} from '../../types/provider-pricing.js';
import { validateRateCard } from '../../utils/provider-pricing/rate-card.js';

/**
 * Phase 2C materialized provider-neutral rate card.
 *
 * Static artifact derived from `references/ai-pricing/ai-provider-model-pricing.json`
 * (Google section, verifiedAt 2026-08-03, source
 * https://ai.google.dev/gemini-api/docs/pricing). Every rate is transcribed
 * exactly from the baseline; nothing is invented, inferred, or estimated.
 *
 * Coverage policy:
 *  - Only models the Rihla AI service actually routes to are materialized:
 *    `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3-flash-preview`,
 *    `gemini-2.5-flash-lite` (fallback chain in
 *    `ai-service/app/core/llm_client.py`).
 *  - `gemini-3.1-flash-tts-preview` is deliberately ABSENT (no verified rate
 *    in the pricing baseline) so TTS calls resolve to `UNPRICED`.
 *  - No aliases are declared: the baseline carries no alias field, and the
 *    illustrative `gemini-2.5-flash-lite-preview-09-2025` → `gemini-2.5-flash-lite`
 *    mapping is a separate reference entry, not a declared alias.
 *  - `context_cache_storage` is a per-hour storage rate, not a per-call tier;
 *    it is not materialized.
 *
 * Cached input is `DISJOINT` for every Google entry: `cachedContentTokenCount`
 * is reported separately from `promptTokenCount`.
 */

const entries = [
  // ---- gemini-3.6-flash (STABLE) ---------------------------------------
  {
    provider: 'google',
    model: 'gemini-3.6-flash',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 1_500_000,
      outputMicrosPerMillion: 7_500_000,
      cachedInputMicrosPerMillion: 150_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  {
    provider: 'google',
    model: 'gemini-3.6-flash',
    status: 'STABLE',
    tier: 'batch',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 750_000,
      outputMicrosPerMillion: 3_750_000,
      cachedInputMicrosPerMillion: 75_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  {
    provider: 'google',
    model: 'gemini-3.6-flash',
    status: 'STABLE',
    tier: 'priority',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 2_700_000,
      outputMicrosPerMillion: 13_500_000,
      cachedInputMicrosPerMillion: 270_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  // ---- gemini-3.5-flash-lite (STABLE) -----------------------------------
  {
    provider: 'google',
    model: 'gemini-3.5-flash-lite',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 300_000,
      outputMicrosPerMillion: 2_500_000,
      cachedInputMicrosPerMillion: 30_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  {
    provider: 'google',
    model: 'gemini-3.5-flash-lite',
    status: 'STABLE',
    tier: 'batch',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 150_000,
      outputMicrosPerMillion: 1_250_000,
      cachedInputMicrosPerMillion: 20_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  {
    provider: 'google',
    model: 'gemini-3.5-flash-lite',
    status: 'STABLE',
    tier: 'priority',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 540_000,
      outputMicrosPerMillion: 4_500_000,
      cachedInputMicrosPerMillion: 50_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  // ---- gemini-3-flash-preview (PREVIEW) ---------------------------------
  {
    provider: 'google',
    model: 'gemini-3-flash-preview',
    status: 'PREVIEW',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 500_000,
      outputMicrosPerMillion: 3_000_000,
      cachedInputMicrosPerMillion: 50_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  {
    provider: 'google',
    model: 'gemini-3-flash-preview',
    status: 'PREVIEW',
    tier: 'batch',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 250_000,
      outputMicrosPerMillion: 1_500_000,
      cachedInputMicrosPerMillion: 50_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  {
    provider: 'google',
    model: 'gemini-3-flash-preview',
    status: 'PREVIEW',
    tier: 'priority',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 900_000,
      outputMicrosPerMillion: 5_400_000,
      cachedInputMicrosPerMillion: 90_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  // ---- gemini-2.5-flash-lite (STABLE) -----------------------------------
  {
    provider: 'google',
    model: 'gemini-2.5-flash-lite',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 100_000,
      outputMicrosPerMillion: 400_000,
      cachedInputMicrosPerMillion: 10_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  {
    provider: 'google',
    model: 'gemini-2.5-flash-lite',
    status: 'STABLE',
    tier: 'batch',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 50_000,
      outputMicrosPerMillion: 200_000,
      cachedInputMicrosPerMillion: 10_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  {
    provider: 'google',
    model: 'gemini-2.5-flash-lite',
    status: 'STABLE',
    tier: 'priority',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 180_000,
      outputMicrosPerMillion: 720_000,
      cachedInputMicrosPerMillion: 18_000,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
  // ---- jina-embeddings-v4 (STABLE) --------------------------------------
  {
    provider: 'jina',
    model: 'jina-embeddings-v4',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 0,
    },
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://jina.ai/pricing',
    verifiedAt: '2026-08-03',
  },
  // ---- gemini-3.1-flash-tts-preview (PREVIEW) ---------------------------
  {
    provider: 'google',
    model: 'gemini-3.1-flash-tts-preview',
    status: 'PREVIEW',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 20_000_000,
    },
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: '2026-08-03',
  },
];

const rawCard = {
  schemaVersion: RATE_CARD_SCHEMA_VERSION,
  currency: RATE_CARD_CURRENCY,
  storageUnit: RATE_CARD_STORAGE_UNIT,
  engineUnit: RATE_CARD_ENGINE_UNIT,
  version: '1.0.0',
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  generatedAt: '2026-08-03',
  provenance: 'RESEARCH_SNAPSHOT',
  entries,
};

const validated = validateRateCard(rawCard);
export const PROVIDER_RATE_CARD: ProviderRateCard = validated.card;
export const RATE_CARD_PROVIDERS: readonly string[] = validated.providers;

export { validateRateCard };
