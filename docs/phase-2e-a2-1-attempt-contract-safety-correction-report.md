# Phase 2E-A2.1 — Attempt Contract & Error Classification Correction

Status: `PHASE_2E_A2_1_READY`

Branch: `feature/provider-pricing-phase2`

This report documents the Phase 2E-A2.1 correction on top of Phase 2E-A2
(failed provider attempt & retry observability). Two defects were corrected:

1. **Contract shape defect** — `providerCallStarted` was emitted as an ISO-8601
   *string* (the call start time). It is corrected to a **boolean** (whether the
   provider SDK call began) plus a separate optional `providerCallStartedAt`
   ISO-8601 timestamp, with Core-side backward compatibility for the legacy
   string shape.
2. **Failure classification defect** — every numeric HTTP status (4xx and 5xx)
   was classified `FAILED`. That was unsafe for billing: an HTTP 5xx, an HTTP
   429, a timeout after start, a dropped connection, or an unknown exception
   after the call began all mean the provider call **may have executed** and
   incurred cost. These are now classified **`INDETERMINATE`**; only confirmed
   request / auth / unsupported-operation rejections are `FAILED`.

Attempt observability remains strictly observability-only: attempts never enter
the pricing engine, never change retry/timeout/fallback behavior, and never
touch Wallet / Durable Billing.

## 1. Corrected `ProviderAttempt` contract

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `attemptId` | string | yes | stable, deterministic per request (`attempt-1`, `attempt-2`, …) |
| `provider` | string | yes | provider name |
| `operation` | string | no | operation label |
| `requestedModel` | string | no | model requested for the attempt |
| `actualModel` | string | no | only ever the real `model_version` from the provider |
| `attemptNumber` | integer ≥ 1 | yes | 1-based retry position of the logical provider operation |
| `outcome` | `SUCCEEDED` / `FAILED` / `INDETERMINATE` | yes | classification of the attempt |
| `providerCallStarted` | **boolean** | yes | whether the provider SDK call began |
| `providerCallStartedAt` | string (ISO-8601) | no | when the provider SDK call began, when known |
| `providerResponseReceived` | boolean | yes | whether a provider response was received |
| `providerCallId` | string | no | id of the corresponding provider call, when one exists |
| `errorCategory` | string | no | one of `RATE_LIMIT`, `INVALID_REQUEST`, `AUTH_ERROR`, `UNSUPPORTED_OPERATION`, `SERVER_ERROR`, `TIMEOUT`, `CONNECTION_ERROR`, `LOCAL_PROCESSING`, `UNKNOWN` |
| `httpStatus` | integer | no | HTTP status observed (429, 401/403, 404, 5xx, …) |

Key invariants:

- `providerCallStarted` is a **boolean**, never a timestamp string.
- `providerCallStartedAt`, when present, is the ISO-8601 time the provider SDK
  call began. It is **never proof of a usable response**;
  `providerResponseReceived` remains the authoritative boolean.
- When a real provider SDK call begins the AI Service emits
  `providerCallStarted: true` and, when the start time is available,
  `providerCallStartedAt: "<ISO-8601>"`.
- Pre-provider local validation failures (no key available, empty TTS text,
  bad parameters) produce **no attempt** and never set
  `providerCallStarted`/`providerCallStartedAt`.
- `providerResponseReceived` is **not renamed**.
- `actualModel` is never fabricated; it is only ever the provider-reported
  `model_version`.
- Attempts never carry prompts, responses, media, API keys, stack traces, or
  credentials, and never contain fabricated token counts.

## 2. Legacy string backward compatibility (Core only)

The AI Service emits only the corrected (boolean) contract. For a graceful
transition, the Core Server `normalizeProviderAttempt` temporarily accepts the
legacy wire shape where `providerCallStarted` was the ISO-8601 start timestamp
string:

- `providerCallStarted: "<ISO timestamp>"` → `providerCallStarted: true` and the
  timestamp moved into `providerCallStartedAt`.
- After normalization the legacy string shape is **never exposed**; the
  normalized attempt contains a boolean `providerCallStarted` and, when valid,
  `providerCallStartedAt`.
