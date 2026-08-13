# Phase 7 — Business Model & /v1/chat Audit

## Executive Summary

This report documents the Phase 7 read-only technical audit of the Rihla AI application's business model, wallet funding, token package and payment flows, admin dashboard management, and the complete runtime/billing execution path of the production Chat endpoints (`/chat` and `/chat/stream`). *(Updated in Phase 7.1 verification)*.

### Key Audit Conclusions

1. **Current Business Model**: Rihla operates a **one-time prepaid Token Package model**. Users purchase generic, non-expiring Wallet Points via Paymob, which are atomically credited to a single `TokenWallet` and consumed across all billed AI features based on actual provider cost.
2. **Production Chat Endpoints**: The production Chat feature is registered at **`POST /chat`** (non-streaming) and **`POST /chat/stream`** (streaming). Both routes enforce JWT authentication, per-user rate limiting, mandatory `Idempotency-Key` headers, Phase 4/4.1 balance-aware safe execution, active Database Rate Card resolution (`ProviderRateCardSnapshot`), dynamic reservation quoting, and atomic settlement.
3. **Billing Path Security**: The production Chat billing path is **SAFE** and protected against duplicate deductions, unpriced provider retries (Phase 6), and unhandled rate card fallbacks.
4. **Subscription / Quota Status**: Subscriptions and feature quotas (daily/monthly limits) do **NOT** exist in code or schema. Purchasing is purely one-time top-ups.
5. **Execution Budget Alignment**: Core Server business budget (`maxInputTokens = 12,000`) and AI Service local safety ceiling (`max_input_tokens = 16,000`) evaluate to an effective limit of **12,000 tokens** via `min(Core limit, safety ceiling)`. Core and AI Service are in exact 100% alignment.
6. **Indeterminate Recovery Safety**: The Phase 1 background recovery worker (`ai-billing-recovery-worker.service.ts`) auto-releases ONLY `NON_BILLABLE_CONFIRMED` operations and auto-settles ONLY confirmed `PRICED` operations. All `INDETERMINATE` operations (timeouts, 429s, 5xxs, disconnects) are retained for manual review (`REVIEW_REQUIRED`) to guarantee no unbilled provider usage is silently released.

---

## Current Business Model

### 1. What the User Actually Buys
- **Item Purchased**: Prepaid **Token Packages** containing generic **Wallet Points**.
- **Purchase Type**: One-time purchase via Paymob checkout.
- **Subscriptions**: **DOES NOT EXIST**. There are no recurring subscriptions, recurring billing engines, or plan renewals.

### 2. Package Structure
- **Prisma Model**: `TokenPackage` (`prisma/schema.prisma` lines 56–74).
- **Attributes**:
  - `id`: Integer (Primary Key)
  - `name`: String (e.g., "Basic Pack")
  - `code`: String (Unique identifier, e.g., `PKG_BASIC`)
  - `price`: Decimal (Stored in DB, e.g., 100.00)
  - `currency`: String (Stored in DB, e.g., "EGP" or "USD")
  - `tokens`: Integer (Wallet Points granted)
  - `isActive`: Boolean (`true` for purchasable packages)
- **Package Validity / Expiry**: **NEVER EXPIRES**. Packages have no validity duration or expiration timestamp.
- **Relationship**: `TokenPackage` 1-to-many with `Payment`.

### 3. Wallet Funding
Wallet Points enter a user's `TokenWallet` through 4 verified code paths:

1. **Signup Free Grant**: `grantFirstLoginTokens()` (`src/services/wallet-grant.service.ts` line 89) grants 400 Wallet Points on the user's **first successful tourist login**.
2. **Package Purchase**: `processPaymobWebhook()` (`src/services/paymob-webhook.service.ts` line 418) credits `tokensSnapshot` from the purchased package upon Paymob payment success.
3. **Admin Adjustment**: `admin-token-wallet.service.ts` allows administrators to credit or adjust tokens manually.
4. **Refund / Bonus**: Defined in `TokenTransactionType` enum (`GRANT`, `CONSUME`, `REFUND`, `BONUS`, `ADJUSTMENT`), but no automated code path issues bonus or refund transactions.

