# Phase 2C — Provider-Neutral Rate Card and Shadow Pricing Engine

**Status:** READY FOR REVIEW
**Date:** 2026-08-03
**Phase:** 2C (versioned provider-neutral rate card, rate-card validation, provider/model/alias/effective-date resolution, BigInt nano-USD arithmetic, pure per-call pricing, pure request aggregation). No wiring, no logs, no coverage service, no admin endpoints, no Wallet/Prisma/duration changes.
**Task type:** production types + config artifact + pure engine utilities + tests + report. No commits, no pushes, no package/dependency/env/Prisma/migration changes.

---

## 1. Executive Summary

Phase 2C implements the provider-neutral **rate card** and the **pure shadow-pricing engine** per the authoritative design (`docs/phase-2-provider-pricing-design.md`, §7, §8, §9, §10, §11, §16-2C):

- A **versioned, dated rate card** is materialized under `src/config/provider-rate-card/` from the research baseline (Google section), carrying `schemaVersion: 1`, `currency: "USD"`, `storageUnit: "MICROS"`, `engineUnit: "NANO_USD"`, `provenance: "RESEARCH_SNAPSHOT"` and `source`/`verifiedAt` per entry.
- A **fail-fast validator** (`validateRateCard`) enforces exact literals, canonicalization, safe-integer rates, ISO dates, non-overlapping effective windows, 1:1 alias rules, billing-unit consistency, and derives the provider set **from validated entries** — no closed provider list anywhere in the engine.
- An **exact resolution** (`resolveRate`) maps canonical provider → canonical model → alias → tier (default `standard`) → effective window → active, returning exactly one line or an `UNRESOLVED` with a provider-neutral `UnpricedReason` (`PROVIDER_NOT_IN_RATECARD`, `ACTUAL_MODEL_NOT_IN_RATECARD`, `REQUESTED_MODEL_NOT_IN_RATECARD`, `RATE_NOT_ACTIVE`).
- **BigInt nano-USD arithmetic** (`arithmetic.ts`): `ceilDiv`, `tokenComponentCostNanoUsd`, `perUnitCostNanoUsd`, `nanoUsdToMicroUsdCeil`, `nanoUsdToUsdString`. No floating-point money anywhere; micro-USD/USD appear only at the explicit output boundary.
- **Pure per-call pricing** (`price-call.ts`): authoritative `actualModel`, usage-state detection (`USAGE_MISSING` / `USAGE_INVALID` / `ZERO_USAGE_EXPLICIT` / priced), reasoning tokens not additive, cached-input `DISJOINT` vs `INCLUDED_IN_INPUT`, modality breakdowns non-additive with `MODALITY_INVALID` guard, image/character/TTS units.
- **Pure aggregation** (`aggregate.ts`): per-call loop, `providerCallMade=false` dropped, exact nUSD sum over priced calls, full `unpricedReasons` record, and exactly three summary statuses (`FULLY_PRICED` / `PARTIALLY_PRICED` / `UNPRICED`), with `noProviderCalls: true` for empty inputs.

Every money conversion reproduces the §8.4 worked example exactly: `gemini-3.6-flash` `inputTokens=1500, outputTokens=200, cachedInputTokens=500` ⇒ `3_825_000 nUSD` ⇒ `3825 µUSD` (bigint) and `"0.003825000"`. The 1-token `gemini-2.5-flash-lite` call is exactly `100 nUSD` (no per-component micro ceiling).

---

## 2. Repositories & Branch Snapshot

| Repo | Worktree path | Branch | HEAD |
|---|---|---|---|
| Core Server | `Core-Server-provider-pricing-phase2` | `feature/provider-pricing-phase2` | 2B HEAD, uncommitted 2C working tree |

- Phase 2C modified only this worktree; no commits, pushes, or merges.
- The AI Service (`ai-service-provider-pricing-phase2`) was not touched in Phase 2C (read-only reference for model inventory).

---

## 3. Scope of Phase 2C

**In scope (implemented):**

