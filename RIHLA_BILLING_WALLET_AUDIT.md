# Rihla Billing & Wallet Audit

## 1. Executive Summary

This document presents the complete, read-only technical audit of the Rihla AI system's billing, wallet, token reservation, chat history, execution budgets, recovery mechanisms, and provider usage architecture across both **Core Server** (`Core-Server-main`) and **AI Service** (`ai-service`).

### Major Findings Overview

| Finding ID | Severity | Classification | Summary | Financial / User Impact |
| :--- | :--- | :--- | :--- | :--- |
| **FINDING-01** | **CRITICAL** | `VERIFIED_BUG` | **Missing Automatic Recovery Worker**: Stale `PENDING` token reservations are never automatically cleared by any cron, worker, or startup job. | Reserved wallet points remain permanently locked in `reservedBalance` for users whenever network drops or errors occur. |
| **FINDING-02** | **HIGH** | `VERIFIED_BUG` | **AI Call Billing Bypass (`ContextAnalyze`)**: The context analysis client (`ai-context.client.ts`) directly invokes AI Service `/analyze` without reserving tokens or charging the wallet. | Unbilled Gemini provider costs paid by Rihla; potential resource exhaustion. |
| **FINDING-03** | **HIGH** | `VERIFIED_DESIGN_PROBLEM` | **Unpriced Retry Provider Exposure**: Failed physical Gemini attempts (e.g. 500 error or timeout) are logged as `providerAttempts` but excluded from `providerCalls`. | GCP provider usage cost incurred during failed retries is not charged to the user. |
| **FINDING-04** | **HIGH** | `VERIFIED_DESIGN_PROBLEM` | **Stranded Balance Barrier**: Fixed per-feature reservation ceilings (e.g., 150 tokens for `AI_CHAT_QUERY`, 313 for Voice) block users with lower positive balances from starting cheap requests. | Users with 50–149 points are entirely blocked from using AI Chat even if their query costs only 2 tokens. |
| **FINDING-05** | **MEDIUM** | `VERIFIED_DESIGN_PROBLEM` | **Execution Budget Mismatch**: Core Server sets `maxInputTokens = 12,000`, while AI Service hardcodes `max_input_tokens = 6,000` for `AI_CHAT_QUERY`. | Core Server reserves points based on 12k tokens, but AI Service caps execution at 6k tokens. |
| **FINDING-06** | **MEDIUM** | `VERIFIED_DESIGN_PROBLEM` | **Chat History Budget Config Disconnect**: Core Server configures `historyTokenBudget = 5500` and `maxRecentMessages = 10`, but AI Service hardcodes `MAX_HISTORY_TOKENS = 6000` and `MAX_HISTORY_MESSAGES = 20`. | Core Server context limits are ignored by AI Service's Python endpoint limiters. |
| **FINDING-07** | **LOW** | `NOT_AN_ISSUE` | **Signup Free Points Usability**: Signup grant gives 400 Wallet Points on first tourist login, which exceeds all per-feature reservation ceilings (75–313 tokens). | Verified fully usable for initial AI operations. |
| **FINDING-08** | **LOW** | `NOT_AN_ISSUE` | **Chat History Delivery**: Core Server sends history arrays and AI Service correctly receives, parses via Pydantic, and formats them into Gemini prompts. | Chat history is working end-to-end as intended. |

---

## 2. System Architecture

```
+-----------------------------------------------------------------------------------+
|                                 CORE SERVER                                       |
|                                                                                   |
|  Client Request --> Auth / Role Check --> Token Wallet / Reservation Check        |
|                                                      |                            |
|                                                      v                            |
|                                         TokenWallet (PostgreSQL)                  |
|                                         (tokenBalance / reservedBalance)          |
|                                                      |                            |
|                                                      v                            |
|                                       AIServiceChatExecutor / HTTP                |
+----------------------------------------------|------------------------------------+
                                               | (HTTP POST /v1/execute/chat)
                                               v
+-----------------------------------------------------------------------------------+
|                                  AI SERVICE                                       |
|                                                                                   |
|  FastAPI Router --> Rate Limiter --> Execution Limits --> Supervisor Agent        |
|                                                              |                    |
|                                                              v                    |
|                                                  GeminiClient (GenAI SDK)         |
|                                                  (Round-Robin Keys & Retries)     |
+----------------------------------------------|------------------------------------+
                                               | (HTTPS Call)
                                               v
+-----------------------------------------------------------------------------------+
|                             EXTERNAL AI PROVIDERS                                 |
|                                                                                   |
|                     Google Gemini API / Jina AI / Google TTS                      |
+-----------------------------------------------------------------------------------+
```

