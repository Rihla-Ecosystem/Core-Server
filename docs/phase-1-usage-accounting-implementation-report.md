# Phase 1 — Provider-Neutral Per-Provider-Call Usage Accounting

**Status:** READY FOR REVIEW
**Date:** 2026-08-03
**Scope:** AI Service + Core Server (Phase 1 only — no durable billing activation, no Wallet pricing changes, no Prisma schema changes, no live provider calls).

---

## 1. Executive Summary

Phase 1 introduces a **provider-neutral per-provider-call usage contract** end to end:

- The **AI Service** now records one `ProviderCallUsage` record **per real provider call** (deterministic `providerCallId`, `call-N`) for chat, chat-stream, voice/audio-understanding + TTS, landmark identify, and itinerary. Gemini-native field names are isolated in a single extraction module.
- The legacy `usage`/`model` response fields are **preserved** as a backward-compatible aggregate derived from the distinct records and **never fabricate zeros**.
- The **Core Server** types the new `providerCalls` field, validates it defensively, and records **per-provider-call telemetry rows** in the existing `AiUsageLog` table (schema unchanged).

Wallet token billing, fixed pricing (`BUSINESS_TOKEN_PRICING_VERSION=1`), Prisma schema, and durable billing activation (`runAIBillingOrchestration` remains dormant) are **unchanged**. This is a telemetry/observability and contract layer only; the authoritative `providerCalls` array is now available for a future pricing engine to consume.

---

## 2. Repositories & Branch Snapshots

| Repo | Worktree path | Branch | HEAD |
|---|---|---|---|
| Core Server | `Core-Server-provider-model-pricing` | `feature/provider-model-pricing` | `d7af972eac3bcab049b2818567733c7fe5eca6b4` |
| AI Service | `ai-service-usage-accounting-phase1` | `feature/usage-accounting-phase1` | `3c758706c14a6dde255c31da0467c0b75f818e93` |

- Phase 1 modified only the two worktrees above. The originals (`Core-Server`, `ai-service`) were not touched.
- No commits, pushes, or merges were made. Changes remain uncommitted in the working tree.

---

## 3. Files Changed (Inventory)

### AI Service (`ai-service-usage-accounting-phase1`)

| File | Status | Purpose |
|---|---|---|
| `app/core/usage.py` | **new** | Provider-neutral contract: enums, `make_provider_call`, `UsageScope` (deterministic `call-N` ids), request-scope accumulator, `derive_legacy_usage`, `final_stream_usage`. Stdlib-only. |
| `app/core/gemini_usage.py` | **new** | Gemini-native token extraction (`extract_response_model`, `extract_token_counts`). Duck-typed `getattr`; provider-native field names stay here. |
| `app/core/llm_client.py` | modified | Records one provider-call entry per executed call; streaming records a single final snapshot; per-method default `operation`. |
| `app/api/chat.py` | modified | `ChatResponse` + `providerCalls`; legacy `usage` via `derive_legacy`. |
| `app/api/stream.py` | modified | Final SSE event includes `providerCalls` + derived usage/model. |
| `app/api/voice.py` | modified | `VoiceResponse` + `providerCalls`; consume happens after TTS so Gemini TTS is captured. |
| `app/api/identify.py` | modified | `IdentifyResponse` + `providerCalls`; cache-hit and cache-miss paths. |
| `app/api/itinerary.py` | modified | `ItineraryResponse` + `providerCalls`. |
| `tests/test_usage_contract.py` | **new** | Unit tests for `app.core.usage`. |
| `tests/test_gemini_usage.py` | **new** | Unit tests for `app.core.gemini_usage`. |
| `tests/test_llm_usage.py` | **new** | Client recording integration tests (stream single-final, per-call distinct ids, UNAVAILABLE). |

### Core Server (`Core-Server-provider-model-pricing`)

