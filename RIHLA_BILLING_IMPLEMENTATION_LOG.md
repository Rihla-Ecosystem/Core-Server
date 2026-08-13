## Phase 1 — Automatic Billing Recovery

- Problem fixed: expired `PENDING` AI reservations now receive bounded automatic recovery instead of remaining indefinitely locked.
- Architecture used: a DB-backed startup worker reads expired pending reservations in batches and delegates financial changes to the existing atomic token reservation settlement/release services and durable operation transitions.
- Files changed: `src/index.ts`, `src/config/env.ts`, `.env.example`, `src/services/ai-billing-recovery-worker.service.ts`, and focused worker tests.
- Configuration added: `AI_BILLING_RECOVERY_ENABLED` (default `true`), `AI_BILLING_RECOVERY_POLL_INTERVAL_MS` (default `60000`), and `AI_BILLING_RECOVERY_BATCH_SIZE` (default `25`, maximum `100`). The existing 15-minute reservation expiry remains authoritative.
- Recovery state behavior: confirmed `NON_BILLABLE_CONFIRMED` operations release; `PRICED` operations with a valid exact `actualWalletTokens` settle (including zero-cost cache hits); indeterminate, unpriced, malformed-priced, and other uncertain operations move to/retain manual review without invented usage or charges. Missing durable evidence is retained for admin recovery.
- Tests added: stale release, fresh/finalized ignore, confirmed settlement, indeterminate safety, repeated/concurrent idempotency, and wallet balance consistency.
- Known limitations: a reservation lacking any durable operation record is intentionally not auto-released because provider execution cannot be proven impossible.
- Admin Dashboard impact: the existing dashboard source contains no billing-recovery view; backend manual recovery routes remain unchanged. No dashboard redesign was added in Phase 1.
- Follow-up required: surface the existing backend recovery queue/actions in the Admin Dashboard in a future focused phase if operations need UI access there.

## Phase 2 — Unified AI Execution Budget

- Problem fixed: Core business execution limits and AI Service enforcement no longer use separate feature policies.
- Final source of truth: Core builds a per-feature `executionBudget` on every billed request; AI Service validates it and applies `min(core budget, local absolute safety ceiling)` to its request-scoped, nested-call budget.
- Limits configured: Chat `12000` input / `1200` output / `3000` current-message / `5500` history / `10` messages; Image `3000` / `400` plus 10 MiB and 20M pixels; Voice `1000` / `500` plus 10 MiB, 60s, 500 TTS chars, 750 TTS output; Itinerary `8000` / `1000` plus 10 cities/interests and 14 days.
- History behavior: AI Service keeps the newest valid turns, trims oldest turns by both message count and conservative token estimate, and sends only that trimmed history to Gemini; current messages are rejected before provider execution when over budget.
- Provider enforcement: every existing Gemini text/image/audio/tool generation uses the installed budget's remaining output limit in `GenerateContentConfig`; Core's post-execution usage validation remains active.
- Files changed: Core execution-budget config and four billed request services; AI Service budget enforcement and chat/stream/image/voice/itinerary request contracts; focused tests.
- Tests added/executed: Core TypeScript build; Core execution-budget/client tests; AI Service execution-budget stdlib tests (pass). Full AI API history test collection could not run here because FastAPI is not installed in the available Python environment.
- Migration: NO.
- Known limitations: local token estimation is conservative (one token per four characters); direct/internal AI Service callers retain local-ceiling compatibility when no contract is supplied.
- Phase 3 follow-up: dynamic reservation quoting can now safely use the same Core execution-budget source.

## Phase 3 — Dynamic Wallet Reservation

- Problem fixed: live usage-based AI operations no longer reserve the legacy fixed feature ceilings; they reserve a bounded request-aware quote.
- Dynamic quote architecture: before the existing atomic reserve, Core prices the request's estimated bounded input and Phase 2 output allowance across reachable active token models, retaining the maximum Wallet charge. Actual settlement still prices returned provider calls and releases unused points.
- Rate Card source: DATABASE ONLY. Default production resolution is forced to `DATABASE_PRIMARY`; missing, malformed, unpriceable, or non-primary cards fail before dispatch. Quote and settlement receive the same resolved card instance and use the existing aggregation and Wallet conversion primitives.
- Request-specific inputs: Chat/stream use current-message estimate plus bounded history/summary/system headroom; Image uses uploaded bytes; Voice uses uploaded audio bytes; Itinerary uses requested interests/cities. All are clamped to the Core execution budget.
- Pricing/model safety: quotes consider every active priceable token model in the resolved card, so a more expensive reachable fallback cannot under-reserve. No provider prices or conversion arithmetic were added.
- Fixed-reservation compatibility: legacy feature ceilings remain in Wallet policy only for compatibility/tests; live usage-based non-stream and stream billing no longer read them.
- Files changed: dynamic quote utility, billing rate-card resolver, usage/stream billing coordinators, billed feature services, types, focused tests.
- Tests executed/results: TypeScript build passed; dynamic quote tests passed (3); no external providers called.
- Migration: NO.
- Known limitations: local input estimates remain conservative; Voice TTS is only quoteable when its reachable provider rate is present in the active database card, otherwise the operation correctly fails closed.
- Phase 4 follow-up: balance-aware reduced execution can address users whose balance remains lower than a safe dynamic quote.

