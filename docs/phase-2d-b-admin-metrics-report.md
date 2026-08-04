# Phase 2D-B — Admin Shadow-Pricing Metrics & Read-Only Historical Preview

Status: `PHASE_2D_B_ADMIN_METRICS_READY`

Branch: `feature/provider-pricing-phase2`

This report documents the Phase 2D-B implementation: read-only admin visibility
into the Phase 2D-A in-memory shadow-pricing observations, plus a truthful
read-only historical recompute preview. It corrects several accounting and
design defects present in the initial draft.

## Files created

- `src/services/ai-shadow-pricing-metrics.service.ts`
- `src/services/ai-shadow-pricing-observation-query.service.ts`
- `src/services/ai-shadow-pricing-recompute.service.ts`
- `src/schemas/admin-shadow-pricing.schema.ts`
- `src/controllers/ai-shadow-pricing-admin.controller.ts`
- `tests/ai-shadow-pricing-metrics.test.ts`
- `tests/ai-shadow-pricing-observation-query.test.ts`
- `tests/ai-shadow-pricing-admin.test.ts`
- `tests/ai-shadow-pricing-recompute.test.ts`
- `docs/phase-2d-b-admin-metrics-report.md` (this file)

## Files modified from the initial draft / prior phases

- `src/routes/admin.routes.ts` — mounted the three admin shadow-pricing routes
  (updated the recompute-preview handler to the dependency-injected factory).
- `tests/ai-shadow-pricing-integration.test.ts` — added the admin controller to
  the allowlist of consumers of the shadow-pricing service module (it reads only
  the shared `DEFAULT_OBSERVATION_BUFFER`; it never invokes pricing).

## Exact routes (all under `/api/admin`)

| Method | Path | Auth / RBAC | Validation |
|--------|------|-------------|-----------|
| GET | `/api/admin/ai-shadow-pricing/summary` | `authenticate` → `requireRole('admin')` | none |
| GET | `/api/admin/ai-shadow-pricing/observations` | `authenticate` → `requireRole('admin')` | `validate(adminObservationsQuerySchema, 'query')` |
| POST | `/api/admin/ai-shadow-pricing/recompute-preview` | `authenticate` → `requireRole('admin')` | `validate(adminRecomputeBodySchema, 'body')` |

Authentication (`authenticate`) and authorization (`requireRole('admin')`) reuse
the existing middleware. No new auth/RBAC mechanism was introduced. Unauthorized
requests receive the existing 401 behavior; authenticated non-admins receive the
existing 403 behavior; admins receive 200. There are no public duplicate routes.

## Corrected defects from the initial draft

1. **Zero-provider-call accounting.** A `noProviderCalls = true, callCount = 0`
   request is a legitimate cache hit, not a pricing failure. The metrics
   aggregator now uses a `requestCategoryOf(report)` helper producing mutually
   exclusive buckets `FULLY_PRICED`, `PARTIALLY_PRICED`, `UNPRICED`,
   `ZERO_PROVIDER_CALLS`. Zero-call requests count under
   `requests.zeroProviderCalls` and `requests.totalObserved`, never under
   `requests.unpriced`, never enter coverage denominators, contribute no cost,
   and remain visible in `bySource`. The initial draft counted them as `UNPRICED`
   because the engine reports `summaryStatus = "UNPRICED"` for an empty call set.

2. **Coverage calculation.** Coverage uses real authoritative provider calls
   only: `pricedCalls / (pricedCalls + unpricedCalls)`. Zero-call observations
   are excluded. When the denominator is zero the result is
   `{ coverageAvailable: false, coverageBasisPoints: null, coveragePercent: null }`
   (never 0%, NaN, or Infinity). Basis points use integer arithmetic with the
   deterministic rule `Math.round(pricedCalls * 10000 / totalRealCalls)`
   (round-half-away-from-zero). All operands stay far below 2^53 so no
   floating-point ambiguity is possible. `coveragePercent` is the exact
   two-decimal string of `basisPoints / 100`.