### 4. Signup Grant Details
- **Amount**: 400 Wallet Points (`DEFAULT_SIGNUP_TOKEN_GRANT` in `src/config/wallet-policy.ts` line 31).
- **Trigger**: First successful tourist login (`loginUser` in `auth.service.ts` line 143).
- **Idempotency**: Protected via reference ID `first-login-grant:<userId>` and DB unique constraint `@@unique([source, referenceId])`.
- **Recipient**: Normal tourist users (`isTokenExemptUser` is false). Admins receive 0 points (admins bypass wallet checks).
- **Expiration**: **Never expires.**

### 5. Wallet Spending
- **Billed AI Features**:
  - `AI_CHAT_QUERY` (Chat `/chat` and `/chat/stream`)
  - `AI_IMAGE_ANALYSIS` (Landmark / photo identification `/identify`)
  - `REAL_TIME_TRANSLATION` (Voice translation & TTS `/voice`)
  - `AI_TRIP_ITINERARY` (Trip itinerary generation `/itinerary`)
- **Scope**: Wallet Points are **generic across all AI features** (not feature-locked).

### 6. Expiration & Quotas
- **Wallet Point Expiration**: **NEVER EXPIRE**.
- **Package Expiration**: **NEVER EXPIRE**.
- **Feature Quotas**: **DOES NOT EXIST**. No daily, monthly, or per-feature usage caps exist.
- **Wallet Maximum**: `MAX_TOKEN_BALANCE = 2,147,483_647` Wallet Points (`src/config/business-token-features.ts` line 13). Enforced in `paymob-webhook.service.ts` line 427.
- **Zero Balance Behavior**: Returns `HTTP 402 Payment Required` before AI dispatch if balance is below the feature's minimum execution floor (Chat output floor = 64 tokens).

---

## Package & Payment Flow

```
User Selects Package
       │
       ▼
POST /payments/intention  (payment.service.ts)
  ├─ Validates TokenPackage (price & tokens read from DB)
  └─ Creates PENDING Payment & Paymob Payment Intention
       │
       ▼
User Completes Paymob Checkout
       │
       ▼
POST /payments/paymob/webhook  (paymob-webhook.service.ts)
  ├─ 1. Verifies SHA-512 HMAC signature (verifyPaymobHmac)
  ├─ 2. Validates amount, currency, and merchant reference
  ├─ 3. Atomic DB Transaction:
  │     ├─ Claim Payment status: PENDING -> COMPLETED (updateMany)
  │     ├─ Credit TokenWallet (increment tokenBalance, check MAX_TOKEN_BALANCE)
  │     └─ Record TokenTransaction (type: GRANT, source: PURCHASE)
  └─ 4. Returns 200 OK to Paymob
```

### Payment Verification & Safety Answers

1. **Can Wallet Points be credited twice by duplicate payment webhook?**
   **NO.** `updateMany` atomically transitions payment status from `PENDING` to `COMPLETED` (line 383). If `updateResult.count === 0` and payment is already `COMPLETED` with matching transaction ID, the function returns safely without re-crediting the wallet (line 404).
2. **Is payment -> Wallet credit atomic and idempotent?**
   **YES.** Payment status update, wallet balance increment, and `TokenTransaction` creation execute inside a single `prisma.$transaction`.
3. **Can a successful payment exist without Wallet credit?**
   **NO.** (Unless `MAX_TOKEN_BALANCE` is exceeded, in which case payment status is marked `FAILED` with `failureReason: 'MAX_TOKEN_BALANCE_EXCEEDED'`).
4. **Can Wallet credit occur without confirmed payment?**
   **NO.** Only callbacks with `success === true` and `errorOccured === false` trigger credit.
