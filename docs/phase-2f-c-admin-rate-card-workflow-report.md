# Phase 2F-C — Admin Rate Card Workflow (Draft / Import / Validate / Publish / Retire / Replace)

Status: `PHASE_2F_C_ADMIN_RATE_CARD_WORKFLOW_READY`

Branch: `feature/provider-pricing-phase2`
Test DB: `postgresql://core_user:core_pass@localhost:5434/core_server_test` (test DB only)
Prisma Client: 6.19.3 (generated to the shared `Core-Server-provider-model-pricing` node_modules)

This report documents Phase 2F-C: the Admin workflow over the Phase 2F-A schema
and Phase 2F-B read path — Draft creation, entry Import (pure bigint
conversion + validation), Validate (pure mapper gating), transactional Publish
(overlap-checked at SERIALIZABLE isolation, with atomic ACTIVE replacement),
idempotent Publish/Retire replay, Retire with an optional `effectiveTo` window
closure, and a script-only, exact-version, idempotent static-card DRAFT import.
The static `PROVIDER_RATE_CARD` remains the only runtime pricing source: the
Admin workflow is REST-only, the static card is imported as a DRAFT snapshot
only by a dedicated script (there is NO HTTP static-import endpoint), nothing
is wired into Shadow Pricing, no ACTIVE real rate card is seeded or left
behind, and the main/original database is untouched.

## 1. Executive summary

Phase 2F-C completes and hardens the Admin-side lifecycle for versioned
rate-card snapshots on top of the Phase 2F-A schema:

- `src/types/provider-rate-card-admin.ts` — stable Admin error contract +
  pure HTTP status mapping (two new 409 codes for replacement/static-import
  conflicts).
- `src/utils/provider-pricing/entry-import.ts` — pure engine-domain card →
  exact PostgreSQL BIGINT row payload conversion, validated through the
  existing engine validator, duplicate `(provider, model, tier)` identities
  rejected (the DB unique identity excludes the window).
- `src/utils/provider-pricing/semantic-parity.ts` — pure, order-insensitive
  "content equality" comparator used for static-import idempotency and
  replay-coherence checks (ignores only DB-generated fields).
- `src/repositories/provider-rate-card-admin.repository.ts` — transactional
  write repository (Draft / Import-replace / Publish / Retire / List / Load):
  atomic ACTIVE replacement (`replaceActiveVersion`), final ACTIVE-candidate
  validation through the pure mapper BEFORE any write, replay-coherent
  no-ops, retire `effectiveTo` window closure; converts P2002 →
  `VERSION_TAKEN`, P2034 → `concurrent`, and guard-miss → `concurrent`.
- `src/services/admin-rate-card.service.ts` — orchestration: validates dates
  and versions, maps pure failures to stable Admin codes, gates Publish on the
  pure mapper, resolves publish/retire replays to a true no-write
  `idempotentReplay`, enforces the retire `effectiveTo` policy, imports the
  static card as an exact-version DRAFT only.
- `src/schemas/admin-rate-card.schema.ts` — strict Zod wire schemas.
- `src/controllers/admin-rate-card.controller.ts` +
  `src/routes/admin-rate-card.routes.ts` — REST surface mounted at
  `/api/admin/rate-cards` behind `requireRole('admin')`.
- `scripts/import-static-provider-rate-card-draft.ts` — the ONLY way to import
  the static card: a hard-gated script that refuses any database other than
  `/core_server_test`, drives the service idempotently, and never leaves an
  ACTIVE snapshot.
- `src/middleware/errorHandler.ts` — maps `ProviderRateCardAdminError` to
  HTTP status via the pure helper.

Readiness marker: `PHASE_2F_C_ADMIN_RATE_CARD_WORKFLOW_READY`.

## 2. Scope and prerequisites

- Worktree = repository root; branch `feature/provider-pricing-phase2`.
- The uncommitted Phase 2F-A/2F-B set (schema, migration
  `20260806165241_add_provider_rate_card_snapshot_phase_2f_a`, mapper,
  contracts, loader, read repository, 2F-A/2F-B tests) was preserved and built
  upon. Phase 2F-C hardening adds no migration and no schema change.
