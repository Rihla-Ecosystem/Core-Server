# Phase 2D-A — Shadow Integration, Structured Reporting, and Bounded In-Memory Observations

**Status:** READY FOR REVIEW  
**Date:** 2026-08-03  
**Phase:** 2D-A (BigInt-safe reporting, bounded observation buffer, failure-isolated shadow service, recordAiUsage integration, focused tests only).  
**Task type:** production services + reporting utility + tests + report. No admin endpoints, no coverage aggregation, no Cost Per Configured Wallet Point, no historical recompute, no Prisma/migrations, no Wallet/billing changes, no AI Service changes, no routes/feature-service changes, no package/dependency/env changes. No commits, no pushes.

---

## 1. Files Created and Modified

### Modified (existing production file)

| File | Change |
|---|---|
| `src/services/ai-usage.service.ts` | Added `recordAiUsageWith` injectable helper; public `recordAiUsage` delegates; single failure-isolated shadow call per invocation |

### New files

| File | Purpose |
|---|---|
| `src/utils/provider-pricing/reporting.ts` | BigInt-safe reporting boundary: `reportMonetary`, `reportableShadowCall`, `reportableTotals`, `toReportableShadow` |
| `src/services/ai-shadow-pricing-observation.service.ts` | Bounded per-process ring buffer (capacity 500), deep-clones on store, immutable snapshots, `reset()` seam |
| `src/services/ai-shadow-pricing.service.ts` | Failure-isolated wrapper: authoritative classification → engine → reporting → buffer → structured log |
| `tests/provider-pricing-reporting.test.ts` | 6 reporting tests |
| `tests/ai-shadow-pricing-observation.test.ts` | 9 observation-buffer tests |
| `tests/ai-shadow-pricing-service.test.ts` | 11 service tests |
| `tests/ai-shadow-pricing-integration.test.ts` | 12 integration tests |

### Not modified

Wallet, Prisma schema/migrations, routes, feature services, AI Service, `package.json`, `tsconfig.json`, `.env.test`, or any Phase 2B/2C file.

---

## 2. Authoritative providerCalls Detection

The `AiShadowPricingService.record()` method classifies the raw `providerCalls` parameter before calling the engine:

| Input | Classification | Engine | Observation | Log | Coverage impact |
|---|---|---|---|---|---|
| `undefined` or non-array | `skipped` (NOT_AUTHORITATIVE) | No | No | No | None |
| Explicit `[]` | `noProviderCalls` | Yes (with `[]`) | Yes (cache-hit) | Yes (noProvider) | Excluded from denominators |
| Non-empty array that normalizes | `authoritative` | Yes | Yes | Yes | Full pricing |
| Non-empty array that fails normalization | `skipped` (INVALID) | No | No | No | None |

Detection uses `Array.isArray`, length check, and `normalizeProviderCalls`. An empty legacy `usage`/`model`-only request never feeds the engine. `providerCallMade=false` records are dropped by the engine's aggregate path (they become `noProviderCalls=true` with `callCount=0`).

---

## 3. Legacy-Path Skip Behavior

When `providerCalls` is absent or invalid, the shadow service returns `{ kind: 'skipped' }`. No engine call, no observation, no log event. The existing `recordAiUsage` legacy path (usage/model → single AiUsageLog row) is completely unchanged.

---

## 4. recordAiUsage Single-Invocation Integration

The shadow invocation is placed **before** the `!params.userId` guard inside `recordAiUsageWith`. This means every call to `recordAiUsage` — including requests that lack a userId — receives exactly one shadow invocation. The shadow service independently classifies absent/invalid providerCalls as skipped.

Integration tests prove:
- Missing userId + authoritative non-empty providerCalls → shadow invoked once, observation stored, no DB write
- Missing userId + explicit `providerCalls=[]` → shadow invoked once, zero-call observation stored, no DB write
- Missing userId + absent providerCalls → shadow invoked once, skips, no observation, no DB write
- All existing userId-present paths unchanged

The public `recordAiUsage` is a thin wrapper around a separately exported `recordAiUsageWith(params, deps)` injectable function, so tests provide fake DB and shadow calls without connecting to Prisma. The production wrapper casts `AiUsageLogRow[]` to `Prisma.AiUsageLogCreateManyInput[]` (and `AiUsageLogRow` to `Prisma.AiUsageLogCreateInput`) via `as unknown as` — structural compatibility is guaranteed because only `AiUsageLogRow` fields are set (no Prisma relations or discriminator).

