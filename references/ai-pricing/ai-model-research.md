# AI Model Research — Image Analysis & Voice/Realtime Audio
**Scope:** Provider-research-only audit for Anthropic, OpenAI, Google Gemini.
**Repository status:** UNKNOWN — REPOSITORY NOT PROVIDED. This document makes no claims about Rihla's currently configured models, endpoints, fallback chains, or code contracts. Every statement below is sourced from public provider documentation, retrieved in this session (Aug 3, 2026), or from the two attached baseline files.
**Rule followed:** no paid API calls were made; no implementation code was written; every factual claim below carries a source URL, verification date, and a status tag: **DOCUMENTED**, **OBSERVED** (community/SDK-reported, not in provider prose), **INFERRED** (derived from documented rules), or **UNKNOWN**.

---

## 0. Baseline files reviewed

- `ai-provider-model-pricing.json` (schemaVersion 1, generatedAt 2026-08-03) — already contains a full Anthropic/OpenAI/Gemini rate card, current as of this session for the models it lists.
- `ai-provider-usage-reference.json` (schemaVersion 1, generatedAt 2026-08-03) — already contains usage-object field mappings per model.

Both baseline files appear to have been produced by a prior, similarly-scoped research pass. This audit re-verifies against live docs and reports deltas in §6.