- Full suite at the start of Phase 2F-C: **1874 / 1874 pass**.

## 3. Files created in Phase 2F-C

| File | Role |
| --- | --- |
| `src/types/provider-rate-card-admin.ts` | `ProviderRateCardAdminError` + `ProviderRateCardAdminErrorCode` union + pure `providerRateCardAdminStatus` |
| `src/utils/provider-pricing/entry-import.ts` | `convertRateCardForImport` / `convertEntriesForImport`, `ImportedEntryRow`, `ProviderRateCardImportError` |
| `src/utils/provider-pricing/semantic-parity.ts` | `semanticParityEqual` / `semanticParityDifferences`, `RateCardSemanticParityOptions` — pure content-equality comparator |
| `src/repositories/provider-rate-card-admin.repository.ts` | `ProviderRateCardAdminRepository` contract + `createPrismaProviderRateCardAdminRepository` |
| `src/services/admin-rate-card.service.ts` | `createDraftRateCard`, `importRateCardEntries`, `validateRateCardDraft`, `publishRateCard`, `retireRateCard`, `listRateCardSnapshots`, `getRateCardByVersion`, `importStaticRateCardAsDraft` |
| `src/schemas/admin-rate-card.schema.ts` | strict Zod schemas (draft / import / publish / retire / params / list query) |
| `src/controllers/admin-rate-card.controller.ts` | HTTP adapter over the service |
| `src/routes/admin-rate-card.routes.ts` | admin sub-router with OpenAPI comments |
| `scripts/import-static-provider-rate-card-draft.ts` | test-only static-card DRAFT import script (hard `/core_server_test` gate, no bypass flag) |
| `tests/admin-rate-card-entry-import.test.ts` | 15 pure converter tests |
| `tests/admin-rate-card.service.test.ts` | 48 service unit tests (fake repository) |
| `tests/admin-rate-card-db.test.ts` | 42 database tests (lifecycle + concurrency + replacement + replay + immutability + static parity) |
| `tests/admin-rate-card-http.test.ts` | 22 HTTP tests (auth + wire + lifecycle + replacement + replay over `app`) |
| `tests/provider-pricing-semantic-parity.test.ts` | 10 pure comparator tests |

## 4. Files modified in Phase 2F-C

- `src/routes/admin.routes.ts` — mounted `adminRateCardRoutes` at `/rate-cards`
  behind `requireRole('admin')`.
- `src/middleware/errorHandler.ts` — handles `ProviderRateCardAdminError`
  before the `AppError`/generic branches, replying `{ error, code,
  mapperCode?, version? }` with the pure status mapping.
- `tests/provider-rate-card-source.test.ts` — test 12b asserts the runtime
  surface exposes `createDraft`/`publish` at `/drafts`; NEW test 12c asserts
  the route/controller expose NO `importStatic`/`importStaticRateCardAsDraft`,
  that the static-import script is not referenced by any route/controller, and
  that the script is hard-gated on `/core_server_test`.
- `tests/provider-pricing-snapshot.test.ts` — tests 28/29 allow the Admin
  modules plus the pure semantic-parity comparator (legitimate consumers of
  the mapper/contracts) while still forbidding any other module.

No Phase 2F-A/2F-B production file and no migration were modified.

## 5. Admin error contract

`ProviderRateCardAdminError extends Error` with `readonly code` and safe
diagnostic options (`version`, `reason`, `mapperCode`, `entryCount`,
`snapshotCount`, `conflictingVersions`, `cause`). Codes:

- `RATE_CARD_ADMIN_INVALID_VERSION` (400) — blank/non-string version.
- `RATE_CARD_ADMIN_INVALID_PAYLOAD` (400) — engine validator rejected the
  import payload.
- `RATE_CARD_ADMIN_DUPLICATE_IDENTITY` (400) — duplicate `(provider, model,
  tier)` DB identity in one snapshot.
