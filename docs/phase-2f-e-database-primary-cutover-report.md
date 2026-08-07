# Phase 2F-E — Database Rate Card Primary Cutover (Authoritative DB Pricing)

## Readiness

**Status: `PHASE_2F_E_DATABASE_PRIMARY_CUTOVER_READY`**

## Worktree & Branch

- **Path**: `/media/mohamed/newvolume/ITI Professional Scholarship nine month/Rhila/Core-Server-provider-pricing-phase2`
- **Branch**: `feature/provider-pricing-phase2`

## Test Database Safety

- All database operations use `core_server_test` only
- `DATABASE_URL` pathname strictly validated as `/core_server_test`
- Main/original database never touched
- Suite-owned fixtures use unique `shadow-primary-db-it-<label>-<uuid>` versions; cleanup deletes ONLY those rows

## Files Created (Phase 2F-E)

- `tests/provider-rate-card-pricing-source-config.test.ts` — Strict config parser tests (6 tests)
- `tests/ai-shadow-pricing-db-primary.test.ts` — DATABASE_PRIMARY runtime tests with injected fakes (16 tests)
- `tests/ai-shadow-pricing-recompute-exact-version.test.ts` — Recompute exact-version lookup tests (7 tests)
- `tests/ai-shadow-pricing-db-primary-db.test.ts` — Real PostgreSQL DATABASE_PRIMARY integration tests (10 tests; self-contained fixtures, targeted cleanup, baseline restored)

## Files Modified (Phase 2F-E)

- `src/config/env.ts` — Exported pure `parseProviderRateCardPricingSource(value)`; added `PROVIDER_RATE_CARD_PRICING_SOURCE` (strict preprocess + `z.enum`, default `STATIC`)
- `src/services/shadow-pricing-deps.ts` — Added `ProviderRateCardPricingSource` type and `pricingSource?` on `ShadowPricingDependencies`; extracted shared `mapLoadError`; added `loadPrimaryRateCard` (unconditional single ACTIVE-date loader, same stable error mapping as shadow); default factory returns `pricingSource: 'STATIC'`
- `src/services/ai-shadow-pricing.service.ts` — Added `dbPricingError` outcome variant; `record()` dispatches to new private `recordDatabasePrimary()` for `DATABASE_PRIMARY`; shadow gate now `dbShadowEnabled || pricingSource === 'DATABASE_SHADOW'`; observability extended (operationId, configured/actual pricing source, pricingDate, rateCardVersion, providerCallCount, pricingStatus, durationMs, loaderErrorCode, rollbackToStatic)
- `src/services/ai-shadow-pricing-recompute.service.ts` — Merges `pricingSource` from deps/env; comparison gate `dbShadowEnabled || pricingSource === 'DATABASE_SHADOW'`; default deps factory `pricingSource: 'STATIC'`

## Feature Flag

### `PROVIDER_RATE_CARD_PRICING_SOURCE`
- **Parsing**: pure exported `parseProviderRateCardPricingSource(value)` in `env.ts` + Zod `preprocess` + `z.enum([...])`
- `undefined` / `""` / `null` → `STATIC`
- Non-string (numbers, booleans, objects) → `STATIC`
- `"STATIC"` (case-insensitive, trimmed) → `STATIC`
- `"DATABASE_SHADOW"` (case-insensitive, trimmed) → `DATABASE_SHADOW`
- `"DATABASE_PRIMARY"` (case-insensitive, trimmed) → `DATABASE_PRIMARY`
- Any unknown / malformed value (`"garbage"`, `"DATABASE"`, `"PRIMARY"`, `"database-primary"`, `"1"`, `"true"`) → `STATIC` (safe disabled)
- **A typo can never silently enable the database as the pricing source.**

| Mode | Authoritative source | DB use |
|------|---------------------|--------|
| `STATIC` (default) | Static `PROVIDER_RATE_CARD` | Only when the 2F-D flag is enabled; comparison-only |
| `DATABASE_SHADOW` | Static `PROVIDER_RATE_CARD` | Loaded for shadow comparison (equivalent to enabling the 2F-D flag); never billing |
| `DATABASE_PRIMARY` | Database rate card | Loaded once per operation and **authoritative** for pricing |

## DATABASE_PRIMARY Runtime Semantics

- Derived canonical pricing date (same as static path).
- Single unconditional `loadPrimaryRateCard(deps, pricingDate)` per operation — **not** gated by `dbShadowEnabled`.
- Normalized providerCalls priced **once** with the loaded DB card (`engine` runs exactly once; the AI/provider is never executed twice).
- The DB result **is** the returned outcome (`kind: 'priced'`); the actual DB snapshot version is recorded in the observation and the pricing log.
- Cache hit / empty providerCalls: no DB load, no pricing; observation logged with `actualPricingSource: 'STATIC'`, `rateCardVersion: null`.
- Timeout isolation reuses the existing `PROVIDER_RATE_CARD_DB_SHADOW_TIMEOUT_MS` (default 150 ms) via `Promise.race`.
- DRAFT/RETIRED snapshots are never selected for live pricing (active-date lookup is ACTIVE-only); no rate-card lifecycle mutation.