---

## 3. Wallet Lifecycle

The complete lifecycle of Wallet Points follows this strict atomic sequence:

1. **Available Balance Check**:
   User's `TokenWallet.tokenBalance` must be greater than or equal to the required feature reservation amount (`tokenBalance >= reservationTokens`).
2. **Atomic Reservation**:
   In a single database transaction (`token-reservation.service.ts` lines 394–405):
   - `tokenBalance` is decremented by `reservationTokens`.
   - `reservedBalance` is incremented by `reservationTokens`.
   - A `TokenReservation` record is created in `PENDING` status.
   - An `AIBillingOperation` record is created in `RESERVED` status.
3. **AI Execution**:
   Core Server dispatches the wire payload to AI Service. AI Service executes the call against Gemini.
4. **Provider Usage & Pricing**:
   AI Service returns `providerCalls[]` and `providerAttempts[]`. Core Server computes exact micro-USD provider cost against the active rate card (`ProviderRateCardSnapshot`) and converts it to Wallet Tokens using `WALLET_TOKEN_VALUE_NANO_USD` (default: 100,000 nano-USD = $0.0001 / token) and `WALLET_MARKUP_BASIS_POINTS` (default: 10,000 = 1.00x).
5. **Settlement**:
   In `settleBusinessTokenReservationForAmount`:
   - `reservedBalance` is decremented by `reservationTokens`.
   - If `actualTokens < reservationTokens`, the unused tokens (`reservationTokens - actualTokens`) are restored to `tokenBalance`.
   - A `TokenTransaction` of type `CONSUME` is created for `actualTokens`.
   - `TokenReservation` status becomes `COMPLETED`.
   - `AIBillingOperation` status becomes `SETTLED`.
6. **Failure & Release Branch**:
   If AI execution fails before reaching provider (e.g. invalid request or pre-provider error):
   - `reservedBalance` is decremented by `reservationTokens`.
   - `tokenBalance` is incremented by `reservationTokens`.
   - `TokenReservation` status becomes `RELEASED`.
   - `AIBillingOperation` status becomes `RELEASED`.

---

## 4. Signup Free Points Audit

- **Granted Amount**: `DEFAULT_SIGNUP_TOKEN_GRANT = 400` Wallet Points (`src/config/wallet-policy.ts` line 31).
- **Trigger**: Issued on the **FIRST successful tourist login** (`grantFirstLoginTokens` in `src/services/wallet-grant.service.ts` line 89, called by `auth.service.ts` line 143 inside `loginUser`). It does **NOT** happen at registration or email verification.
- **Idempotency**: Checked via `hasExistingGrantMarker` looking for reference ID `first-login-grant:<userId>` or legacy `signup-grant:<userId>`. Concurrency protection is enforced via `@@unique([source, referenceId])` on `TokenTransaction`.
- **Role/Admin Exemption**: Admin and system roles pass `isTokenExemptUser(user)` and receive 0 signup tokens (admins bypass wallet consumption).
- **Usability Verdict**: **FULLY USABLE**.
  - Initial grant = 400 points.
  - Per-feature reservations: `AI_CHAT_QUERY` = 150, `AI_IMAGE_ANALYSIS` = 75, `REAL_TIME_TRANSLATION` = 313, `AI_TRIP_ITINERARY` = 195.
  - Since 400 > all individual feature reservation ceilings, a new user can immediately invoke any AI feature upon first login.

---

## 5. Reservation Audit & Balance Matrix

Reservations are determined by per-feature ceilings configured in `DEFAULT_MAX_RESERVATION_TOKENS_BY_FEATURE` (`src/config/wallet-policy.ts` lines 43–50):

| Feature | Reservation Ceiling (Wallet Points) |
| :--- | :--- |
| **AI_CHAT_QUERY** | 150 |
| **AI_IMAGE_ANALYSIS** | 75 |
| **REAL_TIME_TRANSLATION** | 313 |
| **AI_TRIP_ITINERARY** | 195 |

### Balance Matrix: Can Billed AI Operation Start?