- `RATE_CARD_ADMIN_INVALID_WINDOW` (400) — malformed date, missing
  `effectiveFrom` on publish, inverted window, `retiredAt < publishedAt`, or a
  retire `effectiveTo` that precedes `effectiveFrom` / widens the persisted
  window.
- `RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE` (400) — the pure mapper rejected the
  persisted DRAFT row (stable `mapperCode` preserved) or the final ACTIVE
  candidate row during publish.
- `RATE_CARD_ADMIN_NOT_FOUND` (404) — version unknown.
- `RATE_CARD_ADMIN_VERSION_TAKEN` (409) — unique-version violation (P2002).
- `RATE_CARD_ADMIN_DRAFT_REQUIRED` (409) — publish on a non-DRAFT, or a
  publish replay whose provided window conflicts with the persisted ACTIVE
  window.
- `RATE_CARD_ADMIN_ACTIVE_REQUIRED` (409) — retire on a non-ACTIVE, or a
  retire replay whose provided `retiredAt`/`effectiveTo` conflict with the
  persisted RETIRED row.
- `RATE_CARD_ADMIN_IMMUTABLE` (409) — import into a published/retired snapshot.
- `RATE_CARD_ADMIN_PUBLISH_CONFLICT` (409) — window overlap or concurrent
  publish (conflicting versions + count).
- `RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH` (409) — a publish with
  `replaceActiveVersion` where that version is not the single ACTIVE overlap
  (or its window does not precede the new window); carries
  `expectedVersion`/`conflictingVersions`/`snapshotCount`.
- `RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT` (409) — a static import whose exact
  version already exists with DIFFERENT content (DRAFT) or is ACTIVE/RETIRED.
- `RATE_CARD_ADMIN_DATABASE_ERROR` (500) — unexpected repository/Prisma
  failure.

Messages never include credentials, connection URLs, raw SQL, or full
rate-card contents.

## 6. Pure entry-import conversion (`src/utils/provider-pricing/entry-import.ts`)

- The whole card is validated through the existing pure engine validator
  (`validateRateCard`) before any row is produced, so any import provably
  satisfies every engine invariant.
- Monetary numbers → exact `bigint` (PostgreSQL BIGINT); NULL stays absent, an
  explicit `0n` stays an explicit engine zero.
- Engine domain spellings → DB-native: `tier` `standard|batch|priority|
  fast_mode` → `STANDARD|BATCH|PRIORITY|FAST_MODE`; ISO dates → UTC-midnight
  `Date`s; alias arrays → JSON-ready arrays.
- Duplicate `(provider, model, tier)` identities are rejected with
  `IMPORT_DUPLICATE_IDENTITY` even for disjoint windows, mirroring the
  read-side `rejectDuplicateIdentities`; the engine validator first rejects
  overlapping windows for one identity (reported as `IMPORT_INVALID_CARD`).
- `convertEntriesForImport` builds a full card around a raw `entries` array
  with the fixed engine constants — the convenience path used by Admin imports
  where snapshot-level fields live on the draft row.

## 7. Pure semantic-parity comparator (`src/utils/provider-pricing/semantic-parity.ts`)

`semanticParityEqual(a, b)` / `semanticParityDifferences(a, b, options)` decide
whether two persisted snapshot rows carry identical rate-card content, without
any database or engine dependency:

- compares every snapshot-level content field (version, schemaVersion,
  currency, storageUnit, engineUnit, source, generatedAt, provenance, status,
  effectiveFrom, effectiveTo) and every entry field (provider, model, tier,
  billingUnit, status, all monetary rates, tokensPerSecond,
  cachedInputAccounting, aliases, window, source, verifiedAt, inactive);
- is ORDER-INSENSITIVE for entries (canonical payloads keyed by the unique
  `(provider, model, tier)` DB identity);
- keeps NULL vs explicit zero DISTINCT for monetary rates (exact bigint
  strings vs a null marker);
- normalizes only what is semantically equivalent: a `null` tier equals the
  `STANDARD` DB default, and `aliases` are compared as a sorted array;