- The legacy shape is **not** the preferred contract; it is a temporary
  compatibility input only.
- A legacy `providerCallStarted` string that is **not** a valid ISO-8601
  timestamp rejects the element (invalid value, ignored safely).
- Invalid values are ignored safely: the normalizer never throws, never mutates
  the input, and drops unusable elements while keeping valid ones in order.

## 3. `providerCallStartedAt` validation

`providerCallStartedAt` is optional and validated against a broad ISO-8601
date-time form (with optional fractional seconds and UTC/`±hh:mm` offset):

- present and valid ISO-8601 → kept (trimmed)
- present but invalid (non-string or not ISO-8601) → **dropped**, the element is
  kept (a bad timestamp is ignored safely, it does not reject the attempt)
- absent → omitted

## 4. Required-field validation for the corrected contract

`normalizeProviderAttempt` rejects an element (ignored safely, no throw) when any
required field is missing or invalid:

- `attemptId` — non-empty string
- `provider` — non-empty string
- `attemptNumber` — positive safe integer
- `outcome` — one of `SUCCEEDED` / `FAILED` / `INDETERMINATE`
- `providerCallStarted` — boolean (or a valid legacy ISO-8601 string, see §2)
- `providerResponseReceived` — boolean

Optional string fields (`operation`, `requestedModel`, `actualModel`,
`providerCallId`, `errorCategory`) are trimmed and dropped when empty.
`httpStatus` must be an integer. No silent coercion of invalid required values.

## 5. Corrected conservative failure classification (AI Service)

`_classify_error` in `llm_client.py` now maps exceptions conservatively. The
presence of an HTTP status never by itself forces `FAILED`.

Precedence (first match wins):

1. Usable success → `SUCCEEDED`
2. Response/chunk arrived but local processing failed →
   `INDETERMINATE` + `LOCAL_PROCESSING` (+ `providerResponseReceived: true`)
3. Timeout / deadline / stream interrupted after start →
   `INDETERMINATE` + `TIMEOUT`
4. Connection drop / reset / refused / transport error →
   `INDETERMINATE` + `CONNECTION_ERROR`
5. HTTP 5xx (500/502/503/504, …) → `INDETERMINATE` + `SERVER_ERROR`
6. HTTP 429 → `INDETERMINATE` + `RATE_LIMIT` (by default; the request may have
   been accepted before the throttle)
7. Confirmed request / auth / unsupported rejection → `FAILED`:
   - `401` / `403` → `FAILED` + `AUTH_ERROR`
   - `404` → `FAILED` + `UNSUPPORTED_OPERATION` (new category)
   - other `400 ≤ status < 500` → `FAILED` + `INVALID_REQUEST`
8. Unknown exception after the call started → `INDETERMINATE` + `UNKNOWN`

Outcome classification rules:

- `FAILED` is restricted to confirmed, non-ambiguous pre-execution rejections
  (request / auth / unsupported) where the provider definitively did **not**
  execute the call.
- Everything uncertain — 5xx, 429, timeouts, connection errors, interrupted
  streams, unknown exceptions after start, and local processing failures after a
  response arrived — is `INDETERMINATE` (the call may have executed and may
  incur cost).

## 6. Category set

`FAILED` categories:

- `INVALID_REQUEST` — confirmed request rejection (other 4xx)
- `AUTH_ERROR` — confirmed authentication/authorization rejection (401/403)
- `UNSUPPORTED_OPERATION` — confirmed unsupported operation/model rejection (404)

`INDETERMINATE` categories:

- `TIMEOUT` — timeout/deadline after the call started
- `CONNECTION_ERROR` — connection dropped/reset/refused/transport failure
- `SERVER_ERROR` — HTTP 5xx (provider may have executed the call)
- `RATE_LIMIT` — HTTP 429 (may have been accepted before throttling)
- `LOCAL_PROCESSING` — a response was received but local processing failed
- `UNKNOWN` — unknown exception after the call started

`SUCCEEDED` attempts carry no `errorCategory`/`httpStatus`.

## 7. `attemptRiskStatus` (unchanged semantics)