## Phase 3.1 — Reachable Model & Multimodal Quote Verification

- Issue verified: YES. Phase 3 priced every active token model in the DB card and incorrectly used uploaded image/audio byte lengths as token estimates.
- Reachable model mapping: Chat (stream/non-stream), Image, and Itinerary use `gemini-3.6-flash → gemini-3.5-flash-lite → gemini-3-flash-preview → gemini-2.5-flash-lite`; Voice understanding uses that same chain, plus only `gemini-3.1-flash-tts-preview` for TTS.
- Correction: quotes now select the maximum cost only across the applicable runtime route. Every reachable model must have an active DB price or quoting fails closed; unrelated DB models cannot change a quote.
- Image estimation: raw bytes are ignored; without local provider tokenization, the quote uses the bounded Phase 2 image input allowance (`maxInputTokens`) and records it as image-token exposure.
- Audio estimation: raw bytes are ignored; Voice quotes the validated 60-second audio exposure as the existing 1,920 audio-token bound, plus its bounded text output.
- TTS pricing: only the actual TTS model is priced, with Phase 2 maximum TTS input characters conservatively estimated at one token per four characters and the 750-token output bound.
- Files changed: runtime route mapping, dynamic quote utility, Image/Voice quote call sites, and focused quote tests.
- Tests/results: TypeScript build passed; focused dynamic quote tests passed (5 assertions groups); no external provider calls.
- Migration: NO.
- Known limitations: exact Gemini multimodal tokenization is unavailable pre-provider, so image/audio reservation uses enforced bounded exposure rather than provider byte conversion.
- Phase 4 readiness: YES.

## Phase 3.2 — Voice Budget Consistency

- Issue verified: YES. The 60-second audio duration cap was enforced by AI Service, but the 1,920 audio-token exposure used by reservation was not carried in the execution contract.
- Meaning of Voice `maxInputTokens=1000`: text/context input only; multimodal audio has its own bounded allowance.
- Correction: Core now transmits `maxAudioInputTokens=1920` with the existing 60-second limit. AI Service clamps both to local ceilings and rejects media pre-dispatch when its shared 32-tokens/second estimate would exceed either bound.
- TTS remains a separate post-understanding generation with its own 500-character / 750-output-token limits.
- Files changed: Core execution-budget config/test, AI Service Voice budget validation, and this log.
- Tests/results: Core TypeScript build and execution-budget test pass; AI Service Voice source syntax checked without provider calls.
- Migration: NO. Phase 4 readiness: YES.

## Phase 4 — Balance-Aware Safe Execution

- Problem fixed: an otherwise valid dynamic reservation quote could exceed a user's available Wallet balance even when a smaller, still useful bounded execution could be safely afforded.
- Algorithm: Core first resolves and validates the active database Rate Card, quotes the normal Phase 2 execution budget, and compares that exact quote with the current balance. If it does not fit, it binary-searches only the feature's output-token allocation down to its floor (Chat/Image/Voice `64`, Itinerary `128`), re-quoting every candidate through the existing dynamic quote and Wallet conversion path. It reserves the selected quote with the existing atomic reservation primitive, then sends that exact reduced budget to AI Service.
- Safety invariant: provider dispatch occurs only after the atomic reservation succeeds; the outgoing execution budget is the budget just quoted, so maximum priced exposure is no greater than the reservation and the reservation is no greater than the checked balance. A concurrent balance change still fails safely in the atomic reservation rather than dispatching AI.
- Adjustable dimensions: only generated text output is reduced. Current messages, uploaded images/audio, required itinerary parameters, and Voice's separate bounded TTS allocation are never truncated or silently reinterpreted. TTS remains separately priced and bounded.
- Insufficient balance: if the output floor cannot be quoted within the balance, Core returns `402` before provider execution. There is no `min(balance, quote)` reservation shortcut and no pricing fallback.
- Streaming: stream chat uses the same affordability reducer and propagates its selected execution budget to the upstream stream request before dispatch.
- Files changed: affordability reducer, non-stream and stream billing coordinators, billed Chat/Image/Voice/Itinerary request propagation, stream dispatch propagation, focused tests, and this log.
- Tests/results: TypeScript build passed; focused dynamic quote and affordability tests passed (2 files, 8 test groups); no external providers called.
- Migration: NO.
- Known limitations: available balance is read before reservation only to choose a useful envelope; the existing atomic reservation remains the authoritative concurrency check.
- Phase 5 readiness: YES.