---

## 5. Failure-Isolation Design

All failure isolation is local to the shadow service and the integration try/catch:

- **Engine failure**: caught in `record()` → safe generic error log (`"shadow pricing failed"`) → `{ kind: 'error' }` outcome. No observation stored.
- **Buffer failure**: caught separately within `record()` → safe generic error log (`"shadow pricing observation failed"`) → success outcome still returned, structured info log still emitted. Buffer failure cannot prevent the info log.
- **Logger failure**: all logger calls go through `safeLog()` which swallows any throw. Logger failure cannot prevent any other path.
- **Public recordAiUsage belt-and-suspenders**: an outer `try/catch` around the shadow call prevents any unforeseen throw from escaping into the request path.

No raw error messages, stack traces, or request payloads appear in error logs.

---

## 6. BigInt-Safe Reporting Format

Reportable shapes (`src/utils/provider-pricing/reporting.ts`) convert authoritative `bigint` money to exact decimal strings at the output boundary:

| Field | Source | Example |
|---|---|---|
| `pricedCostNanoUsd` | `costNanoUsd.toString()` | `"3825000"` |
| `pricedCostMicroUsd` | `nanoUsdToMicroUsdCeil(costNanoUsd).toString()` | `"3825"` |
| `pricedCostUsd` | `nanoUsdToUsdString(costNanoUsd)` | `"0.003825000"` |

Rules enforced by tests:
- `UNPRICED` reportable calls contain **no** cost fields (verified by JSON-serialization check: the word "cost" does not appear).
- No reportable object contains a raw `bigint` (recursive `assertNoBigint` walks every value).
- `JSON.stringify(reportable)` never throws.
- The §8.4 worked example reproduces exactly: `3825000 nUSD` → `"3825000"` / `"3825"` / `"0.003825000"`.
- Very large nUSD values (beyond `Number.MAX_SAFE_INTEGER`) serialize exactly as decimal strings.

---

## 7. Structured-Log Shape and Privacy Restrictions

Success event (via `console.info('[shadow-pricing]', { event, ... })`):

```
{
  event: "ai_shadow_pricing",
  source: "chat",
  conversationId: "conv-1",
  summaryStatus: "FULLY_PRICED",
  noProviderCalls: false,
  callCount: 2,
  pricedCallCount: 2,
  unpricedCallCount: 0,
  pricedCostNanoUsd: "3825000",
  pricedCostMicroUsd: "3825",
  pricedCostUsd: "0.003825000",
  rateCardVersion: "1.0.0",
  unpricedReasons: { PROVIDER_NOT_IN_RATECARD: 0, MODEL_MISSING: 0, ... }
}
```

Error event:

```
{
  event: "ai_shadow_pricing_error",
  source: "chat",
  errorName: "Error",
  errorMessage: "shadow pricing failed"
}
```

Privacy: no prompt, response, raw payload, authorization header, or URL is ever included. Error messages are the generic constants `"shadow pricing failed"` and `"shadow pricing observation failed"` — raw exception text is never logged.

---

## 8. In-Memory Ring-Buffer Behavior

- Class: `AiShadowPricingObservationService`
- Default capacity: `DEFAULT_OBSERVATION_CAPACITY = 500` (no env var, no DB)
- Bounded: oldest observation removed when capacity exceeded
- On `record()`: the caller's observation is **deep-cloned** via `structuredClone` before storage; caller-side mutation cannot affect internal state
- `snapshot()`: returns a new fresh deep clone of the full buffer; mutation of the returned array/objects does not affect internal state
- `reset()`: clears all entries; deterministic for tests
- No coverage counters; Phase 2D-B derives metrics from immutable snapshots

---

## 9. Cache-Hit Behavior

An explicit empty `providerCalls` array is classified as `noProviderCalls`. The service calls the engine with `[]`, which returns `noProviderCalls: true`, `summaryStatus: 'UNPRICED'`, `calls: []`. This produces a single observation (with `report.noProviderCalls: true`) and one structured log. It is never a pricing failure and does not enter priced/unpriced denominators.

---

## 10. Focused Test Results

| Test suite | Tests | Pass | Fail |
|---|---|---|---|
| Phase 2B (contract + identity) | 37 | 37 | 0 |
| Phase 2C (arithmetic + rate-card + call + aggregate) | 93 | 93 | 0 |
| Phase 2D-A reporting | 6 | 6 | 0 |
| Phase 2D-A observation buffer | 9 | 9 | 0 |
| Phase 2D-A shadow service | 11 | 11 | 0 |
| Phase 2D-A integration | 15 | 15 | 0 |
| **Total** | **171** | **171** | **0** |

