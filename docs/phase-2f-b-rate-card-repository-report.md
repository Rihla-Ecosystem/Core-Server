# Phase 2F-B — Read-Only Rate Card Repository and Loader

Status: `PHASE_2F_B_RATE_CARD_REPOSITORY_READY`

Branch: `feature/provider-pricing-phase2`
Test DB: `postgresql://core_user:core_pass@localhost:5434/core_server_test` (test DB only)
Prisma Client: 6.19.3 (generated to the shared `Core-Server-provider-model-pricing` node_modules)

This report documents Phase 2F-B: a read-only database Rate Card repository and a
loader service built on top of the Phase 2F-A schema. The loader materializes the
existing Pricing Engine `ProviderRateCard` contract from persisted snapshots —
active-date selection with explicit conflict detection and version lookup — while
the static `PROVIDER_RATE_CARD` remains the only live runtime source. No runtime
code is wired to the new read path yet; no fallback, cache, write, Admin CRUD,
Wallet/billing integration, or schema change was introduced.

## 1. Executive summary

Phase 2F-B delivers the database-backed Rate Card read path that Phase 2F-C will
later surface to callers. The design is a clean three-layer seam:

- `src/repositories/provider-rate-card.repository.ts` — read-only persistence
  seam over Prisma (active selection + version lookup), returning plain row
  copies and explicit conflict outcomes.
- `src/utils/provider-rate-card-date.ts` — date-safety helpers enforcing the
  canonical `YYYY-MM-DD` pricing date and UTC-midnight semantics used by the
  repository query.
- `src/types/provider-rate-card-load.ts` — the stable error contract.
- `src/services/provider-rate-card-loader.service.ts` — orchestration that
  validates inputs, calls the repository through its injected abstraction, maps
  persisted rows through the existing pure mapper, and converts outcomes into
  stable domain errors.

Readiness marker: `PHASE_2F_B_RATE_CARD_REPOSITORY_READY`.

## 2. Scope and prerequisites

- Worktree = repository root (verified via `pwd` and the top-level marker).
- Branch `feature/provider-pricing-phase2`, head `a499593`.
- The Phase 2F-A schema, migration `20260806165241_add_provider_rate_card_snapshot_phase_2f_a`,
  mapper, contracts, and 60 snapshot tests were present and uncommitted; they
  were preserved unchanged except for the Phase 2F-B source-scan test updates
  described in section 5.
- Phase 2E-C untracked files (report, probe script, boundary test) preserved.
- No dependency, `.env`, `package.json`, lockfile, or `node_modules` change.

## 3. Phase 2F-A baseline

- Full suite at the start of Phase 2F-B: **1687 tests / 28 suites / 1687 pass /
  0 fail / 0 cancelled / 0 skipped**.
- Test DB at 15 migrations; unique entry index
  `ProviderRateCardEntry_snapshotId_provider_model_tier_key` and 7 named CHECK
  constraints live and confirmed via `pg_constraint`.
- Prisma 6.19.3 maps PostgreSQL `23514` CHECK violations to
  `PrismaClientUnknownRequestError`; P2002 = unique; P2003 = FK.

## 4. Files created in Phase 2F-B

| File | Role |
| --- | --- |
| `src/types/provider-rate-card-load.ts` | `ProviderRateCardLoadError` class + `ProviderRateCardLoadErrorCode` union + safe options |
| `src/utils/provider-rate-card-date.ts` | `normalizePricingDate`, `pricingDateToUtcDate`, `isSnapshotRow` |
| `src/repositories/provider-rate-card.repository.ts` | `ProviderRateCardRepository` contract, `ActiveSnapshotSelection`, `ENTRY_ORDER_BY`, `createPrismaProviderRateCardRepository` |
| `src/services/provider-rate-card-loader.service.ts` | `loadActiveRateCardForDate`, `loadRateCardByVersion`, dependencies object |
| `tests/provider-rate-card-loader.test.ts` | 25 unit tests (fake repository) |
| `tests/provider-rate-card-repository-db.test.ts` | 40 database tests |
| `tests/provider-rate-card-repository-failure.test.ts` | 7 query-failure tests (fake failing Prisma delegate) |
| `tests/provider-rate-card-source.test.ts` | 14 source-scan tests |