## Fail-Closed Guarantees (No Silent Fallback, No Zero Cost)

Every load/pricing failure produces a stable internal `dbPricingError` outcome and logs `ai_shadow_pricing_primary_error`:

| Loader code | Outcome status |
|-------------|----------------|
| `RATE_CARD_NOT_FOUND` (no ACTIVE, or DRAFT/RETIRED-only DB) | `DB_RATE_CARD_NOT_FOUND` |
| `RATE_CARD_ACTIVE_CONFLICT` (overlapping ACTIVE) | `DB_RATE_CARD_ACTIVE_CONFLICT` |
| `RATE_CARD_SNAPSHOT_INVALID` (mapper boundary, e.g. huge BIGINT overflow) | `DB_RATE_CARD_INVALID` |
| `RATE_CARD_DATABASE_ERROR` / unexpected error | `DB_RATE_CARD_ERROR` |
| Timeout (loader exceeds budget) | `DB_RATE_CARD_TIMEOUT` |

- Outcome shape: `{ kind: 'dbPricingError', errorCode, status, errorMessage: 'database rate card pricing unavailable' }`
- **Never** falls back to static pricing; **never** fabricates a zero cost.
- `errorMessage` and log payloads are stable/safe; no raw error text, credentials, prompts, responses, or DATABASE_URL.

## Safe Rollback

- Setting `PROVIDER_RATE_CARD_PRICING_SOURCE=STATIC` (or unsetting it — default) restores static authority with **no code changes and no DB mutations**.
- Static mode never touches the DB loader, and DB failures have zero effect on the static path.

## Historical Recompute (EXPLICIT_VERSION)

- When the recorded `rateCardVersion` is present: exact `loadRateCardByVersion(version)` lookup — ACTIVE/DRAFT/RETIRED all loadable by exact version; the recorded version is **never replaced with the newest**.
- When no version is recorded: `ACTIVE_DATE` lookup on the row's pricing date.
- Missing exact version → stable `DB_RATE_CARD_VERSION_NOT_FOUND`.
- Comparison enabled only when `dbShadowEnabled || pricingSource === 'DATABASE_SHADOW'` (STATIC + flag off → no DB lookup at all).
- Strictly read-only: no repository writes, no Wallet/billing/usage mutation.

## Observability (Structured Log)

Standard pricing log (`ai_shadow_pricing`) now carries Phase 2F-E diagnostics on every branch:

```
event: 'ai_shadow_pricing'
operationId
configuredPricingSource: 'STATIC' | 'DATABASE_SHADOW' | 'DATABASE_PRIMARY'
actualPricingSource: 'STATIC' | 'DATABASE_PRIMARY'
pricingDate
rateCardVersion: <applied DB version | static version | null>
providerCallCount
pricingStatus
durationMs
loaderErrorCode
rollbackToStatic: boolean
noProviderCalls: boolean
```

Primary failure log:

```
event: 'ai_shadow_pricing_primary_error'
operationId, source, conversationId, configuredPricingSource: 'DATABASE_PRIMARY'
actualPricingSource: 'DATABASE_PRIMARY'
pricingDate, rateCardVersion, providerCallCount
pricingStatus: <stable status>
durationMs, loaderErrorCode: <stable code>, rollbackToStatic: false
errorMessage: 'database rate card pricing unavailable'
```

No prompts, responses, images, audio, secrets, credentials, raw SQL, DATABASE_URL, or full rate-card payloads logged.

## What Was NOT Implemented

- ❌ Wallet cutover (no token balances, reservations, transactions, packages, payments, or AI billing settlement changes)
- ❌ Billing changes / AI billing settlement changes
- ❌ Signup grant or admin token adjustment changes
- ❌ Automatic/silent fallback to static on DB failure (explicit fail-closed instead)
- ❌ DB rate-card caching (one fresh load per operation by design)
- ❌ Provider API calls
- ❌ Main/original database changes
- ❌ No commit, merge, or push performed

## Test Results

### Phase 2F-E Focused Suites (39 tests, all pass)

| Test File | Tests | Pass |
|-----------|-------|------|
| `provider-rate-card-pricing-source-config.test.ts` | 6 | 6 |
| `ai-shadow-pricing-db-primary.test.ts` | 16 | 16 |
| `ai-shadow-pricing-recompute-exact-version.test.ts` | 7 | 7 |
| `ai-shadow-pricing-db-primary-db.test.ts` (real PostgreSQL) | 10 | 10 |
| **Total** | **39** | **39** |

### Full Core Suite (including the DB integration file)

Run exactly as required:
`timeout 600 node --env-file=.env.test --import tsx --test --test-concurrency=1 tests/*.test.ts`

- **Total tests**: 2,024
- **Pass**: 2,024
- **Fail**: 0
- **Cancelled**: 0
- **Skipped**: 0
- Every test file under `tests/` is included; the DB integration file is part of the run. (2F-D baseline was 1,985; +39 new 2F-E tests.)