| Balance | AI_CHAT_QUERY (150) | AI_IMAGE_ANALYSIS (75) | REAL_TIME_TRANSLATION (313) | AI_TRIP_ITINERARY (195) |
| :---: | :---: | :---: | :---: | :---: |
| **50** | ❌ BLOCKED (402) | ❌ BLOCKED (402) | ❌ BLOCKED (402) | ❌ BLOCKED (402) |
| **100** | ❌ BLOCKED (402) | ✅ CAN START | ❌ BLOCKED (402) | ❌ BLOCKED (402) |
| **200** | ✅ CAN START | ✅ CAN START | ❌ BLOCKED (402) | ✅ CAN START |
| **500** | ✅ CAN START | ✅ CAN START | ✅ CAN START | ✅ CAN START |
| **999** | ✅ CAN START | ✅ CAN START | ✅ CAN START | ✅ CAN START |
| **1000** | ✅ CAN START | ✅ CAN START | ✅ CAN START | ✅ CAN START |
| **1500** | ✅ CAN START | ✅ CAN START | ✅ CAN START | ✅ CAN START |

---

## 6. Stranded Balance Problem

- **Verification Status**: **VERIFIED_DESIGN_PROBLEM**.
- **Location of Rejection**: Core Server `token-reservation.service.ts` line 399 (`tokenBalance: { gte: tokens }`) throwing `AppError(402, 'Insufficient token balance')`.
- **HTTP Status**: `402 Payment Required`.
- **Provider Call**: NO. Request rejected before network dispatch to AI Service.
- **Wallet State**: Unchanged. Points are not lost or decremented, but remain **unusable**.
- **Impact**: A user with 100 points has sufficient wallet value to pay for 10–20 chat queries (actual cost ~2–5 tokens per query), but is completely blocked from starting `AI_CHAT_QUERY` because their balance (100) is less than the fixed reservation ceiling (150).

### Evaluated Solution Families

1. **A. Lower Fixed Reservations**: Reduce `AI_CHAT_QUERY` ceiling from 150 to 25. High safety, low complexity.
2. **B. Request-Aware Dynamic Reservation**: Calculate quote based on input prompt character length prior to reservation.
3. **C. Bounded Minimum Execution**: Allow execution if `tokenBalance >= 10` (minimum safe threshold) and truncate output tokens dynamically.
4. **D. Fixed Catalog Charging**: Charge flat fee per query (e.g. 5 tokens) without post-settlement usage reconciliation.

---

## 7. Chat History End-to-End

- **Verification Status**: **NOT_AN_ISSUE**.
- **Trace**:
  1. Core Server (`chat.service.ts` / `chat-stream.service.ts`) loads recent messages from PostgreSQL `Message` table.
  2. Core Server constructs `AIWireChatRequest` with field `history: Array<{role, content}>` (`ai-service-chat-executor.ts` lines 189–190).
  3. AI Service endpoint (`ai-service/app/api/chat.py` line 51 and `stream.py` line 55) receives payload into Pydantic schema `ChatRequest` containing `history: List[ChatHistoryMessage]`.
  4. Pydantic validates and parses the history items.
  5. `format_history()` converts the history into string format: `Previous conversation (oldest first):\nuser: ...\nassistant: ...`.
  6. The formatted string is prepended to the current user prompt (`f"{history}\n\nCurrent user message: {req.message}"`) and passed to `route_and_respond()` and Gemini API.

---

## 8. Chat Token Budget Audit

| Parameter | Core Server Config (`chat-limits.ts`) | AI Service Policy (`execution_limits.py` / `chat.py`) | Enforced Where? | Effective Status |
| :--- | :--- | :--- | :--- | :--- |
| `maxInputTokens` | 12,000 | 6,000 (`AI_CHAT_QUERY`) | AI Service ContextVar | **Mismatched** (AI Service enforces 6k) |
| `maxOutputTokens` | 1,200 | 800 (`AI_CHAT_QUERY`) | AI Service GenAI config | **Mismatched** (AI Service enforces 800) |
| `maxCurrentMessageTokens` | 3,000 | 10,000 (`ChatRequest.message`) | FastAPI Pydantic | **Mismatched** |
| `maxMessageCharacters` | 10,000 | 4,000 (`ChatHistoryMessage`) | FastAPI Pydantic | **Enforced in AI Service** |
| `maxRecentMessages` | 10 | 20 (`MAX_HISTORY_MESSAGES`) | FastAPI Pydantic | **Mismatched** (AI Service allows 20) |
| `historyTokenBudget` | 5,500 | 6,000 (`MAX_HISTORY_TOKENS`) | AI Service helper | **Mismatched** |
| `summaryTokenBudget` | 1,000 | Unused in Chat API | None | **Dead Config in Chat** |

