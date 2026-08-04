# Phase 2A — Provider-Neutral Shadow Pricing: Design & Scope Lock (Revised)

**Status:** DESIGN_REVISED_FOR_REVIEW
**Date:** 2026-08-03
**Task type:** design correction only (no production code, tests, Prisma, migrations, Wallet logic, pricing activation, package, dependency, or environment files changed; no commit; no push).
**Repositories (read-only inputs):**
- Core Server — `Core-Server-provider-pricing-phase2`, branch `feature/provider-pricing-phase2`, HEAD `d0f34c7`.
- AI Service — `ai-service-provider-pricing-phase2`, branch `feature/provider-pricing-phase2`, HEAD `a31602f`.

---

## 1. Executive Design

Phase 2 adds a **provider-neutral shadow pricing engine** to the Core Server. The engine prices **every real provider call independently** using the Phase 1 `providerCalls` contract as its sole authoritative input, produces a deterministic **PRICED or UNPRICED** result with an explicit reason per call via a **discriminated union**, and aggregates at the user-request level.

The engine is **shadow by design**:

- It computes provider cost in **integer nano-USD (nUSD)** with **BigInt-only money arithmetic** (`1 USD = 1_000_000_000 nUSD`). Micro-USD / USD are produced **only at an explicit display/reporting boundary**.
- It is **additive**: it never changes Wallet fixed pricing, the legacy `usage`/`model` telemetry contract, the existing `computeAiCost` telemetry cost, the dormant durable billing path, or any `AiUsageLog` row.
- It **never prices an unknown or malformed call as zero** and **never fabricates a rate** absent from the rate card.
- **`actualModel` is authoritative whenever present.** When `actualModel` is present but unresolvable in the rate card, the call is `UNPRICED` (`ACTUAL_MODEL_NOT_IN_RATECARD`) — the engine **never** falls back to `requestedModel` in that case. `requestedModel` is used only when `actualModel` is absent.
- It is wired at a single Core choke point (`recordAiUsage`) so every live feature is covered without per-route churn.
- It is **provider-neutral by construction**: the engine contains no closed provider list. Supported providers are derived solely from the validated rate-card entries; a provider absent from the rate card returns `UNPRICED` (`PROVIDER_NOT_IN_RATECARD`).

Rate values are carried in a **versioned, dated rate card** materialized from the research baselines under `references/ai-pricing/`. Those files are **research snapshots, not live billing rates**; the rate card records `source`, `verifiedAt`, and `provenance: "RESEARCH_SNAPSHOT"` and must be re-verified before any future billing activation.

**Safety invariants locked in this design:**

1. `providerCalls` is authoritative for pricing; legacy `usage`/`model` never feed the engine.
2. Unknown/malformed ⇒ `UNPRICED` + reason. `UNPRICED` results **contain no cost field** (no zero `costNanoUsd` / `costMicros`). Explicit provider-reported zero usage is `PRICED` with zero cost.
3. `actualModel` is authoritative whenever present; an unresolvable `actualModel` is `UNPRICED`, never resolved via `requestedModel`.
4. Modality breakdown fields are non-additive to the aggregate; never double-counted.
5. Reasoning tokens are priced inside output, never added as a separate charge.
6. Cached-input tokens are priced at the cached-input rate only when reported, as a disjoint count.
7. All money is integer nano-USD (BigInt) internally; components and calls are summed in nano-USD; exact deterministic rounding happens only at the output boundary.
8. Supported providers are derived from validated rate-card entries; no hard-coded provider list in the engine.
9. Cache hits are represented by an **empty `providerCalls` array**; `providerCallMade=false` records are defensively ignored; cache hits never create a priced or unpriced call.
10. Request summary statuses are exactly `FULLY_PRICED` | `PARTIALLY_PRICED` | `UNPRICED`.
11. **No Prisma schema change or migration anywhere in Phase 2.** Phase 2D persists nothing durably; it logs structured shadow results and computes coverage in-memory / recompute-on-read. `AiShadowPricingLog`, migrations, durable persistence, and historical backfill are moved to a future separate phase.
12. No Wallet billing activation and no durable billing activation.

---

## 2. Current-State Summary

Verified at the pinned commits (Core `d0f34c7`, AI `a31602f`):

| Area | Current behavior | Evidence |
|---|---|---|
| Wallet fixed pricing | Live on `/chat`, `/chat/stream`, `/identify`, `/voice`, `/itinerary`; `BUSINESS_TOKEN_PRICING_VERSION = 1`; `AI_CHAT_QUERY:1`, `AI_IMAGE_ANALYSIS:5`, `REAL_TIME_TRANSLATION:3`, `AI_TRIP_ITINERARY:10`. | `src/config/business-token-features.ts` |
| Usage telemetry | `recordAiUsage` writes `AiUsageLog` rows; per-provider-call rows preferred when `providerCalls` valid; legacy single row otherwise. | `src/services/ai-usage.service.ts` |
| Telemetry cost | `computeAiCost` uses Gemini-specific USD/M floats + `"lite"`/`"flash"` substring heuristics; stale vs. research baseline for `gemini-3.6-flash` and `gemini-3.5-flash-lite`. | `src/config/ai-pricing.ts` |
| Provider call contract | `ProviderCallUsage` (provider, providerCallId, requestedModel, actualModel, operation, counts, modality token fields) normalized defensively by `normalizeProviderCalls`. | `src/types/ai.ts`, `src/utils/ai-usage.ts` |
| Durable usage billing | `runAIBillingOrchestration` + quote/pricing utils exist but are imported only by tests; dormant. | `src/services/ai-billing-orchestrator.service.ts`, `tests/ai-billing-orchestrator*.test.ts` |
| Prisma | `AiUsageLog` has no provider/operation/providerCallId/requestedModel/cached/reason/rate-card columns; `cost` is `Decimal(12,6)`. | `prisma/schema.prisma:611` |
| AI Service | Emits one `ProviderCallUsage` per real call; stream usage from final cumulative snapshot only; cache hits emit `providerCalls=[]`; TTS call captured but `gemini-3.1-flash-tts-preview` absent from pricing baseline. | `app/core/usage.py`, `app/core/gemini_usage.py`, `app/api/*.py` |
| Pricing reference baselines | Research snapshots dated 2026-08-03; google models include the four Rihla Gemini models; TTS model absent from pricing JSON; capabilities file lists a TTS rate ($1/$20 per M) not present in the pricing baseline. | `references/ai-pricing/*` |

Gaps this phase closes: no per-call pricing exists in Core; `providerCalls` is telemetry-only; there is no rate-card versioning, effective-date handling, alias resolution, or PRICED/UNPRICED reporting; no modality-safe arithmetic; no provider-neutral model-identity rules.

---

## 3. Phase 2 Scope

**In scope (Phase 2A design lock; implemented across 2B → 2D):**

