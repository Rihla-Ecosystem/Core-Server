# Phase 2B — Contract Hardening and Model Identity

**Status:** READY FOR REVIEW
**Date:** 2026-08-03
**Phase:** 2B (contract hardening and model identity only — no rate card, no engine, no wiring).
**Task type:** production types + pure identity utility + tests + report. No commits, no pushes, no package/dependency/env/Prisma/migration changes.

---

## 1. Executive Summary

Phase 2B hardens the provider-neutral shadow-pricing **contract** and the **model-identity** layer per the authoritative design (`docs/phase-2-provider-pricing-design.md`, §5, §6, §16-2B):

- The per-call result is a **discriminated union** `ShadowPricedCall` (`PRICED` | `UNPRICED`). `PRICED` uniquely carries `costNanoUsd: bigint` and a `PricedVia` reason; `UNPRICED` is structurally forbidden from carrying any cost field (`costNanoUsd` / `costMicros` / `costUsd` do not exist on the variant). Explicit provider-reported zero usage is `PRICED` at `0n` (`ZERO_USAGE_EXPLICIT`).
- Model identity follows the **authoritative `actualModel`** rule: `actualModel` is always selected when present (source `ACTUAL_MODEL`); `requestedModel` is inspected only when `actualModel` is absent (`REQUESTED_MODEL_FALLBACK`); neither present ⇒ `MODEL_MISSING`.
- Canonicalization is provider-neutral: provider = trim + lowercase; model display identity = trim only; model lookup key = trim + lowercase. **No closed provider list, no substring/fuzzy/wildcard matching, no provider-from-model inference** in the identity layer.

Everything in scope is new and additive. No existing production file was modified. All 1377 Core tests pass (1345 baseline + 32 new) and `tsc --noEmit` is clean.

---

## 2. Repositories & Branch Snapshot

| Repo | Worktree path | Branch | HEAD |
|---|---|---|---|
| Core Server | `Core-Server-provider-pricing-phase2` | `feature/provider-pricing-phase2` | `d0f34c7400374c2662887887c1111506539c85b8` |

- Phase 2B modified only this worktree; no commits, pushes, or merges.
- The AI Service (`ai-service-provider-pricing-phase2`) was not touched in Phase 2B.

---

## 3. Scope of Phase 2B

**In scope (implemented):**

1. New types file `src/types/provider-pricing.ts` — the discriminated-union result contract, `PricedVia`, `UnpricedReason`, `RequestSummaryStatus`, `PricingIdentitySource`, `PricingIdentityCandidate` / `ModelIdentityFailure`, `RateCardEntry`, `ProviderRateCard`, `RateCardApplied`, `UsageApplied`, `ShadowPricingTotals`, `ShadowPricingResult`, `ShadowPricingInput`, and rate-card schema constants.
2. New pure identity module `src/utils/provider-pricing/model-identity.ts` — `canonicalizeProvider`, `canonicalizeModel`, `selectPricingIdentity`.
3. New tests `tests/provider-pricing-contract.test.ts` (12 tests) and `tests/provider-pricing-identity.test.ts` (20 tests).

**Explicitly deferred to Phase 2C/2D/future (NOT implemented):**

- Rate-card materialization, validation, and loading; provider/model/alias/effective-date/tier resolution.
- The pricing engine (BigInt nUSD arithmetic, per-call pricing, request aggregation).
- Existence checks (`ACTUAL_MODEL_NOT_IN_RATECARD`, `REQUESTED_MODEL_NOT_IN_RATECARD`, `PROVIDER_NOT_IN_RATECARD` are reason *values* in the contract but are produced only by Phase 2C resolution).
- Wiring into `recordAiUsage`, structured logs, coverage services, admin endpoints.
- `AiShadowPricingLog`, Prisma schema/migrations, durable persistence, historical backfill.

---

## 4. Files Created (Inventory)

| File | Kind | Purpose |
|---|---|---|
| `src/types/provider-pricing.ts` | **new** | Phase 2B contracts: discriminated union, literal-hardened rate-card schema, identity candidate, aggregation result, engine input. |
| `src/utils/provider-pricing/model-identity.ts` | **new** | Pure provider/model canonicalization + authoritative-`actualModel` identity selection (§6). |
| `tests/provider-pricing-contract.test.ts` | **new** | Contract tests incl. compile-time guards. |
| `tests/provider-pricing-identity.test.ts` | **new** | Identity-resolution scenarios + impossible-combination compile-time guards. |

**Explicitly NOT changed:** `src/types/ai.ts`, `src/utils/ai-usage.ts`, `src/config/ai-pricing.ts`, `src/types/ai-pricing.ts`, `src/services/ai-usage.service.ts`, all AI service code, Wallet pricing/consumption, durable billing, `package.json`/lockfiles, env files, `prisma/schema.prisma`, migrations.