3. **Cost in breakdowns.** `bySource`, `byProvider`, and `byModel` now carry a
   `pricedProviderCost` (`nanoUsd`/`microUsd`/`usd` strings). Money is aggregated
   internally as bigint nUSD; only PRICED calls contribute cost; UNPRICED calls
   have unknown cost and are never treated as zero actual cost. No `Number()`
   on money, no float aggregation, no raw bigint in responses. For PRICED model
   breakdowns the applied rate-card model is used; for UNPRICED model labels the
   fallback is `actualModel ?? requestedModel ?? "UNKNOWN"` (nothing inferred).

4. **rateCardVersions semantics.** The field now means: *number of observations
   produced under each `report.rateCardVersion`*, counted exactly once per
   observation including zero-call observations. A single observation with
   multiple calls is still counted once. The initial draft counted per-call.

5. **Pure observation query service.** Filtering, ordering, limiting, and
   response mapping moved out of the controller into
   `ai-shadow-pricing-observation-query.service.ts`, which is pure over an
   immutable snapshot. The controller is now thin.

6. **Boolean query parsing.** `noProviderCalls` no longer uses
   `z.coerce.boolean()` (which turned `?noProviderCalls=false` into `true`). It
   now accepts only the literals `"true"` / `"false"` (and boolean `true` /
   `false` when supplied) via an explicit union + transform, and rejects `yes`,
   `1`, `0`, empty string, casing variants, etc.

7. **Historical recompute — no guessing.** The draft's `provider: "google"` and
   `actualModel = requestedModel = model` guessing was removed. Provider identity
   is never inferred from model name, source, feature, current default provider,
   application config, string matching, `computeAiCost`, or fixed Wallet pricing.
   The legacy `model` column is a single collapsed value that is not definitely
   the actual model and not definitely the requested model, so it is never
   assigned to either.

8. **Historical database selection.** The `model: { not: null }` filter was
   removed. The repository retrieves a bounded, deterministic
   (createdAt desc, id desc as tiebreaker), date-ranged selection and maps each
   Prisma row explicitly into a typed `HistoricalPricingRow` via
   `toHistoricalPricingRow`. No `as any[]`, no `miniObs as any`, no broad unsafe
   casts. No writes, no migration, no backfill.

9. **31-day range cap.** The recompute schema enforces `from <= to` and a maximum
   range of 31 days, using the project's existing Zod validation error format.
   Limits: default 100, minimum 1, hard maximum 500 — rejected (not silently
   clamped) when outside.

## Summary response contract

```
{
  generatedAt,
  window: { storage: "IN_MEMORY", ephemeral: true, perProcess: true, capacity, retainedObservations, oldestObservedAt, newestObservedAt },
  requests: { totalObserved, fullyPriced, partiallyPriced, unpriced, zeroProviderCalls },
  providerCalls: { totalRealCalls, pricedCalls, unpricedCalls, coverageAvailable, coverageBasisPoints, coveragePercent },
  pricedProviderCost: { nanoUsd, microUsd, usd },
  unpricedReasons,
  bySource, byProvider, byModel, bySummaryStatus, rateCardVersions
}
```

Invariant enforced and tested: `fullyPriced + partiallyPriced + unpriced +
zeroProviderCalls === totalObserved`.

## Observations response contract (summary rows only)

```
{
  data: [{
    observedAt, source, conversationId,
    engineSummaryStatus,   // the engine's raw status (may be UNPRICED for a cache hit)
    requestCategory,       // FULLY_PRICED | PARTIALLY_PRICED | UNPRICED | ZERO_PROVIDER_CALLS
    noProviderCalls, callCount, pricedCallCount, unpricedCallCount,
    pricedProviderCost: { nanoUsd, microUsd, usd },
    unpricedReasons, rateCardVersion
  }],
  meta: { returned, limit, storage: "IN_MEMORY", ephemeral: true, perProcess: true, capacity }
}
```