5. **Is refund implemented financially and in Wallet?**
   **NO.** Paymob webhooks with `isRefunded` or `isVoided` return safely without deducting wallet points (`paymob-webhook.service.ts` lines 350–353).
6. **Are package prices stored in DB or hardcoded?**
   **STORED IN DATABASE** (`TokenPackage.price`).
7. **Are Wallet Points granted by package stored in DB or hardcoded?**
   **STORED IN DATABASE** (`TokenPackage.tokens`).

---

## Database vs Hardcoded Business Configuration

| Business Item | Current Source | DB / Code / ENV | Verified Location |
| :--- | :--- | :--- | :--- |
| **Package Price** | Database | **DB** | `TokenPackage.price` (`schema.prisma` line 62) |
| **Package Wallet Points** | Database | **DB** | `TokenPackage.tokens` (`schema.prisma` line 64) |
| **Package Active Status** | Database | **DB** | `TokenPackage.isActive` (`schema.prisma` line 68) |
| **Signup Grant Amount** | Environment / Config | **ENV / Code** | `SIGNUP_TOKEN_GRANT` (`wallet-policy.ts` line 31, default `400`) |
| **Wallet Maximum** | Code Constant | **Code** | `MAX_TOKEN_BALANCE` (`business-token-features.ts` line 13, `2,147,483,647`) |
| **Wallet Conversion Value** | Environment / Config | **ENV / Code** | `WALLET_TOKEN_VALUE_NANO_USD` (`wallet-policy.ts` line 32, default `100,000` = $0.0001) |
| **Wallet Markup** | Environment / Config | **ENV / Code** | `WALLET_MARKUP_BASIS_POINTS` (`wallet-policy.ts` line 33, default `10,000` = 1.00x) |
| **Provider Rate Card** | Database | **DB** | `ProviderRateCardSnapshot` table (`ACTIVE` status, Phase 3) |
| **AI Execution Budgets** | Code Config | **Code / ENV** | `chat-limits.ts` & `execution_limits.py` (Phase 2) |
| **Retry Count** | Code Constant | **Code** | `GeminiClient.MAX_RETRIES = 2` (`llm_client.py` line 122, Phase 6) |
| **Package Validity** | Does Not Exist | **N/A** | Unimplemented |
| **Feature Restrictions** | Hardcoded Handlers | **Code** | Express route handlers |

---

## Admin Dashboard Coverage

Inspection of `/media/mohamed/newvolume/ITI Professional Scholarship nine month/Rhila/dashbord`:

| Business Feature | Dashboard Availability | Details / Exact Route |
| :--- | :--- | :--- |
| **Packages Management** | `AVAILABLE` | UI page `/token-packages` (Create, edit, toggle active status) |
| **Package Pricing Edit** | `AVAILABLE` | UI page `/token-packages` (Edit price & currency) |
| **Wallet Points Granted Edit** | `AVAILABLE` | UI page `/token-packages` (Edit tokens) |
| **Users' Wallets View** | `AVAILABLE` | UI page `/token-wallets` (Search user wallets & balances) |
| **Manual Wallet Credit/Debit** | `AVAILABLE` | UI modal in `/token-wallets` calling backend admin wallet routes |
| **Payment Records View** | `AVAILABLE` | UI page `/payments` (List payment transactions & status) |
| **Provider Rate Card Management** | `BACKEND ONLY` | Backend has `/admin/rate-cards` routes; Dashboard lacks dedicated Rate Card editor UI |
| **Billing Operations View** | `AVAILABLE` | UI page `/ai-billing` (View shadow pricing and operation metrics) |
| **Recovery Queue Management** | `BACKEND ONLY` | Backend has `/admin/billing-recovery/queue` APIs; Dashboard lacks Recovery Queue UI |
| **Provider Cost / Usage Analytics** | `AVAILABLE` | UI page `/analytics` and `/ai-billing` |

---

## /v1/chat Production Runtime & Billing Trace