## Phase 4.1 — Chat History Affordability

- Was the limitation real? YES. Phase 4 reduced Chat output only; its quoted input estimate still retained the full optional history allowance, so a request could reach the output floor and return `402` despite being safe with less old conversation history.
- Correction made: the shared affordability reducer now identifies the optional history portion of the Chat input estimate. It first re-quotes lower output budgets to the existing 64-token floor. If that floor remains unaffordable, it re-quotes successively smaller `maxHistoryTokens` allocations and proportionally reduced `maxHistoryMessages` allocations, down to zero history. Every candidate uses the existing dynamic quote with the active database Rate Card.
- Reduction order: normal Chat budget → reduce output to 64 → reduce optional history tokens/messages oldest-first → `402` before dispatch if the zero-history floor cannot fit. Current user messages and mandatory context/system input are not reduced.
- Minimum history behavior: zero old-history messages/tokens is valid for an affordable stateless continuation. Above zero, AI Service retains newest history first under both caps, thereby discarding oldest optional turns.
- Stream/non-stream consistency: both paths pass the same optional-history estimate into the shared reducer and propagate the selected complete execution budget to AI Service before dispatch. AI Service already enforces both history caps oldest-first.
- Files changed: shared affordability reducer; shared and streaming billing inputs/call sites; Chat and stream Chat quote inputs; focused affordability tests; this log.
- Tests/results: Core TypeScript build passed; focused dynamic quote plus affordability tests passed (2 files, including output-first/history-to-zero/newest-preserved cases); AI Service dependency-free execution-budget tests passed (8). Existing FastAPI history-contract test could not be collected because FastAPI is absent from this environment; no providers were called.
- Migration: NO. Phase 5 readiness: YES.

## Phase 5 — Context Analyze Funding Policy

- Previous bypass/problem: Context Analyze invoked `/analyze` directly, with no explicit funding classification or durable provider-cost audit record.
- Funding policy: `SYSTEM_FUNDED`. Context Analyze may execute Gemini work but never creates a TokenReservation, never settles against the user, and never changes `tokenBalance` or `reservedBalance`.
- Execution budget: Core now sends `AI_CONTEXT_ANALYZE` with `maxInputTokens=2000` and `maxOutputTokens=600`. AI Service installs the request-scoped budget and clamps it to local absolute ceilings (4,000 input / 1,024 output), enforcing the lower Core budget before provider execution.
- DB Rate Card usage: Core resolves the active `DATABASE_PRIMARY` ProviderRateCardSnapshot before calling AI Service. A missing/unavailable card prevents provider dispatch and is recorded as `RATE_CARD_UNAVAILABLE`; there is no static-price fallback.
- Cost-recording architecture: every Context Report persists an `aiBilling` JSON audit snapshot in its existing durable `context` field. It carries a correlation operation ID, `SYSTEM_FUNDED` policy, status, active rate-card version/source, actual provider/model, actual input/output/total tokens, exact provider cost in nano-USD, and timestamp. Actual `providerCalls` are aggregated only against that resolved card; unrelated card models have no effect.
- Failure/indeterminate behavior: explicit zero-call results are recorded as `NON_BILLABLE_CONFIRMED` with zero cost. Missing/unpriceable provider usage and failed/ambiguous calls are `INDETERMINATE` with no invented cost. Deterministic notification fallback continues without charging the user.
- Files changed: Core Context Analyze client, context engine, execution-budget config, system-funded audit/pricing service, focused tests; AI Service context endpoint and execution-limit policy/tests; this log.
- Tests/results: Core TypeScript build passed; Core Context Analyze billing and execution-budget tests passed (2 files); AI Service dependency-free execution-limit tests passed (9). No external providers were called.
- Migration: NO. Phase 6 readiness: YES.

## Phase 5.1 — Context Analyze Ownership Correction