1. `src/config/provider-rate-card/index.ts` — materialized provider-neutral rate card (`PROVIDER_RATE_CARD`) and derived provider set.
2. `src/utils/provider-pricing/rate-card.ts` — validation (`validateRateCard`) + resolution (`resolveRate`).
3. `src/utils/provider-pricing/arithmetic.ts` — BigInt nUSD helpers (`ceilDiv`, `tokenComponentCostNanoUsd`, `perUnitCostNanoUsd`, `nanoUsdToMicroUsdCeil`, `nanoUsdToUsdString`).
4. `src/utils/provider-pricing/price-call.ts` — pure per-call pricing (`priceProviderCall`).
5. `src/utils/provider-pricing/aggregate.ts` — pure request aggregation (`aggregateProviderCalls`).
6. Tests: `provider-pricing-arithmetic.test.ts`, `provider-pricing-rate-card.test.ts`, `provider-pricing-call.test.ts`, `provider-pricing-aggregate.test.ts`.
7. Type-extension surfaces in `src/types/provider-pricing.ts` (see §10).

**Out of scope (Phase 2C does NOT do):**

- No `recordAiUsage` integration, no shadow production logs.
- No in-memory coverage service, no admin endpoints.
- No Wallet pricing/debit/reversal changes, no TokenTransaction correlation.
- No Prisma, no migrations, no durable shadow persistence, no durable billing activation.
- No route, feature-service, or AI Service changes.

---

## 4. Rate-Card Materialization Inventory

The materialized card (`src/config/provider-rate-card/index.ts`) is transcribed exactly from `references/ai-pricing/ai-provider-model-pricing.json` (Google section, `verifiedAt 2026-08-03`, source `https://ai.google.dev/gemini-api/docs/pricing`). Twelve entries; three tiers each for the four Rihla-routed models:

| Model | Status | Tier | input µUSD/M | output µUSD/M | cachedInput µUSD/M | Cached semantics |
|---|---|---|---|---|---|---|
| `gemini-3.6-flash` | STABLE | standard | 1_500_000 | 7_500_000 | 150_000 | DISJOINT |
| `gemini-3.6-flash` | STABLE | batch | 750_000 | 3_750_000 | 75_000 | DISJOINT |
| `gemini-3.6-flash` | STABLE | priority | 2_700_000 | 13_500_000 | 270_000 | DISJOINT |
| `gemini-3.5-flash-lite` | STABLE | standard | 300_000 | 2_500_000 | 30_000 | DISJOINT |
| `gemini-3.5-flash-lite` | STABLE | batch | 150_000 | 1_250_000 | 20_000 | DISJOINT |
| `gemini-3.5-flash-lite` | STABLE | priority | 540_000 | 4_500_000 | 50_000 | DISJOINT |
| `gemini-3-flash-preview` | PREVIEW | standard | 500_000 | 3_000_000 | 50_000 | DISJOINT |
| `gemini-3-flash-preview` | PREVIEW | batch | 250_000 | 1_500_000 | 50_000 | DISJOINT |
| `gemini-3-flash-preview` | PREVIEW | priority | 900_000 | 5_400_000 | 90_000 | DISJOINT |
| `gemini-2.5-flash-lite` | STABLE | standard | 100_000 | 400_000 | 10_000 | DISJOINT |
| `gemini-2.5-flash-lite` | STABLE | batch | 50_000 | 200_000 | 10_000 | DISJOINT |
| `gemini-2.5-flash-lite` | STABLE | priority | 180_000 | 720_000 | 18_000 | DISJOINT |

**Materialization policy applied:**

- Only models the Rihla AI service actually routes to are materialized (fallback chain `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3-flash-preview`, `gemini-2.5-flash-lite`).
- `gemini-3.1-flash-tts-preview` is **deliberately absent** (no verified rate in the pricing baseline) ⇒ TTS calls resolve `UNPRICED` (`ACTUAL_MODEL_NOT_IN_RATECARD`), no fabricated rate.
- `context_cache_storage` (per-hour storage) is **not** a per-call tier and is not materialized.
- No aliases declared (baseline carries no alias field; the illustrative `gemini-2.5-flash-lite-preview-09-2025` → `gemini-2.5-flash-lite` mapping is a separate reference entry, not a declared alias).
- No audio modality rate materialized: the baseline's top-level `audioInputRateMicrosPerMillion` is `null` for all four models (per-modality notebooks are not structured rates).

---

## 5. Validation Design (`validateRateCard`)

Fail-fast, no mutation, throws `RateCardValidationError`:

- **Literals:** `schemaVersion`, `currency`, `storageUnit`, `engineUnit`, `provenance` must equal the fixed constants (`1`, `"USD"`, `"MICROS"`, `"NANO_USD"`, `"RESEARCH_SNAPSHOT"`).
- **Strings:** non-empty `version`, `source`, provider, model; provider trimmed + lowercased; model trimmed with a lowercased lookup key.
- **Rates:** every present rate is a non-negative safe integer; no NaN/Infinity/negative.
- **Dates:** `generatedAt`, `effectiveFrom`, `verifiedAt` are valid ISO dates; `effectiveTo >= effectiveFrom`.
- **Uniqueness / windows:** at most one active line per `provider + canonical model + tier` at any effective window; overlapping windows for the same key are rejected; scheduled changes encoded as non-overlapping windows.
- **Aliases:** explicit array; 1:1 (one alias maps to exactly one canonical model within a provider); case-insensitive; no wildcards/globs; an alias canonicalizing to two different models for the same provider is rejected.
- **Billing consistency:** `TOKEN` requires `tokenRates` and forbids `perUnitMicros`; non-`TOKEN` (IMAGE/SECOND/MINUTE/CHARACTER) requires `perUnitMicros` and forbids `tokenRates`/modality/tts/cached fields.
- **Cached-input semantics:** a published `cachedInputMicrosPerMillion` requires an explicit `cachedInputAccounting` (`DISJOINT` | `INCLUDED_IN_INPUT`); the semantic is rejected when no cached-input rate exists.
- **Derived provider set:** supported providers are the distinct `provider` values from validated entries — **no declared provider list exists anywhere in the engine**.

The materialized card passes validation and derives exactly `["google"]`.

---

## 6. Resolution Design (`resolveRate`)

Order (exact, no fallback from an unresolved authoritative `actualModel`):

1. `provider` canonicalized (trim + lowercase) → must have entries, else `PROVIDER_NOT_IN_RATECARD`.
2. Canonical model exact match, then explicit alias match (case-insensitive).
3. Tier selection (`requestedTier ?? 'standard'`).
4. Effective window contains `pricingDate`; entry not `inactive`.

Fails: no matching model ⇒ `ACTUAL_MODEL_NOT_IN_RATECARD` (source `ACTUAL_MODEL`) or `REQUESTED_MODEL_NOT_IN_RATECARD` (source `REQUESTED_MODEL_FALLBACK`); model exists but no active/windowed/tiered line ⇒ `RATE_NOT_ACTIVE`.

Resolution is deterministic and provider-neutral; a resolved reference returns `{ model, appliedTier, entry }` snapshot used by the pricing path.

---

## 7. Arithmetic Design (`arithmetic.ts`)

Money is always **integer nano-USD (nUSD)**, BigInt-only:

- `NANO_PER_USD = 1_000_000_000n`, `NANO_PER_MICRO = 1_000n`, `MICROS_PER_MILLION = 1_000_000n`.
- `ceilDiv(a, b)` = `(a + b - 1n) / b` for non-negative `a`, positive `b` (matches the existing convention in `src/utils/ai-usage-pricing.ts`).
- `tokenComponentCostNanoUsd(tokens, rateMicrosPerMillion)` = `ceilDiv(tokens * rate * NANO_PER_MICRO, MICROS_PER_MILLION)`.
- `perUnitCostNanoUsd(unitCount, perUnitMicros)` = `unitCount * perUnitMicros * NANO_PER_MICRO`.
- Output boundary only: `nanoUsdToMicroUsdCeil(totalNanoUsd)` = `ceilDiv(total, 1_000)` returned as **BigInt micro-USD** — the authoritative money path never calls `Number()` on money; `nanoUsdToUsdString(total)` = exact 9-decimal decimal string.

**Arithmetic rules (mandatory):** BigInt only; components and calls summed in exact nUSD; **no per-component micro-USD rounding**; costs stay integers; no force-float conversion of authoritative cost; no JSON serialization of `bigint`; counts validated as non-negative safe integers before conversion (`USAGE_INVALID` otherwise).

Worked example (§8.4):

```
inputNanoUsd  = ceilDiv(1500 * 1_500_000 * 1_000, 1_000_000) = 2_250_000 nUSD
outputNanoUsd = ceilDiv(200  * 7_500_000 * 1_000, 1_000_000) = 1_500_000 nUSD
cachedInput   = ceilDiv(500  *  150_000 * 1_000, 1_000_000) =     75_000 nUSD
call          = 3_825_000 nUSD = 0.003825 USD  (no per-component micro ceiling)
report        = 3825 µUSD, "0.003825000"
```