| File | Change | Purpose |
|---|---|---|
| `src/types/ai.ts` | modified | Added `ProviderCallUsage`, `RawProviderCall`, and optional `providerCalls` on `AIChatResponse`. |
| `src/utils/ai-usage.ts` | modified | Added `normalizeProviderCalls` (defensive per-call validation; never coerces to zero; rejects negatives). |
| `src/services/ai-usage.service.ts` | modified | `recordAiUsage` accepts `providerCalls` and writes one telemetry row per normalized provider call; legacy single-row path preserved as fallback. |
| `src/services/chat.service.ts` | modified | Passes `aiResponse.providerCalls` to `recordAiUsage`. |
| `src/services/chat-stream.service.ts` | modified | Type passthrough for streamed `providerCalls`. |
| `src/routes/chat-stream.routes.ts` | modified | Captures `providerCalls` from the final SSE event and forwards to `recordAiUsage`. |
| `src/services/voice.service.ts` | modified | Response type + forward `providerCalls`. |
| `src/services/identify.service.ts` | modified | Response type + forward `providerCalls` (only on cache miss, matching the existing usage guard). |
| `src/services/itinerary.service.ts` | modified | Response type + forward `providerCalls`. |
| `tests/ai-usage-contracts.test.ts` | modified | Added tests #39–#56 for `normalizeProviderCalls` and the new type. |

### Read-only inputs (not modified)
- `docs/ai-multimodal-pricing-audit.md`
- `references/ai-research/rihla-ai-integration-map.json`
- `references/ai-pricing/*` (6 files)

### Explicitly NOT changed
- `src/config/business-token-features.ts` (fixed prices unchanged)
- `config/ai-pricing.ts` / `ai-usage-pricing.ts` (pricing engine untouched)
- `prisma/schema.prisma` and all migrations
- `src/services/ai-billing-orchestrator.service.ts` (durable billing dormant)
- `package.json`, `package-lock.json`, `pyproject.toml`, `requirements.txt`, env files

---

## 4. The ProviderCallUsage Contract

The contract is intentionally **provider-neutral** (no Gemini-native field names leak into Core). Shape emitted by the AI Service:

```
ProviderCallUsage {
  provider: string            // "google"
  providerCallId: string      // deterministic "call-1", "call-2", ...
  providerCallMade: boolean   // always true (a real call executed)
  requestedModel?: string     // the model requested for this attempt
  actualModel?: string        // the model the provider reported in the response
  operation?: string          // TEXT_CHAT, TEXT_CHAT_STREAM, IMAGE_ANALYSIS, AUDIO_UNDERSTANDING, TEXT_TO_SPEECH, TEXT_GENERATION, ...
  providerRequestId?: string  // absent: not exposed by current Gemini SDK path (never fabricated)
  usageSource?: string        // PROVIDER_RESPONSE | STREAM_FINAL
  usageCompleteness?: string   // COMPLETE when counts present, else UNAVAILABLE
  accountingSemantics?: string
  inputTokens?, outputTokens?, totalTokens?
  cachedInputTokens?, reasoningTokens?, ...  // only when provider reported them
}
```

### Design rules enforced
- **Unknown = absent, never zero.** A field is only emitted when the provider reported a non-negative integer.
- **token** counts must be finite, non-negative integers; seconds must be finite, non-negative numbers. A present-but-invalid value rejects the whole array (no silent coercion).
- **Streaming** produces exactly one record per streamed call using the **last non-empty cumulative snapshot** (never a sum). Example real dataset `(input/output/total)`: `100/10/110 → 100/25/125 → 100/40/140` records `100/40/140`, never `300/75/375`. Verified by test.
- **`providerCallId`** = deterministic `call-N` assigned in append order by `UsageScope`; distinct per call even for the same model. Never derived from the model name.
- **`requestedModel` vs `actualModel`** kept separate; `actualModel` is never fabricated.
- **Legacy `usage`/`model`** aggregates per-call records: sums only fields that at least one call reported; `totalTokens` is never derived from `input+output`; returns `None` when no token data exists. This prevents misleading zeros in the backward-compatible payload.

---

## 5. Per-Feature Behavior

| Feature | Old behavior | New behavior |
|---|---|---|
| Chat (`/chat`) | One summed usage across all calls | One `ProviderCallUsage` per call (e.g., persona `generate` call-1, optional follow-up call-2, both distinct ids). `usage` = aggregate. |
| Chat stream (`/chat/stream`) | Summed cumulative per-chunk snapshots (double-counted) | Single record `STREAM_FINAL` from last non-empty snapshot, recorded once in `finally`. |
| Voice (`/voice`) | Only entry `[0]` reported | Consume after TTS so a Gemini TTS provider call is also captured; all calls returned. gTTS fallback emits nothing (local/non-metered). |
| Landmark identify (`/identify`) | Only entry `[0]` | Cache-hit returns cached record (no fabricated call); cache-miss records the single vision call. |
| Itinerary (`/itinerary`) | Summed entries | All provider calls recorded; aggregate derived. |
| Telemetry (Core) | One aggregate row | One `AiUsageLog` row per valid provider call (schema unchanged; see limitations). |