- IGNORES only database-generated fields (`id`, `snapshotId`, `createdAt`,
  `updatedAt`) and — unless `compareLifecycleTimestamps` is set — the lifecycle
  timestamps `publishedAt`/`retiredAt`;
- never mutates its inputs and performs no repository/Prisma/engine work.

## 8. Admin repository (`src/repositories/provider-rate-card-admin.repository.ts`)

- `createDraft` — creates an empty DRAFT and writes its audit evidence in one
  `$transaction`; P2002 → `RATE_CARD_ADMIN_VERSION_TAKEN`.
- `importEntries` — inside one transaction: looks up the snapshot (missing →
  `not_found`; non-DRAFT → `not_draft`), atomically `deleteMany` +
  `createMany`-replaces the entries (an admin edit, not an append), optionally
  refreshes `source`/`generatedAt`, writes audit evidence, and returns the
  refreshed row. A published/retired snapshot therefore cannot be mutated.
- `publish` — runs at `Prisma.TransactionIsolationLevel.Serializable`. It
  detects overlapping ACTIVE snapshots with the same inclusive-window predicate
  the read repository uses for active-date selection; an overlap without
  `replaceActiveVersion` returns `{ kind: 'overlap', conflictingVersions,
  snapshotCount }`. With `replaceActiveVersion` the target must be the ONLY
  overlap and its `effectiveFrom` must strictly precede the new window, else
  `{ kind: 'replacement_mismatch' }`. The ACTIVE candidate row (status ACTIVE,
  transaction timestamps, final window) is validated through the pure
  `mapProviderRateCardSnapshot` BEFORE any write — a rejection returns
  `{ kind: 'candidate_invalid', mapperCode, reason }`. The DRAFT→ACTIVE
  transition is guarded by `updateMany({ where: { version, status: 'DRAFT' } })`
  (`count === 1`); the old snapshot is then retired transactionally (status
  RETIRED, `retiredAt` set) and its `effectiveTo` tightened to the day before
  the new `effectiveFrom` ONLY when it was open-ended or would otherwise
  overlap (otherwise preserved), with a `rate_card_retired` audit row. If two
  overlapping publishes race, PostgreSQL SSI aborts one transaction; P2034 /
  guard-miss is converted to `{ kind: 'concurrent' }` — never a silent
  double-active.
- `retire` — transactional ACTIVE→RETIRED with the same updateMany guard; an
  optional `effectiveTo` is applied in the SAME update so the window closure is
  atomic with the status transition.
- `list` — `createdAt DESC`, pagination (`page`/`limit`), optional status
  filter, `_count` entry counts.
- `findSnapshotByVersion` — full row with deterministically ordered entries.
- The repository never calls the Pricing Engine, the pure mapper, or the static
  card; it returns plain copied row objects.

## 9. Admin service (`src/services/admin-rate-card.service.ts`)

- `createDraftRateCard` — validates version/source/generatedAt and the draft
  window, then creates the DRAFT.
- `importRateCardEntries` — validates, converts through the pure converter
  (mapping `IMPORT_DUPLICATE_IDENTITY` → `RATE_CARD_ADMIN_DUPLICATE_IDENTITY`
  and `IMPORT_INVALID_CARD` → `RATE_CARD_ADMIN_INVALID_PAYLOAD`), then replaces
  the draft's entries.
- `validateRateCardDraft` — runs the persisted row through the existing pure
  mapper and reports `{ valid, card, providers, entryCount }`; a mapper failure
  becomes `RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE` with the mapper's stable
  code.