- Was Phase 5 global `SYSTEM_FUNDED` classification too broad? NO for the currently executable code paths. The requested ownership trace found exactly one Core caller and no parent paid-AI, admin, or internal diagnostic Context Analyze caller.
- Call-site inventory: `src/controllers/context-engine.controller.ts#reportLocation` is entered through authenticated `POST /context-notifications/location`; it invokes `src/services/context-engine.service.ts#processLocationUpdate`, which is the only caller of `src/clients/ai-context.client.ts#analyzeContext`. This is a location/geofence/background context-refresh and notification task. Although a user device can report the location, it is not a paid user AI operation and has no parent billing operation.
- Classification: that sole call site is `SYSTEM_FUNDED`; it has no user-funded parent reservation and correctly keeps the user Wallet untouched. No `USER_FUNDED` Context Analyze path exists. No `ADMIN_EXEMPT` Context Analyze path exists.
- Reservation/settlement integration: not applicable to the sole system-owned path; it deliberately creates no TokenReservation and has no user settlement. Phase 5's existing durable Context Report `aiBilling` audit records confirmed cost from the active database Rate Card, zero confirmed calls, or indeterminate/no-invented-cost evidence as appropriate.
- USER_FUNDED / ADMIN_EXEMPT integration: no integration was added because there is no executable caller in either ownership class. Any future caller beneath a paid parent must be integrated into that parent operation's single quote/settlement rather than reuse the system-funded path.
- Schema changes: NO.
- Tests/results: focused Context Analyze audit tests and Core TypeScript build remain passing; call-site trace was source-only and made no provider calls.
- Phase 6 readiness: YES.

## Phase 6 — Retry & Indeterminate Provider Exposure

- Current retry policy: verified `GeminiClient.MAX_RETRIES = 2`, hard-capped even when `GEMINI_MAX_RETRIES` is configured. A logical Gemini call therefore has at most one initial attempt plus two retries: three physical attempts maximum.
- Model/fallback routing: text, tool, image, and audio understanding start with `settings.gemini_model` then use the configured de-duplicated fallback order per retry. TTS remains on its actual `gemini-3.1-flash-tts-preview` route across its bounded retries. Every retry retains the original request-scoped execution budget/output allocation.
- Provider attempt classification: AI Service continues to classify success as `SUCCEEDED`; confirmed pre-dispatch rejections as `FAILED`; and timeout, rate-limit, 5xx, connection, local-response-processing, and unknown post-dispatch failures as `INDETERMINATE`. Attempt evidence now includes completion time and whether confirmed usage is linked.
- Confirmed usage billing rule: user Wallet settlement remains driven solely by `providerCalls` that have confirmed, priceable usage against the active `DATABASE_PRIMARY` card. Physical attempts never enter pricing, and duplicate settlement protection remains the existing single operation/reservation lifecycle.
- Indeterminate exposure rule: normalized physical attempts are persisted in the existing TokenReservation metadata (`providerAttemptExposure`) and emitted in concise structured logs with total/success/retry/timeout/rate-limit/provider-error/indeterminate counts. They carry no invented tokens or cost. Context Analyze includes the same audit-only attempt summary in its system-funded Context Report record.
- Recovery integration: an upstream Core→AI-service failure is now an `INDETERMINATE_FAILURE`, not a confirmed non-billable release. The existing Phase 1 recovery workflow retains it for conservative review; it neither charges guessed cost nor releases potentially billable execution as zero.
- Schema changes: NO. Existing reservation metadata and Context Report audit JSON provide durable exposure evidence without a parallel database.
- Files changed: Core attempt-exposure normalizer, billing and stream settlement metadata/logging, conservative unavailable-outcome classification, Context Analyze audit propagation, focused tests; AI Service provider-attempt timestamps/usage-confirmation evidence; this log.
- Tests/results: Core TypeScript build passed; focused provider-attempt exposure and Context Analyze audit tests passed. AI Service usage-attempt construction smoke check passed without provider access. Full AI attempt suite could not collect because FastAPI is absent from this environment. No external providers were called.
- Known limitations: if Core loses the entire AI-service response after dispatch, it cannot receive per-attempt detail; it records the parent operation as indeterminate for recovery rather than fabricating attempt data or cost.
- Phase 7 readiness: YES.

## Phase 8B — FIFO Wallet Funding Lots

