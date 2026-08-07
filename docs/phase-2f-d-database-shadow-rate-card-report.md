# Phase 2F-D — Database Rate Card Shadow Wiring and Static-vs-DB Comparison

## Readiness

**Status: `PHASE_2F_D_DATABASE_RATE_CARD_SHADOW_READY`**

## Worktree & Branch

- **Path**: `/media/mohamed/newvolume/ITI Professional Scholarship nine month/Rhila/Core-Server-provider-pricing-phase2`
- **Branch**: `feature/provider-pricing-phase2`

## Test Database Safety

- All database operations use `core_server_test` only
- `DATABASE_URL` pathname strictly validated as `/core_server_test`
- Main/original database never touched

## Files Created (Phase 2F-D)

- `src/services/shadow-pricing-deps.ts` — Shadow pricing dependencies interface (`ShadowPricingDependencies`, `loadShadowRateCard`, error handling)
- `src/utils/provider-pricing/shadow-comparison.ts` — Pure deterministic comparison engine (`compareShadowPricingResults`)
- `tests/ai-shadow-pricing-db-rate-card.test.ts` — Unit tests with fakes (13 tests)
- `tests/ai-shadow-pricing-db-rate-card-db.test.ts` — Real PostgreSQL integration tests (16 tests; self-contained fixtures with unique UUIDs/versions, targeted cleanup)
- `tests/provider-rate-card-shadow-comparison.test.ts` — Pure comparator tests (19 tests)
- `tests/ai-shadow-pricing-http-boundary.test.ts` — HTTP/runtime boundary tests (11 tests)
- `tests/ai-shadow-pricing-recompute.test.ts` — Recompute shadow comparison tests (22 tests)

## Files Modified (Phase 2F-D)

- `src/config/env.ts` — Added `PROVIDER_RATE_CARD_DB_SHADOW_ENABLED` and `PROVIDER_RATE_CARD_DB_SHADOW_TIMEOUT_MS` feature flags
- `src/services/ai-shadow-pricing.service.ts` — Extended with async DB shadow comparison (timeout isolation, MATCH/MISMATCH/NOT_FOUND/ERROR/TIMEOUT handling)
- `src/services/ai-shadow-pricing-recompute.service.ts` — Extended with exact-version lookup (`EXPLICIT_VERSION`) + active-date fallback
- `src/services/ai-usage.service.ts` — Updated `runShadowPricing` to async
- `tests/ai-shadow-pricing-service.test.ts` — Updated for async service, all 11 tests pass
- `tests/provider-rate-card-source.test.ts` — Updated to allow `shadow-pricing-deps.ts` import, all 16 tests pass

## Feature Flags

### `PROVIDER_RATE_CARD_DB_SHADOW_ENABLED`
- **Parsing**: Explicit Zod `preprocess` (no `z.coerce.boolean()`)
- `undefined` → `false`
- `""` → `false`
- `"true"` / `"TRUE"` → `true`
- `"false"` / `"FALSE"` → `false`
- `"0"` → `false`
- `"1"` → `false`
- `"garbage"` → `false`
- boolean `true`/`false` handled safely

### `PROVIDER_RATE_CARD_DB_SHADOW_TIMEOUT_MS`
- **Parsing**: Explicit Zod `preprocess` with positive integer validation
- unset/empty/invalid → safe default `150` ms
- Must be a positive integer

## Timeout Isolation

- Configured default: **150 ms**
- Shadow work raced against timeout via `Promise.race`
- On timeout: static result remains authoritative; comparison status = `DB_RATE_CARD_TIMEOUT`; no unhandled rejection; no late state mutation

## Comparison Statuses

| Status | Meaning |
|--------|---------|
| `MATCH` | All aggregate + per-call fields identical |
| `MISMATCH` | Any field differs (cost, model, tier, billing unit, unpriced reasons) |
| `DB_RATE_CARD_NOT_FOUND` | No ACTIVE snapshot for pricing date |
| `DB_RATE_CARD_ACTIVE_CONFLICT` | Multiple ACTIVE snapshots overlap |
| `DB_RATE_CARD_VERSION_NOT_FOUND` | Exact version not found (recompute) |
| `DB_RATE_CARD_INVALID` | Snapshot fails pure mapper validation |
| `DB_RATE_CARD_ERROR` | Unexpected repository/DB failure |
| `DB_RATE_CARD_TIMEOUT` | Shadow branch exceeded timeout |
| `DB_PRICING_ERROR` | Unexpected error during DB pricing calculation |

## Per-Component Comparison

The comparator decomposes and compares each component independently using existing `tokenComponentCostNanoUsd` / `perUnitCostNanoUsd` arithmetic (no formula duplication):