### 1. Entry Points
- **Non-Streaming Endpoint**: `POST /chat` (`src/routes/chat.routes.ts` line 41)
- **Streaming Endpoint**: `POST /chat/stream` (`src/routes/chat-stream.routes.ts` line 45)
- **Mounted Router**: `src/routes/index.ts` lines 38–39 (`router.use('/chat', chatRoutes)` and `router.use('/chat', chatStreamRoutes)`).
- **Controller/Service**: `src/services/chat.service.ts` (`chat()`) and `src/services/chat-stream.service.ts` (`streamChat()`).
- **Middleware**:
  - Auth: `authenticate` (`src/middleware/auth.ts`)
  - Validation: `validate(chatSchema)` / `validate(streamSchema)` (`src/middleware/validate.ts`)
  - Rate Limiting: `userRateLimit({ windowMs: 60,000, max: 60 })` (60 req/min per user)

### 2. Request Contract
Accepted body JSON:
- `message`: string (1–10,000 chars, required)
- `lat`: number (-90 to 90, optional)
- `lon`: number (-180 to 180, optional)
- `conversation_id`: string (UUID, optional)
- `persona`: enum (`auto`, `tour_guide`, `local_expert`, `safety_guru`, optional)
- `context`: Record<string, any> (optional)
- `title`: string (1–120 chars, optional)
- Header Required: `Idempotency-Key` (UUID, required header)

### 3. Authorization
- Auth Required: **YES** (Bearer JWT token).
- User ID Source: Extracted securely from `req.user.userId` via authenticated JWT.
- Conversation Ownership: Enforced in DB queries (`findFirst` where `id: conversationId, userId`). Users **cannot** view or write to another user's conversation ID.

### 4. Chat History Processing
- DB Loading: Core Server loads recent messages from PostgreSQL `Message` table.
- Core -> AI Service Payload: Core builds `history: Array<{role, content}>`.
- AI Service Processing: FastAPI endpoint (`app/api/chat.py` & `app/api/stream.py`) parses history into Pydantic schema `List[ChatHistoryMessage]`, formats via `format_history()`, and prepends to the user prompt (`Previous conversation (oldest first):\n...`). History **is** sent to Gemini.
- Limits: Core budget `historyTokenBudget = 5500` / `maxRecentMessages = 10`; AI Service clamps to `MAX_HISTORY_TOKENS = 6000` / `MAX_HISTORY_MESSAGES = 20`.
- Phase 4.1 Low-Balance History Behavior: If user balance cannot afford standard quote, Core's affordability reducer progressively trims output allocation (down to floor 64), then optional history tokens/messages (down to zero history). Current user message is never truncated. If zero history at output floor 64 is still unaffordable, returns `HTTP 402`.

### 5. Execution Budget & Provider Bounding
- Core Budget: `maxInputTokens = 12,000`, `maxOutputTokens = 1,200` (Phase 2).
- AI Service Budget: `min(Core budget, local safety ceiling)` installed in ContextVar (`app/core/execution_limits.py`). Safety ceiling is 16,000 input tokens.
- Effective Enforced Limit: `min(12,000, 16,000) = 12,000 input tokens`. Core and AI Service are in 100% alignment.
- Provider Output Bounding: `GenerateContentConfig(max_output_tokens=effective_output_limit)` passed to Gemini SDK. Output is **truly bounded** at the provider level.

### 6. Model Routing & DB Rate Card
- Reachable Models Chain: `gemini-3.6-flash` -> `gemini-3.5-flash-lite` -> `gemini-3-flash-preview` -> `gemini-2.5-flash-lite` (Phase 3.1).
- Rate Card Resolution: `resolveBillingRateCard` forces `DATABASE_PRIMARY` resolution from `ProviderRateCardSnapshot` table (Phase 3).
- Price Calculation: Dynamic quote prices ALL reachable models across the active DB Rate Card snapshot and selects the maximum cost. Missing reachable model prices cause the quote to fail closed before dispatch.