### Real PostgreSQL DB Integration (`ai-shadow-pricing-db-primary-db.test.ts`)

All 10 tests pass against `core_server_test` and cover:
- ACTIVE DB snapshot → authoritative DB result; DB version recorded in observation + log
- DB rate change changes the priced cost by exactly the rate delta (proves DB authority)
- single DB load serves multiple provider calls (one load, engine runs once)
- no ACTIVE snapshot → `dbPricingError` `DB_RATE_CARD_NOT_FOUND` (no static fallback, no zero cost)
- DRAFT-only DB → `dbPricingError` `DB_RATE_CARD_NOT_FOUND`
- RETIRED-only DB → `dbPricingError` `DB_RATE_CARD_NOT_FOUND`
- overlapping ACTIVE snapshots → `dbPricingError` `DB_RATE_CARD_ACTIVE_CONFLICT`
- huge BIGINT DB rate → `dbPricingError` `DB_RATE_CARD_INVALID`
- no snapshot lifecycle / entry mutation (read-only)
- no Wallet/billing/usage mutations (baseline counts unchanged)
- hard gate: `DATABASE_URL` pathname is `/core_server_test`

### Unit Runtime Coverage (`ai-shadow-pricing-db-primary.test.ts`, 16 tests)

- Authoritative DB pricing + version recorded; single load; noProviderCalls (no DB load, `actualPricingSource: 'STATIC'`)
- Stable error mapping for NOT_FOUND / ACTIVE_CONFLICT / INVALID / DATABASE_ERROR / timeout
- Engine executes exactly once (no double AI execution)
- No prompt/response/DATABASE_URL/SQL logging; no lifecycle mutation
- STATIC rollback restores authority; STATIC unaffected by DB failure
- DATABASE_SHADOW keeps static authoritative and emits comparison

### Recompute Exact-Version Coverage (`ai-shadow-pricing-recompute-exact-version.test.ts`, 7 tests)

- Recorded version → exact `EXPLICIT_VERSION` lookup; never active-date
- No version → `ACTIVE_DATE` lookup on row date
- DRAFT / RETIRED recorded versions looked up exactly (never replaced with newest)
- Missing exact version → `DB_RATE_CARD_VERSION_NOT_FOUND`
- STATIC + flag off → no DB lookup at all
- Strictly read-only (no repository writes)

## Verification Results

| Check | Result |
|-------|--------|
| `new URL(process.env.DATABASE_URL).pathname === '/core_server_test'` | ✅ Verified |
| `prisma validate` | ✅ Valid |
| `prisma generate` | ✅ Clean |
| `tsc --noEmit` | ✅ Clean |
| Phase 2F-E focused tests (39) | ✅ 39/39 pass |
| Phase 2F-E real PostgreSQL integration (10) | ✅ 10/10 pass |
| Full Core suite (incl. DB integration) | ✅ 2024/2024 pass |
| `git diff --check` | ✅ Clean |
| `PROVIDER_RATE_CARD_PRICING_SOURCE` strict parsing | ✅ Verified (typo/malformed → STATIC) |
| Static authority restored by rollback | ✅ Verified |

## Database State — Baseline Before and After

- **Database used**: `core_server_test` only (`DATABASE_URL` pathname verified `/core_server_test`; main/original database never touched)
- **Snapshot count**: 0 before the suite → 0 after (baseline restored)
- **Entry count**: 0 before the suite → 0 after (baseline restored)
- **Owned test snapshots/entries** (`shadow-primary-db-it-*` and prior `shadow-db-it-*`): 0 left behind after cleanup
- **Version `1.0.0`**: absent (the suite never requires or creates it)
- **Wallet / TokenTransaction / TokenReservation / AIBillingOperation / Payment / TokenPackage / AiUsageLog**: 0 rows, unchanged before and after (no Wallet/billing mutations)
- **Unrelated snapshots**: none exist and none were touched

The `after` hook asserts `assert.deepEqual(now, baseline)` after cleanup, so a non-baseline result would fail the suite.

## Known Limitations

1. **No per-tenant feature flag** — `PROVIDER_RATE_CARD_PRICING_SOURCE` is process-wide (candidate for a future phase).
2. **No DB rate-card caching** — DATABASE_PRIMARY loads once per operation (fresh by design; a cache is a future candidate).
3. **Historical recompute limited by current schema** — Current `AiUsageLog` lacks provider/model identity; only future rows with authoritative fields would recompute.
4. **DATABASE_PRIMARY has no auto-recovery** — a DB outage produces `dbPricingError` outcomes until the operator rolls back to `STATIC` (deliberate fail-closed choice; silent automatic fallback is intentionally excluded).

## Next Phase

- Add gradual rollout with a per-tenant pricing-source override
- Add admin UI for pricing-source status and MATCH-rate metrics
- Evaluate an optional short-lived DB rate-card cache with version validation
- Consider a monitored failover policy that never silently masks DB pricing failures

---

*Report generated from actual working tree state. All verification commands executed against `core_server_test` database only.*