---

## 9. AI Execution vs Billing Validation

- **Reservation Phase**: Core Server uses `maxInputTokens = 12,000` and `maxOutputTokens = 1,200` to compute maximum possible reservation quotes in `calculateAIReservationQuote()` (`src/utils/ai-reservation-quote.ts` lines 32–33).
- **Execution Phase**: AI Service's `ExecutionBudget` (`app/core/execution_limits.py` line 15) hardcaps input tokens at 6,000 and output tokens at 800.
- **Post-Execution Billing Validation**: In `ai-billing-orchestrator.service.ts` line 143, `validateUsageLimits` checks if actual usage exceeds `maxInputTokens` / `maxOutputTokens`. If exceeded, operation marks `USAGE_LIMITS_EXCEEDED` and triggers review.
- **Mismatch**: Provider cost can never exceed the 12,000 input token reservation quote because AI Service enforces a stricter 6,000 token limit upstream.

---

## 10. Provider Call / Usage Tracking Audit

- `providerAttempts[]`: Array of all physical HTTP attempts made against Gemini SDK, including failed, timed-out, and rate-limited attempts.
- `providerCalls[]`: Array of successful provider executions containing usage metrics (`inputTokens`, `outputTokens`, `cachedInputTokens`).
- **Audit Findings**:
  - In `ai-service/app/core/llm_client.py` lines 436–447, `_record_provider_call` is ONLY invoked upon successful completion of a call.
  - Failed or timed-out physical attempts record a `providerAttempt` (lines 452–462) with outcome `INDETERMINATE` or `FAILED`, but do NOT record a `providerCall`.
  - Core Server's pricing aggregator (`src/utils/provider-pricing/aggregate.js`) ONLY processes `providerCalls[]`.
  - **Financial Result**: GCP provider costs incurred on failed retries are NOT included in the user's wallet settlement.

---

## 11. Retry & Fallback Audit

- **Configuration**: `GeminiClient.MAX_RETRIES = 2` (`ai-service/app/core/llm_client.py` line 122).
- **Attempt Calculation**: 1 initial attempt + 2 retries = **3 physical attempts max per request**.
- **Key Rotation**: Round-robin across configured `api_keys` (`_get_next_available_key`).
- **Model Fallback**:
  - Attempt 1: `gemini-3.6-flash` (or configured primary)
  - Attempt 2: `gemini-3.5-flash-lite`
  - Attempt 3: `gemini-3-flash-preview`
- **Cost Exposure**: If Attempt 1 times out after Gemini processes 5,000 input tokens, and Attempt 2 succeeds with 2,000 tokens, the user is charged ONLY for Attempt 2 (2,000 tokens). The 5,000 tokens from Attempt 1 are absorbed by Rihla as unbilled provider cost.

---

## 12. Pricing & Rate Card Audit

- **Rate Card Storage**: Immutable versioned snapshots in PostgreSQL table `ProviderRateCardSnapshot` (`prisma/schema.prisma` line 763).
- **Conversion Policy**: `WALLET_TOKEN_VALUE_NANO_USD` = 100,000 nano-USD ($0.0001 per Wallet Token).
- **Markup**: `WALLET_MARKUP_BASIS_POINTS` = 10,000 (1.00x multiplier).
- **Minimum Charge**: `MINIMUM_WALLET_CHARGE` = 1 Wallet Token.
- **Rounding**: `Math.ceil()` applied to converted nano-USD token value (`src/utils/wallet-conversion.ts`).

---

## 13. Pending Reservation Audit

Paths capable of leaving `TokenReservation` in `PENDING` status:

| Error Scenario | Core Behavior | Reservation Status | Wallet Reserved Balance | Automatic Recovery? |
| :--- | :--- | :--- | :--- | :--- |
| **Provider Timeout** | Returns 504 / INDETERMINATE | `PENDING` | Locked | ❌ NO |
| **Provider 5xx / 429** | Returns INDETERMINATE | `PENDING` | Locked | ❌ NO |
| **Stream Client Disconnect** | Stream breaks mid-way | `PENDING` | Locked | ❌ NO |
| **Core Server Crash** | Node process terminates | `PENDING` | Locked | ❌ NO |
| **Database Transaction Failure** | Settlement commit fails | `PENDING` | Locked | ❌ NO |