---

## 6. Telemetry & Billing Notes

- **Telemetry only.** `AiUsageLog` costs are computed with the existing `computeAiCost`. This table drives the admin usage summary and is **not** a user-facing Wallet charge.
- Wallet token charging/refunding (`AI_CHAT_QUERY`, `AI_IMAGE_ANALYSIS`, `AI_TRIP_ITINERARY`, `REAL_TIME_TRANSLATION`) is **unchanged**; `providerCalls` do not alter debits/refunds.
- **Schema limitation (documented, not a defect):** the current `AiUsageLog` has no `operation`/`providerCallId`/`provider` column, so a provider call's unique id is not persisted yet. Phase 1 records per-call token rows; persisting call identity requires a schema change (out of scope, listed in section 10).
- When `providerCalls` are present and valid, Core prefers per-call rows; otherwise it falls back to the legacy `usage` single row (backward compatible).

---

## 7. Streaming Example

Gemini streaming `usageMetadata` is cumulative every chunk. Phase 1 records a single `STREAM_FINAL` record:

```
chunks (cumulative) (input/output/total): 100/10/110, 100/25/125, 100/40/140
recorded:                                   input=100, output=40, total=140   (last non-empty snapshot)
sum path (removed):                          300/75/140   (wrong)
```

Covered by `tests/test_llm_usage.py::test_stream_records_final_snapshot_once`.

---

## 8. Validation & Test Results (executed)

### AI Service — `tests/` (66 tests total)
Command: `pytest tests -q` via venv pytest (9.1.1).

- **41 Phase 1 tests pass** (31 from initial implementation + 10 stream-failure tests):
  - `test_usage_contract.py` (18) — enums, scope ids, legacy derivation (no zero fabrication, no total derivation), final-snapshot reducer.
  - `test_gemini_usage.py` (9) — extraction incl. absent/zero semantics, modality breakdown non-additivity.
  - `test_llm_usage.py` (4) — client recording via monkeypatched models.
  - `test_stream_usage.py` (10) — consume called exactly once, partial failure after usage observed, failure before any usage, no duplicate provider calls, successful stream unchanged.
- **Existing suite baseline:** 65 passed / 1 failed.
  - The single failure `tests/test_tools.py::test_tool_definitions_exist` (asserts `len(TOOL_DEFINITIONS) >= 9`, actual 8) is **pre-existing and unrelated** to Phase 1 (`app/agent/tools.py` was not modified). Independently reproduced at commit `3c758706c14a6dde255c31da0467c0b75f818e93` on **both** the original `ai-service` worktree (`main`) and the Phase 1 worktree (`feature/usage-accounting-phase1`) with `pytest tests/test_tools.py -q` → `11 passed, 1 failed` (same test, same reason).

