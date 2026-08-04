# Rihla AI Multimodal Pricing Audit

> Repository-aware technical audit of the Rihla Core Server and the sibling `ai-service` repository, focused on provider/model pricing, usage accounting, token-wallet billing, and provider neutrality.

- **Audit date:** 2026-08-03
- **Auditor:** opencode (audit-only session, no production code changed)
- **Method:** static repository inspection (read-only) of both repositories plus the audited reference baselines under `references/ai-pricing/`. No provider API calls, no installs, no secrets read into output.
- **Evidence rules:** the repositories are the source of truth; `references/` files are research baselines only and are explicitly compared against the code. Every fact is tagged `REPOSITORY_OBSERVED`, `DOCUMENTED` (design docs/reference files), `INFERRED`, `UNKNOWN`, or `REQUIRES_LIVE_PROBE`.

---

## 1. Repository State & Commit Snapshots

| Repo | Path | HEAD commit | Branch | Working tree |
|------|------|-------------|--------|--------------|
| Core Server (audit subject) | `Core-Server-provider-model-pricing` | `d7af972eac3bcab049b2818567733c7fe5eca6b4` | `feature/provider-model-pricing` | clean except untracked `references/` |
| AI Service (read-only peer) | `ai-service` | `3c758706c14a6dde255c31da0467c0b75f818e93` | (default branch) | clean |

Audit outputs created by this session (the only changes to the Core worktree):

- `docs/ai-multimodal-pricing-audit.md` (this file)
- `references/ai-research/rihla-ai-integration-map.json`

---

## 2. Executive Summary

Rihla today is a **Google Gemini-only** stack end to end. The AI Service uses the `google-genai` SDK exclusively, rotates a list of Gemini API keys, and applies a single fallback chain: `gemini-3.6-flash` → `gemini-3.5-flash-lite` → `gemini-3-flash-preview` → `gemini-2.5-flash-lite`. OpenAI and Anthropic exist **only** in the research baselines (`references/ai-pricing/*.json`); nothing in either repository imports or calls them.

The Core Server has **two distinct billing layers**:

1. **Active fixed Wallet pricing** (`src/config/business-token-features.ts`) — feature-based debit of Wallet tokens (`AI_CHAT_QUERY:1`, `AI_IMAGE_ANALYSIS:5`, `AI_TRIP_ITINERARY:10`, `REAL_TIME_TRANSLATION:3`, etc.) via `business-token-consumption` (consume/reverse) and `tokenized-service-execution`. This layer is live on the `/chat`, `/chat/stream`, `/identify`, `/voice`, and `/itinerary` routes.
2. **Dormant usage-based durable billing** (`ai-billing-orchestrator.service.ts` + `ai-billing-operation` / `ai-billing-recovery` + repositories + Prisma models) — a complete quoting → reserve → execute → price → settle/release library. `runAIBillingOrchestration` is imported **only by test files** (`tests/ai-billing-orchestrator*.test.ts`); no live route, controller, or service calls it. It is a test-only/shadow path today.

Usage telemetry (`recordAiUsage` → `prisma.aiUsageLog`) is recorded for every live AI feature but is **telemetry only** (admin `GET /admin/ai-usage`); its cost column is computed by the Gemini-specific `computeAiCost`, whose hardcoded fallback prices are **stale relative to the reference baseline** (e.g. Core `gemini-3.6-flash` $0.30/$2.50 per M vs. baseline $1.50/$7.50 per M).

Key findings that block a clean implementation review:

- **Provider coupling inside generic code**: `src/config/ai-pricing.ts:16-51` keys prices by Gemini model strings and matches on substrings `"lite"`/`"flash"`.
- **Stream usage double-count risk**: the AI Service records cumulative `usageMetadata` on **every** stream chunk (`_record_usage` in `llm_client.py:139-144`), then Core/AI Service sums all chunk entries (`stream.py:78-87`). If Gemini emits cumulative usage per chunk (per the usage baseline), each chunk's running total is summed → over-count. `REQUIRES_LIVE_PROBE`.
- **Voice usage under-count**: `voice.py:195` reports only `usage_entries[0]` (the audio-understanding call). The TTS call (`gemini-3.1-flash-tts-preview`, hardcoded at `llm_client.py:363`) records usage that is discarded; TTS cost is never captured, and that model has **no price in the baseline**.
- **Chat multi-call merging**: persona turns can issue 1–2 Gemini calls per turn (tool-call then follow-up). `_sum_usage` merges usage across calls but attributes the merged totals to **the first entry's model** (`chat.py:79-80`, `llm_client` `_extract_usage` uses `response.model`). Fallback mid-turn would mis-price.
- **No provider request ID surfaced**: Gemini responses do not expose a request id through the current code path; `providerRequestId` in the durable contract is never populated → `UNKNOWN`.
- **TTS model unpriced**: `gemini-3.1-flash-tts-preview` is absent from both the pricing and usage baselines.

---

## 3. Scope, Method, and Evidence Rules

- **In scope:** Core Server pricing config, Wallet token billing, usage telemetry, reservation/quote math, durable billing library, execution contracts, all five live AI feature routes/services; AI Service SDK integration, key rotation, fallback model chain, usage extraction/accumulation, and the four feature endpoints (chat, chat-stream, identify, voice) plus itinerary.
- **Out of scope (audit-only):** no production code changes; no live probe; no install; no reads of secret values.
- **Evidence tags:** `REPOSITORY_OBSERVED` = verified by reading code at the pinned commits; `DOCUMENTED` = from `ARCHITECTURE.md`/`SPECS.md`/`references/*.json`; `INFERRED` = derived from adjacent evidence; `UNKNOWN` = cannot be determined statically; `REQUIRES_LIVE_PROBE` = resolvable only with a real provider call.
- **Baselines:** `references/ai-pricing/ai-provider-model-pricing.json`, `ai-provider-usage-reference.json`, `ai-model-capabilities.json`, `ai-provider-response-contracts.json`, `ai-model-research.md`, `ai-live-probe-plan.md`. Note: these live under `references/ai-pricing/`; `references/ai-research/` is created by this audit for output 2.

---

## 4. Architecture Overview

```
Core Server (Express, src/)                          AI Service (FastAPI, app/)
-----------------------------                        --------------------------
/tokens, /token-packages  Wallet fixed billing       /chat        <- Core /chat, /chat/stream
/token-reservation        reservations (15 min TTL)   /chat/stream
/chat, /chat/stream       live routes, fixed debit    /identify    <- Core /identify (multipart)
/identify, /voice, /itinerary                         /voice       <- Core /voice (multipart) + /voice/audio proxy
  |                                                    /itinerary   <- Core /itinerary
  v                                                    |
ai-usage.service (recordAiUsage -> aiUsageLog)         llm_client.py (google.genai only)
ai-billing-* (dormant durable library, tests only)     agents/* (supervisor routing, tool calls)
                                                       rag/retriever.py (Jina embeddings, non-Gemini)
```

- Core talks to the AI Service via HTTP `AI_SERVICE_URL` (default `http://ai-service:3003`, `src/config/env.ts`), guarded by `INTERNAL_API_KEY`.
- The AI Service talks to **Google Gemini only** through `google.genai`. TTS speech synthesis uses the `gTTS` library (Google Translate TTS, a non-API helper), and RAG embeddings use **Jina** (`jina-embeddings-v4`) — both non-Gemini and not priced in this audit's Gemini baseline.

---

## 5. Current AI Feature Inventory & Classification