---

## 14. Recovery / V1 Endpoint Audit

- **Registered Endpoints**:
  - GET `/api/admin/billing-recovery/queue` (`src/routes/admin.routes.ts` line 275)
  - GET `/api/admin/billing-recovery/:reservationId` (line 208)
  - POST `/api/admin/billing-recovery/:reservationId/action` (line 214)
  - POST `/api/admin/billing-recovery/wallets/:walletId/reconcile` (line 201)
- **Automatic Execution**: **NONE**.
- **Cron / Job Schedule**: **NONE**.
- **Startup Recovery**: **NONE**.
- **TTL Behavior**: `RESERVATION_TTL_MS = 15 minutes` sets `expiresAt` timestamp in DB, but **does not trigger balance release or settlement automatically**.
- **Result**: If an admin does not manually call the recovery endpoint, locked points stay in `reservedBalance` permanently.

---

## 15. Crash Safety Matrix

| Failure Point | Provider Cost Incurred? | User Wallet State | Reservation State | Recovery Mechanism |
| :--- | :---: | :--- | :--- | :--- |
| **Crash after Reserve, before AI call** | NO | `tokenBalance` -N, `reservedBalance` +N | `PENDING` | Requires manual admin recovery |
| **Crash during AI execution** | MAYBE | `tokenBalance` -N, `reservedBalance` +N | `PENDING` | Requires manual admin recovery |
| **Crash after AI execution, before Settlement** | YES | `tokenBalance` -N, `reservedBalance` +N | `PENDING` | Requires manual admin recovery |
| **DB Settlement Commit Fails** | YES | `tokenBalance` -N, `reservedBalance` +N | `PENDING` | Requires manual admin recovery |

---

## 16. Billing Bypass Audit

Searching both codebases revealed the following AI/provider invocations that bypass Wallet billing:

1. **Context Analysis (`/analyze`)**:
   - Client: `src/clients/ai-context.client.ts` line 34 (`analyzeContext`).
   - Endpoint: `${env.AI_SERVICE_URL}/analyze` (`app/api/context.py`).
   - Behavior: Calls Gemini directly to analyze user context and produce notifications.
   - Billing Status: **UNBILLED BYPASS**. No reservation, no wallet check, no token decrement.
2. **Admin Assistant (`/admin/assistant`)**:
   - Client: `src/services/admin-assistant.service.ts` line 66.
   - Endpoint: `${env.AI_SERVICE_URL}/admin/assistant`.
   - Billing Status: **UNBILLED BYPASS** (Intended for admins, but lacks explicit billing audit record).

---

## 17. Live / Dead Billing Code Map

| Component / Service | Classification | Called By | Notes |
| :--- | :--- | :--- | :--- |
| `usage-based-ai-billing.service.ts` | **LIVE** | `identify.service.ts`, `itinerary.service.ts`, `voice.service.ts` | Primary non-streaming billing pipeline |
| `chat-stream-billing.service.ts` | **LIVE** | `chat-stream.service.ts` | Primary streaming billing pipeline |
| `token-reservation.service.ts` | **LIVE** | `usage-based-ai-billing`, `chat-stream-billing` | DB wallet & reservation mutation engine |
| `ai-billing-operation.service.ts` | **LIVE** | `usage-based-ai-billing`, `chat-stream-billing` | CRUD for `AIBillingOperation` table |
| `wallet-grant.service.ts` | **LIVE** | `auth.service.ts` (`loginUser`) | Grants 400 free points on 1st tourist login |
| `ai-billing-recovery.service.ts` | **PARTIALLY_USED** | `admin-billing-recovery.controller.ts` | Live logic, but ONLY manual via Admin API |
| `business-token-consumption.service.ts` | **LEGACY / PARTIALLY_USED** | Fixed cost fallbacks | Retained for backward fallback references |
| `ai-shadow-pricing.service.ts` | **TEST_ONLY / UNWIRED** | `shadowPricingAdminController` | Read-only observation comparison engine |

---

## 18. Database Consistency Audit

