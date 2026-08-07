# Phase 2F-A — Versioned Database Rate Card Schema

Status: `PHASE_2F_A_DATABASE_RATE_CARD_SCHEMA_READY`

Branch: `feature/provider-pricing-phase2`
Test DB: `postgresql://core_user:core_pass@localhost:5434/core_server_test` (test DB only)
Prisma Client: 6.19.3 (generated to the shared `Core-Server-provider-model-pricing` node_modules)

This report documents the corrected database Rate Card schema for Phase 2F-A:
immutable, versioned snapshots of the provider-neutral rate card, with BIGINT
monetary columns, a DRAFT/ACTIVE/RETIRED lifecycle, database-enforced structural
financial safety, a corrected migration, rewritten pure contracts/mapper, and
30 pure + 30 database tests. It replaces the defective Phase 2D-B draft (the old
`20260806161204_add_provider_rate_card_snapshot` migration was deleted before
ever being applied to any committed state).

## 1. Executive summary

Phase 2F-A delivers the database shape that Phase 2F-B/C will use to materialize
rate cards. The design principle is: **the database enforces structural financial
safety (non-negative money, positive ratios, valid windows, coherent rate shapes,
lifecycle) while the pure validator enforces complete domain coherence.** The static
`PROVIDER_RATE_CARD` remains the active runtime source — nothing reads the new tables
at runtime; no repository, service, route, or Admin CRUD was added.

All four deliverables are complete and verified:
1. Corrected `prisma/schema.prisma` (BIGINT money, RETIRED lifecycle, tier
   NOT NULL default STANDARD, unique entry identity, `ON DELETE RESTRICT`).
2. Corrected, hand-verified migration `20260806165241_add_provider_rate_card_snapshot_phase_2f_a`
   with 7 database CHECK constraints and a RESTRICT FK, applied to `core_server_test`.
3. Rewritten pure contracts (`src/types/provider-pricing-snapshot.ts`) and mapper
   (`src/utils/provider-pricing/snapshot.ts`) with bigint-aware range checks,
   lifecycle validation, and no runtime cutover.
4. 30 pure contract tests + 30 database tests, all passing.

Readiness marker: `PHASE_2F_A_DATABASE_RATE_CARD_SCHEMA_READY`.

## 2. What was corrected from the Phase 2D-B draft

The prior uncommitted draft had defects that this phase corrected:
- **Float monetary columns** → replaced with PostgreSQL `BIGINT` / Prisma `BigInt`
  for all 7 monetary columns (input/output/cachedInput/cachedOutput per-million,
  `perUnitMicros`, `audioInputMicrosPerMillion`, `audioOutputMicrosPerMillion`).
- **`ARCHIVED` lifecycle status** → removed; the lifecycle is now exactly
  `DRAFT` / `ACTIVE` / `RETIRED`.
- **Nullable tier** → `tier` is `NOT NULL DEFAULT 'STANDARD'` to avoid
  PostgreSQL NULLs-distinct uniqueness behavior; the mapper treats a null
  (plain-object) tier as `standard`.
- **Cascade FK** → `ON DELETE RESTRICT` so a snapshot with entries cannot be
  silently deleted.
