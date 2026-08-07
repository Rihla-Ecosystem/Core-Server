# Phase 2G-A — Wallet Usage-Based Billing Cutover (Reserve → Execute → Price → Settle → Release)

## Readiness

**Status: `PHASE_2G_A_WALLET_USAGE_BILLING_CUTOVER_READY`**

## Worktree & Branch

- **Path**: `/media/mohamed/newvolume/ITI Professional Scholarship nine month/Rhila/Core-Server-provider-pricing-phase2`
- **Branch**: `feature/provider-pricing-phase2`

## Test Database Safety

- All database operations use `core_server_test` only (`DATABASE_URL` pathname `/core_server_test` verified; main/original database never touched)
- New real-PostgreSQL tests are self-contained: unique fixtures, targeted cleanup, `after` hooks assert baseline restoration
- `AI_WALLET_BILLING_MODE=FIXED` is the default in `.env.test`; the live cutover test file forces `USAGE_BASED` in its own process before dynamic imports so the two modes never collide in one run

## Feature Flag — `AI_WALLET_BILLING_MODE`

- **Parsing**: strict pure `parseAIWalletBillingMode(value)` (in `src/config/wallet-policy.ts`) + env preprocess; trimmed, case-insensitive
- `undefined` / `""` / `null` / non-string → `FIXED`
- `"FIXED"` (case-insensitive) → `FIXED`
- `"USAGE_BASED"` (case-insensitive) → `USAGE_BASED`
- Any unknown / malformed value (`"usage"`, `"usagebased"`, `"1"`, `"true"`) → `FIXED` (safe disabled)
- **A typo can never silently enable usage-based billing.**
- One request, one mode, no dual deduction. FIXED is preserved byte-identical as a documented temporary rollback.

## Locked Wallet Policy

`src/config/wallet-policy.ts` (new): strict `WalletPolicyConfigurationError`-throwing parser, `WALLET_POLICY_VERSION='1'`, env var names, defaults:

| Policy | Default | Meaning |
|--------|---------|---------|
| `SIGNUP_TOKEN_GRANT` | `100` | Tokens granted on first successful login |
| `WALLET_TOKEN_VALUE_NANO_USD` | `100000` | 1 token = 100,000 nano-USD (1/10 cent) |
| `WALLET_MARKUP_BASIS_POINTS` | `10000` | 1.00x markup applied once after aggregation |
| `MINIMUM_WALLET_CHARGE` | `1` | Minimum token charge floor |
| `MAX_TOKEN_BALANCE` | `1000` | Balance ceiling (grant/settle clamp) |
| Per-feature reservation ceilings | strict JSON `{"CHAT":5,...}` | Unknown feature or ceiling below fixed cost rejected |

Parser rejects malformed numbers/negative values/unknown ceiling features; never hardcodes denomination in pricing arithmetic.

## Operation-Level Conversion

`src/utils/wallet-conversion.ts` (new): `computeWalletCharge` + `roundHalfUpBigInt`:

1. Sum providerCall costs in bigint nano-USD (never float)
2. Apply markup once (basis points)
3. Convert to Wallet Tokens once
4. Round-half-up once at the final step
5. Clamp to min 1 token **only when** FULLY_PRICED AND provider cost > 0 AND rounded result would be 0

Never per-call rounding, never treating unknown cost as zero.

## Coordinator — `runUsageBasedAIBilling`

`src/services/usage-based-ai-billing.service.ts` (new) + `src/utils/usage-billing.ts` (new). Stage flow: reserve → create+snapshot verify → execute AI **once** → parse outcome → evidence → usage limits → providerCalls classification → aggregate → convert → settle → evidence → exposure metadata. Outcome contract:

- **SUCCESS + FULLY_PRICED** → settle + release + SETTLED; wallet charged converted tokens
- **PARTIALLY_PRICED** → charge confirmed + best-effort unresolved exposure metadata (never fails the settled op)
- **UNPRICED** → no auto-deduct; RECOVERY_REQUIRED
- **NON_BILLABLE_FAILURE** → release, no consumption transaction
- **INDETERMINATE_FAILURE** → no auto release/settle; RECOVERY_REQUIRED
- **Cache hit** (explicit empty `providerCalls` array) → settle zero, release, normal response
- **Absent / non-array `providerCalls`** → never authoritative, never zero → UNPRICED_PROVIDER_CALLS recovery

`resolveUsageBasedBillingResult` throws: 409 on replay codes, 502 RELEASED, 402/403 denial, 500 other recovery.

## First-Login Grant

`src/services/wallet-grant.service.ts` (new): `grantFirstLoginTokens(userId)` best-effort never-throws. Outcome: `GRANTED` / `ALREADY_GRANTED` / `GRANT_DISABLED` / `USER_EXEMPT` / `BALANCE_AT_MAX` / `NO_USER` / `GRANT_ERROR`. Markers `first-login-grant:<userId>` + legacy `signup-grant:<userId>` both count as already-granted. `auth.service.ts` registration grant removed; `loginUser` grants after `lastLoginAt` update. No failed-login/registration grant; no admins; never twice; `MAX_TOKEN_BALANCE` respected.

## Five Live Route Cutovers