| Feature | Core route (file) | AI Service endpoint | AI call type | Wallet debit (active) | Usage telemetry | Classification |
|---|---|---|---|---|---|---|
| Chat (text) | `POST /chat` (`src/routes/chat.routes.ts`) | `/chat` | Gemini text (1–2 calls/turn via persona) | `AI_CHAT_QUERY` = 1 token | yes (`chat.service.ts:133`) | ACTIVE |
| Chat stream | `POST /chat/stream` (`src/routes/chat-stream.routes.ts`) | `/chat/stream` | Gemini streamed text | `AI_CHAT_QUERY` (begin/refund) | yes (`chat-stream.routes.ts:126`) | ACTIVE |
| Landmark identification | `POST /identify` (`src/routes/identify.routes.ts`) | `/identify` | Gemini vision (multipart image) | `AI_IMAGE_ANALYSIS` = 5 | yes (`identify.service.ts:57`) | ACTIVE |
| Voice (audio understanding + TTS) | `POST /voice`, `GET /voice/audio` (`src/routes/voice.routes.ts`) | `/voice`, `/voice/audio?token=` | Gemini audio-in + gTTS out | `REAL_TIME_TRANSLATION` = 3 | yes (`voice.service.ts:55`) | ACTIVE |
| Itinerary generation | `POST /itinerary` (`src/routes/itinerary.routes.ts`) | `/itinerary` | Gemini text + tool `_recommend_itinerary` | `AI_TRIP_ITINERARY` = 10 | yes (`itinerary.service.ts:102`) | ACTIVE |
| Durable usage billing | (no live route) | n/a (wraps `/v1/execute/chat` executor) | n/a | none | none | DORMANT (test-only) |

All live features use **fixed Wallet prices**; none debit usage-based prices. Usage telemetry is recorded on all live features.

---

## 6. Provider Integration (AI Service)

`REPOSITORY_OBSERVED` (ai-service `3c75870`):

- **SDK:** `from google import genai` only (`app/core/llm_client.py`). No OpenAI/Anthropic SDK anywhere in `requirements.txt` or source.
- **Default model:** `gemini_model = "gemini-3.6-flash"` (`app/config.py`).
- **Fallback chain:** `GEMINI_MODEL_FALLBACKS = ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash-lite"]` (`llm_client.py:98` region).
- **Key rotation:** API keys parsed from `gemini_api_keys` → `gemini_key_list`; per-key state `ACTIVE`/`DEGRADED`/`COOLDOWN`; cooldown 60 s; request timeout 120 s.
- **Usage accumulation:** contextvar accumulator with `begin_usage_tracking()` / `consume_usage()`; `_record_usage` appends an entry per response (and per stream chunk); `_extract_usage` reads `response.model` as the actual model, plus `inputTokens`/`outputTokens`/`totalTokens` (`llm_client.py:111-135`).
- **Calls:** `generate`, `generate_with_tools`, `stream` (+ `_stream_to_async`), `generate_with_audio` (voice), `generate_speech` (TTS, model hardcoded `gemini-3.1-flash-tts-preview` at `llm_client.py:363`).

---

## 7. Model Inventory & Classifications