- **Entry unique identity included `billingUnit`** → the Pricing Engine
  `resolveRate` looks up lines by provider + canonical model/alias + tier +
  effective window; `billingUnit` is a billing attribute, **not** a resolution
  dimension. The unique identity is now `(snapshotId, provider, model, tier)`,
  so the database cannot persist two lines the engine could not distinguish.
  The pure mapper's `rejectDuplicateIdentities` uses the same `(provider, model,
  tier)` identity.
- **Missing financial safety** → 7 CHECK constraints added by hand (see §9).
- **Old migration** → `20260806161204_add_provider_rate_card_snapshot` was
  removed (it was never committed); `core_server_test` was reset to the 14
  committed migrations and the single corrected migration applied, for 15 total.

## 3. Files created

- `prisma/migrations/20260806165241_add_provider_rate_card_snapshot_phase_2f_a/migration.sql` (corrected migration, created-only then hand-edited and applied)
- `docs/phase-2f-a-database-rate-card-schema-report.md` (this file)

## 4. Files rewritten

- `prisma/schema.prisma` — corrected Phase 2F-A snapshot/enum section (~line 631 onward).
- `src/types/provider-pricing-snapshot.ts` — `ProviderRateCardSnapshotRow`, `ProviderRateCardEntryRow`, lifecycle enum, bigint monetary fields, error codes.
- `src/utils/provider-pricing/snapshot.ts` — new pure mapper: `mapProviderRateCardSnapshot`, `isoDateOf`, lifecycle validation, bigint range-check, duplicate-identity rejection, `ProviderRateCardSnapshotError`.
- `tests/provider-pricing-snapshot.test.ts` — rewritten to 30 tests (26 contract + 4 source-scan non-cutover).
- `tests/provider-pricing-snapshot-db.test.ts` — rewritten from the old 4-case Phase 2D-B version to the required 30 database cases.

## 5. Untouched Phase 2E-C files preserved

The following untracked Phase 2E-C files are preserved unchanged:
- `docs/phase-2e-c-full-http-roundtrip-report.md`
- `scripts/live-multimodal-http-roundtrip-probe.ts`
- `tests/phase-2e-c-http-boundary.test.ts`

## 6. Enums

Added to `prisma/schema.prisma`:
- `provider_rate_card_snapshot_status`: `DRAFT`, `ACTIVE`, `RETIRED`.
- `provider_rate_card_entry_status`: `STABLE`, `PREVIEW`, `DEPRECATED`, `LIMITED_AVAILABILITY`.
- `provider_rate_card_tier`: `STANDARD`, `BATCH`, `PRIORITY`, `FAST_MODE`.
- `provider_rate_card_billing_unit`: `TOKEN`, `IMAGE`, `SECOND`, `MINUTE`, `CHARACTER`.
- `cached_input_accounting_semantic`: `DISJOINT`, `INCLUDED_IN_INPUT`.

The snapshot status enum removed `ARCHIVED`; the domain tier names map to the
engine's lowercase tiers (`standard`, `batch`, `priority`, `fast_mode`).

## 7. Model: ProviderRateCardSnapshot

Columns: `id` (UUID PK), `version` (TEXT, unique — immutable identity), `status`
(DRAFT default), `schemaVersion` (INT default 1), `currency` (default `USD`),
`storageUnit` (default `MICROS`), `engineUnit` (default `NANO_USD`), `source`,
`generatedAt` (DATE, source research date), `provenance` (default `RESEARCH_SNAPSHOT`),
`effectiveFrom` (DATE, nullable), `effectiveTo` (DATE, nullable),
`publishedAt` (TIMESTAMPTZ, nullable), `retiredAt` (TIMESTAMPTZ, nullable),
`createdAt`, `updatedAt`.

Indexes: `ProviderRateCardSnapshot_version_key` (unique), status/createdAt,
status/effectiveFrom/effectiveTo.

Lifecycle rule (CHECK, §9): DRAFT never published/retired; ACTIVE published with
effectiveFrom and never retired; RETIRED published, effectiveFrom, retiredAt >=
publishedAt.

## 8. Model: ProviderRateCardEntry

Columns: `id` (UUID PK), `snapshotId` (FK → Snapshot, `ON DELETE RESTRICT`),
`provider`, `model`, `status`, `tier` (NOT NULL default `STANDARD`), `billingUnit`,
the 7 BIGINT monetary columns (all nullable), `tokensPerSecond` (DOUBLE PRECISION,
positive ratio, not money), `cachedInputAccounting`, `aliases` (JSONB),
`effectiveFrom` (DATE NOT NULL), `effectiveTo` (DATE), `inactive` (BOOLEAN default false),
`source`, `verifiedAt` (DATE), `createdAt`, `updatedAt`.

Unique entry identity: `@@unique([snapshotId, provider, model, tier])` — aligned
with the Pricing Engine `resolveRate` lookup identity; `billingUnit` is excluded
because it is not a resolution dimension.
Indexes: snapshotId, provider/model/status.

## 9. Database CHECK constraints (7, hand-added and verified)

Verified present in the live database (`core_server_test`):
1. `ProviderRateCardEntry_rates_non_negative_ck` — all 7 monetary columns NULL or `>= 0`.
2. `ProviderRateCardEntry_tokens_per_second_positive_ck` — NULL or `> 0` (ratio, not money).
3. `ProviderRateCardEntry_effective_window_ck` — `effectiveTo` NULL or `>= effectiveFrom`.
4. `ProviderRateCardEntry_rate_shape_ck` — TOKEN entries carry token rates only (no
   `perUnitMicros`, at least one token rate); non-TOKEN entries carry `perUnitMicros`
   only and no token-module columns (input/output/cached-input/audio/tokensPerSecond/
   cachedInputAccounting). Derived directly from the engine validator (`rate-card.ts`).
5. `ProviderRateCardEntry_cached_semantic_requires_rate_ck` — a declared
   `cachedInputAccounting` requires a non-null `cachedInputMicrosPerMillion`.
6. `ProviderRateCardSnapshot_effective_window_ck` — `effectiveTo` set requires an
   `effectiveFrom` with `effectiveTo >= effectiveFrom`.
7. `ProviderRateCardSnapshot_lifecycle_ck` — the DRAFT/ACTIVE/RETIRED lifecycle rule.

The FK `ProviderRateCardEntry_snapshotId_fkey` has delete rule `RESTRICT`
(verified in `pg_constraint.confdeltype = 'r'`).

## 10. Why overlapping ACTIVE windows are not a CHECK

"Only one ACTIVE snapshot effective at wall-clock time" is intentionally **not** a
database CHECK: wall-clock overlap is a transactionally-changing property that a
static CHECK cannot express without races, and it would be misleading. It is
deferred to the publishing/service layer (Phase 2F-B/2F-C) which will validate
overlap inside a transaction. This is documented in the migration comment.

## 11. Monetary representation: BIGINT, never Float

All 7 monetary columns are PostgreSQL `BIGINT` and Prisma `BigInt`. The engine
continues to operate on safe JS numbers; the mapper converts a bigint to a number
only when `0n <= v <= BigInt(Number.MAX_SAFE_INTEGER)`; out-of-range values are
rejected with `SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE` rather than truncated. The DB
test suite proves a `9_000_000_000_000_000_000n` value round-trips exactly at the
database layer while the pure suite proves the mapper rejects it for engine use.

## 12. Pure contracts: src/types/provider-pricing-snapshot.ts

- `ProviderRateCardSnapshotStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED'`.
- `ProviderRateCardEntryStatus`, `ProviderRateCardTier`, `ProviderRateCardBillingUnit`,
  `CachedInputAccountingSemantic` mirror the DB enums.