### 7. Dynamic Reservation & Affordability
1. Core estimates input tokens (current message + bounded history + system/context).
2. Prices reachable models across DB Rate Card for the execution output budget.
3. Compares quote with `TokenWallet.tokenBalance`.
4. If unaffordable, Phase 4/4.1 affordability reducer reduces output (down to 64) and history (down to 0) to find an affordable budget.
5. Executes atomic DB reservation (`tokenBalance` decremented, `reservedBalance` incremented, `TokenReservation` created in `PENDING`).

### 8. Provider Execution & Retries
- Request dispatched to AI Service `/v1/execute/chat` (or `/chat/stream`).
- `GeminiClient` attempts call with round-robin API key rotation.
- Retries: Max **3 physical attempts** (1 initial + 2 retries).
- Usage Tracking (Phase 6): Confirmed usage from successful calls recorded in `providerCalls[]`. Physical attempts logged as `providerAttempts[]` (with outcome `SUCCEEDED`, `FAILED`, or `INDETERMINATE`). Failed physical attempts do NOT enter wallet pricing.

### 9. Billing Settlement
- Core receives response containing `providerCalls[]`.
- Computes exact actual cost against active DB Rate Card.
- Settles `TokenReservation` to `COMPLETED` and `AIBillingOperation` to `SETTLED`.
- `reservedBalance` decremented by reservation amount; actual tokens recorded as `CONSUME` transaction; unused reserved tokens restored to `tokenBalance`.

### 10. Streaming vs Non-Streaming Comparison

| Aspect | Non-Streaming (`POST /chat`) | Streaming (`POST /chat/stream`) |
| :--- | :--- | :--- |
| **Execution Budget** | Identical (Phase 2) | Identical (Phase 2) |
| **DB Rate Card** | Identical (`DATABASE_PRIMARY`) | Identical (`DATABASE_PRIMARY`) |
| **Dynamic Quote** | Identical (Phase 3/3.1) | Identical (Phase 3/3.1) |
| **Affordability Reducer** | Identical (Phase 4/4.1) | Identical (Phase 4/4.1) |
| **History Trimming** | Identical (Oldest-first) | Identical (Oldest-first) |
| **Max Physical Retries** | Identical (3 attempts max) | Identical (3 attempts max) |
| **Reservation Timing** | Synchronous before dispatch | Synchronous before SSE stream dispatch |
| **Settlement Timing** | Synchronous in response handler | Asynchronous on SSE stream completion |
| **Stream Disconnect** | N/A | Handled via `failChatStreamUsageBasedBilling` (`INDETERMINATE` status for Phase 1 recovery worker) |

---

## /v1/chat Failure & Recovery Matrix *(Verified in Phase 7.1)*