Each service branches on `AI_WALLET_BILLING_MODE`; USAGE_BASED → coordinator path; FIXED → legacy fixed deduction:

- `src/services/chat.service.ts` — `/api/chat` (source `CHAT`)
- `src/services/identify.service.ts` — `/api/identify` (source `IMAGE`)
- `src/services/voice.service.ts` — `/api/voice` (source `VOICE`; maps to `REAL_TIME_TRANSLATION`)
- `src/services/itinerary.service.ts` — `/api/itinerary` (source `ITINERARY`)
- `src/services/chat-stream.service.ts` + `src/routes/chat-stream.routes.ts` — `/api/chat/stream`: reserve **before** dispatch, execute stream once, settle once on end from final usage/providerCalls/providerAttempts; disconnect/mid-stream error never silently releases an ambiguous op (INDETERMINATE `STREAM_INTERRUPTED` recovery); idempotent via `billingSettled`; handled by `src/services/chat-stream-billing.service.ts` (new)

Admin exemption preserved: AI executes, usage telemetry + provider pricing observability recorded, zero Wallet Tokens, no reservation/consumption transaction.

## Defect Fixed During Cutover

`src/services/ai-billing-operation.service.ts` `TOKEN_TRANSACTION_SOURCES` omitted `'ITINERARY'`, so coordinator settlement/release evidence validation rejected the itinerary route with `INVALID_INPUT` ("AI billing settlement source is invalid"). The itinerary FIXED legacy path never exercised the coordinator, which is why this surfaced now. Fixed by adding `'ITINERARY'` to the set.

## Tests Added (52 focused)

| File | Count | Type |
|------|-------|------|
| `tests/wallet-policy.test.ts` | 12 | Pure — defaults, strict parse, billing-mode fallbacks, reservation ceilings |
| `tests/wallet-conversion.test.ts` | 20 | Pure — denomination, half-up, below-half, aggregate-before-round, markup once, custom token value, > MAX_SAFE_INTEGER exact, min-clamp, real aggregate integration |
| `tests/signup-grant.test.ts` | 4 | Real Postgres — first-login grant |
| `tests/wallet-billing-outcomes.test.ts` | 10 | Real Postgres coordinator deps — full outcome matrix (settle+charge, partial exposure, unpriced recovery, non-billable release, indeterminate recovery, cache hit, absent providerCalls recovery, insufficient balance 402, replay preflight, usage limits) |
| `tests/wallet-live-routes-usage.test.ts` | 6 | Live HTTP USAGE_BASED — chat, chat-stream, identify, voice, itinerary, admin-exempt chat |

## Verification

| Step | Result |
|------|--------|
| Focused 2G-A suite (5 files) | ✅ 52/52 pass |
| `npx --no-install prisma validate` | ✅ Valid |
| `npx --no-install prisma generate` | ✅ Generated |
| `npx --no-install tsc --noEmit` | ✅ Clean |
| Full Core suite (`tests/*.test.ts`, concurrency 1) | ✅ 2074/2074 pass, fail 0, cancelled 0 |
| `git diff --check` | ✅ Clean |
| FIXED-mode rollback (legacy deduction) | ✅ Preserved (full suite incl. chat-token / identify-token / shadow-pricing DB suites green) |

## Database State — Baseline Before and After

- **Database used**: `core_server_test` only; main/original database never touched
- `AIBillingOperation`: 0 → 0
- `TokenReservation`: 0 → 0
- `TokenWallet`: 0 → 0
- `TokenTransaction`: 0 → 0
- `users`: 2 (seeded baseline) unchanged

## Known Limitations

1. **No per-tenant mode flag** — `AI_WALLET_BILLING_MODE` is process-wide (candidate for a later phase).
2. **Static rate card only** — only google gemini models are priced; TTS/other providers remain UNPRICED (recovery path).
3. **FIXED kept as temporary rollback** — documented, byte-identical, to be removed in 2G-B after soak.
4. **No admin dashboard** — wallet/usage visibility is DB-observability only (per scope: not started).
5. **No rate-card entry CRUD in this prompt** — existing 2F-C admin rate-card workflow unaffected and unextended here.

## Remaining Phase 2G-B Work (exact)

1. **Remove FIXED legacy branches** from `chat.service.ts`, `identify.service.ts`, `voice.service.ts`, `itinerary.service.ts`, `chat-stream-billing.service.ts` + any legacy fixed-deduction helpers; make USAGE_BASED unconditional.
2. **Delete `AI_WALLET_BILLING_MODE`** (or hard-require `USAGE_BASED` with no fallback) and drop the FIXED parsing branch; update `src/config/wallet-policy.ts`, `src/config/env.ts`, `.env.test`.
3. **Admin dashboard** for wallet balances, usage, and exposure/recovery queues (out of 2G-A scope by design).
4. **Rate card entry CRUD** for non-gemini providers to close UNPRICED gaps (out of 2G-A scope).
5. **Per-tenant / per-request mode overrides** and optional providerCalls exposure surfacing to clients.
6. **Soak verification** against a FIXED→USAGE_BASED parity sample before final removal of the legacy path.

---

*Report generated from actual working tree state. All verification commands executed against `core_server_test` database only.*