- `publishRateCard` — a DRAFT is validated through the pure mapper before
  publication, then the window is resolved (request body first, else the
  draft's stored window) and the overlap-checked transition is delegated to the
  repository. If the snapshot is already ACTIVE and the provided window matches
  the persisted row, this is a coherent replay: `idempotentReplay: true` with
  NO repository write. A conflicting window on an ACTIVE (or a publish on
  RETIRED) → `RATE_CARD_ADMIN_DRAFT_REQUIRED`. With `replaceActiveVersion` the
  replacement outcome is mapped: `replacement_mismatch` →
  `RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH`, `candidate_invalid` →
  `RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE` (with `mapperCode`),
  overlap/concurrent → `RATE_CARD_ADMIN_PUBLISH_CONFLICT`.
- `retireRateCard` — requires ACTIVE, validates `retiredAt >= publishedAt` and
  the optional `effectiveTo` (must be >= `effectiveFrom` and must not widen the
  persisted window), then retires transactionally. On an already-RETIRED
  snapshot a matching optional `retiredAt`/`effectiveTo` replays
  (`idempotentReplay: true`, no write); a conflicting body →
  `RATE_CARD_ADMIN_ACTIVE_REQUIRED`. An omitted `effectiveTo` preserves the
  current window (window closure is OPT-IN for a plain retire).
- `listRateCardSnapshots` / `getRateCardByVersion` — read views with fresh
  plain-object metadata; `getRateCardByVersion` reports a non-fatal
  `mappingError` (code + message) when a row cannot be mapped.
- `importStaticRateCardAsDraft` — imports the static `PROVIDER_RATE_CARD` as a
  DRAFT under its EXACT version (`PROVIDER_RATE_CARD.version`, no prefix),
  never ACTIVE. A second identical import is an idempotent replay: the stored
  DRAFT is compared to the expected fresh row via `semanticParityEqual` and the
  run returns `idempotentReplay: true` with NO write (no create, no entry
  writes, no audit evidence). A DIFFERENT-content DRAFT, or any ACTIVE/RETIRED
  snapshot, under that version → `RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT` (the
  importer NEVER deletes, overwrites, or downgrades).

Every service error is a `ProviderRateCardAdminError`; the service performs no
pricing arithmetic, no model selection, no caching, and no direct Prisma use.

## 10. HTTP surface

Mounted in `src/routes/admin.routes.ts` at `/rate-cards` behind
`requireRole('admin')` (and the global `authenticate` on the admin router):

- `GET /api/admin/rate-cards` — paginated list (optional `status`).
- `GET /api/admin/rate-cards/:version` — snapshot detail + engine entries.
- `POST /api/admin/rate-cards/drafts` — create empty DRAFT.
- `POST /api/admin/rate-cards/drafts/:version/import` — replace draft entries.
- `POST /api/admin/rate-cards/drafts/:version/validate` — mapper gating.
- `POST /api/admin/rate-cards/:version/publish` — transactional publish;
  body supports `effectiveFrom`/`effectiveTo` and optional `replaceActiveVersion`.
- `POST /api/admin/rate-cards/:version/retire` — transactional retire; body
  supports optional `retiredAt`/`effectiveTo`.

There is NO HTTP static-import endpoint. The static card can only be imported
by the dedicated script (section 11). All bodies/params/query are validated
with strict Zod schemas (unknown keys → 400). Errors are mapped by the global
`errorHandler`: 400 / 404 / 409 / 500 per the pure
`providerRateCardAdminStatus` helper.

## 11. Static import is script-only, exact-version, idempotent, DRAFT-only

- `scripts/import-static-provider-rate-card-draft.ts` is the ONLY way to import
  the static card. It hard-fails (exit 1) unless `DATABASE_URL` resolves to
  pathname `/core_server_test` — there is NO bypass flag, so it can never run
  against the real database.
- It upserts a dedicated system actor (`system.rate-card-import@core.test`) —
  the audit `actor_id` is FK-constrained to `users`, so the actor is a real
  user — then drives `importStaticRateCardAsDraft` with no version override
  (the EXACT `PROVIDER_RATE_CARD.version`), and exits 0 only on `CREATED` or an
  `IDEMPOTENT REPLAY (no write)`.
- Idempotency is verified twice in sequence: run #2 prints `IDEMPOTENT REPLAY
  (no write)` and leaves the snapshot count and the audit rows unchanged.
- Source-scan guarantee (test 12c): no route/controller references
  `importStatic` or the service static-import, and the script is hard-gated on
  `/core_server_test`.
- Verified at rest: the test DB holds exactly one snapshot — `1.0.0`, status
  DRAFT, `entryCount` 12 — and **0 ACTIVE**.

## 12. Static-vs-database parity verification

- The imported DRAFT was read back through the Phase 2F-B read path
  (`loadRateCardByVersion`) and its engine entries and providers are exactly
  equal to `PROVIDER_RATE_CARD.entries` / `RATE_CARD_PROVIDERS` (deep-equal
  after canonical `(provider, model, tier)` sorting; the immutable snapshot version matches PROVIDER_RATE_CARD.version exactly.
- DB test 41 asserts the full read-path parity; DB test 42 asserts every row
  keeps exact bigint money, UTC-midnight dates, and DB tier spellings.
- The idempotency replay itself is decided by the pure semantic-parity
  comparator (section 7), so "the exact `1.0.0` DRAFT already exists" is
  recognized without trusting any DB-generated field.

## 13. Concurrency, replacement, replay, and immutability proof (DB tests)

- DB test 32: two concurrent replacements (`Promise.allSettled`) of the same
  ACTIVE snapshot → exactly one new snapshot ACTIVE, exactly one
  `replacement_mismatch`/concurrent rejection, and the old ACTIVE retired
  exactly once.
- DB test 29: a replacement atomically activates the draft (old
  RETIRED + `effectiveTo` closed to the day before the new `effectiveFrom`,
  `rate_card_published` + `rate_card_retired` audit rows); the read path no
  longer applies the retired card and serves the new card from its
  `effectiveFrom`.
- DB tests 30/31: a non-forward window or a version that is not the current
  ACTIVE overlap → `RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH`, leaving both
  the ACTIVE and the DRAFT rows untouched.
- DB tests 27/28: republishing an ACTIVE snapshot with the matching window is a
  coherent no-op (no write, no extra audit); a conflicting window is still
  rejected.
- DB test 33: retiring an already-RETIRED snapshot is a coherent no-op
  (timestamps/entries unchanged, no extra audit). DB test 34: `retire
  effectiveTo` closes the business window atomically with the status
  transition. DB test 35: a widening `effectiveTo` → `INVALID_WINDOW`, ACTIVE
  untouched.
- DB test 18: two overlapping drafts published concurrently → exactly one
  `published`, the other rejects with `RATE_CARD_ADMIN_PUBLISH_CONFLICT`; one
  ACTIVE and one DRAFT row remain.
- DB tests 6-7, 24: imports into published/retired snapshots → `IMMUTABLE`;
  publish on ACTIVE/RETIRED → `DRAFT_REQUIRED`; a second retire is an
  idempotent replay (cannot be undone).

## 14. Test suites (Phase 2F-C)

- **Entry-import (15):** bigint conversion, tier mapping, per-unit/modality/TTS
  rates, aliases, UTC dates, engine-validator failures → `IMPORT_INVALID_CARD`,
  disjoint-window duplicate identity → `IMPORT_DUPLICATE_IDENTITY`, no input
  mutation.
- **Money wire (11):** strict non-negative integer string Zod schema (`rateCardMoneyStringSchema`),
  direct string-to-bigint conversion, rejection of JSON numbers/negative/decimal/exponent/
  whitespace/empty/overflow, `"0" → 0n`, absent/null → null, values > MAX_SAFE_INTEGER
  preserved exactly, tokensPerSecond remains positive number (non-money).
- **Service (48):** validation gating, window coercion (body vs draft),
  mapper-required publishability with `mapperCode`, overlap/concurrent →
  `PUBLISH_CONFLICT`, publish/retire replays (`idempotentReplay`, no repo call),
  conflicting-window replay rejections, replacement forwarding +
  `replacement_mismatch`/`candidate_invalid` mappings, retire `effectiveTo`
  policy, all NOT_FOUND / wrong-state mappings, exact-version static import
  (never publishes), static-import idempotency replay, content-conflict →
  `STATIC_IMPORT_CONFLICT`, fresh output objects.
- **Repository/service DB (42):** full Draft→Import→Validate→Publish→Retire
  lifecycle, bigint round-trip, atomic re-import, overlap conflicts, the SSI
  concurrency proof, atomic replacement + window closure + concurrency,
  publish/retire replay no-ops, retire `effectiveTo`, immutability, list
  pagination/filter, audit evidence, static DRAFT import + idempotency +
  conflicts + exact version + full read-path parity; `after` asserts global
  table isolation against a baseline.
- **HTTP (25):** 401 unauthenticated, 403 non-admin, full lifecycle over
  `app`, strict-schema 400s, **money wire contract 400s** (numeric money,
  negative/decimal/exponent/whitespace/empty/overflow strings),
  `"0" stores 0n`, omitted money stores null, large strings stay exact bigint,
  publish replay, atomic replacement over HTTP (409 on mismatch),
  retire replay, no static endpoint, no ACTIVE ever created.
- **Semantic parity (10):** DB-field-insensitive equality, entry order
  insensitivity, NULL-vs-zero distinctness, all content-field differences,
  rate/alias/window/status/inactive/verifiedAt detection, tier null-vs-STANDARD
  equivalence, lifecycle-timestamp opt-in comparison.
- **Source-scan (16):** updated for phase evolution — only the admin
  route/controller may exist; the loader/repository are still not imported by
  any runtime module; static card stays the live source; the static-import
  script is hard-gated on `/core_server_test` and referenced by no route or
  controller; no cache, no fallback, no pricing arithmetic in the new modules.
- **Snapshot regression (30):** existing Phase 2F-B snapshot tests all pass,
  confirming no regression in load/snapshot paths.

## 15. Full suite results

```
npm test  (node --env-file=.env.test --import tsx --test-concurrency=1 --test tests/*.test.ts)
```

- Before the static `1.0.0` DRAFT import: **1926 tests / 30 suites / 1926 pass
  / 0 fail / 0 cancelled / 0 skipped** (delta vs the prior 1912 baseline: **+14**
  from money-wire 11 + HTTP money 3).
- After the static `PROVIDER_RATE_CARD` DRAFT import (exact `1.0.0`, 12
  entries): **1926 / 1926 pass** again — the DRAFT is inert and nothing
  regresses with it present.
- The script itself was executed in sequence: run #1 `CREATED`; run #2
  `IDEMPOTENT REPLAY (no write)` with no snapshot/audit changes; after the
  post-import suite (DB test 38 exercises and then cleans up the exact-version
  DRAFT it replays on), a final run re-`CREATED` the DRAFT so the exact
  `1.0.0` card is left at rest.

## 16. TypeScript and Prisma verification

- `npx --no-install tsc --noEmit`: **clean (exit 0)** across the whole project.
- `npx --no-install prisma validate`: **valid**; `prisma generate`: clean.
- No migration was created; `prisma/schema.prisma` was not modified in Phase
  2F-C hardening (the only schema modification remains the uncommitted Phase
  2F-A set).

## 17. Git verification

- `git diff --check`: **clean** (no whitespace errors).
- `git status --short --untracked-files=all`: only the expected uncommitted
  set — Phase 2F-A/B files plus the Phase 2F-C files listed in sections 3-4.
- No commit, push, merge, rebase, reset, or stash was performed.

## 18. Static import script — system actor and database isolation

The import script (`scripts/import-static-provider-rate-card-draft.ts`) is
hard-gated to `core_server_test` and must never touch the main/original
database. Because `audit_logs.actor_id` has a foreign-key constraint
(`audit_logs_actor_id_fkey` referencing `users.id`, migration
`20260719122209_init` line 189), the script cannot use a synthetic UUID.
Instead it upserts a dedicated test user:

- Email: `system.rate-card-import@core.test`
- Created on first run (roleId 1, displayName "Rate Card Static Import (test)")
- Reused on subsequent runs via `resolveSystemActorId()`

**Isolation proof:** The script's database activity is strictly limited to:

- `provider_rate_card_snapshot` — creates/updates exactly one DRAFT row
- `provider_rate_card_entry` — creates/updates exactly 12 entry rows
- `audit_logs` — writes exactly 2 audit entries (draftCreated + import) on first run; **0 additional audit rows on replay**
- `users` — creates/reuses the single system actor row above

No other tables are touched. Specifically, the script does not read or write:
- `users` (other than the system actor)
- `roles`
- `token_wallets`
- `token_transactions`
- `token_reservations`
- `ai_billing_operations`
- `payments`
- `token_packages`
- `ai_usage_logs`

This is enforced by the repository implementation (`provider-rate-card-admin.repository.ts`)
which only touches the three tables above, and verified by DB test 38 (`after` assertions)
which snapshots all table row counts before/after and asserts zero delta on all other tables.

## 19. Money wire contract — HTTP evidence

The Admin HTTP boundary enforces a strict non-negative integer string contract
for every monetary field (`tokenRates.*MicrosPerMillion`, `perUnitMicros`,
`modalityRates.audioInputMicrosPerMillion`, `tts.audioOutputMicrosPerMillion`):

- **Accepted:** `"0"`, `"1500000"`, `"9000000000000000000"` (up to int64 max `9223372036854775807`)
- **Rejected (400 Validation error):**
  - JSON numbers: `1500000`, `0`, `-1`, `1.5`, `Number.MAX_SAFE_INTEGER + 1`
  - Negative strings: `"-1"`, `"-0"`
  - Decimals: `"1.5"`, `"0.0"`
  - Exponent: `"1e3"`, `"1E3"`
  - Whitespace: `" 1"`, `"1 "`, `"\t1"`
  - Empty: `""`
  - Sign: `"+1"`
  - Underscore: `"1_000"`
  - Overflow: `"9223372036854775808"` (exceeds PostgreSQL BIGINT)
- **Persisted exactly as `bigint`:** strings convert directly via `BigInt(value)` — never through `Number`
  - `"0"` → `0n`
  - Absent/null fields → `NULL` in DB
  - Values > `Number.MAX_SAFE_INTEGER` (e.g. `"9000000000000000000"`) remain exact in PostgreSQL
- **Non-money field:** `tokensPerSecond` remains a positive `number` (rate, not money)

Evidence: `tests/admin-rate-card-money-wire.test.ts` (11 tests), `tests/admin-rate-card-http.test.ts`
tests 23–25 (money wire HTTP 400/200 behavior), and `src/schemas/admin-rate-card.schema.ts`
(`rateCardMoneyStringSchema`), `src/utils/provider-pricing/entry-import.ts` (`normalizeMoney`),
`src/services/admin-rate-card.service.ts` (`convertImport` → `convertAdminEntriesForImport`).

Internal static-card import (bypassing HTTP) still accepts non-negative safe-integer
`number` values for backward compatibility; the HTTP wire never does.

## 20. Known intentional limits and final confirmation

Intentional limits (all matching the Phase 2F-C spec):

- The Admin workflow is REST-only; it is not wired into Shadow Pricing, the
  Wallet, or billing. The static `PROVIDER_RATE_CARD` remains the only runtime
  pricing source.
- The static card is imported as a DRAFT only, by the hard-gated script, under
  its exact version; no ACTIVE real rate card is seeded or left behind
  (verified: 0 ACTIVE at rest), and there is no HTTP static-import endpoint.
- Only `core_server_test` was used; the main/original database was not touched.
- No migration, dependency, `.env`, `package.json`, or lockfile change.

Final confirmation:

- Focused Phase 2F-C suites: **197/197 pass** (entry-import 15, money-wire 11,
  service 48, DB 42, HTTP 25, semantic parity 10, source-scan 16, snapshot 30).
- Full suite before the DRAFT import: **1926/1926**; after: **1926/1926**.
- `tsc --noEmit` clean, `prisma validate`/`generate` clean, `git diff --check`
  clean.
- At rest: exactly one snapshot `1.0.0` (DRAFT, 12 entries), **0 ACTIVE** (the
  exact-version DRAFT is re-imported after the suite that exercises it).

Status: **`PHASE_2F_C_ADMIN_RATE_CARD_WORKFLOW_READY`**