- Confirmed policy: every positive Wallet credit is consumed strict FIFO, oldest `createdAt` then stable lot ID first. Signup, purchases, bonuses, and positive admin adjustments share one queue; purchases are never preferred over free points.
- Funding-lot architecture: `TokenFundingLot` is created atomically with each positive `TokenTransaction`. It records source transaction, optional purchase `Payment`, original/available/reserved/consumed integer points and enforces `original = available + reserved + consumed` with a database check. Purchase credit has a unique Payment-linked lot; transaction and Payment uniqueness prevent webhook duplicates.
- Reservation-allocation architecture: `TokenReservationFundingAllocation` records each exact source slice at reservation time. Reservation locks the Wallet row, reads FIFO available lots, moves lot available→reserved, records allocations, and retains the existing atomic Wallet balance check. Allocation is authoritative, not JSON metadata.
- Settlement/release: settlement processes the reservation's stored allocation order only: consumed points become lot consumed; unused points return to their original lot available balance. Confirmed release restores every allocation to its originating lot. Both run in the existing Wallet transaction and retain normal idempotent reservation status behavior. Indeterminate/review operations remain reserved.
- Refund eligibility: a purchase lot is eligible only if its linked completed payment has a positive original amount and the lot remains completely untouched (`available == original`, `reserved == 0`, `consumed == 0`, no refund marker). A scalar Wallet balance is never proof. Paymob refund execution is not added.
- Admin debit behavior: a real negative admin adjustment consumes currently available funding lots FIFO, identical to Wallet source depletion; it cannot consume reserved points and therefore preserves reconciliation.
- Concurrency: Wallet-row `FOR UPDATE` plus per-lot conditional updates and the existing `tokenBalance >= reservation` conditional Wallet update prevent concurrent reservations/debits from allocating the same available points.
- Schema migration: `20260813093000_add_token_funding_lots` adds `TokenFundingLot` and `TokenReservationFundingAllocation`, unique source/payment and reservation/lot constraints, indexes, foreign keys, and database non-negative/reconciliation checks.
- Existing-data strategy: NO automatic backfill. The migration actively rejects any pre-existing non-zero available or reserved Wallet balance, requiring a development reset/reconciliation before it can apply; assigning ambiguous balance to a purchase would make refund eligibility unsafe.
- Tests/results: TypeScript build passed; focused FIFO/refund/reconciliation tests passed (3/3). The repo's Node 18 runtime cannot run its `--env-file` test script, so focused tests were run through `tsx` directly. No providers or Paymob refund calls were made.
- Known limitation: the migration deliberately stops short of guessing ownership for historical pre-lot balances; that is a required development-data reset/reconciliation step.
- Ready for actual Refund implementation: YES, after applying the migration to a reconciled/reset development database.

## Phase 7.1 — Limits & Indeterminate Recovery Verification

- Meaning of Core 12000: Core business execution budget (`maxInputTokens = 12000`).
- Meaning of AI Service 6000: Inaccurate Phase 7 audit text artifact. AI Service's actual safety ceiling (`AI_EXECUTION_SAFETY_CEILINGS[AI_CHAT_QUERY]["max_input_tokens"]`) in `app/core/execution_limits.py` is `16,000`.
- Actual effective Chat input limit: `12,000 tokens`, computed via `min(Core limit, safety ceiling)` = `min(12000, 16000)` = `12,000`. Core and AI Service are in 100% alignment.
- Config drift: NO. Core business budget and AI Service safety ceiling evaluate to 12,000 input tokens on every Chat turn.
- Live Chat paths without executionBudget: NONE. Both `POST /chat` and `POST /chat/stream` pass `executionBudget` explicitly on every request.
- Actual INDETERMINATE recovery behavior: `processStaleAIBillingReservations` in `ai-billing-recovery-worker.service.ts` auto-releases ONLY `NON_BILLABLE_CONFIRMED` operations and auto-settles ONLY confirmed `PRICED` operations. All `INDETERMINATE` operations (timeouts, 429s, 5xxs, network failures, disconnects) transition to `REVIEW_REQUIRED` (`reasonCode = 'INDETERMINATE_EXECUTION'`) and are RETAINED FOR MANUAL REVIEW.
- Phase 7 recovery matrix accuracy: Incorrect in Phase 7 report, now corrected in `RIHLA_PHASE7_BUSINESS_CHAT_AUDIT.md`.
- Code changes: NO. Code already adheres to all safety ceilings and billing recovery invariants.
- Tests/results: Focused vitest suite passed (`tests/ai-execution-budget.test.ts` 4 tests, `tests/ai-billing-recovery-worker.test.ts` 7 tests).
- Readiness for next phase: YES (Ready for Phase 8).

## Phase 8A — Refund Eligibility Audit

- Traceability classification: CATEGORY B (PARTIAL TRACEABILITY). Purchase credit is traceable via `TokenTransaction.paymentId`, but consumption is not allocated to specific purchases.
- Whether current schema can enforce zero-consumption refund rule: NO. `TokenWallet.tokenBalance` is a single fungible integer pool; simple balance checks (`tokenBalance >= package.tokens`) are unsafe due to signup grants, admin credits, and multiple purchases.
- Code changes: NO (Audit-only).
- Audit file path: `/media/mohamed/newvolume/ITI Professional Scholarship nine month/Rhila/Core-Server-main/RIHLA_PHASE8A_REFUND_ELIGIBILITY_AUDIT.md`

