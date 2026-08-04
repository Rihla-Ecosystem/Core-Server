# Test Database Isolation Fix Report

## Scope
- Branch: `feature/provider-pricing-phase2`
- Target database: `postgresql://core_user:***@localhost:5434/core_server_test` (name confirmed; credentials not printed)
- This work addresses DB-backed integration-test isolation defects only. No Prisma schema, migration, package manifest, lockfile, environment file, or production pricing/billing/AI-Service code was modified.

## Root Cause
The `Role` model has `name String @unique`, while `User.roleId` is a plain FK to `Role.id` with a schema default of `1`. Tests seeded shared roles using **incompatible fixed role IDs** and, in several files, **upserted roles by `id`** (e.g. `where: { id: 1 }, create: { id: 1, name: 'USER' }`) while another file created the same logical role under a **different fixed ID** (`id: 9997`, `name: 'USER'`). When the suite ran sequentially against one shared database without a reset, this produced two confirmed failure classes:

1. `Unique constraint failed on the fields: (name)` — a role with the same `name` already existed under another fixed `id`, so a name-based create/update collision occurred (e.g. `tests/admin-token-package.test.ts` ~old line 630).
2. `users_role_id_fkey` — a User was created without an explicit `roleId`, falling back to the schema default `1`, but no role with `id = 1` existed, so the insert violated the FK (e.g. `tests/admin-token-package.test.ts` ~old line 2210).

## Root-cause details
- `tests/admin-payment.test.ts` created `admin` (fixed id 9998) and `USER` (fixed id 9997).
- `tests/admin-token-package.test.ts` created `admin` (fixed id 9999) and upserted `id: 1` / `name: 'USER'`.
- `tests/admin-token-wallet.test.ts` created `admin` (fixed id 9987) and `USER` (fixed id 9986).
- The remaining AI-billing/business-token/identify/token suites all used `where: { id: 1 }, create: { id: 1, name: 'USER' }`.
- None of these used the canonical seeded role names (`user`, `moderator`, `admin`), and all relied on the `User.roleId` default `1` or on fixed/stale IDs.

## Fix — shared role-fixture helper
Created `tests/helpers/test-role-fixtures.ts` with pure **name-based** resolution (no fixed IDs, no primary-key relocation):

```ts
export async function ensureTestRole(name: string): Promise<Role> {
  return prisma.role.upsert({ where: { name }, update: {}, create: { name } });
}
export function ensureAdminRole(): Promise<Role> {
  return ensureTestRole(ADMIN_ROLE_NAME); // 'admin'
}
export function ensureUserRole(): Promise<Role> {
  return ensureTestRole(USER_ROLE_NAME); // 'user'
}
```

- Roles are resolved **only** through the unique `Role.name` (matching the seed's canonical names `user` / `moderator` / `admin`, which the auth service also derives JWT claims from).
- The returned role record exposes the real auto-increment `id`; every User fixture binds `roleId` to it.
- No shared role is ever deleted or relocated to a fixed id.

## Per-file changes
Every affected test now calls the helper in its `before` hook, captures `USER_ROLE_ID = (await ensureUserRole()).id`, and passes `roleId: USER_ROLE_ID` on **every** `prisma.user.create`, so no test depends on the `User.roleId` default `1`:

- `tests/admin-payment.test.ts` — `ensureAdminRole()` + `ensureUserRole()`; all `adminRole.id` / `userRole.id` bindings.
- `tests/admin-token-package.test.ts` — `ensureAdminRole()` + `ensureUserRole()`; both `prisma.user.create` calls now pass `roleId`.
- `tests/admin-token-wallet.test.ts` — `ensureAdminRole()` + `ensureUserRole()` before; `createUser` helper passes `roleId`.
- `tests/ai-billing-operation.test.ts`, `tests/ai-billing-recovery.test.ts`, `tests/business-token-consumption.test.ts`, `tests/chat-token.test.ts`, `tests/identify-token.test.ts`, `tests/identify-validation.test.ts`, `tests/token-reservation.test.ts`, `tests/token-summary.test.ts`, `tests/token-transactions.test.ts`, `tests/token-wallet.test.ts` — replaced `where: { id: 1 }` upserts or added `ensureUserRole()` in `before`, and pass `roleId` on every user create.
- `tests/journey-quest.test.ts`, `tests/signup-grant.test.ts` — also relied on the default `roleId`; now call `ensureUserRole()` and pass `roleId` explicitly.

## Cleanup verification
- No test performs `role.deleteMany` / `role.delete` / `roles.delete` (grep verified) — shared roles persist across files.
- User-facing cleanup keeps child-before-parent ordering (TokenTransaction → TokenWallet → User), and roles are never part of cleanup, so no FK ordering defect remains.
- The `audit_logs_actor_id_fkey` log lines emitted by "Missing AuditLog actor rolls back deletion" are the intentional, expected rollback-path behavior and are not defects.

## Why name-upsert is safe
- `Role.name` is the schema-unique key; upserting by name is idempotent across files and runs.
- `User.roleId` now always references the resolved `role.id`, so the FK is satisfied regardless of which auto-increment id the role received.
- No fixed role ids remain; the schema default `roleId = 1` is no longer relied upon by any test.

## Validation results (shared database, no reset between files within each run)
1. Clean reset (`prisma migrate reset --force --skip-seed`) then `admin-payment` → `admin-token-package` (the formerly failing sequence): **99 pass / 0 fail / 0 cancelled** (28 + 71).
2. Token suites sequentially (`token-reservation` → `token-summary` → `token-transactions` → `token-wallet`): **155 pass / 0 fail / 0 cancelled**.
3. Repeat run of the affected sequences without any reset: **254 pass / 0 fail / 0 cancelled**.
4. Full sequential suite
   `timeout 600 node --env-file=.env.test --import tsx --test --test-concurrency=1 --test tests/*.test.ts`
   → **1594 tests / 1594 pass / 0 fail / 0 cancelled / 27 suites** (log: `full-test-output.log`).

## Static checks
- `npx --no-install tsc --noEmit` → exit `0` (production `src` type-checks clean).
- Test files type-check clean under strict settings for all role-fixture changes; remaining `'body' is of type 'unknown'` / JSON-field noise is pre-existing (the project has no test tsconfig; tests execute via `tsx` without type-checking).
- `git diff --check` → clean.
- `git status --short` → only test-file modifications plus new `tests/helpers/`; **no** `prisma/`, migration, `package.json`, lockfile, or `.env` changes.

## Remaining blockers
- None for the database-isolation scope. All confirmed role/FK ordering defects are resolved and the full suite passes sequentially and repeatedly without a reset.

## Scope confirmation
Changes are limited to: `tests/helpers/test-role-fixtures.ts` (new) and 15 test files. No production code, dependencies, or DB schema were altered for this fix.

TEST_DATABASE_ISOLATION_READY