- Monetary fields are `bigint | null`; `tokensPerSecond` is `number | null`.
- Lifecycle fields: `effectiveFrom`/`effectiveTo` as `string | null` (ISO date),
  `publishedAt`/`retiredAt` as `string | null` (ISO datetime).
- Error codes include: `SNAPSHOT_LIFECYCLE_INVALID`, `SNAPSHOT_INVALID_WINDOW`,
  `SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE`, `SNAPSHOT_DUPLICATE_ENTRY_IDENTITY`,
  `SNAPSHOT_INVALID_INVARIANT`, `SNAPSHOT_UNSUPPORTED_BILLING_UNIT`.
- No import of the static card, no Prisma import, no repository/service import.

## 13. Pure mapper: src/utils/provider-pricing/snapshot.ts

`mapProviderRateCardSnapshot(row)` → `{ version, generatedAt, entries }`:
- `isoDateOf()` normalizes DATE/TIMESTAMPTZ to `YYYY-MM-DD`.
- Validates lifecycle + business window; invalid → `SNAPSHOT_LIFECYCLE_INVALID`.
- `rejectDuplicateIdentities` rejects entries sharing the `(provider, model,
  tier)` resolution identity inside the mapped card →
  `SNAPSHOT_DUPLICATE_ENTRY_IDENTITY` — regardless of `billingUnit`, matching
  the engine `resolveRate` lookup identity.