## 5. Files modified in Phase 2F-B

Only one pre-existing test file changed, and only its source-scan tests:

- `tests/provider-pricing-snapshot.test.ts` — tests 28 and 29 were extended so
  the new read-only loader/repository (which legitimately consume the mapper and
  live under `repositories/` and `services/`) are allowed, while still asserting
  that no route, controller, or runtime module touches them. This is the intended
  phase evolution: Phase 2F-A asserted "no repository exists"; Phase 2F-B creates
  the read-only repository and loader explicitly.

No production Phase 2F-A file and no migration were modified.

## 6. Repository contract (`ProviderRateCardRepository`)

```ts
export interface ProviderRateCardRepository {
  findActiveSnapshotForDate(pricingDate: string): Promise<ActiveSnapshotSelection>;
  findSnapshotByVersion(version: string): Promise<ProviderRateCardSnapshotRow | null>;
}
```

- `ActiveSnapshotSelection` is an explicit union: `none` | `found` (with the full
  persisted row, entries included) | `conflict` (with `pricingDate`, `versions[]`,
  and `count`).
- Row-level "not found" outcomes are values, not exceptions — the loader converts
  them to stable domain errors.

## 7. Repository implementation

- `createPrismaProviderRateCardRepository(client: ProviderRateCardRepositoryClient)`
  follows the existing `createPrisma...Repository()` factory convention and
  returns a plain object literal.
- The client is injected through the minimal interface
  `ProviderRateCardRepositoryClient` (a `Pick` of `findMany | findUnique | count`),
  so unit tests can supply a deliberately failing fake; the application `prisma`
  client satisfies it structurally. Defaults to the app client at wiring time.
- Every returned snapshot/entry is copied into a fresh plain row object
  (`toSnapshotRow` / `toEntryRow`) — never a mutable Prisma model reference.

## 8. Active-snapshot selection semantics

- Query filters: `status = 'ACTIVE'`, `effectiveFrom <= pricingDate`, and
  `(effectiveTo IS NULL OR effectiveTo >= pricingDate)`.
- `take: 2` with `orderBy: { version: 'asc' }`; 0 rows → `none`, 1 row → `found`,
  2+ rows → a second `count` query runs and a `conflict` surfaces.
- DRAFT and RETIRED snapshots are never returned by active-date selection.
- The loader re-normalizes the pricing date before each call (idempotent), so
  repository and loader stay in agreement.

## 9. Inclusive boundary semantics

- Both boundaries are inclusive: `effectiveFrom <= date <= effectiveTo`.
- A null `effectiveTo` is open-ended (applies to any later date).
- Verified by DB tests 6 (effectiveFrom == date), 7 (effectiveTo == date), and
  8 (open-ended window).

## 10. Conflict detection

- Overlapping ACTIVE snapshots are never silently resolved by version, `createdAt`,
  or any ordering. A `conflict` carries the exact matching versions and count.
- DB tests 14 (two overlapping → conflict), 15 (not resolved by version order),
  16 (not resolved by createdAt order), and 17 (disjoint windows → no conflict)
  prove this.
- Loader converts `conflict` to `RATE_CARD_ACTIVE_CONFLICT` with the same safe
  metadata.

## 11. Version lookup semantics

- `findSnapshotByVersion` uses the unique `version` and includes entries.
- Ignores lifecycle status: DRAFT, ACTIVE, and RETIRED all load (DB tests 20-22).
- Ignores effective dates: a snapshot with a future `effectiveFrom` still loads
  by version (DB test 25).
- Unknown version → `null` (DB test 23); the loader maps that to
  `RATE_CARD_VERSION_NOT_FOUND`.

## 12. Deterministic entry ordering

