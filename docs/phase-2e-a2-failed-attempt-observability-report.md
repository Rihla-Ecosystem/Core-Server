# Phase 2E-A2 — Failed Provider Attempt & Retry Observability

Status: `PHASE_2E_A2_READY`

Branch: `feature/provider-pricing-phase2`

This report documents the Phase 2E-A2 implementation: diagnostic observability
of failed provider attempts and retries across the AI Service
(`ai-service-provider-pricing-phase2`) and the Core Server
(`Core-Server-provider-pricing-phase2`). It extends the Phase 2E-A contract
hardening (2E-A) and the confirmed contract fixes (2E-A1) with a per-request
`providerAttempts[]` diagnostic trail that is **strictly observability-only** —
it never enters the pricing engine, never changes retry/timeout/fallback
behavior, and never touches Wallet / Durable Billing.

## Files created

AI Service (`ai-service-provider-pricing-phase2`):

- `tests/test_attempts.py` — 21 tests (scenarios A–G + contract + local-failure
  guards)

Core Server (`Core-Server-provider-pricing-phase2`):

- `tests/ai-provider-attempts.test.ts` — 15 tests
- `docs/phase-2e-a2-failed-attempt-observability-report.md` (this file)

## Files modified

AI Service (`ai-service-provider-pricing-phase2`):

- `app/core/usage.py` — attempt outcome/category enums, `make_provider_attempt`,
  `record_provider_attempt`, `consume_attempts`, `consume_usage_and_attempts`,
  deterministic per-request attempt ids, `record_provider_call` returns a
  `providerCallId`
- `app/core/llm_client.py` — `_now_iso`, `_classify_error`, `_record_attempt`;
  every generation method (`generate`, `generate_with_tools`,
  `generate_with_image`, `generate_with_audio`, `generate_speech`,
  `_stream_to_async`) records per-attempt outcomes
- `app/api/identify.py` — `providerAttempts` exposed; cache hits return `[]`
- `app/api/voice.py` — `providerAttempts` exposed via `VoiceResponse`
- `app/api/stream.py` — final SSE completion/error event carries
  `providerAttempts` exactly once
- `app/api/chat.py`, `app/api/itinerary.py` — `providerAttempts` exposed
- `app/api/voice.py` — **bug fix**: `logger.warning("Gemini TTS failed, falling
  back to gTTS", error=...)` passed an unexpected keyword to the stdlib logger
  and raised `TypeError`, blocking the gTTS fallback. Changed to a `%s`
  formatted warning.

Core Server (`Core-Server-provider-pricing-phase2`):

- `src/types/ai.ts` — `ProviderAttemptOutcome`, `ProviderAttempt`,
  `RawProviderAttempt`, `AttemptRiskStatus`, and `providerAttempts?` on the AI
  response contract
- `src/utils/ai-usage.ts` — `normalizeProviderAttempt`, `normalizeProviderAttempts`,
  `computeAttemptRiskStatus`, `attemptsIncludeRetry`
- `src/services/ai-usage.service.ts` — `RecordAiUsageParams.providerAttempts?`
  threaded into the shadow-pricing context
- `src/services/ai-shadow-pricing.service.ts` —
  `ShadowPricingRequestContext.providerAttempts?`; the observation now stores
  normalized attempts and the derived `attemptRiskStatus`
- `src/services/ai-shadow-pricing-observation.service.ts` —
  `ShadowPricingObservation` gains optional `attemptRiskStatus` / `attempts`
- `src/services/ai-shadow-pricing-metrics.service.ts` — new `attempts` metrics
  section (totals, retry, risk, dimension breakdowns)
- `src/services/ai-shadow-pricing-observation-query.service.ts` — admin rows
  expose `attemptRiskStatus`, `attemptCount`, `failedAttemptCount`,
  `indeterminateAttemptCount`, `hasRetry`
- `src/services/voice.service.ts`, `src/services/identify.service.ts`,
  `src/services/chat.service.ts`, `src/services/itinerary.service.ts`,
  `src/routes/chat-stream.routes.ts` — call sites thread `providerAttempts`
  into `recordAiUsage`