- **Foreign Keys**: `TokenReservation.walletId` -> `TokenWallet.id` (`ON DELETE Restrict`), `TokenReservation.userId` -> `User.id`.
- **Unique Constraints**:
  - `TokenReservation`: `@@unique([referenceId])`, `@@unique([userId, feature, idempotencyKey])`.
  - `AIBillingOperation`: `@@unique([operationId])`, `@@unique([reservationId])`.
  - `TokenTransaction`: `@@unique([source, referenceId])`.
- **Consistency Verification**: Schema constraints prevent duplicate transaction references and double reservations under matching idempotency keys.

---

## 19. Additional Problems Discovered

1. **Unpriced Cached Input Tokens**: If Gemini returns cached input tokens, they are flagged in `providerCalls` but may be unpriced depending on rate card tier mapping.
2. **TTS / Voice Duration Estimates**: Voice reservation calculates 313 tokens based on max 60-second audio, creating high reservation barriers for short 2-second voice commands.

---

## 20. Verified Issues Table

| ID | Severity | Classification | Issue Description | Financial Impact | User Impact | Root Cause | Exact Evidence | Recommended Direction |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ISSUE-01** | **CRITICAL** | `VERIFIED_BUG` | Stale `PENDING` token reservations are never automatically recovered. | User points locked indefinitely; manual support overhead. | User loses access to reserved points after network disconnects. | No background recovery worker or cron scheduled in `src/index.ts`. | `src/index.ts` lines 13–18 (only notification interval present). | Add background cron job calling `ai-billing-recovery.service.ts`. |
| **ISSUE-02** | **HIGH** | `VERIFIED_BUG` | `ContextAnalyze` AI calls bypass Wallet billing completely. | Unbilled Gemini costs paid by Rihla GCP account. | Free unmetered background context calls. | `ai-context.client.ts` POSTs directly to `/analyze` without reservation. | `src/clients/ai-context.client.ts` line 34. | Wrap `/analyze` in system/admin token check or log explicit exemption. |
| **ISSUE-03** | **HIGH** | `VERIFIED_DESIGN_PROBLEM` | Failed retry attempts incur GCP provider cost but are excluded from pricing. | GCP costs incurred without charging user wallet. | User under-charged on retried requests; business absorbs cost. | `_record_provider_call` only called on success in `llm_client.py`. | `ai-service/app/core/llm_client.py` lines 436 vs 452. | Aggregate failed attempt token usage into settlement calculation. |
| **ISSUE-04** | **HIGH** | `VERIFIED_DESIGN_PROBLEM` | Fixed 150-token reservation blocks low-balance users from chat. | Reduced user engagement and chat feature usage. | Users with 50–149 points blocked from initiating chat. | Fixed `maxReservationTokensByFeature` ceiling in `wallet-policy.ts`. | `src/config/wallet-policy.ts` line 46. | Lower reservation ceiling for `AI_CHAT_QUERY` or implement dynamic quotes. |
| **ISSUE-05** | **MEDIUM** | `VERIFIED_DESIGN_PROBLEM` | Mismatch between Core Server (12k input tokens) and AI Service (6k input tokens) execution limits. | Core reserves excess points relative to actual max execution. | Excessive reservation quotes for high-capacity models. | Independent hardcoded configs in `chat-limits.ts` vs `execution_limits.py`. | `chat-limits.ts` line 48 vs `execution_limits.py` line 15. | Harmonize execution limits in single shared config across repos. |

---

## 21. Suspected Problems NOT Confirmed

1. **Unusable Signup Points**: **DISPROVED**. Signup grant is 400 Wallet Points, which is greater than all reservation ceilings (75–313 tokens). Points are immediately usable.
2. **Chat History Dropped by Pydantic**: **DISPROVED**. Pydantic schema in AI Service defines `history: List[ChatHistoryMessage]`, which is received and formatted into the Gemini prompt.

---

## 22. Top Fixes Before Submission

1. **Automated Recovery Cron Worker**:
   - Risk Reduced: Eliminates permanently locked user points.
   - Files Affected: `src/index.ts`, `src/services/ai-billing-recovery.service.ts`.
   - Complexity: **LOW**.
   - Regression Risk: **LOW**.
2. **Route Context Analysis Through Billing / Audit**:
   - Risk Reduced: Stops unbilled Gemini usage.
   - Files Affected: `src/clients/ai-context.client.ts`, `src/services/context-engine.service.ts`.
   - Complexity: **LOW**.
   - Regression Risk: **LOW**.