1. Price every provider call independently, keyed on `providerCallId`.
2. `actualModel`-authoritative model identity with a strict, documented fallback policy (only when `actualModel` is absent).
3. Explicit PRICED / UNPRICED results as a discriminated union with explicit reasons.
4. Multi-model request support (one result entry per provider call; request-level aggregation).
5. Modality breakdown anti-double-counting.
6. Deterministic integer (BigInt) **nano-USD** arithmetic.
7. Versioned rate cards with effective dates and curated model aliases.
8. Provider-neutral engine (no closed provider list; providers derived from the rate card).
9. Shadow integration in Core at the `recordAiUsage` choke point.
10. Coverage metrics: priced/unpriced calls, cost per request, per feature, and **Cost Per Configured Wallet Point** (from fixed feature-cost configuration).
11. Documentation of what the current `AiUsageLog` can/cannot persist, and the future separate persistence phase.
12. A per-subphase test plan.

**Phase sub-split (locked):**

- **Phase 2B — Contract hardening and model identity.** Types (discriminated union, enums), provider-neutrality rules, model-identity resolution (authoritative `actualModel`). No rate card, no engine, no wiring.
- **Phase 2C — Rate card and pure pricing engine.** Rate-card materialization/validation, BigInt nano-USD arithmetic, per-call pricing, request aggregation. No wiring.
- **Phase 2D — Shadow integration.** Wire the pure engine at the `recordAiUsage` choke point; emit structured logs; provide in-memory / recompute-on-read coverage only. **No Prisma, no migration.**
- **Future phase (out of Phase 2):** `AiShadowPricingLog` model + migrations, durable persistence, historical backfill, durable exact cost-per-charged-point correlation.

---

## 4. Explicit Non-Goals

1. **No Wallet charging from shadow prices.** Wallet fixed pricing (`BUSINESS_TOKEN_FEATURE_COSTS`), consumption/reversal, reservations, and `tokenized-service-execution` remain unchanged and authoritative for user debits.
2. **No durable usage billing activation.** `runAIBillingOrchestration`, `ai-billing-operation`, `ai-billing-recovery`, `ai-reservation-quote`, and `calculateAIUsagePrice` (the dormant PROVIDER_USAGE path) are untouched and stay dormant.
3. **No Prisma schema or migration anywhere in Phase 2.** `AiUsageLog` is reused as-is. The `AiShadowPricingLog` table, its migration, durable persistence, and historical backfill are explicitly deferred to a future separate phase.
4. **No AI Service change required for Phase 2.** The `ProviderCallUsage` wire contract from Phase 1 is sufficient. Optional AI-service enrichment (audio-output token reporting for TTS) is deferred and non-blocking.
5. **No live provider calls and no new rates invented.** Missing rates (notably TTS) resolve to `UNPRICED` with a reason until a live probe / refreshed baseline supplies them.
6. **No change to the legacy telemetry contract.** `usage`/`model` response fields, `computeAiCost`, and `AiUsageLog.cost` semantics stay as-is.
7. **No package, dependency, or environment changes.** Existing node_modules and the pinned AI venv are used in place.
8. **No floating-point money anywhere** in the pricing path.
9. **No network calls, no new env vars required** for the pricing engine to function.
10. **No exact correlation with `TokenTransaction` records.** Phase 2 reports **Cost Per Configured Wallet Point** from the fixed feature-cost configuration only; exact cost-per-charged-point correlation is a future phase that requires a stable operation/billing correlation id.
11. **No closed provider list in the engine.** Providers are derived from validated rate-card entries; this is a hard neutrality requirement.

---

## 5. Contract Changes

**Input contract (unchanged, authoritative):** `ProviderCallUsage` as already emitted by the AI Service and normalized by `normalizeProviderCalls` (`src/types/ai.ts`, `src/utils/ai-usage.ts`). Shadow pricing consumes only this. Legacy `usage`/`model` are never used for pricing.

**New Core-side output contracts (added in Phase 2B/2C):**

- `RateCardEntry` / `ProviderRateCard` — the versioned rate card (§7).
- `ShadowPricedCall` — a **discriminated union** of `PRICED` and `UNPRICED` variants (§9).
- `ShadowPricingResult` — request-level aggregation with the three standardized summary statuses (§9).
- `PricedVia` and `UnpricedReason` enums (§10).
- `ShadowPricingInput` — `{ providerCalls: unknown; pricingDate?: string; tier?: RateCardTier }`.

**Discriminated-union result contract (Phase 2B):**

```
type ShadowPricedCall =
  | {
      kind: 'PRICED'
      providerCallId: string
      provider: string
      operation?: string
      requestedModel?: string
      actualModel?: string
      reason: PricedVia                       // ACTUAL_MODEL | REQUESTED_MODEL_FALLBACK | ZERO_USAGE_EXPLICIT
      rateCard: { version: string; model: string; tier: string; billingUnit: string }
      costNanoUsd: bigint                     // exact internal cost; present ONLY on PRICED
      usageApplied?: { inputTokens?; outputTokens?; cachedInputTokens?; cachedOutputTokens?; generatedImageCount? }
      pricedAt: string
    }
  | {
      kind: 'UNPRICED'
      providerCallId: string
      provider: string
      operation?: string
      requestedModel?: string
      actualModel?: string
      reason: UnpricedReason
      pricedAt: string
      // NO cost field of any kind: costNanoUsd / costMicros / costUsd are
      // forbidden on UNPRICED. "Zero cost" must never be fabricated.
    }
```

**Dormant-path compatibility note:** the existing `AIProviderTokenRate` type in `src/types/ai-pricing.ts` is left unchanged; the new rate card is a separate, richer type. The dormant path continues to compile and pass its tests unmodified.

---

## 6. Model Identity Rules

### 6.1 Provider identity (provider-neutral)

- **No closed provider list exists in the engine.** Supported providers are the set of `provider` values present in validated rate-card entries.
- Normalization: trim + lowercase (e.g. `"Google"` → `"google"`).
- Resolution: a call's normalized provider must match at least one active rate-card entry for that provider. Otherwise ⇒ `UNPRICED`, reason `PROVIDER_NOT_IN_RATECARD`.
- Provider strings are never derived from model strings.

### 6.2 Canonical model identity

The canonical model id is the provider-reported model string (from `actualModel`, else `requestedModel`), trimmed, preserved in canonical form for display, and **case-insensitively** resolved for lookup.

### 6.3 Model alias rules

Aliases live inside the rate card (curated, 1:1). Resolution order for a single model id:

1. **Exact canonical match** on the rate card entry `model`.
2. **Alias map** `aliases: string[]` → one canonical model (e.g. `gemini-2.5-flash-lite-preview-09-2025` → `gemini-2.5-flash-lite`).
3. Miss ⇒ model not in rate card.

Rules:

- Aliases are **1:1** (one alias maps to exactly one canonical model). No wildcards, no globs.
- **Substring/fuzzy matching is forbidden** (this explicitly rejects the current `"lite"`/`"flash"` heuristic in `src/config/ai-pricing.ts`).
- Alias resolution precedes effective-date resolution (an alias points at a canonical entry; that entry's date window then applies).
- An alias that would create a cycle or a duplicate target is a rate-card validation error.

### 6.4 actualModel vs requestedModel rules (authoritative actualModel)

`actualModel` is authoritative **whenever present**. The engine never substitutes `requestedModel` for a present-but-unresolvable `actualModel`.

| `actualModel` | `requestedModel` | Resolution |
|---|---|---|
| present, resolvable | any | `PRICED`, priced on `actualModel`. Reason `ACTUAL_MODEL`. |
| present, **unresolvable** | any (even resolvable) | `UNPRICED`. Reason `ACTUAL_MODEL_NOT_IN_RATECARD`. **No fallback to `requestedModel`.** |
| absent | present, resolvable | `PRICED`, priced on `requestedModel`. Reason `REQUESTED_MODEL_FALLBACK`. |
| absent | present, **unresolvable** | `UNPRICED`. Reason `REQUESTED_MODEL_NOT_IN_RATECARD`. |
| absent | absent | `UNPRICED`. Reason `MODEL_MISSING`. |

Notes:

- `actualModel` is never fabricated; a provider that does not report one triggers the `requestedModel` fallback only under the exact "absent" conditions above.
- A call whose `actualModel` differs from `requestedModel` is priced at `actualModel` — the correct behavior for mid-turn fallback where a single request spans two models.
- There is **no** `actualModelMiss`/"best effort" state: identity resolution is strictly binary (resolved or `UNPRICED`).

---

## 7. Rate-Card Schema

### 7.1 Design

```
ProviderRateCard {
  schemaVersion: 1
  currency: "USD"
  storageUnit: "MICROS"                       // rate card entries are stored as integer micro-USD
  engineUnit: "NANO_USD"                      // engine sums in integer nano-USD (1 USD = 1e9 nUSD)
  version: string                             // e.g. "2026-08-03.v1"
  source: string                              // provenance path e.g. "references/ai-pricing/ai-provider-model-pricing.json"
  generatedAt: string                         // ISO date of materialization
  provenance: "RESEARCH_SNAPSHOT"             // explicitly not live billing
  entries: RateCardEntry[]
}

RateCardEntry {
  provider: string                            // canonical provider id (engine-neutral; derived set)
  model: string                               // canonical model id
  aliases: string[]                           // curated 1:1 aliases, optional
  status: "STABLE" | "PREVIEW" | "DEPRECATED" | "LIMITED_AVAILABILITY"
  tier: "standard" | "batch" | "priority" | "fast_mode"    // default "standard"
  billingUnit: "TOKEN" | "IMAGE" | "SECOND" | "MINUTE" | "CHARACTER"

  // Token-based rates (integer micro-USD per 1M tokens). null = not published.
  tokenRates?: {
    inputMicrosPerMillion?: number
    outputMicrosPerMillion?: number
    cachedInputMicrosPerMillion?: number
    cachedOutputMicrosPerMillion?: number
  }

  // Non-token per-unit rate (whole micro-USD per unit), e.g. 39000 for a $0.039 image.
  perUnitMicros?: number

  // Optional modality overrides: micro-USD per 1M for a distinct modality
  // line within the aggregate token count (e.g. Gemini audio-input upcharge).
  modalityRates?: {
    audioInputMicrosPerMillion?: number
  }

  // TTS-specific conversion + rate (audio output priced per output token;
  // tokens per second only when the provider documents it, e.g. 25 for Gemini TTS).
  tts?: {
    audioOutputMicrosPerMillion?: number
    tokensPerSecond?: number
  }

  effectiveFrom: string                       // ISO date (inclusive)
  effectiveTo?: string                        // ISO date (inclusive), optional
  inactive: boolean                           // hard-disable switch
  source?: string                             // per-entry provenance/URL
  verifiedAt?: string                         // ISO date of verification
}
```

Rate-card rates are stored as **integer micro-USD** (matching the baseline files exactly, avoiding transcription error). The engine converts each rate to nano-USD internally using `NANO_PER_MICRO = 1_000` (see §8). For every published Phase 2 rate, `rateMicrosPerMillion` is a multiple of 1 000, so the per-token rate in nano-USD is an exact integer.

### 7.2 Validation rules (enforced at load, fail fast on bad card)

- Non-empty `provider`/`model`; unique `provider + model + tier` key.
- Aliases are 1:1 and resolve to an existing canonical model.
- Every present rate is a non-negative safe integer; `null`/absent means unpublished.
- `effectiveFrom` present and valid ISO; `effectiveTo >= effectiveFrom` when present.
- `perUnitMicros` and `billingUnit` agree (a `perUnitMicros` without a non-`TOKEN` billing unit is an error, and a non-`TOKEN` billing unit without `perUnitMicros` is an error).
- No more than one active (`inactive=false`) entry for the same `provider + model + tier` at any given effective window (scheduled changes are expressed via distinct windows, not duplicates).
- **Provider set is derived, not declared:** no separate "supported providers" constant may exist in the engine; supported providers are the distinct `provider` values in `entries`.

### 7.3 Rate-card materialization policy

- The Phase 2 rate card is a **static TypeScript/JSON artifact under `src/config/`**, derived from the research baselines by a reviewable mapping, with every entry carrying `source` + `verifiedAt` + `provenance`.
- **Rates are never entered by hand into code from memory** and never injected via the old `AI_PRICING_JSON` float env mechanism.
- Baseline vs. Core telemetry discrepancies (e.g. `gemini-3.6-flash` $0.30/$2.50 in Core vs $1.50/$7.50 in baseline) are resolved in favor of the **rate card** for shadow pricing; the legacy `computeAiCost` is deliberately left untouched (telemetry-only, backward compatible).
- **TTS rate (`gemini-3.1-flash-tts-preview`): not materialized.** It is absent from the pricing baseline (present only in the capabilities file at $1/$20 per M, an inconsistent snapshot) ⇒ TTS calls resolve to `UNPRICED` (`ACTUAL_MODEL_NOT_IN_RATECARD` / `UNIT_UNPRICED`) until a live probe or a refreshed baseline supplies and verifies the rate.

---

## 8. Monetary Arithmetic Design

### 8.1 Internal unit: integer nano-USD (nUSD)

Decision: **integer nano-USD (`1 USD = 1_000_000_000 nUSD`), BigInt-only, internal.**

- `NANO_PER_USD = 1_000_000_000n`
- `NANO_PER_MICRO = 1_000n`
- `MICROS_PER_MILLION = 1_000_000n` (µUSD per 1M-token conversion)

Rationale:

- Nano-USD (10⁻⁹ USD) gives **exact representation of every published rate and per-unit price** in the baselines, including sub-micro cents ($0.017/min = 17 000 000 nUSD/min; $0.039/image = 39 000 000 nUSD/image; $1.50/1M tokens = 1 500 000 µUSD = 1 500 000 000 nUSD/M, i.e. 1 500 nUSD/token).
- Micro-USD was rejected as the **internal** unit because per-component micro-USD ceiling **materially overstates small calls** (see §8.4 worked example).
- The internal engine uses **arbitrary-precision BigInt**, so no overflow is reachable during pricing; safe-integer concerns are confined to the display/reporting boundary (§8.3).

### 8.2 Component and summation math (all in nUSD)

```
// Token components — exact integer nano-USD.
// rateMicrosPerMillion is read from the rate card (micro-USD per 1M tokens).
inputNanoUsd        = ceilDiv(inputTokens        * inputRateMicrosPerMillion        * NANO_PER_MICRO, MICROS_PER_MILLION)
outputNanoUsd       = ceilDiv(outputTokens       * outputRateMicrosPerMillion       * NANO_PER_MICRO, MICROS_PER_MILLION)
cachedInputNanoUsd  = ceilDiv(cachedInputTokens  * cachedInputRateMicrosPerMillion  * NANO_PER_MICRO, MICROS_PER_MILLION)
cachedOutputNanoUsd = ceilDiv(cachedOutputTokens * cachedOutputRateMicrosPerMillion * NANO_PER_MICRO, MICROS_PER_MILLION)
   // Because Phase 2 rates are multiples of 1000 µUSD, these reduce to exact
   // integer nUSD per token with no fractional remainder; ceilDiv is applied
   // only to guarantee integer output for any validated rate.

// Per-unit components — exact when the count is an integer:
perUnitNanoUsd      = unitCount * perUnitMicros * NANO_PER_MICRO
   // Fractional units (e.g. seconds) are first promoted to an integer sub-unit
   // (nano-seconds) and priced with ceilDiv. No Phase 2 card exercises this
   // path (TTS is UNPRICED until a verified rate exists), but the rule is fixed:
   // never floor, never banker's-round, never split a unit into a float.

callNanoUsd         = inputNanoUsd + outputNanoUsd + cachedInputNanoUsd + cachedOutputNanoUsd + perUnitNanoUsd
                     // all BigInt; exact sum, no further rounding
requestNanoUsd      = Σ callNanoUsd over PRICED calls        // exact sum in nUSD
```

`ceilDiv(a, b)` for non-negative BigInt `a` and positive BigInt `b` is `(a + b - 1n) / b`, matching the existing convention in `src/utils/ai-usage-pricing.ts`. No floating-point money arithmetic exists anywhere in this path.

### 8.3 Rounding and safe-integer boundaries

- **Components and calls are summed in exact integer nUSD. There is no per-component micro-USD rounding.**
- **The only rounding is at an explicit output boundary** (reporting/display/log serialization), and it is exact and deterministic:
  - `microUsd = Number(ceilDiv(totalNanoUsd, NANO_PER_MICRO))` — round up to a whole micro for reporting.
  - `usd = decimalString(totalNanoUsd, 9)` — exact 9-decimal string (or 6-decimal for micro-compatible display) derived directly from the BigInt value.
- **Safe-integer strategy:** because internal arithmetic is arbitrary-precision BigInt, `OVERFLOW` is not reachable during pricing. The defensive guard lives at the output boundary: converting `totalNanoUsd` to a JS `Number` requires `totalNanoUsd <= BigInt(Number.MAX_SAFE_INTEGER)`; on violation the report emits the exact decimal string instead of a `Number`. `OVERFLOW` remains a defensive `UnpricedReason` reserved for future non-BigInt transport (§10), not a normal state.
- Input validation: token counts must be `Number.isSafeInteger` and ≥ 0; seconds must be finite and ≥ 0; invalid values are `UNPRICED` (`USAGE_INVALID`), never coerced.

### 8.4 Worked example (showing why per-component micro-ceiling is rejected)

`gemini-3.6-flash`: `inputMicrosPerMillion = 1_500_000`, `outputMicrosPerMillion = 7_500_000`, `cachedInputMicrosPerMillion = 150_000`. A call reports `inputTokens=1 500`, `outputTokens=200`, `cachedInputTokens=500`, `reasoningTokens=50`.

- `inputNanoUsd        = ceilDiv(1 500 × 1 500 000 × 1 000, 1 000 000) = 2 250 000 nUSD`
- `outputNanoUsd       = ceilDiv(200   × 7 500 000 × 1 000, 1 000 000) = 1 500 000 nUSD`
- `cachedInputNanoUsd  = ceilDiv(500   × 150 000   × 1 000, 1 000 000) =   75 000 nUSD`
- `callNanoUsd = 3 825 000 nUSD = 0.003825 USD` (reasoning tokens priced inside output; never added separately)
- Report: `microUsd = ceilDiv(3 825 000, 1 000) = 3825 µUSD`; `usd = "0.003825"`.

**Small-call overstatement comparison.** `gemini-2.5-flash-lite` input `100 000 µUSD/1M` ⇒ 100 nUSD/token. A 1-token call:

- **Rejected (per-component micro ceiling):** `ceil(1 × 100 000 / 1 000 000) = 1 µUSD` — a 10× overstatement of a single 1-token call, and the error accumulates across many small calls.
- **Adopted (nano-USD internal):** `1 × 100 000 × 1 000 / 1 000 000 = 100 nUSD` exact. Reporting converts the exact total once: `microUsd = ceilDiv(totalNanoUsd, 1 000)`, so the internal truth (100 nUSD) is preserved and summed exactly before any rounding.

### 8.5 Component application rules (what gets priced)

| Component | Rule |
|---|---|
| `inputTokens` | Standard `inputMicrosPerMillion`. |
| `outputTokens` | `outputMicrosPerMillion`. |
| `cachedInputTokens` | `cachedInputMicrosPerMillion` when reported; treated as **disjoint** from `inputTokens` (Gemini `cachedContentTokenCount` is separate from `promptTokenCount`). If the rate card lacks a cached-input rate, `UNPRICED` (`UNIT_UNPRICED`) rather than silently billing cached tokens at the standard rate. |
| `cachedOutputTokens` | `cachedOutputMicrosPerMillion` when defined; else `UNPRICED` for that component if reported without a rate. |
| `reasoningTokens` | **Not separately priced.** Billed inside output (provider output rate covers reasoning). Never summed with `outputTokens`. Only a rate card that explicitly defines a distinct reasoning rate (Phase 2 defaults: none) would apply it. |
| `imageInputTokens` / `audioInputTokens` | **Non-additive breakdowns** of `inputTokens` (§11). Never added on top of the aggregate. Only used to split the aggregate when the rate card defines a distinct `audioInputMicrosPerMillion`. |
| `generatedImageCount` | Priced at `perUnitMicros` only when the entry's `billingUnit = "IMAGE"` (e.g. `gemini-2.5-flash-image` $0.039/image). |
| `audioOutputSeconds` / `audioOutputTokens` | TTS path (§11.4). |
| `inputCharacters` / `outputCharacters` | Priced at `perUnitMicros` only when `billingUnit = "CHARACTER"` (none in Phase 2 cards). |

---

## 9. Pricing Result Contract

### 9.1 Per-call result (discriminated union)

See §5 for the full type. Highlights:

- **`PRICED` variant carries `costNanoUsd: bigint`** (exact) and the resolved `rateCard` snapshot. Reason is a `PricedVia` value.
- **`UNPRICED` variant carries no cost field of any kind** (`costNanoUsd`, `costMicros`, `costUsd` are absent). Reason is an `UnpricedReason`.
- **Explicit provider-reported zero usage** (e.g. all counts present as 0) is `PRICED` with `costNanoUsd = 0n` and reason `ZERO_USAGE_EXPLICIT`. Absent fields are never converted to zero.
- **Missing or unknown pricing** is `UNPRICED` with no cost field — consumers can distinguish `PRICED@0` (provider said zero) from `UNPRICED` (we could not price) purely by `kind`.

### 9.2 Request-level aggregation

```
interface ShadowPricingResult {
  pricedAt: string
  noProviderCalls: boolean                  // true when providerCalls was empty (cache hit)
  calls: ShadowPricedCall[]                 // one per real provider call; cache hits add none
  totals: {
    callCount: number
    pricedCallCount: number
    unpricedCallCount: number
    unpricedReasons: Record<UnpricedReason, number>
    pricedCostNanoUsd: bigint               // Σ over PRICED calls, exact nUSD
  }
  summaryStatus: "FULLY_PRICED" | "PARTIALLY_PRICED" | "UNPRICED"
}
```

**Summary status derivation (exactly three values):**

| Condition | `summaryStatus` |
|---|---|
| `callCount > 0` and `pricedCallCount === callCount` | `FULLY_PRICED` |
| `callCount > 0` and `0 < pricedCallCount < callCount` | `PARTIALLY_PRICED` |
| `callCount > 0` and `pricedCallCount === 0` | `UNPRICED` |
| `callCount === 0` (empty `providerCalls`, e.g. cache hit) | `UNPRICED` (with `noProviderCalls: true`) |

- Aggregation is a pure reduce; no rounding at the request level (sum of already-integer nUSD).
- Multi-model requests (e.g. a persona turn with two Gemini calls) produce two `ShadowPricedCall` entries priced against their own `actualModel`, then aggregate.
- Requests with zero provider calls are excluded from coverage denominators (§14); `noProviderCalls: true` prevents them from being misread as `UNPRICED` pricing failures.

---

## 10. PRICED and UNPRICED Reason Enums

```
type PricedVia =
  | "ACTUAL_MODEL"                    // priced on actualModel (authoritative)
  | "REQUESTED_MODEL_FALLBACK"        // priced on requestedModel (actualModel ABSENT)
  | "ZERO_USAGE_EXPLICIT";            // provider explicitly reported zero usage

type UnpricedReason =
  | "PROVIDER_NOT_IN_RATECARD"        // provider absent from all rate-card entries (engine-neutral)
  | "MODEL_MISSING"                   // neither actualModel nor requestedModel present
  | "ACTUAL_MODEL_NOT_IN_RATECARD"    // actualModel present but unresolvable; NO requestedModel fallback
  | "REQUESTED_MODEL_NOT_IN_RATECARD" // actualModel absent; requestedModel present but unresolvable
  | "USAGE_MISSING"                   // providerCallMade=true but no usage fields at all
  | "USAGE_INVALID"                   // present-but-invalid values (negative, NaN, malformed breakdown)
  | "RATE_NOT_ACTIVE"                 // effective date window does not include pricingDate
  | "UNIT_UNPRICED"                   // reported unit has no published rate (e.g. TTS)
  | "MODALITY_INVALID"                // breakdown inconsistent (e.g. audioInputTokens > inputTokens)
  | "OVERFLOW";                       // defensive only; unreachable with BigInt internal arithmetic
```

Semantics:

- `USAGE_MISSING` covers `usageCompleteness: "UNAVAILABLE"` calls that Phase 1 records with no counts.
- `ACTUAL_MODEL_NOT_IN_RATECARD` is the direct consequence of the authoritative-`actualModel` rule: an unresolvable `actualModel` always blocks pricing, even when `requestedModel` would resolve.
- `PROVIDER_NOT_IN_RATECARD` is the provider-neutral counterpart of the model reason; it is derived from the rate card, never from a hard-coded list.
- Every `UNPRICED` reason is countable for coverage metrics and must be surfaced in `unpricedReasons`.

---

## 11. Modality Accounting Rules

### 11.1 Aggregate-only pricing default

For every model whose rate card defines a single input rate for all modalities, price **only the aggregate `inputTokens`** (and the aggregate `outputTokens`). The per-modality breakdown (`imageInputTokens`, `audioInputTokens`) is observability-only.

### 11.2 Non-additivity rule (image/audio input)

Gemini reports image/audio input tokens **both** inside `promptTokenCount` **and** broken out in `promptTokensDetails[]`. These breakdowns are a decomposition of the aggregate, not an additive surcharge. **Never** add `imageInputTokens`/`audioInputTokens` on top of `inputTokens`.

The only sanctioned use of a breakdown is rate differentiation (all arithmetic in nUSD):

```
if rateCard.modalityRates.audioInputMicrosPerMillion is defined AND audioInputTokens is reported:
    audioNanoUsd = ceilDiv(audioInputTokens * audioInputRate * NANO_PER_MICRO, MICROS_PER_MILLION)
    textNanoUsd  = ceilDiv((inputTokens - audioInputTokens) * inputRate * NANO_PER_MICRO, MICROS_PER_MILLION)
    inputNanoUsd = audioNanoUsd + textNanoUsd
else:
    inputNanoUsd = ceilDiv(inputTokens * inputRate * NANO_PER_MICRO, MICROS_PER_MILLION)
```

Guard: `audioInputTokens > inputTokens` ⇒ `UNPRICED` (`MODALITY_INVALID`), never clamped.

### 11.3 Cached-token disjointness

`cachedInputTokens` is priced as a disjoint count at the cached-input rate and added to the input side. If a future provider reports cached tokens as a strict subset of `inputTokens`, that provider's rate card entry must set a `cachedDisjoint: false` flag (Phase 2 default `true` for google) — no current provider requires this.

### 11.4 Reasoning tokens

`reasoningTokens` are folded into `totalTokenCount` by the provider and are billed under the model's output rate. Phase 2 prices output using `outputTokens` only and **never** adds a separate reasoning charge. If a card ever defines `reasoningOutputMicrosPerMillion`, the engine applies it to `reasoningTokens` in place of output billing for that portion — designed but unused in Phase 2.

### 11.5 Cache hits

- The **normal authoritative cache-hit representation is an empty `providerCalls` array** (Phase 1 already emits this: `identify` cache hits return no provider calls and no usage). An empty `providerCalls` produces `calls: []`, `noProviderCalls: true`, and no coverage impact.
- **`providerCallMade=false` records, if received, are defensively ignored** (dropped before pricing). They never create a priced or unpriced call, never produce cost, and never count toward priced/unpriced metrics.

### 11.6 Text-to-speech units

- TTS is priced per **audio-output token** when the provider reports `audioOutputTokens`, at `tts.audioOutputMicrosPerMillion`.
- If only `audioOutputSeconds` is reported and the rate card defines `tts.tokensPerSecond` (Gemini documents 25 tokens/sec), tokens are derived as `ceil(seconds * tokensPerSecond)` and priced at the audio-output token rate. This is an explicit, documented derivation — never an invented conversion.
- **Phase 2 reality:** `gemini-3.1-flash-tts-preview` has no rate in the pricing baseline, so TTS calls resolve to `UNPRICED` (`ACTUAL_MODEL_NOT_IN_RATECARD` or `UNIT_UNPRICED`). gTTS (local, non-metered) is already not emitted as a provider call. No rate is fabricated.

---

## 12. Shadow-Integration Design

### 12.1 Location: the `recordAiUsage` choke point (Phase 2D)

All five live features already pass `providerCalls` through `recordAiUsage` (`src/services/ai-usage.service.ts`): chat, chat-stream (final SSE event), identify (miss only), voice, itinerary. This is the single, correct choke point to guarantee **every provider call is priced exactly once** with no per-route churn.

Pipeline inside `recordAiUsage` (additive, failure-isolated):

```
providerCalls (raw)
  → normalizeProviderCalls (existing, unchanged)        // authoritative normalized array
  → drop providerCallMade=false records (defensive)     // cache-hit representation is empty array
  → priceProviderCalls(calls, { pricingDate })          // NEW pure engine (2C)
  → ShadowPricingResult (discriminated union, exact nUSD)
  → shadowPricingService.record(result)                  // 2D: structured log + in-memory coverage buffer
  → existing AiUsageLog writes unchanged
```

- The engine is a **pure, synchronous function** (`src/utils/provider-pricing/`), fully unit-testable, with no Prisma/network/environment dependencies.
- A thin `src/services/ai-shadow-pricing.service.ts` wrapper calls the pure engine and handles side effects (structured logs, an in-memory coverage buffer for admin visibility). It is **failure-isolated**: any engine/logging error is caught and logged; it never throws into the request path and never blocks the AI response.
- The legacy `cost` column (via `computeAiCost`) is untouched; shadow cost is computed and reported separately.
- **No persistence:** Phase 2D writes no new rows. Coverage is served from (a) the in-memory buffer of live `ShadowPricingResult` values and (b) recompute-on-read over existing `AiUsageLog` rows (§14). Structured logs are the durable trace.

### 12.2 Alternative considered and rejected

Wiring shadow pricing into each feature service (chat/voice/identify/itinerary/stream) individually was rejected: five call sites, duplicated logic, and higher risk of missing a call path. The choke point also guarantees coverage when a feature adds multi-call turns.

### 12.3 Rate resolution context

`pricingDate` defaults to the current date in the app timezone and is injectable for tests and historical recompute. `tier` defaults to `standard`; a future request can resolve batch/priority entries without engine changes.

---

## 13. Persistence Limitations

### 13.1 Persistable today with the current `AiUsageLog` schema (no migration)

Per-provider-call rows (already written by Phase 1 for calls with `totalTokens > 0`):

| Column | Maps to |
|---|---|
| `model` | `actualModel ?? requestedModel` (Phase 1 already does this) |
| `inputTokens` / `outputTokens` / `totalTokens` | reported aggregate counts |
| `cost` | legacy `computeAiCost` output (unchanged semantics) |
| `source` | feature (`chat` / `stream` / `identify` / `voice` / `itinerary`) |
| `userId` / `conversationId` / `createdAt` | correlation keys for coverage metrics |

Because the inputs for shadow pricing (per-call tokens + model + source) are present in these rows, a **recompute-on-read** coverage metric can deterministically reproduce PRICED/UNPRICED status and nUSD cost at query time using the versioned rate card — no schema change required. Caveats: `model` is the collapsed `actual ?? requested`, so `actualModel`-specific attribution cannot be recovered for old rows, and a recompute that hits an unresolvable stored model yields `ACTUAL_MODEL_NOT_IN_RATECARD` or `REQUESTED_MODEL_NOT_IN_RATECARD` consistently with live behavior.

### 13.2 NOT persistable without a future Prisma migration (future phase)

The current `AiUsageLog` has no columns for, and therefore cannot persist:

- `provider` (assumed `google` today, but not recorded)
- `providerCallId` (call identity within a request)
- `requestedModel` and `actualModel` separately
- `operation` (`TEXT_CHAT`, `TEXT_TO_SPEECH`, `IMAGE_ANALYSIS`, …)
- `cachedInputTokens`, `reasoningTokens`, and all modality/per-unit counts
- PRICED/UNPRICED `kind` and `reason`
- `rateCardVersion`, applied `tier`, effective-date used
- shadow `costNanoUsd` (per call and per request)

`AiUsageLog.cost` (`Decimal(12,6)`) happens to be micro-precision-compatible, but it is deliberately **not** repurposed: changing its meaning would corrupt the existing telemetry contract.

**Future phase (explicitly out of Phase 2):** add an `AiShadowPricingLog` model (providerCallId, provider, operation, requestedModel, actualModel, kind, reason, rateCardVersion, tier, costNanoUsd, priced counts, request-level aggregator) behind a new migration, enabling durable coverage metrics, historical backfill, and durable exact cost-per-charged-point correlation. This is the first Prisma change of the program and requires a stable operation/billing correlation id.

---

## 14. Coverage Metrics

| Metric | Definition | Phase 2 mechanism (in-memory / recompute-on-read) |
|---|---|---|
| Priced call count | `PRICED` calls / total real provider calls | engine result; recompute from `AiUsageLog` rows |
| Unpriced call count + reason breakdown | `UNPRICED` calls grouped by `UnpricedReason` | engine result; recompute per reason |
| Cost per request | Σ `costNanoUsd` over `PRICED` calls for a `providerCallId` set / `conversationId` + `createdAt` window | `ShadowPricingResult.totals.pricedCostNanoUsd` (in-memory) |
| Cost per feature | Σ `costNanoUsd` grouped by `source` | group recomputed `AiUsageLog` rows by `source` |
| **Cost per Configured Wallet Point** | Σ `costNanoUsd` ÷ fixed feature cost (tokens) from `BUSINESS_TOKEN_FEATURE_COSTS` for the same feature/source | divide shadow cost by the **configured** fixed cost (read-only reference); no `TokenTransaction` lookup |
| Coverage ratio | priced ÷ (priced + unpriced) | engine result |

**Wallet-point semantics (locked):**

- Phase 2 reports **Cost Per Configured Wallet Point** using the fixed feature-cost configuration (`BUSINESS_TOKEN_FEATURE_COSTS`, e.g. `AI_CHAT_QUERY = 1`, `AI_IMAGE_ANALYSIS = 5`). It answers "given a request priced at N nUSD for feature F, what is the provider cost per point that feature *is configured to* charge."
- **No exact correlation with actual `TokenTransaction` records is claimed.** Phase 1/2 have no stable operation/billing correlation id shared between usage rows and token transactions (non-chat features lack a shared `conversationId`; there is no `businessRequestId` on `AiUsageLog`). Any "cost per *charged* point" would be a guess.
- **Durable exact cost-per-charged-point correlation is a future phase** requiring a stable operation/billing correlation id and (in the future phase) the `AiShadowPricingLog` table.

---

## 15. Backward Compatibility Requirements

1. Wallet fixed pricing, consumption/reversal, reservations, and `tokenized-service-execution` are byte-for-byte unchanged; all `token-wallet` / `business-token-*` / `chat-token` / `identify-token` tests must still pass.
2. The legacy `usage`/`model` AI-service fields and the legacy single-row `recordAiUsage` path remain unchanged.
3. `computeAiCost`, `ai-usage-pricing.ts` (dormant `PROVIDER_USAGE`), `ai-reservation-quote.ts`, `ai-billing-*`, and the `ai-service-chat-executor` are untouched; their existing tests must still pass.
4. `ProviderCallUsage` wire contract and `normalizeProviderCalls` behavior are unchanged (already tested by `ai-usage-contracts.test.ts` #39–#56).
5. New code is additive: new files under `src/utils/provider-pricing/`, `src/config/provider-rate-card*`, `src/services/ai-shadow-pricing.service.ts`; the only touched existing file is the integration call in `ai-usage.service.ts` (guarded, failure-isolated, Phase 2D only).
6. No new env vars are required; the rate card is a static artifact, not env-injected floats.
7. Full Core suite (currently 1345 tests) and `tsc --noEmit` remain green after each subphase.

---

## 16. Testing Plan (per subphase)

### Phase 2B — contract hardening and model identity (no rate card, no engine)

- **Contract tests:** the `ShadowPricedCall` discriminated union type-checks both variants; `PRICED` requires `costNanoUsd` and a `PricedVia` reason; `UNPRICED` is structurally forbidden from carrying a cost field (compile-time type test); `ZERO_USAGE_EXPLICIT` is `PRICED` with `0n`.
- **Identity tests:** authoritative `actualModel` resolution table of §6.4, including the critical cases:
  - `actualModel` present + resolvable ⇒ `ACTUAL_MODEL`.
  - `actualModel` present + unresolvable ⇒ `UNPRICED` `ACTUAL_MODEL_NOT_IN_RATECARD`, even when `requestedModel` is present and resolvable (no fallback).
  - `actualModel` absent + `requestedModel` resolvable ⇒ `REQUESTED_MODEL_FALLBACK`.
  - `actualModel` absent + `requestedModel` unresolvable ⇒ `REQUESTED_MODEL_NOT_IN_RATECARD`.
  - both absent ⇒ `MODEL_MISSING`.
- **Neutrality tests:** the engine has no closed provider list; provider set is derived from the rate-card; a provider with no entries ⇒ `PROVIDER_NOT_IN_RATECARD`; `"flash"`/`"lite"` substring inputs never match.
- **Summary-status contract tests:** exactly `FULLY_PRICED` / `PARTIALLY_PRICED` / `UNPRICED`; zero-call requests ⇒ `UNPRICED` + `noProviderCalls: true`.

### Phase 2C — rate card and pure pricing engine

- **Rate-card validation:** unique keys, alias 1:1/cycle rejection, date-window ordering, `billingUnit`/`perUnitMicros` agreement, invalid rates rejected, no hard-coded provider list (provider set derived).
- **Rate resolution:** exact match; alias match; case-insensitivity; effective-date selection (past/future windows, `RATE_NOT_ACTIVE`); tier selection.
- **Arithmetic (nano-USD):** `ceilDiv` BigInt correctness; components and calls summed exactly in nUSD; the §8.4 small-call example asserts the 1-token `gemini-2.5-flash-lite` call is `100 nUSD` (not `1 µUSD`); cached-input disjoint pricing; reasoning-included-in-output; audio-input rate-differentiation split; `MODALITY_INVALID` when `audioInputTokens > inputTokens`; generated-image per-unit pricing; no float path (audit for `Math.round` / `* 1e-6` on money); output-boundary conversion (`ceilDiv` to µUSD and 9-decimal USD string) deterministic.
- **Per-call pricing matrix:** all `PricedVia` and `UnpricedReason` outcomes, including `USAGE_MISSING` (completeness UNAVAILABLE, no counts), `USAGE_INVALID` (negative/NaN), explicit-zero (`PRICED` at `0n`), `UNIT_UNPRICED` (TTS), `OVERFLOW` defensive guard.
- **Aggregation:** multi-call/multi-model sums; `FULLY_PRICED` / `PARTIALLY_PRICED` / `UNPRICED` derivation; `unpricedReasons` tally; `providerCallMade=false` records dropped (never priced or unpriced).

### Phase 2D — shadow integration (structured logs + in-memory/recompute coverage only)

- `recordAiUsage` computes and returns/logs a `ShadowPricingResult` for each of the five feature paths (chat, stream final-event, identify miss, voice, itinerary) without altering `AiUsageLog` writes or Wallet behavior.
- Cache-hit request (empty `providerCalls`) yields `calls: []`, `noProviderCalls: true`, no coverage impact.
- Failure isolation: a throwing engine never breaks the request path.
- Coverage recompute-on-read from `AiUsageLog` rows matches the live engine result on a synthetic dataset.
- **Cost Per Configured Wallet Point** test: shadow cost ÷ fixed feature cost from `BUSINESS_TOKEN_FEATURE_COSTS`; assert no `TokenTransaction` lookup is performed.
- Structured-log shape test (JSON serialization converts BigInt via the output boundary, never raw `BigInt`).
- Full regression: all 1345 Core tests + `tsc --noEmit` green; legacy `usage` path unaffected.

### Future phase (out of Phase 2, tests deferred)

- `AiShadowPricingLog` migration + write/read round-trip; backfill/no-op for rows without `providerCallId`; durable coverage-metric queries; durable exact cost-per-charged-point correlation with a stable operation/billing correlation id.

---

## 17. Planned File Changes for Phase 2B, 2C, and 2D

**Phase 2B — contract hardening and model identity (no rate card, no engine):**
- `src/types/provider-pricing.ts` — `RateCardEntry`, `ProviderRateCard`, the `ShadowPricedCall` discriminated union, `ShadowPricingResult`, `PricedVia`, `UnpricedReason`, `ShadowPricingInput`, `RequestSummaryStatus`.
- `src/utils/provider-pricing/model-identity.ts` — provider/model canonicalization and the authoritative `actualModel` resolution table (§6).
- `tests/provider-pricing-contract.test.ts`; `tests/provider-pricing-identity.test.ts`.

**Phase 2C — rate card and pure pricing engine (no wiring):**
- `src/config/provider-rate-card/` — materialized card (JSON or TS constant) + `loadProviderRateCard()`/validation (provider set derived).
- `src/utils/provider-pricing/arithmetic.ts` — BigInt nUSD helpers (`ceilDiv`, `nanoUsdToMicroUsd`, `nanoUsdToUsdString`, input validation, output-boundary guards).
- `src/utils/provider-pricing/rate-card.ts` — provider/model/alias/effective-date/tier resolution.
- `src/utils/provider-pricing/price-call.ts` — pure per-call pricing (discriminated-union output).
- `src/utils/provider-pricing/aggregate.ts` — request-level summary (`FULLY_PRICED`/`PARTIALLY_PRICED`/`UNPRICED`).
- `tests/provider-pricing-rate-card.test.ts`; `tests/provider-pricing-arithmetic.test.ts`; `tests/provider-pricing-call.test.ts`; `tests/provider-pricing-aggregate.test.ts`.

**Phase 2D — shadow integration (no Prisma, no migration, no durable persistence):**
- `src/services/ai-shadow-pricing.service.ts` — wrapper: normalize → drop `providerCallMade=false` → pure engine → structured log + in-memory coverage buffer; failure-isolated.
- `src/services/ai-usage.service.ts` — invoke the shadow wrapper (guarded, additive, Phase 2D only).
- `src/controllers/admin/...` + `src/routes/admin/...` — coverage metrics (in-memory + recompute-on-read; **Cost Per Configured Wallet Point**).
- `tests/ai-shadow-pricing.test.ts`; extend `tests/ai-usage-contracts.test.ts`; regression on existing suite.

**Future phase (explicitly NOT Phase 2):**
- `prisma/schema.prisma` — `AiShadowPricingLog` model; `prisma/migrations/*` — migration.
- Durable persistence write path in the shadow service; historical backfill job.
- Durable exact cost-per-charged-point correlation (requires a stable operation/billing correlation id).
- Corresponding persistence tests.

---

## 18. Acceptance Criteria

1. Every live provider call is priced exactly once with a deterministic `PRICED`/`UNPRICED` result and a reason; nothing is priced twice or skipped in the five live features.
2. **Model identity:** `actualModel` is authoritative whenever present; a present-but-unresolvable `actualModel` is `UNPRICED` (`ACTUAL_MODEL_NOT_IN_RATECARD`) with **no** `requestedModel` fallback; `requestedModel` is used only when `actualModel` is absent; `MODEL_MISSING` covers neither.
3. **Result safety:** results are a discriminated union; `UNPRICED` carries no cost field (never a zero `costNanoUsd`/`costMicros`); explicit provider-reported zero usage is `PRICED` with zero cost; missing/unknown pricing is `UNPRICED`.
4. **Arithmetic:** all money is integer nano-USD (BigInt) internally; components and calls sum exactly in nUSD; µUSD/USD appear only at an explicit deterministic output boundary; per-component micro-USD ceiling is not used; `OVERFLOW` is a tested defensive guard only.
5. Unknown/malformed inputs never yield `PRICED` with a fabricated cost; unknown models are always `UNPRICED` (no substring heuristics).
6. Modality breakdowns are never double-counted; cached-input and reasoning-token semantics follow §11.
7. **Provider neutrality:** the engine has no closed provider list; supported providers derive from validated rate-card entries; a provider absent from the rate card returns `PROVIDER_NOT_IN_RATECARD`.
8. Rate cards are versioned, dated, alias-driven, `provenance: "RESEARCH_SNAPSHOT"`-tagged; TTS stays `UNPRICED` until a verified rate exists.
9. **Cache hits:** empty `providerCalls` is the authoritative cache-hit representation; `providerCallMade=false` records are defensively ignored; cache hits create no priced or unpriced call.
10. **Summary statuses** are exactly `FULLY_PRICED` | `PARTIALLY_PRICED` | `UNPRICED`.
11. **Coverage:** priced/unpriced calls, cost per request, cost per feature, and **Cost Per Configured Wallet Point** (from `BUSINESS_TOKEN_FEATURE_COSTS`) are computed; no exact `TokenTransaction` correlation is claimed.
12. **No Prisma schema or migration anywhere in Phase 2** (2B/2C/2D); Phase 2D is structured-log + in-memory/recompute coverage only; `AiShadowPricingLog`, migrations, durable persistence, and historical backfill are deferred to a future phase.
13. Wallet fixed pricing, legacy `usage`/`model`, `computeAiCost`, and the dormant durable path are unchanged; all 1345 Core tests and `tsc --noEmit` stay green after 2B, 2C, and 2D.
14. Nothing is activated for Wallet charging; this is shadow-only.

---

## 19. Risks and Open Questions

1. **TTS pricing (open).** `gemini-3.1-flash-tts-preview` has no rate in the pricing baseline; capabilities file lists $1/$20 per M (research snapshot only). Decision: stay `UNPRICED` until a live probe / refreshed baseline verifies the rate and the usage unit (per output token vs per second). No rate is fabricated.
2. **Interactions API vs generateContent (open, affects future phases).** The research notes Google's GA shift to the Interactions API with unknown usage-object field parity. This affects the AI Service extraction, not the Core pricing engine (which consumes the normalized `ProviderCallUsage`). Tracked for a later subphase; no Core change needed now.
3. **Cached-input disjointness assumption (documented).** Pricing cached tokens as disjoint assumes `cachedInputTokens` is separate from `inputTokens` (Gemini semantics). A future provider that folds cached tokens into `inputTokens` requires the `cachedDisjoint: false` flag; validated by a rate-card schema field (§11.3).
4. **Reasoning-token billing assumption (documented).** Priced inside output. If a provider bills reasoning at a distinct rate, a rate-card `reasoningOutputMicrosPerMillion` field is designed but unused; re-verify with a probe before any future billing activation.
5. **Rate staleness.** Reference baselines are dated 2026-08-03 and explicitly not live billing. Shadow costs may drift from provider invoices; a refresh procedure (live probe plan) must precede any billing activation. Shadow values are labeled accordingly.
6. **Collapsed-model recompute (2D) loses actualModel specificity** for pre-future-phase rows because `AiUsageLog.model` collapses actual/requested. Durable per-call identity arrives only with the future `AiShadowPricingLog` migration.
7. **Cost Per Configured Wallet Point vs charged cost (open, acknowledged).** Phase 2 deliberately reports the configured ratio only; exact cost-per-charged-point requires a stable operation/billing correlation id and the future persistence phase. Until then, coverage numbers must not be presented as invoice-accurate.
8. **nano-USD reporting ergonomics (open).** BigInt is not JSON-serializable; the structured log must convert via the output boundary (µUSD integer or 9-decimal USD string). Decision: enforce via a single `toReportable()` helper to prevent accidental `BigInt` in logs.
9. **Open question:** whether the in-memory coverage buffer (2D) should be per-process only (recommended: yes, bounded, admin-gated) or aggregated in a shared store. Default: per-process, in-memory, bounded ring buffer; durable aggregation is the future phase.
10. **Open question:** whether a `pricingDate` recompute job should reprocess historical `AiUsageLog` rows in 2D. Default: supported recompute-on-read for admin queries; no background job until the future persistence phase.

---

## 20. Readiness Verdict

Phase 2A design is revised and internally consistent with the 10 mandatory corrections: authoritative-`actualModel` identity with `ACTUAL_MODEL_NOT_IN_RATECARD` / `REQUESTED_MODEL_NOT_IN_RATECARD` / `MODEL_MISSING`; a cost-free `UNPRICED` discriminated union; BigInt nano-USD internal arithmetic with output-boundary rounding; re-split phases (2B contract/identity, 2C rate card + engine, 2D integration + logs + in-memory/recompute coverage) with **no Prisma anywhere in Phase 2**; engine-derived providers (`PROVIDER_NOT_IN_RATECARD`); **Cost Per Configured Wallet Point** only; empty-array cache-hit semantics with `providerCallMade=false` defensively ignored; exactly three summary statuses; and all preserved invariants (providerCalls authoritative, no legacy pricing, no Wallet changes, no durable activation, no invented rates, TTS `UNPRICED`, no package/environment changes).

Only `docs/phase-2-provider-pricing-design.md` was modified; no production code, tests, Prisma, migrations, Wallet logic, package, dependency, or environment files were touched; no commit or push was performed.

PHASE_2A_DESIGN_REVISED_READY