- Bigint range-check → `SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE` for values above
  `Number.MAX_SAFE_INTEGER` (never truncates).
- Distinguishes explicit `0` from `null`; maps null tier to `standard`;
  `null` mapping for cachedOutput where not published.
- No mutation of inputs; re-validates the final card through the existing pure
  `validateRateCard` (no duplicated validator or arithmetic).
- Single error type `ProviderRateCardSnapshotError`.
- Exports `isoDateOf` for tests and consumers.

## 14. No runtime cutover

- The static `PROVIDER_RATE_CARD` (in `src/config/provider-rate-card/`) remains the
  active runtime source; `provider-pricing-*.ts` engine modules and the Wallet/billing
  path are unchanged.
- No repository class, no service, no route, no Admin CRUD, no static fallback was
  added; nothing reads the new tables at runtime.
- Enforced by 4 source-scan tests in the pure suite (see §22).

## 15. Pure contract test suite (tests/provider-pricing-snapshot.test.ts) — 30 tests

26 contract tests (mapping, lifecycle, windows, bigint range, duplicates, null-vs-zero,
unsupported units, generatedAt) + 4 source-scan non-cutover tests. All pass.

## 16. Database test suite (tests/provider-pricing-snapshot-db.test.ts) — 30 tests

All 30 pass. Unique random versions/models per test; the `before`/`after` hooks
delete only rows whose version starts with the `test-snapshot-` prefix and assert
no other table was modified.

## 17. DB tests: identity and uniqueness

- Duplicate snapshot `version` → P2002.
- Same `provider`/`model`/`tier` with a **different `billingUnit`** within one
  snapshot → P2002 (engine-aligned identity: billingUnit is not a resolution
  dimension; nested create is atomic, nothing is created).
- Duplicate default/standard-tier identity (explicit `STANDARD` vs. DB-default
  `STANDARD`) → P2002, proving the NOT NULL default behaves as an identity value.
- The same `(provider, model, tier)` entry identity in a **different** snapshot
  is accepted.

## 18. DB tests: CHECK constraint rejection

Prisma maps PostgreSQL `23514` check violations to `PrismaClientUnknownRequestError`
(code undefined, not P2004); the suite asserts that error class. Covered: negative
input rate, negative output rate, negative per-unit rate, `tokensPerSecond = 0`,
`tokensPerSecond < 0`, inverted entry window, inverted snapshot window, DRAFT with
`publishedAt`, ACTIVE without `publishedAt`, ACTIVE without `effectiveFrom`,
RETIRED without `retiredAt`, RETIRED with `retiredAt < publishedAt`.

## 19. DB tests: lifecycle acceptance

Valid DRAFT, valid ACTIVE, and valid RETIRED lifecycle rows are each created
successfully and read back with the expected status and timestamps.

## 20. DB tests: BIGINT round-trip

- Exact round-trip of `1_500_000n` / `7_500_000n` / `150_000n`.
- Exact round-trip of `9_000_000_000_000_000_000n` (> `Number.MAX_SAFE_INTEGER`)
  proving the database never loses precision.
- Explicit `0n` round-trips as `0n` (distinct from `null`); optional rates
  (cached output, per-unit, audio) remain `null` when omitted.

## 21. DB tests: referential integrity

- Deleting a snapshot that still has entries fails (RESTRICT, P2003).
- Explicitly deleting entries then deleting a DRAFT snapshot succeeds and the
  snapshot is gone.
- An orphan entry insert (random snapshotId UUID) fails (P2003).

## 22. Source-scan non-cutover tests (pure suite)

1. Static card still exported and used by the aggregate.
2. No runtime `src` file imports `provider-pricing-snapshot` or
   `provider-pricing/snapshot` except the two allowed files.