| Failure Scenario | Wallet Reservation Status | User Wallet Impact | Recovery Mechanism & Worker Action |
| :--- | :--- | :--- | :--- |
| **Failure before provider dispatch** | `RELEASED` | `tokenBalance` restored, `reservedBalance` decremented | Immediate atomic release in error handler (`NON_BILLABLE_CONFIRMED` -> `AUTO_RELEASE`) |
| **Provider Timeout** | `PENDING` (Operation `INDETERMINATE`) | Tokens locked in `reservedBalance` | Worker flags `REVIEW_REQUIRED` (`INDETERMINATE_EXECUTION`) -> **RETAIN_FOR_MANUAL_REVIEW** |
| **Provider 429 Rate Limit** | `PENDING` (Operation `INDETERMINATE`) | Tokens locked in `reservedBalance` | Worker flags `REVIEW_REQUIRED` -> **RETAIN_FOR_MANUAL_REVIEW** |
| **Provider 5xx Server Error** | `PENDING` (Operation `INDETERMINATE`) | Tokens locked in `reservedBalance` | Worker flags `REVIEW_REQUIRED` -> **RETAIN_FOR_MANUAL_REVIEW** |
| **Core -> AI Service Network Failure** | `PENDING` (Operation `INDETERMINATE`) | Tokens locked in `reservedBalance` | Worker flags `REVIEW_REQUIRED` -> **RETAIN_FOR_MANUAL_REVIEW** |
| **Core Crash after Reservation before dispatch** | `PENDING` (Operation `RESERVED`) | Tokens locked in `reservedBalance` | Worker skips auto-release (no durable proof of non-execution) -> **RETAIN_FOR_MANUAL_REVIEW** |
| **Core Crash after AI response, before Settlement** | `PENDING` (Operation `PRICED` / `EXECUTION_SUCCEEDED`) | Tokens locked in `reservedBalance` | If `PRICED` with valid tokens -> **AUTO_SETTLE**; otherwise **RETAIN_FOR_MANUAL_REVIEW** |
| **DB Settlement Commit Failure** | `PENDING` (Operation `PRICED`) | Tokens locked in `reservedBalance` | Worker settles using durable `actualWalletTokens` -> **AUTO_SETTLE** |
| **Client SSE Stream Disconnect** | `PENDING` (Operation `INDETERMINATE`) | Tokens locked in `reservedBalance` | Worker flags `REVIEW_REQUIRED` -> **RETAIN_FOR_MANUAL_REVIEW** |

---

## Dead / Legacy Chat Paths

| Endpoint / Service | Classification | Route / File Path | Billing Integrity Status |
| :--- | :--- | :--- | :--- |
| `POST /chat` | **LIVE** | `src/routes/chat.routes.ts` | **SAFE** (Full usage billing, DB rate card, dynamic quote) |
| `POST /chat/stream` | **LIVE** | `src/routes/chat-stream.routes.ts` | **SAFE** (Full usage billing, DB rate card, dynamic quote) |
| `POST /ai-service/ingest` | **LIVE** | `src/routes/ai-service.routes.ts` | **SAFE** (Admin-only proxy for vector DB doc ingestion) |
| `POST /analyze` (Context Analyze) | **LIVE** | `src/clients/ai-context.client.ts` | **SAFE** (System-Funded audit record, Phase 5/5.1) |
| `POST /admin/assistant` | **LIVE** | `src/services/admin-assistant.service.ts` | **SAFE** (Admin-only diagnostic tool) |

---

## Verified Problems

| ID | Severity | Type | Description | File Location |
| :--- | :--- | :--- | :--- | :--- |
| **FINDING-7.1** | **MEDIUM** | `ENGINEERING_BUG` | **Unhandled Paymob Webhook Refunds**: Paymob webhooks with `isRefunded` or `isVoided` return safely without deducting Wallet Points or creating a `REFUND` transaction. | `src/services/paymob-webhook.service.ts` lines 350–353 |

---

## Business Decisions Still Required

The following items are **NOT software bugs**, but product/business choices that require product decisions:

1. **Subscriptions vs One-Time Packages**: Decide whether to maintain one-time Token Packages or implement recurring monthly subscriptions.
2. **Package Expiration Policy**: Decide whether purchased Token Packages or Wallet Points should expire after N months or remain non-expiring.
3. **Feature-Level Quotas**: Decide whether free/paid user tiers should have daily/monthly feature quotas (e.g. max 50 chats/day) alongside Wallet Points.
4. **Financial Refund / Chargeback Policy**: Define business rule for handling refunds when a user has already spent their purchased Wallet Points.

---

## Recommended Next Engineering Phase

### Phase 8 — Admin Recovery UI & Financial Refund Handling

1. **Admin Recovery Queue UI**: Expose the existing Phase 1 backend recovery queue (`/admin/billing-recovery/queue`) in the Admin Dashboard (`dashbord`).
2. **Paymob Refund Handling**: Implement refund logic in `paymob-webhook.service.ts` to process Paymob refund webhooks, record `TokenTransaction` (`type: REFUND`), and deduct tokens from user wallet safely.