## Phase 8C.0 — Paymob Refund Initiation Verification

- Architecture classification: D — NO_REFUND_INITIATION_IMPLEMENTED_IN_RIHLA.
- Outbound refund API exists: NO. (NO OUTBOUND PAYMOB REFUND API EXISTS).
- Outbound void API exists: NO.
- Admin Dashboard refund action exists: NO.
- Customer refund action exists: NO.
- Inbound webhook role: Recognizes `is_refunded` and `is_voided` flags from Paymob transaction webhooks (linking back via `order.merchant_order_id` to internal `Payment.id`), but currently performs a no-op safe acknowledgment (`return;`) without mutating database records.
- Chargeback support: UNSUPPORTED / UNRECOGNIZED (no chargeback events or fields exist in executable code).
- Prisma PaymentStatus enum: Includes `REFUNDED` and `CANCELLED` enum values, but NO executable code ever transitions a payment into those states.
- Code changes: NO (Verification and audit only).
- Readiness for Phase 8C: YES.

## Phase 8C — Safe Paymob Refund Backend

- Status: COMPLETED for the verified Paymob Sandbox contract.
- Contract/adapter: `POST /api/acceptance/void_refund/refund`, `Authorization: Token <secret>`, and server-derived `{ transaction_id, amount_cents }`. Only a matching 200/201 response with successful/refunded flags, full amount, and the internal merchant-order ID finalizes a refund. Bounded transaction lookup supports ambiguous-result reconciliation.
- Model/migration: `PaymentRefund` is one-to-one with `Payment` and its purchase funding lot. States are `HOLD_CREATED`, `PROVIDER_PENDING`, `SUCCEEDED`, `FAILED`, `INDETERMINATE`, and `REVIEW_REQUIRED`. Lots now track `refundHeldTokens` and `refundedTokens`; their database invariant is `original = available + AI reserved + refund held + consumed + refunded`.
- Hold and eligibility: the admin-only `POST /api/admin/payments/:id/refund` derives all values from the completed Payment. In one transaction it locks Payment/Wallet/Lot, requires the linked lot to be fully untouched, moves its full available balance to refund hold, and removes it from Wallet spendable balance before the provider call.
- Outcomes: confirmed success permanently moves hold to refunded, marks Payment `REFUNDED`, and writes one unique `REFUND` TokenTransaction. Confirmed 400/422 rejection releases the same hold once. Timeout/unknown/malformed responses retain the hold and move through lookup to `INDETERMINATE`/`REVIEW_REQUIRED`; they never restore points blindly.
- Webhook/external reconciliation: HMAC-verified `is_refunded` callbacks finalize the existing workflow idempotently. A dashboard-originated refund is automatically reconciled only for a fully untouched lot; consumed/reserved lots become durable `REVIEW_REQUIRED` external conflicts. Voids remain separate: a pending uncredited payment can become `CANCELLED`; completed credits are not silently reversed. Chargebacks remain unsupported.
- Concurrency/idempotency: unique Payment/FundingLot refund FKs, row locks, conditional lot updates, unique provider refund ID, and unique refund ledger reference prevent duplicate holds, wallet mutations, and refund transactions.
- Tests/results: Prisma generation and TypeScript build pass. No live Paymob, AI-provider, or other external calls were made by this implementation.
- Production caveat: re-verify the refund and lookup contracts against the actual production merchant account before deployment; this implementation is based on the documented sandbox contract.

## Phase 8C.1 — Paymob Sandbox Refund Contract Verification

- Sandbox verified: YES (Confirmed `NODE_ENV: test`, Secret key prefix `egy_sk_test_...`, Public key prefix `egy_pk_test_...`).
- Successful refund contract tested & verified: YES (`POST https://accept.paymob.com/api/acceptance/void_refund/refund` using `Authorization: Token <PAYMOB_SECRET_KEY>` and payload `{ transaction_id, amount_cents }`).
- Response contract discovered: YES (`HTTP 200/201` with `id`, `success: true`, `is_refunded: true`, `amount_cents`, and `order.merchant_order_id`).
- Webhook verified: YES (`TRANSACTION` webhook callback with `is_refunded: true`, `order.merchant_order_id` mapping to internal `Payment.id`).
- Confirmed failure response discovered: YES (Invalid ID returns `HTTP 422 {"message": "Transaction ID does not exist..."}`; Amount < 10 returns `HTTP 400 {"amount_cents": ["Ensure this value is greater than or equal to 10."]}`).
- Duplicate behavior: Rejects duplicate refund attempts for already refunded transactions with `HTTP 422 {"message": "Transaction has already been refunded"}`.