- `NONE` — no failed / indeterminate attempts
- `FAILED_ATTEMPT_PRESENT` — at least one confirmed `FAILED` and no `INDETERMINATE`
- `INDETERMINATE_COST_RISK` — at least one `INDETERMINATE`; the most conservative
  state, **takes precedence** over `FAILED_ATTEMPT_PRESENT`

Pricing summary statuses (`FULLY_PRICED` / `PARTIALLY_PRICED` / `UNPRICED`)
remain purely `providerCalls`-pricing-based and are unaffected by attempts.

## 8. AI Service instrumentation changes

`app/core/usage.py`:

- Added `ERROR_CATEGORY_UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION"`.
- `make_provider_attempt(...)` now takes `provider_call_started: Optional[bool]`
  (a boolean) and `provider_call_started_at: Optional[str]` (an ISO-8601
  timestamp), and emits `providerCallStartedAt` only when the timestamp is
  present. The docstring documents that `providerCallStarted` is a boolean and
  that `providerCallStartedAt` is never proof of a usable response.

`app/core/llm_client.py`:

- `_now_iso()` — provider-neutral UTC timestamp, now explicitly documented as
  the value for `providerCallStartedAt`.
- `_classify_error()` — rewritten to the conservative policy in §5.
- `_record_attempt()` — signature changed to
  `provider_call_started_at: str`; it is only ever invoked from inside a
  provider try block (a real SDK call began), so it always emits
  `provider_call_started=True` and the recorded start time. Pre-provider local
  failures never reach it.
- `_stream_to_async()` — passes the recorded start time through; mid-stream
  failures are `INDETERMINATE` with `providerResponseReceived: true` when chunks
  were delivered and a call record was produced.
- Every generation path (`generate`, `generate_with_tools`,
  `generate_with_image`, `generate_with_audio`, `generate_speech`) now records
  `provider_call_started_at=<recorded start time>` on both the success and error
  attempt blocks.

## 9. AI Service response exposure (unchanged)

- Non-streaming endpoints (`/identify`, `/voice`, `/chat`, `/itinerary`) include
  `providerAttempts` in the 200 response body.
- `/identify` cache hits return `providerAttempts: []` and `providerCalls: []`.
- `/stream` emits `providerAttempts` once on the final SSE completion/error event.
- The field is optional / default-safe: absent when there were no attempts.

## 10. Core normalization changes

`src/utils/ai-usage.ts` `normalizeProviderAttempt`:

- `providerCallStarted` is now a **required boolean** (or a valid legacy ISO-8601
  string per §2).
- `providerCallStartedAt` is an optional ISO-8601 timestamp: kept when valid,
  dropped when invalid (§3).
- Required-field validation updated per §4.
- `providerCallStarted` was removed from the generic optional-string list.

`src/types/ai.ts`:

- `ProviderAttempt.providerCallStarted` is now `boolean` (was `string`).
- `ProviderAttempt.providerCallStartedAt?: string` added.
- `RawProviderAttempt` gains `providerCallStartedAt?: unknown`.
- Comment on `ProviderAttemptOutcome.FAILED` corrected to "confirmed request /
  auth / unsupported rejection".

## 11. Core integration path (unchanged)

`recordAiUsage` / `recordAiUsageWith` pass `providerAttempts` into the shadow
context; the shadow service normalizes them, derives `attemptRiskStatus`, and
stores both on the immutable observation riding the (authoritative)
`providerCalls` pricing observation. Attempts ride the pricing observation and
are never stored standalone. All call sites (`voice`, `identify`, `chat`,
`itinerary`, `stream`) thread `providerAttempts` — unchanged from 2E-A2.

## 12. Metrics & admin rows (unchanged output, corrected input)

- `computeShadowPricingMetrics` aggregates attempts into `totalAttempts`,
  `succeeded`, `failed`, `indeterminate`, `retryContainingRequests`,
  `indeterminateCostRisk`, and dimension maps; JSON-safe, no bigint.
- Admin observation rows expose `attemptRiskStatus`, `attemptCount`,
  `failedAttemptCount`, `indeterminateAttemptCount`, `hasRetry`.
- Input attempts now carry the corrected boolean contract; the aggregate output
  shape is unchanged. No timestamp aggregation was introduced.