3. No rate-card repo/service/route anywhere outside `config`/`utils`/`types`.
4. Shadow service and recompute service contain no `prisma` usage.

## 23. Migration process and safety

- Only the test DB was used; every destructive step asserted
  `DATABASE_URL` pathname `/core_server_test` first.
- The old uncommitted migration was deleted; `prisma migrate reset --force --skip-seed`
  restored the 14 committed migrations; the corrected migration was applied via
  `prisma migrate deploy`; `prisma generate` regenerated the Client.
- Test DB now at 15 migrations. Committed migrations were not modified.

## 24. Verification evidence

- `prisma validate` → `The schema at prisma/schema.prisma is valid 🚀`.
- `prisma generate` → Client regenerated (v6.19.3).
- `tsc --noEmit` → clean.
- Live PostgreSQL inspection confirmed all 7 CHECK constraints, the RESTRICT FK
  (`confdeltype = 'r'`), `bigint` types for all 7 monetary columns, and the
  unique index `ProviderRateCardEntry_snapshotId_provider_model_tier_key`
  (billingUnit excluded).
- Pure suite: 30 pass / 0 fail. DB suite: 30 pass / 0 fail.
- Pricing + shadow-pricing + snapshot suites: 309 pass / 0 fail.
- Complete Core suite: **1687 tests / 28 suites / 1687 pass / 0 fail /
  0 cancelled / 0 skipped** (test count exceeds the 1650 baseline).

## 25. Test counts

- `provider-pricing-snapshot.test.ts`: 30.
- `provider-pricing-snapshot-db.test.ts`: 30.
- Phase 2F-A total new/rewritten tests: 60 (both suites fully green).
- Full Core suite: 1687 tests (exceeds 1650), 0 fail, 0 cancelled, 0 skipped.

## 26. What was deliberately not changed

No changes to: Wallet balances, business-token consumption, `TokenTransaction`,
`TokenReservation`, durable billing, billing orchestration, refunds, markup,
payment flow, the static `PROVIDER_RATE_CARD`, the AI Service, provider execution,
user-facing AI routes, package.json / lockfiles / environment files, the frontend,
or earlier committed migrations.

## 27. Constraints honored

- Work performed only inside the `Core-Server-provider-pricing-phase2` worktree on
  branch `feature/provider-pricing-phase2`; no new worktree, no branch switch.
- No commit, no push.
- No dependencies installed/removed/updated; `npx --no-install` used throughout.
- Only the test DB was touched; safety gate enforced.

## 28. Known intentional limits

- Overlapping ACTIVE windows are not DB-enforced (deferred to Phase 2F-B/2F-C).
- Prisma client maps `23514` check violations to `PrismaClientUnknownRequestError`
  (code undefined); the DB tests assert this class rather than a Prisma code.
- The tables are not yet consumed at runtime — that is Phase 2F-B/2F-C work.

## 29. Environment

- Test DB: `postgresql://core_user:core_pass@localhost:5434/core_server_test`.
- `node_modules` is a symlink to `../Core-Server-provider-model-pricing/node_modules`;
  Prisma Client 6.19.3 generated there.
- Node v24; tests run via `node --env-file=.env.test --import tsx --test`.

## 30. Final confirmation

Confirmed: corrected schema (BIGINT money, RETIRED lifecycle, tier NOT NULL STANDARD,
engine-aligned unique identity `(snapshotId, provider, model, tier)` without billingUnit,
RESTRICT FK), 7 CHECK constraints verified in the live DB, corrected migration applied
(15 total), pure contracts + mapper rewritten with bigint-safe range checks and the
same `(provider, model, tier)` duplicate identity as the database, no runtime cutover,
30 pure + 30 DB tests all passing, pricing/shadow suites green, full Core suite
1687 pass / 0 fail / 0 cancelled / 0 skipped, `tsc` and `prisma validate` clean,
no other tables modified, no commits/pushes, Phase 2E-C untracked files preserved.

No commit. No push. Report ends with the readiness marker.
PHASE_2F_A_DATABASE_RATE_CARD_SCHEMA_READY