## Prior reports referenced

- AI: `docs/phase-2e-a-multimodal-contract-hardening-audit.md` (2E-A audit)
- AI: `docs/phase-2e-a1-confirmed-contract-fixes-report.md` (2E-A1)
- AI worktree root: `Gemini-Multimodal-Audit-Report-EN.md` (external Gemini audit)
- Core: `docs/phase-2-provider-pricing-design.md`
- Core: `docs/phase-2c-pricing-engine-report.md`
- Core: `docs/phase-2d-a-shadow-integration-report.md`
- Core: `docs/phase-2d-b-admin-metrics-report.md`

## Contract: the `providerAttempt` record

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `attemptId` | string | yes | stable, deterministic per request (`attempt-1`, `attempt-2`, …) |
| `provider` | string | yes | provider name |
| `operation` | string | no | operation label |
| `requestedModel` | string | no | model requested for the attempt |
| `actualModel` | string | no | only ever the real `model_version` from the provider |
| `attemptNumber` | integer ≥ 1 | yes | 1-based retry position of the logical provider operation |
| `outcome` | `SUCCEEDED` / `FAILED` / `INDETERMINATE` | yes | classification of the attempt |
| `providerCallStarted` | string (ISO-8601) | no | when the provider call was started |
| `providerResponseReceived` | boolean | yes | whether a provider response was received |
| `providerCallId` | string | no | id of the corresponding provider call, when one exists |
| `errorCategory` | string | no | one of `RATE_LIMIT`, `INVALID_REQUEST`, `AUTH_ERROR`, `SERVER_ERROR`, `TIMEOUT`, `CONNECTION_ERROR`, `LOCAL_PROCESSING`, `UNKNOWN` |
| `httpStatus` | integer | no | HTTP status observed (429, 401/403, 5xx, …) |

`SUCCEEDED` — a usable provider response was received and the corresponding
`ProviderCallUsage` was recorded (attempt links to `providerCallId`).
`FAILED` — the provider definitively rejected the call (confirmed 4xx/5xx /
explicit rejection); no call was executed, so no `providerCallId`. `INDETERMINATE`
— the call may have executed (timeout after start, dropped connection, response
received but local processing failed, or a retry where the previous attempt may
have executed); `providerCallId` is carried only when a call record exists.

Pre-provider local validation failures are **not** attempts. Attempts never carry
prompts, responses, media, API keys, stack traces, or credentials, and never
contain fabricated token counts.

## AI Service instrumentation

`llm_client.py` is the single narrowest shared boundary covering text, stream,
tools, image, audio, TTS, and itinerary generation. Each provider operation
records one attempt entry in execution order:

- `generate()` (non-stream + stream)
- `generate_with_tools()`
- `generate_with_image()`
- `generate_with_audio()`
- `generate_speech()`
- `_stream_to_async()` — records a final snapshot plus a `SUCCEEDED` attempt on
  a clean final event, or an `INDETERMINATE` attempt mid-stream (with
  `providerResponseReceived = true` and the `providerCallId` when chunks were
  delivered and a call record was produced)

`_classify_error` maps exceptions: confirmed 4xx/5xx → `FAILED` with an
`errorCategory`; timeouts/deadlines → `INDETERMINATE` + `TIMEOUT`; connection
drops → `INDETERMINATE` + `CONNECTION_ERROR`. `_record_attempt` writes the
attempt into the request scope. Retry counts, timeouts, fallbacks, endpoints,
and normal behavior are unchanged.

## AI Service response exposure

- Non-streaming endpoints (`/identify`, `/voice`, `/chat`, `/itinerary`) include
  `providerAttempts` in the 200 response body.
- `/identify` cache hits return `providerAttempts: []` (mirrors the
  `providerCalls: []` cache-hit contract).
- `/stream` emits `providerAttempts` once on the final SSE completion/error
  event — never on intermediate chunks.
- The field is optional / default-safe: when absent it is omitted.

## Core normalization & risk derivation

`normalizeProviderAttempts(raw)`:

- non-array input → `undefined` (the "no attempts" contract, mirroring absent
  `providerCalls`)
- explicit empty array → `[]` (cache-hit / no-attempt representation)
- invalid elements are dropped individually; valid elements keep relative order
- required fields (`attemptId`, `provider`, `attemptNumber`, `outcome`,
  `providerResponseReceived`) must be present and valid; present-but-invalid
  values reject the element (no silent coercion); optional strings are trimmed
  and dropped when empty; `httpStatus` must be an integer

`computeAttemptRiskStatus(attempts)` → `AttemptRiskStatus`:

- `NONE` — no failed / indeterminate attempts
- `FAILED_ATTEMPT_PRESENT` — at least one confirmed `FAILED`
- `INDETERMINATE_COST_RISK` — at least one `INDETERMINATE`; this is the most
  conservative state and **takes precedence** over `FAILED_ATTEMPT_PRESENT`

`attemptsIncludeRetry(attempts)` — true when any `attemptNumber > 1`.

`attemptRiskStatus` is computed by the shadow service, stored on the
observation, and never lives inside `ShadowPricingResult`. It never changes
`FULLY_PRICED` / `PARTIALLY_PRICED` / `UNPRICED` semantics, which remain purely
`providerCalls`-pricing-based.

## Core integration path

`recordAiUsage` / `recordAiUsageWith` pass `providerAttempts` into the shadow
context. The shadow service normalizes them, derives the risk status, and stores
both on the immutable observation that rides the (authoritative)
`providerCalls` pricing observation. Attempts ride the pricing observation: an
absent / non-authoritative `providerCalls` produces no observation (the normal
skip path), and attempts are never stored standalone.

The call sites (`voice`, `identify`, `chat`, `itinerary`, `stream`) thread the
upstream `providerAttempts` into `recordAiUsage`. Cache-hit `/identify`
responses (no `recordAiUsage` call) naturally produce no attempt observation.

## Attempt observability metrics

`computeShadowPricingMetrics` now includes an `attempts` section aggregated over
the retained in-memory observations:

```json
{
  "attempts": {
    "totalAttempts": 3,
    "succeeded": 1,
    "failed": 1,
    "indeterminate": 1,
    "retryContainingRequests": 1,
    "indeterminateCostRisk": 1,
    "byProvider": { "google": 3 },
    "byOperation": { "TEXT_CHAT": 3 },
    "byRequestedModel": { "gemini-3.6-flash": 3 },
    "byActualModel": { "gemini-3.6-flash": 3 },
    "byErrorCategory": { "RATE_LIMIT": 1, "TIMEOUT": 1 }
  }
}
```

- `retryContainingRequests` counts observations containing any `attemptNumber > 1`.
- `indeterminateCostRisk` counts observations whose risk status is
  `INDETERMINATE_COST_RISK`.
- Dimension maps are keyed by the attempt's own value, `'UNKNOWN'` when the
  optional dimension is absent, and emitted as sorted JSON-safe records.
- Aggregation is in-memory and ephemeral (same ring buffer as pricing); no Prisma
  schema, no migration, no persistence.
- No prompts, responses, media, or secrets are ever aggregated.

## Admin observation rows

`GET /api/admin/ai-shadow-pricing/observations` rows now carry:

```json
{
  "attemptRiskStatus": "FAILED_ATTEMPT_PRESENT",
  "attemptCount": 2,
  "failedAttemptCount": 1,
  "indeterminateAttemptCount": 0,
  "hasRetry": true
}
```

The existing pricing row fields (`engineSummaryStatus`, `requestCategory`,
`noProviderCalls`, `callCount`, `pricedCallCount`, `unpricedCallCount`,
`pricedProviderCost`, `unpricedReasons`, `rateCardVersion`) are unchanged.

## Safety & exclusion guarantees (verified)

- Attempts are never priced; `providerAttempts` are never fed to the pricing
  engine and never read by the `AiUsageLog` row-writing path.
- No retry counts, timeouts, fallbacks, endpoints, or normal request behavior
  changed.