- No prompts, responses, media, or secrets are ever aggregated.

## 13. Files modified — AI Service

`ai-service-provider-pricing-phase2`:

- `app/core/usage.py` — `ERROR_CATEGORY_UNSUPPORTED_OPERATION`;
  `make_provider_attempt` boolean `provider_call_started` +
  `provider_call_started_at`
- `app/core/llm_client.py` — conservative `_classify_error`; `_record_attempt`
  signature; `_stream_to_async`; all generation call sites pass
  `provider_call_started_at`
- `tests/test_attempts.py` — migrated to the corrected contract; added tests for
  401/403 `AUTH_ERROR`, 404 `UNSUPPORTED_OPERATION`, 500/502/504 `SERVER_ERROR`
  (INDETERMINATE), 429 `RATE_LIMIT` (INDETERMINATE), unknown-exception-after-start
  `UNKNOWN`, and boolean `providerCallStarted` + `providerCallStartedAt`
  assertions

## 14. Files modified — Core Server

`Core-Server-provider-pricing-phase2`:

- `src/types/ai.ts` — boolean `providerCallStarted`, optional
  `providerCallStartedAt`, `RawProviderAttempt` update
- `src/utils/ai-usage.ts` — `normalizeProviderAttempt` corrected contract +
  legacy string backward compat + ISO validation
- `tests/ai-provider-attempts.test.ts` — factory migrated to boolean
  `providerCallStarted` + `providerCallStartedAt`; added 10 tests covering the
  corrected contract and conservative risk derivation

## 15. Tests — AI Service (`tests/test_attempts.py`)

28 tests, all passing, all provider calls mocked. Coverage includes:

- Clean success → `SUCCEEDED` attempt with `providerCallStarted: true` and a
  `providerCallStartedAt` timestamp, linked to the provider call
- Stream success → `SUCCEEDED` attempt on the final snapshot
- Confirmed rejections → `FAILED`: 400 `INVALID_REQUEST`, 401/403 `AUTH_ERROR`,
  404 `UNSUPPORTED_OPERATION`
- Conservative `INDETERMINATE`: 429 `RATE_LIMIT`, 500/502/503/504
  `SERVER_ERROR`, timeout `TIMEOUT`, connection drop `CONNECTION_ERROR`, unknown
  exception after start `UNKNOWN`
- Retry then success → `INDETERMINATE` (attempt 1) then `SUCCEEDED` (attempt 2),
  `attemptNumber` 1 and 2, one provider call
- TTS response received but no usable audio → `INDETERMINATE` +
  `LOCAL_PROCESSING` with `providerResponseReceived: true`, then a retry succeeds
- Voice: audio success + Gemini TTS failure + gTTS fallback preserved
- `/identify` cache hit → `providerAttempts: []` and `providerCalls: []`
- Contract tests: boolean `providerCallStarted`, `providerCallStartedAt`
  presence, no fabricated usage, no fake provider call, no prompt/response/media
  content, pre-provider local failures produce no attempt

Full AI suite: **112 passed, 1 failed** — the single failure is the pre-existing
`tests/test_tools.py::TestTools::test_tool_definitions_exist` (`assert 8 >= 9`),
which predates this phase and is intentionally left untouched (see §21).

## 16. Tests — Core Server (`tests/ai-provider-attempts.test.ts`)

25 tests, all passing, using the existing `fakeDeps` / `recordAiUsageWith`
seams. In addition to the 2E-A2 coverage, this phase adds:

16. Boolean `providerCallStarted` normalizes; `providerCallStartedAt` kept when
    valid ISO and omitted when absent
17. `providerCallStartedAt`: valid ISO accepted, invalid dropped (element kept)
18. Legacy string `providerCallStarted` (ISO) → `providerCallStarted: true` with
    the timestamp moved into `providerCallStartedAt`; legacy string shape never
    exposed after normalization
19. Invalid `providerCallStarted` (non-boolean, non-ISO string) rejects the element
20. `INDETERMINATE` 5xx attempt → `INDETERMINATE_COST_RISK`, pricing unchanged
21. `INDETERMINATE` 429 attempt → `INDETERMINATE_COST_RISK`, pricing unchanged
22. Confirmed `FAILED` → `FAILED_ATTEMPT_PRESENT`; `INDETERMINATE` still wins
    precedence