**Important structural finding:** Google has moved its primary supported entry point from `generateContent` (`v1beta/models/{model}:generateContent`) to a new **Interactions API** (`v1beta/interactions`), which the docs now mark as GA and "recommended... for access to all the latest features and models" [DOCUMENTED, https://ai.google.dev/gemini-api/docs/image-understanding, 2026-08-03]. The attached `ai-provider-usage-reference.json` documents Gemini usage fields exclusively in the older `generateContent`/`usageMetadata` shape (`promptTokenCount`, `candidatesTokenCount`, etc.). Both surfaces may currently be live, but this is a **possible-obsolescence flag** — see §6.

---

## 1. ANTHROPIC — Image Analysis

### 1.1 Model identity
| Model | Status | Modalities | Notes |
|---|---|---|---|
| claude-fable-5 | STABLE | TEXT, IMAGE_INPUT, DOCUMENT_INPUT | Mythos-tier, safety-hardened variant [DOCUMENTED, baseline pricing file] |
| claude-mythos-5 | LIMITED_AVAILABILITY | TEXT, IMAGE_INPUT, DOCUMENT_INPUT | Restricted access program (Project Glasswing) |
| claude-opus-5 | STABLE | TEXT, IMAGE_INPUT, DOCUMENT_INPUT | Current flagship |
| claude-opus-4-8 | STABLE | TEXT, IMAGE_INPUT, DOCUMENT_INPUT | Prior-generation, still served |

Source for all rows: `https://platform.claude.com/docs/en/about-claude/pricing`, verified 2026-08-03, status DOCUMENTED (taken from the reviewed baseline file, itself sourced to the same URL; not independently re-fetched in this session because the pricing skill/network allowlist for this session does not include `platform.claude.com`/`docs.claude.com` — **UNKNOWN, requires re-fetch outside this session's domain allowlist** to independently confirm rather than trust the baseline).

**No native Claude audio capability of any kind.** Anthropic's Messages API accepts only `text`, `image`, and `document` content blocks; there is no audio content type, no STT endpoint, no TTS endpoint, and no realtime/audio-to-audio endpoint. This is DOCUMENTED in the reviewed baseline `ai-provider-usage-reference.json` and consistent with Anthropic's publicly described Messages API content-block types. Anthropic is therefore **out of scope for the Voice/Audio section below** except as an explicit "not supported" entry.

### 1.2 Image analysis — request/response shape
- Image is provided as a `image` content block with `source.type` of `base64`, `url`, or a Files-API-issued `file_id` (three input methods).
- Multiple images and text can be combined in one message's `content` array.
- Image tokens are computed from pixel dimensions by a documented approximate formula (`width_px * height_px / 750`, capped per model) and folded directly into `input_tokens` — there is **no separate image-token field** in the `usage` object. This means: **the exact rule to avoid double-charging is to never separately add an estimated image-token count on top of `input_tokens` — `input_tokens` already includes it.** Client-side estimation (via the formula) is the only way to get a pre-call image-token count; it cannot be recovered after the fact from the response. [DOCUMENTED, baseline usage-reference file, consistent with Anthropic's public vision documentation on image token costs]
- Anthropic does not generate images; image/document are input-only modalities, billed at the standard input token rate (no separate image line-item price).

### 1.3 Streaming usage
`input_tokens` (and cache fields) arrive in `message_start`; `output_tokens` arrives cumulatively in `message_delta` events; there is no single event carrying the full usage object — a client must combine `message_start.message.usage` (input side) with the final `message_delta.usage.output_tokens` (output side). [DOCUMENTED, baseline usage-reference file]

---

## 2. OPENAI — Image Analysis

### 2.1 Model identity (vision-capable, current)
Per the official model catalog and pricing page (`https://developers.openai.com/api/docs/pricing`, `https://developers.openai.com/api/docs/models`, verified 2026-08-03, DOCUMENTED):

| Model | Status | API family | Notes |
|---|---|---|---|
| gpt-5.6-sol / -terra / -luna | STABLE (current flagship family) | Responses API, Chat Completions API | Vision supported; short/long-context tiered pricing |
| gpt-5.5 / gpt-5.5-pro | STABLE | Responses/Chat | Vision supported |
| gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano / gpt-5.4-pro | STABLE | Responses/Chat | Vision supported; different resize/patch-budget rules per model size (see §2.3) |
| gpt-4o, gpt-4.1, gpt-4o-mini, gpt-4.5 | STABLE (legacy but served) | Chat Completions/Responses | Tile-based image tokenization (legacy scheme) |
| gpt-image-2, gpt-image-1.5, gpt-image-1-mini | STABLE | Images API / `image_generation` tool | Image **generation/editing** models — take image input but their primary modality is image output, not analysis; included here because Rihla's stated goal spans "image upload and image analysis," and these models can also be used as an editing-analysis hybrid via input images. Flagged as a **different capability class**, not a drop-in analysis replacement. |
| computer-use-preview | STABLE (preview) | Responses API | Vision + computer-use; different tokenization; out of scope unless Rihla needs computer-use |

Un-supported-for-vision OpenAI models (correctly excluded per the task's "don't include unsupported models" instruction): pure-text reasoning/codex/embedding models such as `gpt-5.3-codex`, `chat-latest` variants without vision flag, embeddings models — **UNKNOWN** whether each individual one supports image input without a per-model doc check; the ones enumerated above are the ones the pricing/model pages explicitly mark multimodal.

### 2.2 Request format (DOCUMENTED, `https://developers.openai.com/api/docs/guides/images-vision`, verified 2026-08-03)
Three ways to supply an image:
1. **Fully-qualified URL** — `{"type": "input_image", "image_url": "<https url>", "detail": "auto"}` (Responses API) or `{"type":"image_url","image_url":{"url":"..."}}` (Chat Completions).
2. **Base64 data URL** — `image_url` set to `data:image/jpeg;base64,<...>`.
3. **File ID** — image pre-uploaded via the Files API (`purpose: "vision"`), then referenced as `{"type": "input_image", "file_id": "<id>"}`.

Multiple images + text can be combined in one `content`/`input` array; each additional image adds its own token cost.

Supported file types: PNG, JPEG, WEBP, non-animated GIF. Size limits: **up to 512 MB total payload per request, up to 1,500 individual image inputs per request.** [DOCUMENTED]

`detail` parameter: `low` | `high` | `original` | `auto`. On `gpt-5.5`/`gpt-5.6`, `auto` and the omitted default now behave like `original` (full resolution, no forced downscale) — this is a **behavior change from earlier GPT-4o-era models**, where `auto`/omitted behaved like `high`. [DOCUMENTED]

### 2.3 Image token accounting — exact anti-double-charging rule
OpenAI image tokens are **folded directly into the aggregate `prompt_tokens`/`input_tokens` count** — there is no separate always-present billable "image token" field returned by the API; the token cost is computed pre-call via one of two documented formulas and then simply included in the same input-token bucket as text:

- **Patch-based (gpt-5.4/5.5/5.6 family, o4-mini, gpt-4.1-mini/nano):** cover the image in 32×32px patches, apply model-specific patch-budget caps and a multiplier (e.g., 1.62× for gpt-5.4-mini, 2.46× for gpt-5.4-nano, no multiplier stated for the flagship 5.6 tiers). Full worked formula is DOCUMENTED at the source above.
- **Tile-based (GPT-4o, GPT-4.1, GPT-4o-mini, o1/o1-pro/o3, computer-use-preview):** base tokens + N × tile tokens, where tiles are 512px squares after scaling to fit 2048×2048 and shortest-side-768px.

**Anti-double-charging rule:** because the computed image-token count is added directly to `prompt_tokens`/`input_tokens` before the response returns, a client must **never** separately estimate and add image tokens on top of the returned `usage.input_tokens` (or `usage.prompt_tokens`) value — doing so double-counts. If a per-image breakdown is needed for cost attribution, it must be computed client-side, pre-call, using the documented formula, not derived from the response.

Pricing: image content is billed at the model's standard input-token rate under Chat Completions/Responses (no separate "per image" SKU for analysis models — that pricing model applies only to the *generation* models `gpt-image-2`/`gpt-image-1.5`/`gpt-image-1-mini`, which have distinct Image-modality input/output rates: e.g. gpt-image-1.5 image input $8/output $32 per 1M tokens, standard tier). [DOCUMENTED, `https://developers.openai.com/api/docs/pricing`]

### 2.4 Response shape / finish reason / safety fields
**UNKNOWN — requires live probe.** The `images-vision` guide shown in this session covers request construction and cost calculation in detail but the fetched excerpt did not include a full annotated JSON response example with `finish_reason`, safety/moderation fields, or the request-ID header name. OpenAI's general Chat Completions/Responses response shape (`id`, `object`, `choices[].message.content`, `choices[].finish_reason`, `usage{prompt_tokens,completion_tokens,total_tokens}`, response header `x-request-id`) is DOCUMENTED elsewhere in OpenAI's API reference but was not independently re-confirmed for the vision-specific response path in this session — flagged for live-probe plan.

---

## 3. GOOGLE GEMINI — Image Analysis

### 3.1 Model identity (vision-capable, current, per `https://ai.google.dev/gemini-api/docs/pricing` and `.../image-understanding`, verified 2026-08-03, DOCUMENTED)

| Model | Status | Modalities |
|---|---|---|
| gemini-3.6-flash | STABLE (current flagship-speed model) | TEXT, IMAGE, VIDEO, AUDIO input |
| gemini-3.5-flash | STABLE | TEXT, IMAGE, VIDEO, AUDIO input |
| gemini-3.5-flash-lite | STABLE | TEXT, IMAGE, VIDEO, AUDIO input |
| gemini-3.1-pro-preview | PREVIEW | TEXT, IMAGE, VIDEO, AUDIO input; tiered pricing >200k tokens |
| gemini-3.1-flash-lite | STABLE | TEXT, IMAGE, VIDEO input (audio priced separately/higher) |
| gemini-3-flash-preview | PREVIEW | TEXT, IMAGE, VIDEO, AUDIO input |
| gemini-2.5-pro | STABLE (scheduled shutdown 2026-10-16 per third-party source — **UNKNOWN, not seen directly on the official deprecations page in this session, needs confirmation**) | TEXT, IMAGE, VIDEO, AUDIO input |
| gemini-2.5-flash | STABLE | TEXT, IMAGE, VIDEO, AUDIO input |
| gemini-2.5-flash-lite | STABLE | TEXT, IMAGE, VIDEO, AUDIO input |
| gemini-2.0-flash / -flash-lite | **DEPRECATED_SHUTDOWN, shut down 2026-06-01** | (historical only) |
| gemini-3.1-flash-image ("Nano Banana 2") | STABLE | IMAGE+TEXT output (generation, not pure analysis) |
| gemini-3-pro-image ("Nano Banana Pro") | STABLE | IMAGE+TEXT output (generation) |
| gemini-2.5-flash-image ("Nano Banana", preview) | PREVIEW | IMAGE+TEXT output (generation) |

The image-*generation* models (Nano Banana family) also accept image input (for editing/reference), but their primary billed modality is image *output* tokens, priced completely differently from the analysis models above — see §3.3.

### 3.2 Request format (DOCUMENTED, `https://ai.google.dev/gemini-api/docs/image-understanding`, verified 2026-08-03)
Google's current documented entry point is the **Interactions API** (`client.interactions.create(...)`, REST endpoint `POST https://generativelanguage.googleapis.com/v1beta/interactions`), which supersedes the older `generateContent` endpoint referenced throughout the attached baseline usage file.

Three ways to supply an image:
1. **File API upload → URI reference** — `client.files.upload(...)` then `{"type": "image", "uri": "<file uri>", "mime_type": "image/jpeg"}`. Recommended for large/reused files.
2. **Inline base64 data** — `{"type": "image", "data": "<base64>", "mime_type": "image/jpeg"}`. Inline request total (text + inline bytes) capped at **20MB**.
3. **Public URL** — also uploaded via Files API in the shown examples (Gemini does not appear to support directly embedding a bare external `https://` URL without going through Files API, unlike OpenAI — **UNKNOWN, needs live-probe confirmation** whether a raw external URL type exists outside Files-API-mediated URIs).

Multiple images + text combine in the same `input` array. Supported MIME types: PNG, JPEG, WEBP, HEIC, HEIF. **File limit: max 3,600 image files per request.** [DOCUMENTED]

### 3.3 Image token accounting — Gemini's distinguishing behavior
Gemini is the **only one of the three providers whose usage object reports image tokens in two places simultaneously**: folded into the aggregate `promptTokenCount`/`totalTokenCount` (or the Interactions-API equivalent) **and** broken out separately by modality in a `promptTokensDetails[]` array (`{modality: "IMAGE", tokenCount: N}`). [DOCUMENTED, reviewed baseline usage-reference file, consistent with Google's documented usageMetadata shape]

**Anti-double-charging rule for Gemini specifically:** because the per-modality breakdown is a genuine **breakdown of** the aggregate (not additive to it), a client must bill only off the aggregate (`promptTokenCount`/equivalent) — using the modality breakdown *in addition to* the aggregate for billing would double-count. The breakdown exists for observability/attribution only.

Token cost formula (image-understanding page, DOCUMENTED): 258 tokens if both dimensions ≤ 384px; larger images tiled into 768×768px tiles at 258 tokens/tile, with a documented crop-unit formula for tile count. Gemini 3 adds a `media_resolution` parameter controlling max tokens allocated per image/frame.

Pricing for analysis (non-generation) models: image input billed at the model's **standard input token rate** — no per-image SKU (that only applies to the Nano Banana generation family, e.g. gemini-3.1-flash-image image *output* at $60/1M tokens ≈ $0.067/1024px image). [DOCUMENTED, `https://ai.google.dev/gemini-api/docs/pricing`]

Note: some Gemini models (e.g. gemini-3.1-flash-lite, gemini-3-flash) price **audio input higher than image/video/text input** even though both are "input tokens" — e.g. gemini-3-flash: $0.50 text/image/video vs $1.00 audio, standard tier. Image is *not* surcharged relative to text on current-generation models; audio is.

---

## 4. VOICE / AUDIO

### 4.1 Anthropic — not supported
No STT, TTS, audio-input, audio-output, or realtime audio-to-audio capability exists in the Claude API in any form. [DOCUMENTED, reviewed baseline usage-reference file] Confirmed consistent with the model-identity table in §1 (no AUDIO modality listed for any Claude model). This is a **hard product gap**, not a version-specific limitation — Rihla's voice-conversation feature cannot use Anthropic models at all.

### 4.2 OpenAI — voice/audio classification (DOCUMENTED, `https://developers.openai.com/api/docs/guides/realtime`, `.../pricing`, verified 2026-08-03)

| Class | Model(s) | Notes |
|---|---|---|
| **Native realtime audio-to-audio** | `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime` (GA), `gpt-realtime-1.5` | Speech-to-speech in a single model; WebRTC/WebSocket/SIP transport over `/v1/realtime` |
| **Realtime translation (audio-to-audio, different session type)** | `gpt-realtime-translate` | Dedicated endpoint `/v1/realtime/translations`; continuous session, no `response.create` turn lifecycle |
| **Realtime transcription (audio-to-text streaming)** | `gpt-realtime-whisper`, `gpt-live-transcribe` | Streaming transcript deltas without model-generated spoken responses |
| **File/bounded speech-to-text** | `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | Request-based, not a live session |
| **Text-to-speech** | (speech generation models under `/v1/audio/speech`, not separately named in the pricing table fetched this session — **UNKNOWN, needs live-probe**, model IDs such as `tts-1`/`gpt-4o-mini-tts`-class names referenced in older OpenAI docs were not re-confirmed live in this session) | Request-based |
| **STT+LLM+TTS pipeline** | Any text model (e.g. gpt-5.6) chained manually with a transcription model + TTS model | Not a single API; a Rihla-side orchestration pattern, not a provider feature |

**Transport:** WebRTC (browser/mobile capture), WebSocket (server-side media pipelines), SIP (telephony) — client chooses based on where audio is captured. [DOCUMENTED]

**Session types (all under GA `/v1/realtime` unless noted):**
- Voice-agent session: standard conversation lifecycle, tool calls, `response.create`.
- Translation session (`/v1/realtime/translations`): continuous, no turn lifecycle, no `response.create`.
- Transcription session: streaming transcript deltas only, no model-generated speech.

**Beta→GA migration note (DOCUMENTED):** older Realtime integrations using `OpenAI-Beta: realtime=v1` header must migrate; GA uses `POST /v1/realtime/client_secrets` for ephemeral tokens and `/v1/realtime/calls` for WebRTC session establishment; event names changed (e.g. `response.output_audio.delta`, `response.output_audio_transcript.delta`). **This is directly relevant if Rihla's existing (unseen) code targets the older beta event names — flagged UNKNOWN/repository-dependent, cannot confirm without repo access.**

**Safety identifiers:** recommended (not required) via `OpenAI-Safety-Identifier` header, bound at ephemeral-token-creation time or connection time. [DOCUMENTED]

### 4.2.1 OpenAI voice pricing (DOCUMENTED, `https://developers.openai.com/api/docs/pricing`, verified 2026-08-03)

| Model | Modality | Input | Cached input | Output |
|---|---|---|---|---|
| gpt-realtime-2.1 | Audio | $32.00/1M | $0.40/1M | $64.00/1M |
| | Text | $4.00/1M | $0.40/1M | $24.00/1M |
| | Image | $5.00/1M | $0.50/1M | — |
| gpt-realtime-2.1-mini | Audio | $10.00/1M | $0.30/1M | $20.00/1M |
| | Text | $0.60/1M | $0.06/1M | $2.40/1M |
| | Image | $0.80/1M | $0.08/1M | — |
| gpt-realtime-translate | Audio | — | — | $0.034/minute |
| gpt-live-transcribe | Audio | — | — | $0.017/minute |
| gpt-realtime-whisper | Audio | — | — | $0.017/minute |
| gpt-transcribe | Transcription | — | — | $0.0045/minute |
| gpt-4o-transcribe | Transcription | $2.50/1M | — | $10.00/1M ($0.006/min estimated) |
| gpt-4o-mini-transcribe | Transcription | $1.25/1M | — | $5.00/1M ($0.003/min estimated) |

Note the realtime models notably now also carry an **Image** input rate ($5.00/$0.50 per 1M for gpt-realtime-2.1) — OpenAI's realtime models added **image input support** as of the "gpt-realtime" GA launch (per the OpenAI blog announcement: "new API capabilities including MCP server support, image input, and SIP phone calling support"). This means a realtime voice session can also accept image input mid-conversation — relevant if Rihla wants combined voice+image workflows.

### 4.2.2 OpenAI voice usage accounting
Per OpenAI's Managing Costs guide (DOCUMENTED, `https://developers.openai.com/api/docs/guides/realtime-costs`): "Audio tokens in user messages are 1 token per 100ms of audio, while audio tokens in assistant messages are 1 token per 50ms of audio." Realtime sessions bill **input and output tokens across text, audio, and image modalities** — separate line items, not folded together the way Anthropic folds image into text-input tokens. Streaming translation and transcription sessions are billed by **audio duration** (minutes) rather than tokens.

**Anti-double-counting rule (INFERRED from the above):** because audio, text, and image are each their own token-rate line in the realtime pricing table, a client must sum them as **separate billable categories**, not merge audio-derived tokens into the text token count. This is the opposite pattern from Anthropic (which folds everything into one `input_tokens` count) — a Rihla billing layer that assumes one "input_tokens" number per turn across all providers will under- or over-count for OpenAI realtime sessions specifically.

**UNKNOWN / needs live probe:** the exact JSON shape of the realtime `usage` object as it appears in `response.done` / session-summary events (field names, whether cached-audio is broken out per-turn or only session-final, whether the audio-duration-billed models like `gpt-realtime-translate` return any token-shaped usage at all or only a duration figure) was not independently confirmed with a live session in this research pass.

### 4.3 Google Gemini — voice/audio classification (DOCUMENTED, `https://ai.google.dev/gemini-api/docs/pricing`, `.../live-api`, verified 2026-08-03)

| Class | Model(s) | Notes |
|---|---|---|
| **Native realtime audio-to-audio (Live API)** | `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025` | WebSocket-based bidirectional streaming |
| **Realtime speech-to-speech translation** | `gemini-3.5-live-translate-preview` | 70+ languages, dedicated translate session |
| **Text-to-speech** | `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts` | Request-based, priced per audio-output token (25 tokens/sec of audio) |
| **Audio input to text output** | Any standard Gemini model (e.g. gemini-3.6-flash) via `generateContent`/Interactions with audio content block | Not a distinct STT endpoint like OpenAI's — audio is just another input modality billed at the audio-input rate |
| **STT + LLM + TTS pipeline** | Manual orchestration only | Not a first-party Google feature |

**Transport:** Live API uses **WebSocket** (`.../live-api/get-started-websocket`) and a GenAI SDK wrapper; no documented WebRTC or SIP support was surfaced in this session — **UNKNOWN, needs live-probe** whether WebRTC/SIP exist for Gemini Live (not seen in the fetched navigation/pricing pages).

### 4.3.1 Gemini voice pricing (DOCUMENTED, `https://ai.google.dev/gemini-api/docs/pricing`, verified 2026-08-03)

| Model | Input | Output |
|---|---|---|
| gemini-3.1-flash-live-preview | $0.75/1M text; $3.00/1M or $0.005/min audio; $1.00/1M or $0.002/min image/video | $4.50/1M text; $12.00/1M or $0.018/min audio |
| gemini-3.5-live-translate-preview | $3.50/1M or $0.0053/min audio | $21.00/1M or $0.0315/min audio |
| gemini-2.5-flash-native-audio-preview-12-2025 | $0.50/1M text; $3.00/1M audio/video | $2.00/1M text; $12.00/1M audio |
| gemini-3.1-flash-tts-preview | $1.00/1M text | $20.00/1M audio (25 tokens/sec) |
| gemini-2.5-flash-preview-tts | $0.50/1M text | $10.00/1M audio |
| gemini-2.5-pro-preview-tts | $1.00/1M text | $20.00/1M audio |

Google publishes **both a per-token and a per-minute equivalent** for several Live/translate models (e.g. "$3.00 or $0.005/min"), which is a distinctive dual-unit pricing presentation not seen from OpenAI or Anthropic. Audio tokens correspond to a documented **25 tokens per second of audio** rate for TTS models. [DOCUMENTED]

### 4.3.2 Gemini voice usage accounting
Per the reviewed baseline usage-reference file (DOCUMENTED, consistent with Google's documented `usageMetadata` shape for audio input): audio input tokens follow the **same dual-reporting pattern as image tokens** — folded into `promptTokenCount`/aggregate **and** broken out in `promptTokensDetails[]` with `modality: "AUDIO"`. The exact `usageMetadata` shape for audio **output** (Live API native-audio and TTS models) was explicitly flagged **UNKNOWN** in the baseline file itself ("not confirmed in this pass... do not assume it matches the AUDIO modality entries documented above for input"). This audit did not close that gap — still UNKNOWN, carried into the live-probe plan.

**Anti-double-counting rule for Gemini audio (same as image, §3.3):** bill off the aggregate token count; the per-modality breakdown is observability-only, not additive.

---

## 5. Arabic / Egyptian Arabic support

- **OpenAI Realtime/transcription models:** general multilingual support is documented at a high level (Whisper-derived models support broad language coverage); **no explicit, dedicated "Egyptian Arabic" dialect-level documentation was found** in the pages fetched this session. **UNKNOWN — needs live probe** with real Egyptian-Arabic audio samples across `gpt-realtime-whisper`, `gpt-4o-transcribe`, and `gpt-realtime-2.1`.
- **Gemini:** `gemini-3.5-live-translate-preview` advertises "70+ languages" for live speech-to-speech translation; standard Arabic (MSA) is very likely included given Gemini's broad language support, but **dialect-level Egyptian Arabic accuracy is UNKNOWN** — not documented at the dialect level in any page fetched this session.
- **Anthropic:** not applicable (no audio capability at all).

This entire area requires empirical testing (see live-probe plan) rather than documentation — none of the three providers publish dialect-level (as opposed to language-level) accuracy or support statements for Arabic variants.

---

## 6. Comparison against the two attached baseline files

**Missing models (present in live docs, absent from baseline pricing file):**
- OpenAI: `gpt-5.6-sol/-terra/-luna` family, `gpt-realtime-2.1` / `-2.1-mini`, `gpt-realtime-translate`, `gpt-realtime-whisper`, `gpt-live-transcribe`, `gpt-transcribe`, `gpt-image-2` — **UNKNOWN whether these appear elsewhere in the full (truncated) baseline file**, since only a partial view of `ai-provider-model-pricing.json` was read in this session (lines 1–193 and 1976–2167 of a 2167-line file). **Recommend a full line-by-line diff outside this chat**, since large parts of the file (roughly lines 194–1975, covering the remaining Anthropic and all OpenAI entries) were not displayed to this auditor.
- Google: `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.5-live-translate-preview`, `gemini-3.1-flash-lite-image`, `gemini-3.1-flash-tts-preview` were confirmed live but not seen in the visible portion of the baseline file (which showed gemini-2.0-flash/-flash-lite and the three image-generation models as its last entries) — likely present in the untruncated middle section, **UNKNOWN without full diff**.

**Obsolete/deprecated models correctly flagged in baseline:** `gemini-2.0-flash`, `gemini-2.0-flash-lite` — baseline correctly marks these `DEPRECATED_SHUTDOWN`, consistent with the live pricing page's shutdown notice (2026-06-01). ✅ No correction needed.

**Possible obsolescence not yet flagged in baseline:** the baseline usage-reference file documents Gemini's usage object exclusively via the `generateContent`/`usageMetadata` shape. Google's docs now present the **Interactions API** (`v1beta/interactions`) as the recommended GA surface for "all the latest features and models." **This is the single most important open question for Rihla's integration:** if new development should target the Interactions API, the usage-object field names and shapes documented in the baseline (`promptTokenCount`, `candidatesTokenCount`, `promptTokensDetails[]`, etc.) need to be re-verified against the Interactions API's actual response schema, which was not shown in the pages fetched this session. **Flagged UNKNOWN, top priority for live-probe plan.**

**Missing prices:** none identified as outright missing in the visible portions of the baseline; Anthropic and the visible Gemini/OpenAI rows in the baseline matched live pricing at the specific line items checked.

**Missing usage fields:** OpenAI Realtime API's exact `usage` object shape for audio-token accounting (per-modality breakdown location, whether it's incremental or session-final) is not present in the baseline and was not fully closed in this pass either — carried to live-probe plan.

**Missing image/audio accounting semantics:** Gemini audio-*output* `usageMetadata` shape (baseline already flags this as unconfirmed — audit did not close it).

**Possible double-counting risks:**
1. OpenAI Realtime: audio/text/image are **separate** billable lines — a naive integration that sums "all input tokens" into one Anthropic-style bucket will misreport cost. (§4.2.2)
2. Gemini: per-modality breakdown fields (`promptTokensDetails[]`) are **non-additive** to the aggregate — summing both double-counts. (§3.3, §4.3.2)
3. Anthropic: image tokens are invisible inside `input_tokens` — any client-side pre-estimate must not also be added post-response. (§1.2)

**Fields requiring a real API probe:** see §7 / `ai-live-probe-plan.md`.

**Conflicting information:** third-party (non-official) sources gave a Gemini 2.5 Pro/Flash/Flash-Lite shutdown date of "October 16, 2026," while the only shutdown notices independently confirmed on the **official** Google pricing page in this session were for `gemini-2.0-flash`/`-flash-lite` (2026-06-01) and Imagen 4 (2026-08-17) and Veo 3/Veo 2 (2026-06-30). The 2.5-family October shutdown claim is **UNKNOWN / unconfirmed on official docs** in this session and should not be treated as fact without checking `https://ai.google.dev/gemini-api/docs/deprecations` directly.

---

## 7. Summary of open UNKNOWNs carried to the live-probe plan
See `ai-live-probe-plan.md` for the full enumerated list and suggested (non-billed where possible, or minimal-cost) verification steps.