---

## 5. Contract Hardening (Discriminated Union)

`ShadowPricedCall` is keyed on `kind` (`'PRICED' | 'UNPRICED'`):

```
type ShadowPricedCall =
  | { kind: 'PRICED';   reason: PricedVia;    rateCard: RateCardApplied; costNanoUsd: bigint; usageApplied?: UsageApplied; ... }
  | { kind: 'UNPRICED'; reason: UnpricedReason; ... }        // NO cost field of any kind
```

Safety invariants locked in the type system:

1. **`UNPRICED` cannot carry a cost.** `costNanoUsd`, `costMicros`, and `costUsd` do not exist on the `UNPRICED` variant. Three `@ts-expect-error` guards in `tests/provider-pricing-contract.test.ts` fail to compile if any cost field is ever added to `UNPRICED` (the directive becomes "unused"), and runtime assertions confirm `'costNanoUsd' in call === false`.
2. **`PRICED` requires an exact `bigint` `costNanoUsd`** and a `RateCardApplied` snapshot (version/model/tier/billingUnit) plus a `PricedVia` reason.
3. **`ZERO_USAGE_EXPLICIT` is `PRICED` at `0n`** — explicit provider-reported zero usage is distinct from "could not price".
4. **No JSON serialization behavior in Phase 2B.** `costNanoUsd` stays an internal raw `bigint`; `JSON.stringify(bigint)` throws (`TypeError`), and no `toJSON` is attached — serialization is Phase 2D's output-boundary concern.
5. `ShadowPricingResult` requires exactly the three summary statuses `FULLY_PRICED | PARTIALLY_PRICED | UNPRICED`, and `unpricedReasons` is a full `Record<UnpricedReason, number>` so every reason is countable.
6. `UnpricedReason` enumerates all ten reasons (including the Phase 2C-produced `*_NOT_IN_RATECARD` reasons and the defensive `OVERFLOW`).
7. `ShadowPricingInput.providerCalls` is typed `unknown` so the future engine must defend against unvalidated payloads; `pricingDate`/`tier` are optional and injectable.

**Literal hardening (final Phase 2B correction):**

- `ProviderRateCard.schemaVersion`, `.currency`, `.storageUnit`, `.engineUnit`, `.provenance` are **literal types** (`1`, `"USD"`, `"MICROS"`, `"NANO_USD"`, `"RESEARCH_SNAPSHOT"`) tied to the exported constants/types; any other value fails to compile (`@ts-expect-error` guards in the contract test).
- `RateCardApplied.tier` is `RateCardTier` and `.billingUnit` is `RateCardBillingUnit` (closed unions), so a `PRICED` call snapshot cannot carry an untyped tier/billing string.
- `PricingIdentityCandidate` is a **discriminated union**: `SELECTED` requires `model`, `modelLookupKey`, and `source`; `MISSING_MODEL` requires `reason: 'MODEL_MISSING'` and structurally carries no `model` / `modelLookupKey` / `source` (impossible combinations are compile-time errors).

---

## 6. Model Identity Implementation

`src/utils/provider-pricing/model-identity.ts` is pure, defensive, and stateless.

**Canonicalization (§6.1, §6.2):**

- `canonicalizeProvider(value)`: trim + lowercase; non-string / empty-after-trim ⇒ `undefined`. (Provider display identity equals its lookup key.)
- `canonicalizeModel(value)`: returns `{ display, lookup }` where `display` is trimmed (case preserved) and `lookup` is trimmed + lowercased; non-string / empty-after-trim ⇒ `undefined`.
- Whitespace-only and non-string model/provider values are treated as **absent**, never coerced.

**Identity selection (§6.4, authoritative `actualModel`):**

| `actualModel` | `requestedModel` | Result |
|---|---|---|
| present | any | `kind: 'SELECTED'`, `source: 'ACTUAL_MODEL'`, model = actual. `requestedModel` is never inspected. |
| absent | present | `kind: 'SELECTED'`, `source: 'REQUESTED_MODEL_FALLBACK'`, model = requested. |
| absent | absent | `kind: 'MISSING_MODEL'`, `reason: 'MODEL_MISSING'`, no model/source. |

`PricingIdentityCandidate` is a **discriminated union** (`SELECTED` | `MISSING_MODEL`). `SELECTED` requires `model`, `modelLookupKey`, and `source`; provider fields remain optional (Phase 2B does not fail identity selection solely because the provider is missing). `MISSING_MODEL` requires `reason: 'MODEL_MISSING'` and structurally contains no `model` / `modelLookupKey` / `source` fields (enforced by `@ts-expect-error` compile-time guards).

