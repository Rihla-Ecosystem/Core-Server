# AI Live Probe Plan — Image & Voice Integration
No paid API calls were made in this research pass. Everything below is a plan for a follow-up session with a funded API key, minimal-cost test calls, and (where available) free-tier requests. Items are ordered by priority for Rihla's stated goal (image analysis + voice conversation).

**Repository status: UNKNOWN — REPOSITORY NOT PROVIDED.** None of the steps below assume anything about Rihla's existing code; each is written as a standalone verification against the provider, independent of any existing integration.

---

## Priority 1 — Structural / breaking-change risks

1. **Gemini: Interactions API vs generateContent usage-object parity.**
   - Make one minimal image-analysis call via `v1beta/interactions` and one equivalent call via legacy `v1beta/models/{model}:generateContent`, same image, same model.
   - Diff the two response bodies field-by-field, specifically the usage object (`promptTokenCount` family vs whatever the Interactions API returns).
   - **Why P1:** the entire baseline usage-reference file's Gemini section is written against `generateContent`; if Rihla is meant to build against the new recommended surface, every Gemini usage-mapping field in the baseline may need renaming.
   - Cost: 1 free-tier-eligible call per surface (Flash-tier models have a free tier).

2. **OpenAI Realtime: GA vs beta event names.**
   - Open one GA WebSocket session against `gpt-realtime-2.1`, send a short audio turn, and capture the full event stream verbatim (event type names, nesting, `response.done`/completion event name, error event shape).
   - **Why P1:** if any existing (unseen) Rihla code still targets `OpenAI-Beta: realtime=v1` beta event names, it will not parse GA events at all — this is a hard compatibility break, not a cosmetic one.
   - Cost: a few seconds of realtime audio (~$0.01–0.05 at documented per-token rates).

3. **OpenAI: Responses API usage-object field names for image + realtime calls.**
   - One vision call via `/v1/responses` with an image, capture `response.usage` verbatim.
   - One realtime session, capture the final usage/session-summary payload verbatim.
   - **Why P1:** needed to build correct, non-double-counting billing logic; this audit could not confirm exact field names from documentation alone.

---

## Priority 2 — Accounting / billing-correctness risks

4. **OpenAI Realtime usage event: incremental vs final, and cached-audio granularity.**
   - Run a multi-turn realtime session; capture every usage-bearing event; determine whether usage is cumulative-final or must be summed turn-by-turn, and whether cached-audio-input tokens are broken out per turn or only in a session summary.

5. **Gemini Live API: audio-output usage shape.**
   - Run one Live API (WebSocket) session with `gemini-3.1-flash-live-preview`, capture the full event stream, specifically any usage/quota event carrying audio-output token counts.
   - This is explicitly flagged unconfirmed in both the reviewed baseline file and this audit; it is the largest remaining gap in Gemini voice billing.

6. **Confirm Anthropic's exact provider-request-id header name and safety-block response shape.**
   - One image-analysis call to `claude-opus-5` with an ambiguous/borderline image; inspect response headers for a request-ID header, and (if triggerable) inspect the shape of a safety-refused response.
   - Note: this session's network allowlist did not include Anthropic's docs domains, so even the documentation-only version of this check could not be completed here — this should be the very first item done in a session with full network access, doc-only, before spending on API calls.

7. **OpenAI vision response: exact `finish_reason`/moderation-block shape on the Responses API.**
   - One call to `/v1/responses` with an image likely to trigger a content-policy response (e.g., a CAPTCHA image, which OpenAI's docs state is blocked outright) to observe the refusal/finish-reason shape without needing genuinely harmful test content.

---

## Priority 3 — Feature-completeness / quality checks

8. **Egyptian Arabic accuracy — empirical, not documentation-based.**
   - Run identical Egyptian-Arabic audio samples (a handful of representative utterances, ideally with known ground-truth transcripts) through: `gpt-realtime-whisper`, `gpt-4o-transcribe`, `gemini-3.1-flash-live-preview` (Live API transcription), and `gemini-3.5-live-translate-preview`.
   - Score word-error-rate / semantic accuracy manually since no provider publishes dialect-level accuracy figures.
   - This cannot be resolved by more documentation research — no provider publishes Egyptian-dialect-specific benchmarks.

9. **Gemini Live API transport confirmation.**
   - Confirm via direct doc fetch (not done this session) of `https://ai.google.dev/gemini-api/docs/live-api/capabilities` whether WebRTC or SIP transport exists for Live API, or whether WebSocket is the only supported transport. Currently UNKNOWN.

10. **OpenAI dedicated TTS model IDs and voice/style/speed parameters.**
    - Direct fetch of `https://developers.openai.com/api/docs/guides/text-to-speech` (not completed this session) to get exact current model IDs, available voices, and style/speed control parameters — the pricing table fetched this session did not enumerate a discrete TTS model line separate from the realtime/transcription rows shown.

11. **Full baseline-file diff.**
    - The reviewed `ai-provider-model-pricing.json` is 2,167 lines; only the first ~193 and last ~192 lines were displayed to this auditor (the middle section, roughly lines 194–1975, covering most Anthropic detail rows and the full OpenAI section, was not shown). A complete line-by-line diff against this session's live-fetched pricing tables (§6 of `ai-model-research.md`) should be run mechanically (e.g., a script comparing model IDs and rates) rather than by manual re-reading, since manual reading in a follow-up session would re-incur the same truncation problem.

12. **Anthropic vision response and safety fields — direct doc re-fetch.**
    - This session's network allowlist excluded Anthropic's own documentation domains (`docs.claude.com` / `platform.claude.com`), so every Anthropic-specific claim above is sourced to the *reviewed baseline file*, not independently re-verified against Anthropic's live docs in this pass. A follow-up session with Anthropic's docs domains enabled should re-verify the entire Anthropic section of `ai-model-research.md` against source, not just trust the baseline file's citations.

---

## What NOT to probe (out of scope per task instructions)
- Anything about Rihla's own repository, current model configuration, fallback chains, or existing code contracts — remains UNKNOWN — REPOSITORY NOT PROVIDED until repository access is granted.
- No implementation code should be written as part of executing this plan; it is a verification plan, not a build plan.
- No paid API request should be made purely to "double check" something already stated unambiguously in official documentation and confirmed in this pass (e.g., published pricing figures) — probing is reserved for structural/schema unknowns, not re-confirming plain numbers.

---

## Suggested order of operations for a follow-up session
1. Re-fetch Anthropic docs directly (no cost) — closes item 12/6 partially.
2. Gemini Interactions-vs-generateContent diff (near-zero cost, Flash free tier) — closes item 1.
3. One OpenAI GA realtime session + one Gemini Live API session, captured verbatim (low cost, cents) — closes items 2, 4, 5.
4. One OpenAI Responses-API vision call + one Anthropic vision call, captured verbatim (low cost) — closes items 3, 6, 7.
5. Egyptian Arabic sample runs across the four models identified (moderate cost depending on sample count) — closes item 8.
6. Direct doc fetches for TTS model IDs and Live API transport (no cost) — closes items 9, 10.
7. Mechanical full-file diff of the baseline pricing JSON against a freshly re-scraped live pricing table — closes item 11.