- `ENTRY_ORDER_BY`: `provider ASC, model ASC, tier ASC, effectiveFrom ASC, id ASC`.
- `tier ASC` follows the PostgreSQL enum ordinal (STANDARD < BATCH < PRIORITY <
  FAST_MODE), confirmed by DB test 10.
- Ordering is applied by the repository query (nested `orderBy` in the `include`);
  it does not change engine semantics — the engine resolves entries by identity
  and window, not by array position.

## 13. Date policy

- Canonical pricing date is a strict `YYYY-MM-DD` string, matching the engine's
  `requireIsoDate` regex `/^\d{4}-\d{2}-\d{2}$/` plus a real-calendar check.
- `normalizePricingDate` rejects timestamps, locale-formatted dates,
  calendar-invalid dates (`2026-02-31`), and non-strings (DB-less, unit-tested).
- `pricingDateToUtcDate` produces `YYYY-MM-DDT00:00:00Z`; Prisma compares the
  `@db.Date` columns against that UTC-midnight instant, so `DATE` boundaries are
  day-precision inclusive.
- JavaScript `Date` inputs and timestamps are rejected with
  `RATE_CARD_INVALID_PRICING_DATE`; no local-timezone drift is possible.

## 14. Error contract

`ProviderRateCardLoadError extends Error` with `readonly code` and safe options:
`pricingDate?`, `version?`, `snapshotVersions?`, `snapshotCount?`, `mapperCode?`,
`cause?`. Codes:

- `RATE_CARD_NOT_FOUND` — no ACTIVE snapshot applies to the date.
- `RATE_CARD_ACTIVE_CONFLICT` — overlapping ACTIVE snapshots (versions + count).
- `RATE_CARD_VERSION_NOT_FOUND` — version lookup miss.
- `RATE_CARD_INVALID_PRICING_DATE` — malformed/non-canonical date.
- `RATE_CARD_INVALID_VERSION` — blank/non-string version.
- `RATE_CARD_SNAPSHOT_INVALID` — pure mapper rejected the persisted row.
- `RATE_CARD_DATABASE_ERROR` — unexpected repository/database failure.

Messages never include raw SQL, credentials, URLs, or host strings (failure test 3).

## 15. Loader service

- `ProviderRateCardLoaderDependencies { repository }` plus
  `createDefaultProviderRateCardLoaderDependencies(...)` follows the existing DI
  convention.
- `loadActiveRateCardForDate(deps, pricingDate)` validates the date, calls the
  repository through `repositoryRead`, and maps the selection outcome.
- `loadRateCardByVersion(deps, version)` validates the version (`requireVersion`),
  looks it up, and maps the row (or raises `RATE_CARD_VERSION_NOT_FOUND`).
- `repositoryRead` rethrows a stable `ProviderRateCardLoadError` unchanged (never
  reclassified) and wraps any unexpected failure as `RATE_CARD_DATABASE_ERROR`.
- The loader never imports Prisma, never writes, and never imports the static card.

## 16. Mapper integration

- Persisted rows are passed to the existing pure `mapProviderRateCardSnapshot`
  unchanged in shape; the repository row contract matches the mapper input.
- BIGINT monetary columns reach the mapper as `bigint`; the mapper's existing
  engine-safe-number range check converts them to `number` (DB tests 27-28).
- A mapper failure becomes `RATE_CARD_SNAPSHOT_INVALID` with the mapper's stable
  code preserved as `mapperCode` (e.g. `SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE`, DB
  test 30; `SNAPSHOT_EMPTY_ENTRIES`, DB test 31; `SNAPSHOT_INVALID`, unit 13).
- NULL optional fields stay absent in the engine contract (DB test 29).

## 17. No pricing arithmetic duplication

- Neither the loader nor the repository call `priceProviderCall`,
  `aggregateProviderCalls`, or `resolveRate` (source-scan test 14; loader unit
  tests 21). Pricing remains exclusively in `src/utils/provider-pricing/*`.

## 18. No static-card fallback