- `inputCostNanoUsd` → `INPUT_COST`
- `outputCostNanoUsd` → `OUTPUT_COST`
- `cachedInputCostNanoUsd` → `CACHED_INPUT_COST`
- `cachedOutputCostNanoUsd` → `CACHED_OUTPUT_COST`
- `audioInputCostNanoUsd` → `AUDIO_INPUT_COST`
- `audioOutputCostNanoUsd` → `AUDIO_OUTPUT_COST`
- `perUnitCostNanoUsd` → `PER_UNIT_COST`
- `total costNanoUsd` → `PER_CALL_COST` / `TOTAL_COST`

**Same total with different components → `MISMATCH`** (verified by test `same total but different components → MISMATCH`)

## Live Selection (ACTIVE_DATE)

- Derives canonical `YYYY-MM-DD` pricingDate (same as static path)
- Calls `loadActiveRateCardForDate(pricingDate)` via injected loader
- If ACTIVE snapshot found: prices same normalized `providerCalls` with DB card
- Compares results, emits structured log, returns static result
- DRAFT/RETIRED never selected by active-date lookup

## Historical Recompute (EXPLICIT_VERSION)

- When enabled + eligible historical row:
  - If row has `rateCardVersion`: `loadRateCardByVersion(version)` (`EXPLICIT_VERSION`)
  - Else: `loadActiveRateCardForDate(row.createdAt)` (`ACTIVE_DATE` fallback)
- Comparison emits `selectionMode` in observation
- Never auto-selects newest version; distinguishes version missing / invalid / DB error
- **DRAFT/RETIRED versions loadable by exact version** (verified by tests)
- No historical record mutation; no Wallet/billing mutation

## Static-Authoritative Rule (Non-Negotiable)

- Static `PROVIDER_RATE_CARD` always produces the returned result
- Database pricing is **comparison-only** — never determines billed amount
- Never alters Wallet, TokenReservation, TokenTransaction, AIBillingOperation, Payment
- Never alters AI responses or HTTP status
- Even perfect DB match returns static result

## Observability (Structured Log)

```
event: 'ai_shadow_pricing_comparison'
operationId
comparisonStatus
selectionMode: 'ACTIVE_DATE' | 'EXPLICIT_VERSION'
pricingDate
staticRateCardVersion
databaseRateCardVersion
staticPricingStatus
databasePricingStatus
staticTotalCostNanoUsd (string)
databaseTotalCostNanoUsd (string | null)
deltaNanoUsd (string | null)
mismatchFields: string[]
mismatchCategories: string[]
loaderErrorCode
providerCallCount
durationMs
featureEnabled: boolean
```

No prompts, responses, images, audio, secrets, credentials, raw SQL, DATABASE_URL, or full Rate Card payloads logged.

## HTTP/Runtime Boundary Guarantees

Verified by `tests/ai-shadow-pricing-http-boundary.test.ts` (11 tests):
- Feature disabled → unchanged HTTP output
- Feature enabled + DB MATCH → unchanged HTTP output
- Feature enabled + DB MISMATCH/NOT_FOUND/ACTIVE_CONFLICT/ERROR/TIMEOUT → unchanged HTTP output
- AI executor called exactly once (shadow does not duplicate)
- No extra Wallet deduction
- No extra TokenTransaction
- Idempotent replay unchanged

## What Was NOT Implemented

- ❌ Database-primary pricing
- ❌ Wallet cutover
- ❌ Billing changes
- ❌ Fallback to DB on static failure
- ❌ Cache for DB Rate Card
- ❌ Migration / schema changes
- ❌ Provider API calls
- ❌ Main/original database changes

## Test Results

### Phase 2F-D Focused Suites (108 tests, all pass)

| Test File | Tests | Pass |
|-----------|-------|------|
| `ai-shadow-pricing-db-rate-card-db.test.ts` (real PostgreSQL) | 16 | 16 |
| `provider-rate-card-shadow-comparison.test.ts` | 19 | 19 |
| `ai-shadow-pricing-db-rate-card.test.ts` | 13 | 13 |
| `ai-shadow-pricing-http-boundary.test.ts` | 11 | 11 |
| `ai-shadow-pricing-recompute.test.ts` | 22 | 22 |
| `ai-shadow-pricing-service.test.ts` | 11 | 11 |
| `provider-rate-card-source.test.ts` | 16 | 16 |
| **Total** | **108** | **108** |

### Full Core Suite (including the DB integration file)

Run exactly as required:
`timeout 600 node --env-file=.env.test --import tsx --test --test-concurrency=1 tests/*.test.ts`