Notes:

- A present-but-eventually-unresolvable `actualModel` still resolves as `ACTUAL_MODEL` in Phase 2B; the "not in rate card" decision is Phase 2C and never triggers a fallback to `requestedModel`.
- No allowlist, no substring/fuzzy/prefix/suffix matching, no provider-from-model inference (tested explicitly).
- Stateless per call, so multi-model requests resolve independently.

---

## 7. What Phase 2B Does NOT Do (Boundary Enforcement)

- Does **not** implement rate-card existence, alias, or active-status resolution (Phase 2C).
- Does **not** compute any cost, run any BigInt arithmetic, or produce `ShadowPricingResult` from real calls.
- Does **not** touch `recordAiUsage`, any feature service, any route, or the AI Service.
- Does **not** add a closed provider list anywhere; provider neutrality is enforced by the identity layer and will be derived from rate-card entries in Phase 2C.
- Does **not** introduce `toJSON`/serialization for BigInt money.

---

## 8. Verification

**Focused (this phase):**

```
node --env-file=.env.test --import tsx --test-concurrency=1 --test \
  tests/provider-pricing-contract.test.ts tests/provider-pricing-identity.test.ts
ℹ tests 37 | pass 37 | fail 0
```

**Full Core suite:** `npm test` → **1382 tests pass, 0 fail** (1345 pre-existing + 37 new; no regressions).

**Type checks:**

- `npx --no-install tsc --noEmit` → clean (0 errors), covers `src/`.
- Explicit `tsc --noEmit --strict ...` over the two new test files → clean, which also validates every `@ts-expect-error` compile-time guard (each is active, i.e. the guarded value/access is a genuine type error).

**Repo hygiene:** `git diff --check` clean; `git status` shows only the four new Phase 2B files plus pre-existing untracked docs/references/`node_modules`.

---

## 9. Backward Compatibility Confirmation

- No existing production file was modified; `ProviderCallUsage` and `normalizeProviderCalls` behavior are unchanged.
- `src/types/ai-pricing.ts` (`AIProviderTokenRate`) is untouched; the dormant path still compiles and passes.
- Legacy `usage`/`model`, `computeAiCost`, `AiUsageLog` writes, Wallet fixed pricing, and durable billing are byte-for-byte unchanged.
- All 1382 Core tests and `tsc --noEmit` are green (matches §15 of the design).

---

## 10. Deviations from the Design

None material. Notes:

- The design's §6.4 "unresolvable" rows produce `ACTUAL_MODEL_NOT_IN_RATECARD` / `REQUESTED_MODEL_NOT_IN_RATECARD`; per the locked Phase 2B boundary those outcomes are produced by Phase 2C rate resolution, while Phase 2B pins down the *source selection* (`SELECTED` via `ACTUAL_MODEL` vs `REQUESTED_MODEL_FALLBACK` vs `MISSING_MODEL`). The tests assert this boundary explicitly (e.g. `requestedModel` is never inspected when `actualModel` is present).

---

## 11. Open Items Carried Into Phase 2C

1. Rate-card materialization/validation; provider set derived from entries (no hard-coded list).
2. Alias + effective-date + tier resolution; case-insensitive model lookup using the `modelLookupKey`.
3. Produce `ACTUAL_MODEL_NOT_IN_RATECARD` / `REQUESTED_MODEL_NOT_IN_RATECARD` / `PROVIDER_NOT_IN_RATECARD` from resolution.
4. BigInt nUSD arithmetic (ceilDiv, §8.2), per-call pricing, request aggregation.

---

## 12. Acceptance-Criteria Mapping (Phase 2B subset of §18)

- **Result safety:** `UNPRICED` carries no cost field (compile-time + runtime verified); explicit zero usage is `PRICED` at `0n`; missing pricing is `UNPRICED`. ✓
- **Model identity:** authoritative `actualModel`, no `requestedModel` fallback when `actualModel` is present, `MODEL_MISSING` when neither. ✓
- **Provider neutrality:** no closed list, no substring heuristics, no provider-from-model inference in the identity layer. ✓
- **Arithmetic:** internal money stays integer `bigint` nUSD; no float path, no serialization behavior in 2B. ✓
- **No schema/migration, no Wallet/legacy changes:** confirmed. ✓

---

## 13. Final Verdict

Phase 2B delivered the hardened discriminated-union contract, the literal-typed rate-card schema, and the authoritative-`actualModel` model-identity layer with compile-time and runtime verification. All 1382 Core tests and `tsc --noEmit` are green; no production file, package, env, Prisma schema, or migration was changed. Phase 2C can now build the rate card and pure pricing engine directly on this contract.

PHASE_2B_CONTRACT_READY