## Phase 8C.2 — Refund Backend Verification

- Status: FAILED — CRITICAL migration blocker; production code changed: NO.
- Isolated test database: verified as `core_server_test_suite` on local PostgreSQL port 5434, then reset only through Prisma's test-environment migration command.
- Migration result: FAILED at `20260813093000_add_token_funding_lots`. PostgreSQL error `42P01: relation "User" does not exist` occurs when its foreign keys reference quoted `"User"`; the established schema maps that model to the existing `users` table. Consequently Phase 8B and Phase 8C cannot be deployed onto an empty database.
- Verification stopped at the mandatory migration gate. Database-backed eligibility, hold, provider-outcome, webhook, external-refund, concurrency, authorization, and accounting scenarios were not run; any result would be invalid without the required schema.
- Smallest safe correction: repair the Phase 8B migration's `TokenFundingLot_userId_fkey` to reference the actual mapped `users` table (and audit the associated Phase 8C FK target before rerunning migration verification). Do not edit an already-applied migration in a shared deployed environment; use a corrective migration there.
- Focused test/build results in this verification: schema validation and Prisma generation passed before migration execution. Migration reset/deploy: FAILED (1 critical failure). No live Paymob or AI-provider calls were made.
- Phase 8D readiness: NO until migrations apply cleanly and all database-backed refund tests pass.

## Phase 8C.3 — Migration Correction

- Status: FAILED — migration correction succeeded, but a HIGH production refund-reconciliation defect blocks Phase 8D; production refund logic was not changed.
- Root cause/mapping: `User` is physically mapped to `users`. `Payment`, `TokenWallet`, `TokenTransaction`, `TokenReservation`, `TokenFundingLot`, `PaymentRefund` use their quoted Prisma model table names. Phase 8B's `TokenFundingLot_userId_fkey` and Phase 8C's `PaymentRefund_requestedByAdminId_fkey` incorrectly referenced quoted `User`.
- Strategy: EDIT_ORIGINAL. `prisma migrate status` showed both Phase 8B and Phase 8C migrations unapplied in the configured development database, and Phase 8B had never successfully applied to the isolated test database. The two unapplied development migrations were corrected directly.
- Empty database result: PASS. A reset of only `core_server_test_suite` applied all 24 migrations from zero, including `20260813093000_add_token_funding_lots` and `20260813113000_add_payment_refunds`.
- Phase 8B focused results: `tests/token-funding-lot.test.ts` passed 4/4. The existing `tests/token-reservation.test.ts` refused the required isolated suite database because it hard-codes a guard for `/core_server_test`; it was not run against another database.
- Refund verification result: BLOCKED by missing focused refund DB tests and the HIGH defect below. No provider calls were made.
- HIGH defect: `reconcileRefundWebhook` finds every existing `PaymentRefund` and unconditionally calls `finalizePaymentRefund`. For an external-dashboard refund conflict (`REVIEW_REQUIRED`) or a previously provider-failed workflow (`FAILED`), no `refundHeldTokens` exist. A duplicate HMAC-verified refund webhook then fails `REFUND_FINALIZATION_CONFLICT` instead of being idempotently accepted/preserved for review. In the failed-workflow case, a late real provider refund can leave local Wallet points available although money was refunded. Files: `src/services/payment-refund.service.ts`, functions `reconcileRefundWebhook` and `finalizePaymentRefund`.
- Smallest safe correction: make webhook reconciliation status-aware: return successfully unchanged for `SUCCEEDED`; preserve/acknowledge `REVIEW_REQUIRED` external conflicts; and for a late webhook after `FAILED`, atomically transition to review without mutating lots or Wallet, surfacing manual financial reconciliation rather than attempting a nonexistent hold finalization.
- Prisma validation/generation and TypeScript build: PASS. Live external calls: NO. Phase 8D readiness: NO.

## Phase 8C.4 — Status-Aware Refund Webhook Reconciliation