Small-call exactness: 1-token `gemini-2.5-flash-lite` (input `100_000 µUSD/1M`) = exactly `100 nUSD`, rejecting per-component micro ceiling.

---

## 8. Per-Call Pricing Design (`priceProviderCall`)

- **Identity:** reuses Phase 2B `selectPricingIdentity`; `MISSING_MODEL` ⇒ `UNPRICED MODEL_MISSING`.
- **Usage state:** no billable field ⇒ `USAGE_MISSING`; negative/NaN/non-safe-integer ⇒ `USAGE_INVALID`; all present billable counts zero ⇒ `PRICED` @ `0n` (`ZERO_USAGE_EXPLICIT`); absent fields are never coerced to zero.
- **Token billing:** aggregate `inputTokens` at `inputMicrosPerMillion`, `outputTokens` at `outputMicrosPerMillion`; `reasoningTokens` is informational (never added; provider output rate covers reasoning).
- **Cached input:** `DISJOINT` adds `cachedInputTokens` at the cached rate; `INCLUDED_IN_INPUT` never counts it a second time; reported cached tokens with no applicable cached rate ⇒ `UNIT_UNPRICED`. `cachedOutputTokens` requires a `cachedOutputMicrosPerMillion`, else `UNIT_UNPRICED`.
- **Modality:** no `audioInputMicrosPerMillion` ⇒ price the aggregate input only (breakdowns are observability-only). With an audio rate, the split is exact nUSD arithmetic; `audioInputTokens > inputTokens` or `imageInputTokens > inputTokens` ⇒ `MODALITY_INVALID` (never clamped).
- **Per-unit:** `generatedImageCount` priced only for `IMAGE` billing at `perUnitMicros`; `inputCharacters`/`outputCharacters` under `CHARACTER`; `audioOutputSeconds` under `SECOND`/`MINUTE`. Unsupported reported units ⇒ `UNIT_UNPRICED`, never silent zero.
- **Fractional duration (SECOND/MINUTE, Option A):** Phase 2C prices **only whole-unit duration counts**. A fractional duration would require floating-point sub-unit promotion, so it is rejected as `USAGE_INVALID` when an applicable per-unit rate exists — never floored, never rounded, never split into a float. No Phase 2 card exercises this path: TTS has no verified rate, so no fractional duration is ever priced.
- **TTS:** `gemini-3.1-flash-tts-preview` has no verified rate ⇒ `UNPRICED` (`ACTUAL_MODEL_NOT_IN_RATECARD`), no fabrication, no legacy-rate reuse.

`OVERFLOW` remains the defensive reserve reason; BigInt internal arithmetic makes it unreachable in normal pricing (audited in §13).

---

## 9. Aggregation (`aggregateProviderCalls`)

`aggregateProviderCalls(input)` returns `ShadowPricingResult`:

- Accepts authoritative `providerCalls` (array or anything), drops `providerCallMade=false` defensively, prices each real call exactly **once**.
- `calls`: one `ShadowPricedCall` per real call; duplicates preserved; empty payload ⇒ `calls: []`, `noProviderCalls: true`.
- `totals.pricedCostNanoUsd`: exact BigInt sum over `PRICED` calls (never rounded).
- `totals.unpricedReasons`: deterministic count over every `UnpricedReason` (all zero-initialized).
- `summaryStatus`: exactly three values — all priced ⇒ `FULLY_PRICED`; none ⇒ `UNPRICED`; mixed ⇒ `PARTIALLY_PRICED`; zero real calls ⇒ `UNPRICED` with `noProviderCalls: true`.
- Pure reduce; no rounding, no I/O, no mutation.

---

## 10. Type Extensions (additive only)

`src/types/provider-pricing.ts` received only additive Phase 2C surfaces; all Phase 2B literal and discriminated-union guarantees are preserved:

- `CachedInputAccountingSemantic = 'DISJOINT' | 'INCLUDED_IN_INPUT'` (explicit; no undocumented default).
- `RateCardEntry.cachedInputAccounting?: CachedInputAccountingSemantic` (required when a cached-input rate is published).
- `UsageApplied` extended with optional `imageInputTokens`, `audioInputTokens`, `audioOutputTokens`, `audioOutputSeconds`, `inputCharacters`, `outputCharacters`, `cachedInputAccounting`.
- New `RateResolution` discriminated union (`RESOLVED` | `UNRESOLVED`).
- `ShadowPricingInput.card?: ProviderRateCard` (injectable; defaults to the materialized card).

No existing production file was otherwise modified.

---

## 11. Status & Boundary Enforcement

- Phase 2C implements **only** the pure engine; `recordAiUsage`, logs, coverage service, admin endpoints, Wallet, TokenTransaction, Prisma, migrations, durable persistence, durable billing activation, routes, and the AI Service are **out of scope** and untouched.
- No commits, no pushes, no package/env/Prisma schema/migration changes were made.
- Legacy `computeAiCost` / `src/config/ai-pricing.ts` / `src/utils/ai-usage.ts` remain untouched (telemetry-only).
- The engine is pure, synchronous, unit-testable, with no Prisma/network/environment dependencies.

---

## 12. Verification (completed)

1. **Focused tests:** `node --env-file=.env.test --import tsx --test-concurrency=1 --test tests/provider-pricing-*.test.ts` → **130/130 pass** (Phase 2B: 37 contract + identity; Phase 2C: 22 arithmetic, 38 rate-card, 19 call, 14 aggregate = 93).
2. **Money-safety correction (final Phase 2C):** `nanoUsdToMicroUsdCeil` returns **bigint** (`3825n`), not number; compile-time guards assert every authoritative money helper (`ceilDiv`, `tokenComponentCostNanoUsd`, `perUnitCostNanoUsd`, `nanoUsdToMicroUsdCeil`) is typed `bigint` — no `Number()` on authoritative money. Very large nUSD totals convert exactly without `Number.MAX_SAFE_INTEGER` overflow. Fractional SECOND/MINUTE durations return `USAGE_INVALID` (Option A); TTS remains `UNPRICED`.
3. **Source typecheck:** `npx --no-install tsc --noEmit` → **clean** (src includes all new engine modules).
4. **Test-file typecheck:** explicit `tsc --strict` on the Phase 2B + 2C `tests/provider-pricing-*.test.ts` → **clean** (all `@ts-expect-error` guards active).
5. **Whitespace:** `git diff --check` → **clean**.
6. **Backward compatibility:** no existing production source imports the new engine modules; the only existing file modified is the additive type surface in `src/types/provider-pricing.ts`.
7. **Engine behavior:** the §8.4 worked example reproduces exactly (`3_825_000 nUSD`, `3825 µUSD` bigint, `"0.003825000"`); 1-token `gemini-2.5-flash-lite` = `100 nUSD`; empty payload returns `noProviderCalls: true`.

**Full-suite count (corrected):** the Phase 2B full-suite baseline was **1382 passing tests** (= 1345 pre-existing + 37 Phase 2B). After Phase 2C the runner discovers **1475 tests total** (= 1382 Phase 2B + 93 Phase 2C). This matches the runner's reported `ℹ tests 1475`.

**Full-suite hang investigation (comparative, bounded):**

| Item | Phase 2C worktree | Phase 2B worktree |
|---|---|---|
| Command | `timeout 240 node --env-file=.env.test --import tsx --test-concurrency=1 --test tests/*.test.ts` | `timeout 120 node --env-file=.env.test --import tsx --test-concurrency=1 --test tests/token-package.test.ts` (same env) |
| Timeout | 240 s | 120 s |
| Last completed test before hang | Phase 2C pricing tests complete, then `tests/signup-grant.test.ts` (Signup Token Grant), then `tests/token-package.test.ts` starts | n/a (single file) |
| Suspected hanging test/file | `tests/token-package.test.ts` | `tests/token-package.test.ts` |
| Process exit code | 124 (timeout) | 124 (timeout) |
| Root error | `PrismaClientInitializationError: Database core_server_test does not exist` (Postgres on `localhost:5434` reachable, but the test DB is not created in this environment) | identical |
| Interrupted report | `Interrupted while running: tests/token-package.test.ts` | identical |