- **Total tests**: 1,985
- **Pass**: 1,985
- **Fail**: 0
- **Cancelled**: 0
- **Skipped**: 0
- Every test file under `tests/` is included; the DB integration file is part of the run.

### Real PostgreSQL DB Integration (`ai-shadow-pricing-db-rate-card-db.test.ts`)

All 16 tests pass against `core_server_test` and cover:
- exact-parity ACTIVE snapshot → `MATCH`
- changed ACTIVE rate → `MISMATCH` (`INPUT_COST`)
- DRAFT ignored by active-date lookup → `DB_RATE_CARD_NOT_FOUND`
- RETIRED ignored by active-date lookup → `DB_RATE_CARD_NOT_FOUND`
- `effectiveFrom` inclusive → `MATCH`
- `effectiveTo` inclusive → `MATCH`
- `effectiveTo` null (open-ended) → `MATCH`
- no ACTIVE snapshot → `DB_RATE_CARD_NOT_FOUND`
- overlapping ACTIVE snapshots → `DB_RATE_CARD_ACTIVE_CONFLICT`
- exact DRAFT version lookup
- exact RETIRED version lookup
- bigint exactness (DB stores huge BIGINT exactly; engine boundary rejects out-of-range → `DB_RATE_CARD_INVALID`)
- same snapshot reused for multiple provider calls (one DB load)
- no snapshot lifecycle mutation / no entry mutation
- no Wallet/billing/usage mutations
- hard gate: `DATABASE_URL` pathname is `/core_server_test`

### DB Integration Test Hygiene

The suite is self-contained and does NOT depend on the static import script or a pre-existing `1.0.0` DRAFT:
- Snapshot IDs are real UUIDs (`crypto.randomUUID()`)
- `ProviderRateCardEntry` uses flat DB columns with exact BIGINT rates
- `tier` uses the DB enum spellings `STANDARD` / `BATCH` / `PRIORITY` / `FAST_MODE`
- Every test-owned snapshot uses a unique `shadow-db-it-<label>-<uuid>` version
- Baseline counts are recorded before the suite and verified after; cleanup deletes ONLY rows owned by this suite's prefix
- No unrelated snapshots are read, published, retired, modified, or deleted

## Verification Results

| Check | Result |
|-------|--------|
| `new URL(process.env.DATABASE_URL).pathname === '/core_server_test'` | ✅ Verified |
| `prisma validate` | ✅ Valid |
| `prisma generate` | ✅ Clean |
| `tsc --noEmit` | ✅ Clean |
| DB integration test (real PostgreSQL) | ✅ 16/16 pass |
| Phase 2F-D focused tests (108) | ✅ 108/108 pass |
| Full Core suite (incl. DB integration) | ✅ 1985/1985 pass |
| `git diff --check` | ✅ Clean |
| Static `PROVIDER_RATE_CARD` authoritative | ✅ Verified via source-scan tests |

## Database State — Baseline Before and After

- **Database used**: `core_server_test` only (`DATABASE_URL` pathname verified `/core_server_test`; main/original database never touched)
- **Snapshot count**: 0 before the suite → 0 after (baseline restored)
- **Entry count**: 0 before the suite → 0 after (baseline restored)
- **Owned test snapshots/entries** (`shadow-db-it-*`): 0 left behind after cleanup
- **Version `1.0.0`**: absent (the suite never requires or creates it)
- **Wallet / TokenTransaction / TokenReservation / AIBillingOperation / Payment / TokenPackage / AiUsageLog**: 0 rows, unchanged before and after (no Wallet/billing mutations)
- **Unrelated snapshots**: none exist and none were touched

The `after` hook asserts `assert.deepEqual(now, baseline)` after cleanup, so a non-baseline result would fail the suite.

## Known Limitations

1. **Component-level costs only decomposed in comparison** — Not exposed in HTTP responses (by design, shadow is comparison-only).
2. **Historical recompute limited by current schema** — Current `AiUsageLog` lacks provider/model identity; only future rows with authoritative fields would recompute.
3. **No per-tenant feature flag** — Currently process-wide only (Phase 2F-E candidate).
4. **No admin UI for comparison metrics** — Observability via structured logs only (Phase 2F-E candidate).

## Next Phase

**Phase 2F-E: Production Hardening**
- Add per-component cost decomposition to comparison output (if needed for observability)
- Add configurable timeout budget per-tenant/environment
- Add admin UI/dashboard for comparison metrics (MATCH rate, mismatch categories)
- Evaluate DB-primary cutover criteria (MATCH rate threshold, zero critical mismatches)
- Add gradual rollout strategy with per-tenant feature flag

---

*Report generated from actual working tree state. All verification commands executed against `core_server_test` database only.*