- No Wallet / Durable Billing / reserve / settle / release path is touched.
  `ai-usage.service.ts` imports no Wallet/token/billing modules.
- No live provider probes; every provider call in tests is mocked.
- No Prisma migrations; observation remains in-memory and ephemeral.
- No secrets, prompts, responses, media, or credentials are stored or exposed.

## Tests — AI Service (`tests/test_attempts.py`)

21 tests, all passing, mocking all provider calls and covering:

- Scenario A: clean success → 1 `SUCCEEDED` attempt linked to the provider call
- Scenario B: failed first attempt + successful retry → 2 attempts, 1 call
- Scenario C: all attempts fail → `FAILED` attempts, no call
- Scenario D: timeout after start → `INDETERMINATE` + `TIMEOUT`
- Scenario E: stream that errors mid-way → `INDETERMINATE` with partial delivery
- Scenario F: voice/Gemini-TTS failure falls back to gTTS (the voice logger bug
  fix) → attempts reflect the failed Gemini attempt, gTTS fallback succeeds
- Scenario G: image identification, cache hits, tools, audio
- Contract tests: no prompt/response/API key/stack in attempts; no fabricated
  token counts; `requestedModel` never copied into `actualModel`; pre-provider
  local validation failures produce no attempt; field defaults

Full AI suite: `105 passed, 1 failed` — the single failure is the pre-existing
`tests/test_tools.py::TestTools::test_tool_definitions_exist` (`assert 8 >= 9`),
which is unrelated to this phase and intentionally left untouched.

## Tests — Core Server (`tests/ai-provider-attempts.test.ts`)

15 tests, all passing, using the existing `fakeDeps` / `recordAiUsageWith` seams:

1. `normalizeProviderAttempts` — order preserved; non-array → `undefined`; `[]` → `[]`
2. `normalizeProviderAttempts` — invalid elements dropped individually, valid kept
3. `computeAttemptRiskStatus` — `NONE` / `FAILED_ATTEMPT_PRESENT` / `INDETERMINATE` precedence
4. `attemptsIncludeRetry` — true only when `attemptNumber > 1`
5. `recordAiUsageWith` threads `providerAttempts` into the shadow ctx; observation
   stores normalized attempts + risk
6. Retry-then-success → `FAILED_ATTEMPT_PRESENT`, summary stays `FULLY_PRICED`,
   one provider call, `providerCallId` only on the succeeded attempt
7. `INDETERMINATE` → `INDETERMINATE_COST_RISK`, pricing semantics unchanged
8. Cache hit (`[]` / `[]`) → `ZERO_PROVIDER_CALLS` observation with `NONE`
9. Malformed attempts are default-safe and never throw
10. Attempts ride the pricing observation; skipped `providerCalls` record no
    observation
11. Metrics aggregate attempt totals across observations
12. Metrics aggregate retry/risk counters and dimension breakdowns
13. Metrics attempts output is JSON-safe (no bigint) and holds no sensitive content
14. Observation query rows expose `attemptRiskStatus` + attempt counters (JSON-safe)
15. Production `recordAiUsage` end-to-end: attempts reach the buffer, no DB write
    on empty userId, no Wallet, and every call site threads `providerAttempts`

Full Core suite: **1609 passed, 0 failed**. `npx tsc --noEmit` is clean. The
`package.json` has no `typecheck` script, so `npx tsc --noEmit` is the
typecheck gate for this report.

## Known pre-existing issue (not in scope)

`tests/test_tools.py::TestTools::test_tool_definitions_exist` in the AI Service
fails (`assert 8 >= 9`). It predates this phase, is unrelated to attempt
observability, and is intentionally left untouched.

## Final gate

- AI Service: `tests/test_attempts.py` 21/21 pass; full suite 105 pass + 1
  documented pre-existing failure
- Core Server: `tests/ai-provider-attempts.test.ts` 15/15 pass; full suite
  1609/1609 pass
- Core Server: `npx tsc --noEmit` clean
- No commits or pushes were made.

Status: `PHASE_2E_A2_READY`