### Core — `tests/*.test.ts` (1345 tests)
Command: `node --env-file=.env.test --import tsx --test-concurrency=1 --test tests/*.test.ts`
- **1345 passed / 0 failed**, including the 18 new `normalizeProviderCalls` contract tests (#39–#56).

### Type checking & lint
- `Core`: `tsc --noEmit` — **clean, exit 0**. No lint tooling present in `package.json` (no ESLint script/config); TypeScript strict compile is the gate.
- `Core` files used the exact local `node_modules`; no installs run.
- `AI`: `ruff check` — findings on my changed files are pre-existing repo-wide categories (`UP0xx` modern-typing suggestions already present in untouched committed files) or the NTFS `mount` `EXE002` artifact present on every repo file (no shebang + `core.filemode=false` in git, ignored). `ruff format --check` on new files passes; existing files were already format-non-compliant at baseline and left to avoid unrelated churn.
- `Core`: `git diff --check` clean. `AI`: `git diff --check` clean.

---

## 9. Safety Confirmations

1. **Wallet pricing unchanged** — `src/config/business-token-features.ts` verified identical; fixed prices intact (`AI_CHAT_QUERY=1`, `AI_IMAGE_ANALYSIS=5`, `AI_TRIP_ITINERARY=10`, `REAL_TIME_TRANSLATION=3`).
2. **Wallet charging / billing flows untouched** — no edits to `business-token-consumption`, `tokenized-service-execution`, `ai-billing-orchestrator` durable paths, or `ai-billing-operation`.
3. **Durable billing stays dormant** — orchestrator module only touched for references; no new activation.
4. **No Prisma schema/migration changes** — `prisma/schema.prisma` untouched; `AiUsageLog` reused as-is.
5. **No fixed-price derivation changes** — `ai-pricing.ts`, `ai-usage-pricing.ts`, `ai-reservation-quote.ts` untouched.
6. **No live provider calls made** — all provider-facing code is tested with stubs/fakes; no network calls.
7. **No secrets committed** — env files untouched; no API key strings added.
8. **Provider neutrality respected at Core** — no Gemini-native field names in Core-modified files; extraction is isolated to `app/core/gemini_usage.py`.
9. **Unknown usage never reported as 0** — contract omits absent fields; legacy derivation drops fields not reported; verified by tests.
10. **No package-manager / dependency changes** — `package.json`, `package-lock.json`, `pyproject.toml`, `requirements.txt` untouched; installed deps used in place.
11. **No installs / env mutations run** — only test/typecheck/lint.
12. **Provider ids not fabricated** — `providerRequestId` stays absent; `actualModel` only from provider response; calls without usage recorded with `usageCompleteness=UNAVAILABLE`.

---

## 10. Unknowns / Out of Scope (Phase 2+)

- **Per-chunk cumulative streaming semantics** for TTS (`generate_speech`) not re-live-probed; relies on the same patterns documented in the existing baseline. Live probe (`references/ai-pricing/ai-live-probe-plan.md`) is the recommended next step.
- **Gemini request-id exposure**: the SDK path does not surface a request id; `providerRequestId` is left absent. If it becomes available, wire it — never fabricate.
- **TTS pricing fidelity**: gTTS fallback is local/non-metered and is not emitted as a provider call. Whether Gemini TTS carries its own pricing is a Phase 2 pricing-engine decision.
- **`AiUsageLog` identity columns** (provider, operation, providerCallId): requires a schema change, deliberately deferred; Phase 1 records per-call rows as `TELEMETRY_ONLY` aggregates without that identity.

---

## 11. Provenance (read-only inputs)

- `docs/ai-multimodal-pricing-audit.md`
- `references/ai-pricing/ai-live-probe-plan.md`
- `references/ai-pricing/ai-model-capabilities.json`
- `references/ai-pricing/ai-provider-model-pricing.json`
- `references/ai-pricing/ai-provider-response-contracts.json`
- `references/ai-pricing/ai-provider-usage-reference.json`
- `references/ai-research/rihla-ai-integration-map.json`

---

## 12. Inventory of Diff

### AI Service changed files (uncommitted working tree)
- `M app/api/chat.py`
- `M app/api/identify.py`
- `M app/api/itinerary.py`
- `M app/api/stream.py`
- `M app/api/voice.py`
- `M app/core/llm_client.py`
- `A app/core/gemini_usage.py`
- `A app/core/usage.py`
- `A tests/test_gemini_usage.py`
- `A tests/test_llm_usage.py`
- `A tests/test_usage_contract.py`

### Core Server changed files (uncommitted working tree)
- `M src/types/ai.ts`
- `M src/utils/ai-usage.ts`
- `M src/services/ai-usage.service.ts`
- `M src/services/chat.service.ts`
- `M src/services/chat-stream.service.ts`
- `M src/routes/chat-stream.routes.ts`
- `M src/services/voice.service.ts`
- `M src/services/identify.service.ts`
- `M src/services/itinerary.service.ts`
- `M tests/ai-usage-contracts.test.ts`

---

## 13. Final Verdict

Phase 1 delivered: the provider-neutral per-provider-call usage accounting contract is implemented and verified in both worktrees; all 41 new AI tests and 1345 Core tests pass; the AI suite passes (65/66) except one pre-existing unrelated `test_tools` assertion; `tsc` is clean. Stream failure paths are now covered — providerCalls are consumed and surfaced even on partial failures. No Wallet/pricing/Prisma/durable-billing behavior changed.

**Status: PHASE_1_READY_FOR_REVIEW**