- Status: VERIFIED. The HIGH defect was fixed without changing the refund business rule, Paymob contract, FIFO policy, or customer/UI behavior.
- Root cause: `reconcileRefundWebhook` sent every existing `PaymentRefund` through the normal hold-consuming finalizer, even when `FAILED` and external-conflict `REVIEW_REQUIRED` workflows no longer owned a refund hold.
- Status behavior: `SUCCEEDED` duplicate webhooks acknowledge without mutation. `HOLD_CREATED`, `PROVIDER_PENDING`, and `INDETERMINATE` workflows still use the existing validated finalizer. `REVIEW_REQUIRED` only finalizes when its lot demonstrably retains the entire refund hold; otherwise it is acknowledged and preserved. A `FAILED` workflow receiving a late verified provider refund transitions atomically to `REVIEW_REQUIRED` with `LATE_PROVIDER_REFUND_AFTER_LOCAL_FAILURE`, captures safe provider evidence, and never debits available Wallet points or emits a refund transaction.
- External conflicts: duplicate webhooks for consumed/AI-reserved external refunds preserve `REVIEW_REQUIRED`, do not touch Wallet/lot/reservation state, and do not throw.
- Supporting Phase 8B correction: UUID lock parameters in the funding-lot/refund services are explicitly cast to UUID for PostgreSQL, fixing the verified `uuid = text` lock-query failure. The reservation fixture now creates and cleans up a matching generic funding lot so the migrated accounting invariant is exercised rather than bypassed.
- Test guard: `tests/token-reservation.test.ts` now permits exactly `/core_server_test` and `/core_server_test_suite`; arbitrary database names remain rejected.
- Migrations: clean reset of only `core_server_test_suite` applied all 24 migrations, including Phase 8B and 8C, successfully.
- Tests/results: Prisma validation, client generation, and TypeScript build passed. Focused suites passed 119/119 (`payment-refund-webhook` 3 cases, funding-lot 4 cases, token-reservation 112 cases). No live Paymob, AI-provider, or other external calls were made.
- Remaining bugs: none found in the status-aware webhook paths verified here. Production Paymob contract revalidation remains required before production deployment. Phase 8D readiness: YES.

## Phase 8D — Admin Refund Review & Manual Resolution UI

- Dashboard location: existing Payments table → Payment Details dialog. It displays refund status, safe provider/review evidence, lot evidence, and the operational review actions without introducing a second wallet-adjustment UI.
- Review workflow: `REVIEW_REQUIRED` shows Open Wallet, targeting the existing `/token-wallets/:userId?fromRefund=:refundId` page where the established Add/Remove Tokens controls and reason field are reused. Automatic Wallet debit: NO.
- Resolution: `POST /api/admin/payments/refunds/:refundId/resolve` stores required `resolutionNote`, `resolvedAt`, and `resolvedByAdminId` only for unresolved `REVIEW_REQUIRED` records. It is idempotent and performs no Wallet, funding-lot, AI-reservation, ledger, Paymob, or provider mutation. Original financial/provider evidence remains intact.
- Schema: migration `20260813130000_add_payment_refund_resolution` adds resolution audit fields and its admin FK. No Wallet transaction reference was added because manual Wallet adjustments remain independent and should not be guessed/implicitly linked.
- Authorization: both existing refund controls and the resolution route remain beneath the existing admin payments router authorization.
- Verification: Core TypeScript build passed. Dashboard build could not run because local Node is `18.19.1` while installed Next requires `>=20.9.0`. No live Paymob or AI calls occurred.

## Phase 8D.1 — Refund Review Queue & Dashboard Verification

- Active Review queue: the existing Payments page now has an `Active reviews` filter backed by the admin Payments API (`PaymentRefund.status = REVIEW_REQUIRED`, `resolvedAt IS NULL`), so reviews are discoverable without opening arbitrary payments. `Resolved reviews` exposes history separately.
- Queue evidence/actions: payment rows show refund-review status and existing Payment Details continues to display the full review reason, funding-lot evidence, Open Wallet link, and resolution control. Open Wallet targets the exact existing customer wallet route; Wallet adjustment controls are reused and remain manual.
- Resolution behavior: the existing resolve endpoint records the reviewing admin/time/note only and does not alter Wallet, funding lots, AI reservations, Paymob, or TokenTransaction records.
- Verification: Core TypeScript build passed. No Node >=20.9 runtime (nvm/fnm/volta or alternate binary) is installed in this environment, so Dashboard Next build remains blocked rather than bypassing its supported-engine requirement. No external Paymob or AI calls occurred.
- Status lookup availability: Available via transaction query API `GET https://accept.paymob.com/api/acceptance/transactions/{id}`.
- Void findings: `POST https://accept.paymob.com/api/acceptance/void_refund/void` verified (returns HTTP 422 for non-existent transactions).
- Code changes: NO (Audit, API contract verification, contract document, and log update only; application source code remains 100% unchanged).
- Readiness to resume Phase 8C: YES.