**Classification:** the identical `tests/token-package.test.ts` hang reproduces in both the Phase 2C worktree and the Phase 2B worktree (`Core-Server-provider-model-pricing`) under the same environment — **reproducible pre-existing/environmental evidence**, not a Phase 2C regression. The hang is caused by the missing `core_server_test` Postgres database (Prisma init error) plus the test's `server.close()` waiting on the failed/keep-alive Prisma handle. It is unrelated to the additive 2C changes: no existing production source imports the new engine modules, and all `provider-pricing-*` tests pass in isolation.

> **Resolution (environmental, not a Phase 2C defect):** the full suite cannot complete until the `core_server_test` database exists in this environment. This is out of scope for Phase 2C (no Prisma/migration/env changes permitted).

---

## 13. Backward Compatibility Confirmation

- `src/types/provider-pricing.ts` gained only optional fields and new exported types; no existing consumer depends on changed construction, and the discriminated unions remain intact.
- No existing test file was changed.
- New engine modules are not referenced by existing production code, so Phase 2C cannot alter live behavior.

---

## 14. Deviations from the Design

| # | Design | Implementation | Justification |
|---|---|---|---|
| 1 | Audio modality split (baseline notes for `gemini-3.1-flash-lite` / `gemini-3-flash-preview`) | Audio `audioInputMicrosPerMillion` not materialized | Baseline top-level `audioInputRateMicrosPerMillion` is `null`; notes are not structured rates. Aggregate-only pricing is the §11.1 default; no invented rate. |
| 2 | Alias `gemini-2.5-flash-lite-preview-09-2025` → `gemini-2.5-flash-lite` (§6.3 example) | No alias materialized | Baseline has the preview as a **separate entry**, no alias field; Rihla routes to the four materialized models. Materializing an unverified alias would violate the 1:1 curation rule. |
| 3 | `context_cache_storage` tier (§7) | Not materialized | Per-hour storage, not a per-call tier; `RateCardTier` has no such member and no call path bills it. |

No behavioral deviation was introduced; the engine matches the design contract exactly.

---

## 15. Verification Surface / Open Items Into 2D

Verified the engine end-to-end with the §8.4 worked example and the 1-token small-call exactness case.

**Open / carried into Phase 2D:**

1. Wire the engine into the `recordAiUsage` choke point (`src/services/ai-usage.service.ts`) — pure call → `shadowPricingService.record(result)`.
2. Shadow production logs + in-memory coverage buffer (Phase 2D).
3. Admin visibility endpoints (Phase 2D/E, out of 2B/2C).
4. Recompute-on-read coverage over existing `AiUsageLog` rows (Phase 2D).
5. Preserved invariants that 2D must not break: `providerCalls` authoritative, `UNPRICED` cost-free, `ZERO_USAGE_EXPLICIT` at `0n`, provider set derived (no allowlist), no substring/fuzzy matching, BigInt-only money, no provider inference.

---

## 16. Acceptance-Criteria Mapping (Phase 2C subset of §18)

| Criterion | Status |
|---|---|
| Versioned rate card with effective dates (aliases curated only when reference-backed) | ✔ |
| BigInt nano-USD internal arithmetic with output-boundary rounding | ✔ |
| `PRICED`/`UNPRICED` per-call discriminated union | ✔ (§5, Phase 2B + §8) |
| Exactly three request summary statuses | ✔ (§9) |
| Cached-input disjointness + `INCLUDED_IN_INPUT` semantic | ✔ |
| Modality-safe breakdown accounting with `MODALITY_INVALID` guard | ✔ |
| Provider set derived from the rate card; no closed provider list | ✔ (§4, §6) |
| TTS stays `UNPRICED` until verified | ✔ (§8) |
| No package/environment/Prisma changes, no commits | ✔ |

---

## 17. Final Verdict

Phase 2C is **implemented and verified**: the provider-neutral rate card, validation, exact resolution, BigInt money arithmetic, pure per-call pricing, and pure aggregation are complete and covered by 93 new focused tests (130 Phase 2B+2C focused total), with clean typechecks for both `src` and tests and exact arithmetic verified against the §8.4 worked example. The engine is pure and does not alter any live behavior. The full suite's DB/network integration tests hang in this environment (pre-existing, non-2C) and were tracked separately.

**Status:** READY FOR REVIEW. Next phase is 2D — integration into `recordAiUsage` with shadow logs, in-memory coverage, and recompute-on-read coverage.

---

PHASE_2C_PRICING_ENGINE_READY