Option 2 of the design was chosen: the engine status is preserved
(`engineSummaryStatus`) and a separate `requestCategory` carries the admin view.
Cache hits are therefore never presented to the dashboard as normal unpriced
failures. Default limit 50, hard maximum 200, newest-first, minimal rows, no
prompts/responses/provider payloads/secrets/raw errors. The returned arrays
cannot mutate the observation buffer.

## Zero-call request category

`ZERO_PROVIDER_CALLS` is a first-class request category. It is excluded from the
`UNPRICED` counts, from all coverage denominators, and from cost. It is still
visible in `bySource`, in `bySummaryStatus` (engine status), and in the
observations view under `requestCategory: "ZERO_PROVIDER_CALLS"`.

## Coverage denominator and rounding rule

- Denominator: `pricedCalls + unpricedCalls` (real authoritative calls only).
- Zero-call observations are excluded.
- Rule: `coverageBasisPoints = Math.round(pricedCalls * 10000 / totalRealCalls)`
  — integer numerator/denominator, round-half-away-from-zero.
- `coveragePercent = (coverageBasisPoints / 100).toFixed(2)`.
- Denominator zero ⇒ `coverageAvailable:false`, `coverageBasisPoints:null`,
  `coveragePercent:null`.
- Boundary tested: 1/32 => 312.5 => 313 bps => `"3.13"`.

## Cost breakdown semantics

- Internal money is bigint nUSD; output is exact strings via
  `money()` (nanoUsd = raw string, microUsd = `ceilDiv(n, 1000)`, usd =
  9-decimal `nanoUsdToUsdString`).
- PRICED-only cost. UNPRICED calls have unknown cost and never contribute.
- bySource attributes each PRICED call to its containing observation source.
- byProvider/byModel sum PRICED cost per key.
- Exact beyond `Number.MAX_SAFE_INTEGER` is tested.

## rateCardVersions semantics

Counts each observation once under its `report.rateCardVersion`, including
zero-call observations; never counts per-call. Tested for one observation with
multiple calls (counted once), two observations with the same version,
observations with different versions, and a zero-call observation contributing
to the version count.

## BigInt-safe handling

- Aggregation stays in bigint; conversion to strings happens only at the output
  boundary. There is no `Number()` on money, no float money arithmetic, and no
  raw bigint in any response. A `no-bigint` scan assert covers summary,
  observations, and recompute responses.

## In-memory / per-process limitations

- Storage is `IN_MEMORY`, `ephemeral: true`, `perProcess: true`, fixed capacity
  (default 500, ring buffer). Metrics/observations reset on process restart and
  differ across processes/instances. This is intentionally not durable billing.

## Historical recompute truthfulness rules

- A row is recomputed only when the typed contract carries authoritative
  provider, actual/requested model, and usage.
- Provider identity is never inferred; model identity is never guessed.
- Legacy fixed-price `cost` / `computeAiCost` are never read as pricing inputs
  (the repository `select` never even requests those columns).
- The production mapper always yields `recomputeSupported:false` for current
  legacy AiUsageLog rows → `SKIPPED_UNSUPPORTED_LEGACY_SHAPE`.

## Why provider/model identity was not inferred

The `AiUsageLog` Prisma schema persists: `model String?`, `source`,
`inputTokens`, `outputTokens`, `totalTokens`, `cost Decimal`, `conversationId?`,
`createdAt` (plus userId). There is no provider column, no actual-model vs
requested-model split, and no request/operation grouping key. Recovering any of
those would require guessing, which is explicitly forbidden.
`requestAggregationAvailable` is therefore `false`.

## Historical skip reasons

- `SKIPPED_UNSUPPORTED_LEGACY_SHAPE` (all current production rows)
- `SKIPPED_MISSING_PROVIDER_IDENTITY`
- `SKIPPED_MISSING_MODEL_IDENTITY`
- `SKIPPED_MISSING_USAGE`
- `SKIPPED_INVALID_USAGE`

`skipReasons` reports the SKIPPED_* counts; `rows.{scanned, recomputedPriced,
recomputedUnpriced, skipped}` give the row totals. Warnings explicitly state:
read-only preview, no DB data changed, priced cost excludes unresolved/skipped
historical usage, request aggregation unavailable, and no provider/model identity
was inferred. Nothing claims the current rate card was applied to a skipped row.