| Model | Where defined | Status (baseline) | Classification |
|---|---|---|---|
| `gemini-3.6-flash` | default `gemini_model` (AI Service) | STABLE | **ACTIVE** (primary) |
| `gemini-3.5-flash-lite` | fallback[1] (AI Service) | STABLE | **FALLBACK_CONFIGURED** |
| `gemini-3-flash-preview` | fallback[2] (AI Service) | PREVIEW | **FALLBACK_CONFIGURED** |
| `gemini-2.5-flash-lite` | fallback[3] (AI Service) | STABLE | **FALLBACK_CONFIGURED** |
| `gemini-3.1-flash-tts-preview` | hardcoded in `generate_speech` (AI Service) | absent from baselines | **ACTIVE** for TTS / pricing **UNKNOWN** (REQUIRES_LIVE_PROBE) |
| `claude-*` (`claude-opus-5`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`) | baseline only | STABLE/LIMITED | **REFERENCE_ONLY** (not integrated) |
| `gpt-*`/OpenAI | baseline only | (n/a) | **REFERENCE_ONLY** (not integrated; 0 models in capabilities baseline) |
| `jina-embeddings-v4` | AI Service RAG (`app/rag/retriever.py`) | not in Rihla pricing baseline | **REFERENCE_ONLY** / background (used for RAG ingest; not a user-facing billable feature currently priced in Core) |
| `gemini-2.5-flash-image` etc. | baseline only | PREVIEW | **FUTURE_CANDIDATE** (no image-generation feature wired) |

No `UNSUPPORTED` entries: every model in the repos has a classification above.

---

## 8. Per-Feature Data Flow & Billing Touchpoints

### 8.1 Chat (text)
- Core `POST /chat` → `chat.service.ts` → `executeWithBusinessTokenCharge` (feature `AI_CHAT_QUERY`, 1 token) → HTTP to AI Service `/chat` → supervisor `detect_intent` routes to `tour_guide`/`safety_guru`/`local_expert`; persona `generate_with_tools` and, if tool results arrive, a second `generate` call → `_sum_usage(usage_entries)` → response `usage` + `model` → Core `recordAiUsage` (`chat.service.ts:133`).
- Billing: **fixed** 1 token. Telemetry: `aiUsageLog` row.

### 8.2 Chat stream
- Core `POST /chat/stream` → `chat-stream.service.ts` begin charge (refund on error) → AI Service `/chat/stream` (SSE) → Core streams chunks and records usage from the final summary event (`chat-stream.routes.ts:126`).
- Billing: **fixed** 1 token. Telemetry: one `aiUsageLog` row per stream.

### 8.3 Identify (vision)
- Core `POST /identify` (multer 5 MB; JPEG/PNG signature checks) → `identify.service.ts` → AI Service `/identify` (multipart) → in-memory **MD5 cache**; cache hit returns `cached=True` with **no provider call and no usage** (`identify.py:46-48`); miss calls Gemini and records usage `usage_entries[0]`.
- Billing: **fixed** 5 tokens (`AI_IMAGE_ANALYSIS`). Telemetry: row only on cache miss.

### 8.4 Voice (audio + TTS)
- Core `POST /voice` (multer, WAV/MP3/OGG/WEBM/MP4) → `voice.service.ts` → AI Service `/voice` → `generate_with_audio` (Gemini audio understanding) + `generate_speech` (gTTS; model `gemini-3.1-flash-tts-preview` hardcoded) → Core `recordAiUsage` (`voice.service.ts:55`) + `consume`/`reverse`.
- Audio served via Core `GET /voice/audio` proxying AI Service `/voice/audio?token=` (audio cache).
- Billing: **fixed** 3 tokens (`REAL_TIME_TRANSLATION`). Telemetry: `voice.py:195` reports only `usage_entries[0]` (audio-understanding); the TTS usage entry is **discarded**.

### 8.5 Itinerary
- Core `POST /itinerary` → `itinerary.service.ts` (`recordAiUsage` at line 102, `consume`/`reverse`) → AI Service `/itinerary` using tool `_recommend_itinerary`.
- Billing: **fixed** 10 tokens (`AI_TRIP_ITINERARY`). Telemetry: row.

### 8.6 Durable usage-based billing (dormant)
- `runAIBillingOrchestration` (quote → reserve → execute → price → settle/release) exists with full Prisma backing (`AIBillingOperation`, `AIBillingRecovery`, token reservation). Imported **only** by `tests/ai-billing-orchestrator.test.ts` and `tests/ai-billing-orchestrator-durable.test.ts`. `tests/ai-service-chat-executor.test.ts:682` even asserts the executor source excludes `runAIBillingOrchestration`. `src/routes/internal.routes.ts` exposes no execute endpoint. No live route debits both fixed and usage-based prices.

---

## 9. Usage Accounting & Anti-Double-Counting Analysis

| Call type | Reported usage path | Risk |
|---|---|---|
| Chat (non-stream) | `_sum_usage` over all entries; model = first entry's `response.model` | Summing across 1–2 distinct calls is correct for distinct provider calls; **but** merged totals are attributed to one model — mis-price on mid-turn fallback. |
| Chat stream | `stream.py:78-87` sums `inputTokens`/`outputTokens`/`totalTokens` over **all chunk entries** | **Double-count risk**: Gemini `usageMetadata` is cumulative (`EVERY_EVENT_CUMULATIVE` per usage baseline); per-chunk `_record_usage` appends each chunk's running total. `REQUIRES_LIVE_PROBE` to confirm whether every chunk carries usageMetadata. |
| Identify | cache hit → no usage; miss → `usage_entries[0]` | Correct (single call, single model). Cache-hit rows must never fabricate cost — current behavior does not. |
| Voice | `voice.py:195` `usage_entries[0]` only | **Under-count**: the TTS call's usage entry is discarded. TTS pricing unit and rates `UNKNOWN`. |
| Image input (Gemini) | tokens folded into aggregate `promptTokenCount` AND broken out by modality (`promptTokensDetails[]`) | Anti-double-count rule: price the **aggregate input** only; never add aggregate + `imageInputTokens`. Baseline confirms non-additive. |
| Reasoning/thoughts | `thoughtsTokenCount` folded into `totalTokenCount`; not separately priced | If priced, price aggregate only. |

---

## 10. Pricing & Cost Calculation

- **Active (Wallet):** fixed feature prices in `src/config/business-token-features.ts` (`BUSINESS_TOKEN_FEATURE_COSTS`). **Keep unchanged.** `BUSINESS_TOKEN_PRICING_VERSION = 1`.
- **Telemetry cost (`computeAiCost`, `src/config/ai-pricing.ts`):** `input/1M * input$ + output/1M * output$`. Provider-specific hardcoded fallback prices **differ from the reference baseline**:

| Model | Core fallback ($/M in/out) | Baseline ($/M in/out) | Delta |
|---|---|---|---|
| `gemini-3.6-flash` | 0.30 / 2.50 | 1.50 / 7.50 | Core understates |
| `gemini-3.5-flash-lite` | 0.10 / 0.40 | 0.30 / 2.50 | Core understates |
| `gemini-3-flash-preview` | 0.30 / 2.50 | 0.50 / 3.00 | Core understates |
| `gemini-2.5-flash-lite` | 0.10 / 0.40 | 0.10 / 0.40 | matches |

- Baseline also defines **batch/priority/cache** tiers (e.g. `gemini-3.6-flash` batch 0.75/3.75/0.075, priority 2.7/13.5/0.27, context-cache storage 1.0 per M·hr) and grounding notes (5,000 free search requests/month then $14/1k). None of these are represented in Core config today.

---

## 11. Reservation / Quote Math

- `src/utils/ai-reservation-quote.ts` computes a **max** quote from `calculateAIUsagePrice` + limits; pure function, tested (`tests/ai-reservation-quote.test.ts`).
- Limits from `src/config/chat-limits.ts` (`CHAT_LIMITS_DEFAULTS`): `maxInputTokens:12000`, `maxCurrentMessageTokens:3000`, `maxMessageCharacters:10000`, `maxRecentMessages:10`, `historyTokenBudget:5500`, `summaryTokenBudget:1000`, `maxOutputTokens:1200`, `inputHeadroomTokens:2500`; env-overridable (`CHAT_MAX_INPUT_TOKENS`, etc.).
- Token reservation service: 15-minute TTL, reserve/settle/release (`src/services/token-reservation.service.ts`).
- Quote math is dormant-path only (no live caller); it correctly uses pure integer-based pricing utils.

---

## 12. Token Wallet & Fixed Pricing (unchanged)

- `BUSINESS_TOKEN_FEATURE_COSTS`: `AI_TRIP_ITINERARY:10`, `AI_CHAT_QUERY:1`, `AI_IMAGE_ANALYSIS:5`, `REAL_TIME_TRANSLATION:3`, `PERSONALIZED_RECOMMENDATIONS:5`, `OFFLINE_MAP_DOWNLOAD:8`, `SMART_BUDGET_PLANNER:6`, `LOCAL_AUDIO_GUIDE:12`, `BOOKING_PRICE_COMPARISON:4`.
- `MAX_TOKEN_BALANCE = 2_147_483_647`.
- Signup grant: `SIGNUP_TOKEN_GRANT` default 20 (`src/config/env.ts:59`, `src/services/auth.service.ts:58-69`).
- Debit paths: `business-token-consumption.service.ts` (consume/reverse), `tokenized-service-execution.service.ts` (fixed-charge wrapper), `token-package.routes.ts`/admin packages. **No changes proposed to this layer.**

---

## 13. Provider-Neutrality & Architecture Violations

1. **Gemini model strings in generic pricing config** — `src/config/ai-pricing.ts:16-51` (violates "generic pricing never parses provider-native fields").
2. **Substring heuristics** `"lite"`/`"flash"` for price matching (`ai-pricing.ts:48-49`).
3. **Hardcoded TTS model** `gemini-3.1-flash-tts-preview` in `llm_client.py:363` (provider-specific constant inside client layer).
4. **Provider SDK reach extends to chat/voice orchestration** (`llm_client.py`) — no adapter boundary; OpenAI/Anthropic would require refactor.
5. **Usage contract lacks modality, actual-vs-requested model split, and per-call multiplicity** (`AIProviderUsage` in `src/types/ai.ts` carries only tokens/audioSeconds).
6. **Request ID not captured** — `providerRequestId` never populated; `UNKNOWN`.

---

## 14. Rate Card Contract Proposal (dormant path target)

Proposed generic rate-card record (already partially present in `src/types/ai-pricing.ts` as `AIProviderTokenRate`):

```
provider/model/status/tier (standard|batch|priority|cache_storage)/
input/output/cachedInput rates in integer micros per 1M tokens/
perUnit for non-token units (perImage, perAudioSecond, perCharacter)/
effectiveFrom, source, verification tag
```

Rules: integer micros only (no floats); token pricing priced on **aggregate** counts; per-image/per-audio units kept separate from token rates; unknown models fail closed to fixed cost (as today in `ai-usage-pricing.ts`).

---

## 15. Usage Contract Proposal

Canonical usage payload consumed by the dormant durable path (`src/types/ai-execution.ts`, `ai-service-execution.ts` schemaVersion 1):

- `provider`, `requestedModel`, `actualModel`, `providerRequestId` (nullable), `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, `reasoningTokens`, optional modality breakdown `{text,image,audio,video,document}` (non-additive), optional `perUnit` usage (generated images count, audio seconds, characters).
- Streaming: emit usage once from the final cumulative chunk; never sum per-chunk entries.
- Cache hits (`identify`): emit `cached=true`, zero usage, zero cost.

---

## 16. Adapter Boundary Specification

- Provider SDK calls must live only in provider-specific adapters (e.g. `googleGeminiAdapter`), returning the canonical contract above.
- Core generic code (pricing, quoting, orchestration, recovery, reservations, `aiUsageLog`) must consume only canonical usage + rate cards; never provider-native fields.
- The AI Service `/chat`, `/chat/stream`, `/identify`, `/voice`, `/itinerary` endpoints already emit a near-canonical usage object; changes required: (a) report actual + requested model separately, (b) emit TTS/audio usage explicitly, (c) fix stream summation to last-chunk semantics, (d) optionally surface request id when the SDK exposes it.

---

## 17. Baseline Reconciliation

- **Pricing baseline** (`ai-provider-model-pricing.json`, generated 2026-08-03, USD micros per 1M tokens): contains all four Rihla Gemini models; Core telemetry fallback prices match only `gemini-2.5-flash-lite`. TTS model absent.
- **Usage baseline** (`ai-provider-usage-reference.json`): `gemini-3.6-flash` `usageReporting` maps `promptTokenCount→inputTokens`, `candidatesTokenCount→outputTokens`, `totalTokenCount→totalTokens`, `thoughtsTokenCount→reasoningTokens`, `cachedContentTokenCount→cachedInputTokens`; image input folded into aggregate + non-additive modality breakdown; streaming `usageMetadata` cumulative. Matches AI Service `_extract_usage` field naming.
- **Capabilities baseline** (`ai-model-capabilities.json`): only `anthropic` models populated (4); `openai` and `google_gemini` empty — Rihla Gemini entries must be added.
- **Response-contracts baseline** (`ai-provider-response-contracts.json`): anthropic/openai/gemini shapes; gemini streaming usage location confirmed cumulative; provider request-id fields `UNKNOWN` for anthropic header, gemini not exposed via current SDK path.
- **Research doc / probe plan:** consistent with findings; live-probe plan remains the correct next validation step (this audit performed none).

---

## 18. Known Gaps, Risks, and Unknowns

1. `REQUIRES_LIVE_PROBE` — whether every streamed chunk carries cumulative `usageMetadata` (double-count gate).
2. `UNKNOWN` — TTS (`gemini-3.1-flash-tts-preview`) price unit/rate; also whether gTTS output is a billable provider call (gTTS is a free helper service, not an API).
3. `UNKNOWN` — provider request id for Gemini through `google.genai`; OpenTelemetry/langfuse may be the source instead.
4. Dormant durable path has no live caller — safe to evolve without touching active Wallet billing.
5. Core telemetry cost column is stale vs. baseline (cosmetic today; would become financial if `aiUsageLog` is ever used for billing).
6. `identify` in-memory cache is not persistent; behavior (cached flag, zero usage) is already correct for pricing.

---

## 19. Test Coverage Inventory

Relevant test files (all present under `tests/`): `ai-billing-orchestrator.test.ts`, `ai-billing-orchestrator-durable.test.ts`, `ai-billing-operation.test.ts`, `ai-billing-recovery.test.ts`, `ai-execution-contract.test.ts`, `ai-reservation-quote.test.ts`, `ai-service-chat-executor.test.ts`, `ai-service-execution-client.test.ts`, `ai-usage-contracts.test.ts`, `ai-usage-pricing.test.ts`, `business-token-consumption.test.ts`, `business-token-features.test.ts`, `chat-limits.test.ts`, `chat-token.test.ts`, `identify-token.test.ts`, `identify-validation.test.ts`, `signup-grant.test.ts`, `token-reservation.test.ts`, `token-summary.test.ts`, `token-transactions.test.ts`, `token-wallet.test.ts`. The orchestrator tests exercise settle/release/recovery extensively with in-memory deps.

---

## 20. Phased Implementation Plan

- **Phase 1 — Fix accounting correctness (no billing change):** stream usage last-chunk-only semantics; voice reports both audio-understanding and TTS usage explicitly; chat reports per-call usage or a `perCall:[]` array with per-call model attribution.
- **Phase 2 — Rate card + usage contract hardening:** materialize provider-neutral rate cards from the baseline (integer micros, tiers); extend canonical usage contract with modality + actual/requested model + request id slot; populate capabilities baseline for google_gemini.
- **Phase 3 — Adapter boundary extraction:** introduce `googleGeminiAdapter` (and stub adapters for openai/anthropic) behind the canonical contract; move `computeAiCost` fallback logic out of generic config; keep Wallet fixed pricing untouched.
- **Phase 4 — Activate durable usage billing (optional, gated):** wire `runAIBillingOrchestration` behind a feature flag on the five routes; reconcile telemetry cost with the rate card; run the live probe plan; then flip to usage-based pricing only after acceptance.

---

## 21. Acceptance Criteria

- All five live features still debit the **unchanged fixed Wallet prices**; no regression in `token-wallet`/`business-token-*` tests.
- Stream usage reported exactly once from the final cumulative chunk; no double-count.
- Voice reports audio-understanding + TTS usage explicitly; TTS rate resolvable (or explicitly `UNKNOWN` pending probe).
- Generic Core pricing never contains provider model strings or substrings.
- All pricing arithmetic uses integer micros / BigInt; no floating-point money.
- Reference baselines and the integration map stay consistent (schemaVersion, enums, null-for-unknown).
- Durable path activation (if any) is feature-flagged and covered by the existing orchestrator tests.

---

## 22. Readiness Verdict

NOT_READY_FOR_RIHLA_AI_PRICING_IMPLEMENTATION_REVIEW