3. **Include Failed Attempts in Billing Settlement**:
   - Risk Reduced: Prevents unpriced GCP provider cost exposure.
   - Files Affected: `ai-service/app/core/llm_client.py`, `src/utils/provider-pricing/aggregate.js`.
   - Complexity: **MEDIUM**.
   - Regression Risk: **LOW**.
4. **Lower Chat Reservation Ceiling**:
   - Risk Reduced: Solves stranded balance barrier for low-balance users.
   - Files Affected: `src/config/wallet-policy.ts`.
   - Complexity: **LOW**.
   - Regression Risk: **LOW**.
5. **Harmonize Execution Limits**:
   - Risk Reduced: Eliminates config mismatch between Core Server and AI Service.
   - Files Affected: `src/config/chat-limits.ts`, `ai-service/app/core/execution_limits.py`.
   - Complexity: **LOW**.
   - Regression Risk: **LOW**.

---

## 23. Post-Submission Improvements

1. **Dynamic Prompt-Aware Quotes**: Calculate reservation quotes dynamically based on input token length rather than static per-feature ceilings.
2. **Unified Core-AI Config Sync**: Publish limit configurations via shared environment parameters or internal config endpoint.

---

## 24. Final Answers

1. **Are signup free Wallet Points usable today?**
   **YES.** The 400 free Wallet Points granted on first tourist login exceed all per-feature reservation ceilings (75–313 points).
2. **Can a user have Wallet Points but still be blocked because their balance is below the required reservation?**
   **YES.** A user with 100 points is blocked from `AI_CHAT_QUERY` (150 reservation) and `AI_TRIP_ITINERARY` (195 reservation).
3. **Are remaining Wallet Points stranded under the current reservation system?**
   **YES.** Balances below 75 points cannot be spent on any billed AI feature.
4. **Is Chat history currently reaching Gemini?**
   **YES.** History is passed from Core Server, accepted by Pydantic in AI Service, formatted, and prepended to the Gemini prompt.
5. **Are Chat history token-budget settings actually effective?**
   **PARTIALLY.** AI Service hardcodes `MAX_HISTORY_TOKENS = 6000` and `MAX_HISTORY_MESSAGES = 20`, overriding Core Server's settings.
6. **Are `12000 / 1200` execution limits or post-execution billing limits?**
   They act as **reservation quote inputs** and **post-execution validation limits** in Core Server, but AI Service caps execution at 6,000 input / 800 output tokens.
7. **Can provider cost exceed Wallet charge?**
   **YES**, in cases of rate card fallback or unpriced attempts.
8. **Can retries generate unpriced provider exposure?**
   **YES.** Failed retries incur GCP cost but are excluded from `providerCalls[]` used for wallet pricing.
9. **Can PENDING Wallet Points remain locked?**
   **YES.** Interrupted or crashed operations stay `PENDING` indefinitely unless manually recovered.
10. **Is there an automatic stale-operation recovery worker?**
    **NO.**
11. **Is the suspected V1 recovery endpoint registered?**
    **YES**, at `/api/admin/billing-recovery/*`.
12. **Is that V1 endpoint actually used automatically?**
    **NO.** It is purely an admin manual REST endpoint.
13. **What happens if nobody calls recovery?**
    Points in `reservedBalance` remain locked permanently.
14. **Are there AI/provider calls bypassing Wallet billing?**
    **YES.** `ContextAnalyze` (`/analyze`) calls Gemini without wallet reservation or billing.
15. **Which billing implementation is the TRUE live implementation?**
    `usage-based-ai-billing.service.ts` and `chat-stream-billing.service.ts`.
16. **What are the TOP 3 verified billing risks?**
    - Risk 1: Indefinitely locked reserved balances due to missing automatic recovery worker.
    - Risk 2: Unbilled Gemini usage via `ContextAnalyze` bypass.
    - Risk 3: Unpriced provider cost exposure on failed retry attempts.
17. **What are the TOP 5 safest fixes before submission?**
    1. Add automatic recovery cron worker in `src/index.ts`.
    2. Route `ContextAnalyze` through token checks/logging.
    3. Include failed physical attempts in settlement usage.
    4. Lower `AI_CHAT_QUERY` reservation ceiling to 25–50 tokens.
    5. Align Core Server and AI Service limit configurations.
18. **What should NOT be changed before submission?**
    Do not alter the atomic reservation transaction logic, rate card schema, or 100,000 nano-USD denomination policy.