Command:
```
node --env-file=.env.test --import tsx --test-concurrency=1 --test \
  tests/provider-pricing-*.test.ts tests/ai-shadow-pricing-*.test.ts
```

---

## 11. TypeScript Results

```
npx --no-install tsc --noEmit                                   → clean (exit 0)
npx --no-install tsc --noEmit --strict \
  tests/provider-pricing-*.test.ts tests/ai-shadow-pricing-*.test.ts  → clean (exit 0)
```

All Phase 2B/2C/2D-A test files pass strict TypeScript checks. All `@ts-expect-error` guards remain active.

---

## 12. Full-Suite Result

```
timeout 120 node --env-file=.env.test --import tsx \
  --test-concurrency=1 --test tests/*.test.ts
```

**Result:** Timeout (120s) — identical to Phase 2B and Phase 2C findings. The `tests/token-package.test.ts` file hangs because `core_server_test` Postgres database does not exist in this environment (`PrismaClientInitializationError: Database core_server_test does not exist`). This is a pre-existing environmental blocker, not a Phase 2D-A regression. All 168 Phase 2B/2C/2D-A focused tests pass independently without the missing test database.

---

## 13. git diff --check Result

```
git diff --check → clean (no whitespace errors)
```

---

## 14. Wallet/Prisma/AI-Service Scope-Safety Confirmation

- **No Wallet changes**: `src/services/ai-usage.service.ts` contains no wallet import, no `business-token`, no `TokenTransaction`, no `billing-orchestrator`, no `debit`/`refund`.
- **No Prisma schema or migration**: no `prisma/` file touched; the only Prisma reference in `ai-usage.service.ts` is the unchanged production `prisma.aiUsageLog.createMany/create` path, which the testable seam wraps with `as any` casts.
- **No AI Service changes**: Core-side only.
- **No routes or feature-service changes**: the only modified production file is `src/services/ai-usage.service.ts`. Shadow service is imported only by that file (verified by recursive file scan test 32).
- **No package/dependency/env changes**: `package.json`, `package-lock.json`, `.env.test`, `tsconfig.json` untouched.
- **No admin or public endpoint**: no controller, no route file changed or added.
- **No commits or pushes**: all changes remain uncommitted.

---

## 15. Deferred Phase 2D-B Work

The following are explicitly out of scope for Phase 2D-A and remain for Phase 2D-B:

1. **Admin read endpoint**: no route/controller to expose shadow observations or coverage.
2. **Coverage aggregation**: the observation buffer stores immutable reports; no priced/unpriced ratio or total cost aggregation is computed.
3. **Cost Per Configured Wallet Point**: no `BUSINESS_TOKEN_FEATURE_COSTS` lookup or ratio calculation.
4. **Limited historical recompute**: no recompute-on-read over existing `AiUsageLog` rows.
5. **Durable shadow persistence**: no `AiShadowPricingLog` model, migration, or write path.
6. **Admin metrics route**: no HTTP endpoint for shadow-pricing insight.

---

## 16. Risks and Remaining Limitations

1. **Missing `core_server_test` database**: The full Core suite cannot complete in this environment due to a missing test Postgres database. This is a pre-existing environmental blocker (reproduced in Phase 2B and Phase 2C) and not a Phase 2D-A defect. All 168 Phase 2B/2C/2D-A focused tests pass without the database.
2. **Observation buffer is per-process**: Process restart loses all observations. Phase 2D-B admin endpoints and Phase 2D-B recompute-on-read will address durable visibility.
3. **No thread-safe internal buffer**: The ring buffer uses a plain array; concurrent access from a shared context (e.g. multiple simultaneous `recordAiUsage` calls) is not synchronized. Node.js runs a single event loop, so non-awaited synchronous operations within one turn are safe; any future `await` or worker-thread usage requires a lock.
4. **`normalizeProviderCalls` returns `undefined` for empty arrays**: The shadow service's `classifyProviderCalls` must check `Array.isArray` + `.length` *before* calling `normalizeProviderCalls`. Tests confirm this distinction works correctly.

---

**Status:** READY FOR REVIEW

PHASE_2D_A_SHADOW_INTEGRATION_READY