## Is any existing AiUsageLog row safely recomputable?

No. Every current legacy row lacks stored provider identity and an authoritative
model identity, so the production mapper marks each as an unsupported legacy
shape and skips it. No invented historical cost is produced.

## Recompute preview response

```
{
  mode: "READ_ONLY_PREVIEW",
  requestAggregationAvailable: false,
  selection: { from, to, requestedLimit, appliedLimit },
  rows: { scanned, recomputedPriced, recomputedUnpriced, skipped },
  pricedProviderCost: { nanoUsd, microUsd, usd },
  unpricedReasons,
  skipReasons,
  warnings
}
```

The pure service is separately tested with an explicitly authoritative test row
shape (provider + actual/requested model + usage) to prove the pricing path and
exact-cost aggregation work correctly when a future schema can supply the
authoritative fields — without weakening the production truthfulness rules.

## requestAggregationAvailable

`false`. There is no reliable operationId / request-grouping key in `AiUsageLog`.
Grouping by conversationId alone, timestamp proximity, userId, source, or model
is prohibited.

## Test coverage

Focused test files and counts (all pass, 0 fail):

| File | Tests |
|------|------|
| `tests/ai-shadow-pricing-metrics.test.ts` | 25 (the 25 required cases) |
| `tests/ai-shadow-pricing-observation-query.test.ts` | 17 |
| `tests/ai-shadow-pricing-admin.test.ts` | 14 |
| `tests/ai-shadow-pricing-recompute.test.ts` | 22 |
| provider-pricing-* + service/observation/integration | remainder |

**Focused total: 249 pass / 0 fail.**

The tests cover: mutual exclusivity of request buckets; zero-call avoidance of
the coverage denominator; deterministic coverage rounding boundaries; exact cost
beyond `MAX_SAFE_INTEGER`; breakdown cost aggregation; rateCardVersions
observation semantics; newest-first ordering and limit caps; explicit boolean
parsing; recompute skip reasons (provider/model/usage/unsupported); exact priced
recompute cost; no guesswork; no DB write / no Wallet / no durable-billing
dependency; no grouping heuristics; JSON-safe money strings; and admin
401/403/200 behavior plus route/import scope checks.

## Validation results

- Focused tests: **249 pass / 0 fail**.
- Strict TypeScript over all Phase 2B/2C/2D-A/2D-B test files (with
  `src/types/index.ts` for the Express `req.user` augmentation): **exit 0**.
- Source `npx --no-install tsc --noEmit`: **exit 0**.
- `git diff --check`: **clean**.
- `git status --short --untracked-files=all`: no
  `prisma/`, `package.json`, `.env*`, migration, or lockfile changes.

## Full-suite bounded result & database blocker

Attempted `timeout 120 npm test`. The suite **timed out** (exit 124) and emitted
base-level failures of the form:

```
PrismaClientInitializationError:
  Invalid `prisma.tokenPackage.findMany()` invocation
  Database `core_server_test` does not exist
```

`core_server_test` is the test database expected by `.env.test`; it is not
present. `psql -lqt` lists **no** `core_server*` databases. This is the same
pre-existing environmental blocker documented in the Phase 2B / Phase 2C /
Phase 2D-A reports — the focused provider-pricing/shadow-pricing suites are
designed to be DB-independent and pass without it. Per instructions the database
was **not** created; credentials/URLs are not reproduced here.

## Scope safety

Confirmed no Phase 2D-B changes to: Wallet balances, business-token consumption,
`TokenTransaction`, `TokenReservation`, durable billing, billing orchestration,
refunds, markup, Wallet token value, payment flow, Prisma schema, migrations,
the AI Service, provider execution, user-facing AI routes, package dependencies,
environment files, or the frontend dashboard.

No commit. No push. Report ends with the readiness marker.
PHASE_2D_B_ADMIN_METRICS_READY