- No `try { db } catch { PROVIDER_RATE_CARD }` pattern exists in any Phase 2F-B
  module (source-scan test 8; loader unit test 20).
- The loader/repository never import `PROVIDER_RATE_CARD` (source-scan tests 6-7).

## 19. No cache

- No in-memory/TTL/LRU/Redis/SWR cache in any Phase 2F-B module (source-scan
  test 9; loader unit test 25). Every call hits the repository.

## 20. No runtime cutover

- The static `PROVIDER_RATE_CARD` remains the active runtime source: it is still
  exported and still imported by `aggregate.ts` and the shadow pricing service
  (source-scan test 1; Phase 2F-A snapshot test 27).
- Shadow pricing and recompute services do not import the loader/repository
  (source-scan tests 2-3).
- No route or controller imports the loader/repository (source-scan test 4).
- The loader/repository are not imported by any runtime module yet
  (source-scan test 13).

## 21. No Admin CRUD

- No rate-card route or controller exists (source-scan test 12); the read path is
  not admin-editable. Publish/retire/edit services remain out of scope.

## 22. No Wallet or billing integration

- Wallet, token-reservation, durable-billing, payment, and paymob modules do not
  import the loader/repository (source-scan test 5; loader unit test 24).

## 23. Read-only guarantees

- The repository contains no `.create(`, `.update(`, `.delete(`, `.upsert(`,
  `createMany`, `updateMany`, or `deleteMany` (source-scan test 10); same for the
  loader (source-scan test 11; loader unit test 23).
- DB tests 33-39 capture counts before and after loads for rate-card rows,
  TokenWallet, TokenTransaction, TokenReservation, AIBillingOperation, User,
  Role, Payment, and AiUsageLog — all unchanged. The `after` hook asserts global
  isolation against the baseline.

## 24. Loader unit tests (`tests/provider-rate-card-loader.test.ts`) — 25 tests

Fake repository (never Prisma). Covers: contract mapping (1), version preserved
(2), providers (3), metadata (4), no row mutation (5), no shared mutable
references (6), NOT_FOUND (7), ACTIVE_CONFLICT with versions+count (8),
VERSION_NOT_FOUND (9), INVALID_VERSION (10), INVALID_PRICING_DATE for 11 bad
inputs (11), SNAPSHOT_INVALID (12-13, mapper code preserved), DATABASE_ERROR and
non-reclassification (14-15), DRAFT/ACTIVE/RETIRED by version (16-18), unknown
provider (19), static card never imported (20), no arithmetic (21), no Prisma
(22), no write (23), no Wallet/billing (24), no cache (25).

Result: **25 / 25 pass.**

## 25. Repository database tests (`tests/provider-rate-card-repository-db.test.ts`) — 40 tests

Real PostgreSQL (`/core_server_test`, safety gate + unique version prefix +
`beforeEach` cleanup + isolation counts). Active selection: none with empty/DRAFT/
RETIRED/future/expired (1-5), found with inclusive boundaries, open-ended window,
entries included, deterministic ordering, version, metadata, fresh copies (6-13).
Conflicts: overlap, not resolved by version/createdAt, disjoint windows OK,
ACTIVE+DRAFT, ACTIVE+RETIRED (14-19). Version lookup: DRAFT/ACTIVE/RETIRED/unknown/
entries/no-date-filter (20-25). Loader integration: engine contract, bigint to
number, zero preserved, NULLs absent, out-of-range → SNAPSHOT_INVALID, empty →
SNAPSHOT_INVALID, unknown provider (26-32). Read-only: no writes across all
tracked tables (33-39). Version lookup full loader path for RETIRED (40).

Result: **40 / 40 pass.**

## 26. Repository failure tests (`tests/provider-rate-card-repository-failure.test.ts`) — 7 tests

Deliberately failing Prisma delegate (no database). Covers: active failure →
`RATE_CARD_DATABASE_ERROR` not NOT_FOUND (1), version failure → DATABASE_ERROR not
VERSION_NOT_FOUND (2), no credentials/URL leak in messages (3), raw cause
preserved as non-serialized metadata (4), loader keeps repository DATABASE_ERROR
stable (5), count failure during conflict → DATABASE_ERROR (6), empty results are
`none`/`null` outcomes not errors (7).