23. `providerCalls` priced exactly once; attempts never create or alter provider
    calls (priced cost `0.000450000` for the single call)
24. Metrics count corrected outcomes from corrected contract input
25. Wallet / Durable Billing are never invoked by attempt observability

Full Core suite: **1619 passed, 0 failed**. `npx tsc --noEmit` is clean. The
`package.json` has no `typecheck` script, so `npx tsc --noEmit` is the typecheck
gate for this report.

## 17. Git diff summary

AI Service (`git diff --stat` shows cumulative 2E-A2 + 2E-A2.1 uncommitted
changes):

- `app/core/llm_client.py`, `app/core/usage.py` — core instrumentation
- `app/api/chat.py`, `identify.py`, `itinerary.py`, `stream.py`, `voice.py`,
  `app/core/gemini_usage.py` — exposure + related (from 2E-A2)
- `tests/test_gemini_usage.py`, `test_llm_usage.py`, `test_stream_usage.py`,
  `tests/test_attempts.py` (new), `tests/test_identify.py` (new)

Core Server (cumulative 2E-A2 + 2E-A2.1 uncommitted changes):

- `src/utils/ai-usage.ts`, `src/types/ai.ts` — corrected attempt contract
- `src/services/ai-shadow-pricing*.service.ts`, `src/services/ai-usage.service.ts`
- `src/services/{voice,identify,chat,itinerary}.service.ts`,
  `src/routes/chat-stream.routes.ts`
- `tests/ai-provider-attempts.test.ts` (new)

No commits or pushes were made in this phase.

## 18. Exclusions confirmed

- No live Gemini provider probes; every provider call in tests is mocked.
- No Rate Card price changes.
- No Wallet / Durable Billing / reserve / settle / release / fallback charging /
  fixed charging changes.
- No Prisma schema changes or migrations; observations remain in-memory and
  ephemeral.
- No retry counts, timeouts, fallback behavior, endpoints, or dependency/env
  file changes (only the corrected diagnostic contract and classification).
- No `providerResponseReceived` rename; no fabricated `actualModel`.
- No commits or pushes.

## 19. Regression guarantees verified

- `actualModel` only ever from `model_version`; `requestedModel` never copied.
- `/identify` cache hits → `providerCalls: []` + `providerAttempts: []`.
- Attempts observability-only; `providerAttempts` never priced, never read by the
  `AiUsageLog` row-writing path.
- `providerCalls` successful-only; retries separate and in-order.
- Streaming emits attempts once on the final event.
- gTTS is not a Gemini `providerCall`; voice Gemini-TTS failure + gTTS fallback
  preserved.
- Pre-provider local failures produce no attempt.

## 20. How to verify

AI Service:

```
python -m pytest tests/test_attempts.py -q                 # 28 passed
python -m pytest -q                                        # 112 passed, 1 pre-existing
```

Core Server:

```
npm test                                                   # 1619 passed, 0 failed
npx tsc --noEmit                                           # clean
```

## 21. Known pre-existing issue (not in scope)

`tests/test_tools.py::TestTools::test_tool_definitions_exist` in the AI Service
fails (`assert 8 >= 9`). It predates this phase, is unrelated to attempt
observability or the contract correction, and is intentionally left untouched.

## 22. Remaining work / follow-ups

None blocking. Suggested future work (not part of this phase): surface a
`providerCallStartedAt` timestamp in the admin observation rows if a request-level
start-time aggregation is ever genuinely needed; document the legacy-string
compatibility window end date once all producers emit the boolean contract.

## 23. Final gate

- AI Service: `tests/test_attempts.py` 28/28 pass; full suite 112 pass + 1
  documented pre-existing failure
- Core Server: `tests/ai-provider-attempts.test.ts` 25/25 pass; full suite
  1619/1619 pass
- Core Server: `npx tsc --noEmit` clean
- No commits or pushes were made.

Status: `PHASE_2E_A2_1_READY`