Result: **7 / 7 pass.**

## 27. Source-scan tests (`tests/provider-rate-card-source.test.ts`) — 14 tests

Static card still live (1), shadow service imports (2), recompute (3), routes/
controllers (4), Wallet/billing (5), repository no static card (6), loader no
static card (7), no fallback (8), no cache (9), repository read-only (10), loader
read-only (11), no Admin CRUD (12), no runtime import of loader/repository (13),
no pricing arithmetic/model selection (14).

Result: **14 / 14 pass.**

## 28. Phase 2F-A snapshot suites regression

`provider-pricing-snapshot.test.ts` and `provider-pricing-snapshot-db.test.ts`
still pass in full (source-scan tests 28-29 updated only to allow the new
read-only loader/repository, per section 5). Combined with the 2F-B suites:
**146 / 146 pass** (sequential run).

## 29. Pricing + shadow regression

`provider-pricing-rate-card`, `provider-pricing-identity`,
`provider-pricing-contract`, `provider-pricing-aggregate`,
`ai-shadow-pricing-service`, `ai-shadow-pricing-recompute`, plus all snapshot and
2F-B suites: **268 / 268 pass / 0 fail** (sequential run).

## 30. Full suite results

```
timeout 600 node --env-file=.env.test --import tsx --test \
  --test-concurrency=1 tests/*.test.ts
```

**1773 tests / 28 suites / 1773 pass / 0 fail / 0 cancelled / 0 skipped.**

Delta vs Phase 2F-A baseline (1687): **+86** (25 loader + 40 repository DB +
7 failure + 14 source-scan). Log: `full-test-output.log`.

## 31. Prisma validation and client generation

- `npx --no-install prisma validate` (with `.env.test` sourced): **schema valid**.
- `npx --no-install prisma generate`: regenerated the client for the shared
  `Core-Server-provider-model-pricing` node_modules (Prisma Client 6.19.3).
- The Phase 2F-A schema was not changed in Phase 2F-B; validate confirms the
  migration state is consistent.

## 32. TypeScript verification

`npx --no-install tsc --noEmit`: **clean (exit 0)** across the whole project,
including the four new modules and four new test files.

## 33. Git verification

- `git diff --check`: **clean** (no whitespace errors).
- `git status --short --untracked-files=all`: only the expected files — the
  Phase 2F-A/2E-C uncommitted set plus the Phase 2F-B files listed in section 4.
- No commit, push, merge, rebase, reset, or stash was performed.

## 34. No-migration statement

**No migration was created in Phase 2F-B.** The Phase 2F-A migration
`20260806165241_add_provider_rate_card_snapshot_phase_2f_a` (15 applied
migrations total) fully covers the read path; the repository and loader only
query it. This statement is backed by `git status` (no new migration directory)
and by `prisma validate`.

## 35. Known intentional limits and final confirmation

Intentional limits (all by design, matching the Phase 2F-B spec):

- The loader is not yet consumed by any runtime caller; Phase 2F-C wires it in.
- No active snapshot exists in the test DB at rest; a live snapshot is a Phase
  2F-C concern.
- The read path is strictly read-only; publish/retire/Admin flows remain out of
  scope until the schema phase provides them.
- Cache, static fallback, and cutover are intentionally absent.

Final confirmation:

- Focused 2F-B suites: 25 + 40 + 7 + 14 = **86 / 86 pass**.
- Full suite: **1773 / 1773 pass, 0 fail, 0 cancelled, 0 skipped**.
- `prisma validate` valid; `prisma generate` succeeded; `tsc --noEmit` clean;
  `git diff --check` clean.
- Static `PROVIDER_RATE_CARD` remains the active runtime source; the read path is
  not wired in yet.

Status: **`PHASE_2F_B_RATE_CARD_REPOSITORY_READY`**
