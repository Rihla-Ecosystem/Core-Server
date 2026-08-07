# Phase 2E-C — Full HTTP Round-Trip Report

**Marker:** `PHASE_2E_C_FULL_HTTP_ROUNDTRIP_NOT_READY`

**Date:** 2026-08-06
**Worktrees:** Core `Core-Server-provider-pricing-phase2` + AI `ai-service-provider-pricing-phase2` (branch `feature/provider-pricing-phase2`, no commits/pushes)
**Test DB:** `postgresql://core_user:core_pass@localhost:5434/core_server_test` (only test DB used)

---

## 1. Executive summary

This phase set out to prove a **real full HTTP round trip** for Image and Voice:
Probe script → **real Core HTTP server** → **real AI Service HTTP server** → **real Gemini**
→ back → Core ingestion (`AiUsageLog`) → Shadow Pricing observation → Core HTTP response
to the probe, with deterministic nonces and zero provider retries.

The full HTTP transport, Core ingestion, Shadow Pricing observation, admin/wallet safety,
and zero-retry behavior were **all proven working end-to-end** over real HTTP. The phase
did **NOT** reach READY because the **semantic nonce-understanding** invariants could not be
satisfied with the real provider within the approved live-call budget:

1. **Image nonce** — the real identify model ignored the on-image text (read the image as
   "Tahrir Square" from the location context instead of transcribing the nonce).
2. **Voice spoken nonce** — Gemini did not echo the exact spoken nonce in the final run;
   earlier the alphanumeric token was unpronounceable for espeak-ng.

All infrastructure pieces that could be proven without further paid calls were proven. The
remaining work is provider-behavior/prompt-design tuning of the **probe asset**, not Core/AI
service code. Per the phase rules this is an honest `NOT_READY` — never READY based on
successful Gemini calls alone, and never READY while voice semantic understanding is unproven.

**Cumulative real Gemini calls used: 14** (2E-B corrective probes: 8; 2E-C run `67DBED`: 3;
run `KILOVICTOR`: 0 — AI server started with no key due to an env-name mismatch, corrected;
run `MIKEKILO`: 3). No retries occurred in any successful or failing live call.

---

## 2. Exact endpoints used

| Role | Method | Path |
|---|---|---|
| Core health | GET | `http://127.0.0.1:3456/health` |
| Core identify | POST | `http://127.0.0.1:3456/api/identify` (multipart `image`, optional `lat`/`lon`/`radius`) |
| Core voice | POST | `http://127.0.0.1:3456/api/voice` (multipart `audio`, optional `lat`/`lon`/`conversation_id`) |
| Core Admin shadow-pricing observations | GET | `http://127.0.0.1:3456/api/admin/ai-shadow-pricing/observations?source=identify&limit=5` and `?source=voice&limit=5` |
| AI health | GET | `http://127.0.0.1:3003/health` |
| AI identify (via Core) | POST | AI `/identify` (Core forwards with `X-Internal-Api-Key`) |
| AI voice (via Core) | POST | AI `/voice` (Core forwards with `X-Internal-Api-Key`) |

Core forwards the caller's multipart body to `env.AI_SERVICE_URL/identify` and
`/voice` (see `src/services/identify.service.ts`, `src/services/voice.service.ts`),
attaching `X-Internal-Api-Key` (timing-safe internal-key check on the AI side).

## 3. Deterministic nonce assets (image + spoken WAV)

- **Image nonce:** `RIHLA-IMG-<SUFFIX>` drawn with ffmpeg `drawtext` into a deterministic
  PNG (white field + black box + 150px bold white text, 2000×400), unique per run.
- **Spoken nonce:** `RIHLA VOICE <SUFFIX>` synthesized with a locally built espeak-ng 1.53
  (AI `scripts/.espeak-ng-prefix/`, gitignored) → 16 kHz mono WAV via ffmpeg.
- **Run suffix:** random UUID hashed → pronounceable NATO-word pair (e.g. `KILOVICTOR`,
  `MIKEKILO`) so espeak-ng pronounces it unambiguously and Gemini can transcribe it.
- All assets are synthetic and deleted after the run (probe `finally`), with the synthetic
  admin user and related rows removed from the test DB.

## 4. Startup commands (no secrets)

AI service (start first; wait for `/health`):

```
QDRANT_HOST=localhost QDRANT_PORT=6333 GEMINI_MAX_RETRIES=0 \
INTERNAL_API_KEY=<from Core .env.test> JWT_ACCESS_SECRET=<from Core .env.test> \
GEMINI_API_KEYS=<from AI .env> \
<venv>/python -m uvicorn app.main:app --host 127.0.0.1 --port 3003 --log-level info \
> /tmp/rihla-ai-service-roundtrip.log 2>&1
```

Core (start after AI health OK):

```
PORT=3456 node --env-file=.env.test --import tsx src/index.ts \
> /tmp/rihla-core-roundtrip.log 2>&1
```

Probe (run exactly once, no auto-retry):

```
CORE_BASE_URL=http://127.0.0.1:3456 \
AI_HEALTH_URL=http://127.0.0.1:3003/health \
DATABASE_URL=<from Core .env.test> JWT_ACCESS_SECRET=<from Core .env.test> \
ESPEAK_NG_BIN=<AI>/scripts/.espeak-ng-prefix/bin/espeak-ng \
timeout 300 node --env-file=.env.test --import tsx scripts/live-multimodal-http-roundtrip-probe.ts
```

All servers stopped cleanly at the end of this phase (logs preserved under `/tmp/rihla-*.log`).
Qdrant container `qdrant-rihla-roundtrip` (Docker) remains running (ports 6333+6334).

## 5. Test database confirmation

- `DATABASE_URL` asserted by the probe (`assertDbIsTestDb`) to point to `/core_server_test`.
- The Core test suite files also each carry the same top-of-file safety guard.
- Only the test DB was touched; no dev/prod data was read or written.

## 6. Test identity + wallet safety

- **Identify identity:** synthetic admin user created via Prisma in the test DB
  (`probe_roundtrip_<SUFFIX>@example.com`, role `admin`), authorized with a real JWT
  `{ sub, role: "admin" }` signed with the Core `JWT_ACCESS_SECRET`; requests go through the
  real Core `/api/identify` and `/api/voice` routes (authenticate middleware → `isTokenExemptUser`).
- **Wallet safety (run `MIKEKILO`):** before → after counts on the probe admin user:
  `TokenWallet 0→0`, `TokenTransaction 0→0`, `TokenReservation 0→0`, `AIBillingOperation 0→0`.
  Only `AiUsageLog` grew `0→3` (one identify row + two voice rows). No Wallet/TokenTransaction
  mutation occurred (admin token-exemption, existing Core route semantics — billing not modified).
- The probe deletes its temp assets and the synthetic admin user (and related rows) in `finally`.

## 7. Image nonce — NOT verified

- Image nonce used: `RIHLA-IMG-<SUFFIX>` drawn with ffmpeg `drawtext` into a deterministic PNG
  (white field + black box + 150px bold white text, 2000×400).
- Run `67DBED`: nonce not detected in the identify response.
- Run `MIKEKILO`: nonce not detected (`identify_image_nonce_detected = FAIL`).
- **Root cause (proven at 0 Gemini cost via the AI image md5 cache):** with Cairo lat/lon
  (30.0444, 31.2357) plus RAG nearby-context, the identify system prompt biases the model to
  identify a landmark — it answered `name="Tahrir Square"` and never read the on-image text.
- **Design fix applied to the probe (not yet live-verified):** the image probe no longer sends
  lat/lon, so the model must describe the actual image content and is expected to transcribe the
  nonce text. This consumes the remaining budget, so it was left for an approved follow-up run.

## 8. Spoken nonce — NOT verified

- Spoken phrase: `The verification code is <NONCE>. Say exactly: <NONCE>. Repeat the verification code exactly: <NONCE>.`
- Run `67DBED`: espeak-ng reads `RIHLA VOICE 67DBED` as "sixty-seven D-B-E-D", so Gemini cannot
  transcribe the exact token → `voice_spoken_nonce_detected = FAIL`.
- Run `MIKEKILO` (pronounceable suffix): the voice reply did not echo the exact spoken nonce
  (`voice_spoken_nonce_detected = FAIL`).
- **Design fixes applied to the probe (not yet live-verified):** run suffix is now a
  pronounceable letter-only NATO-word pair (e.g. `KILOVICTOR`, `MIKEKILO`) and the phrase
  explicitly commands "Say exactly: … Repeat the verification code exactly: …". espeak-ng
  phonemes verified cleanly (`RIHLA VOICE KILODELTA` → `r'Ihl@ v'OIs k,Il@d'Elt@`).

## 9. Semantic voice understanding proof — NOT achieved

Gemini's `text_response` (returned as `text_response` through Core) must contain the exact
spoken nonce after normalization. This is unproven for both live runs; therefore, per the phase
rules, READY is impossible regardless of HTTP/provider success.

## 10. providerCalls / providerAttempts reached Core — VERIFIED

- Identify (`MIKEKILO`): `providerCalls=1`, `providerAttempts=1`, HTTP 200, no retry.
- Voice (`MIKEKILO`): `providerCalls=2`, `providerAttempts=2`, HTTP 200, no retry.
- Both are returned in the real Core HTTP response body and persisted into Shadow Pricing
  observations (see §11) and `AiUsageLog` (usage token fields only; `providerCalls`/`providerAttempts`
  are passed to the shadow-pricing engine, not stored in `AiUsageLog`, matching the schema).

## 11. probeCalls captured in AiUsageLog (schema)

`AiUsageLog` stores usage token fields only (model, inputTokens, outputTokens, totalTokens,
cost); `providerCalls`/`providerAttempts` are passed to the shadow-pricing engine and are
NOT persisted as columns (matches `prisma/schema.prisma`). The full provider-call/attempt
records are observable through the Shadow Pricing observation buffer and Admin API.

## 12. Actual models used

- Image: `gemini-3.6-flash` (AI default `gemini_model`; identify provider call).
- Voice audio understanding: `gemini-3.6-flash`.
- Voice TTS: `gemini-3.1-flash-tts-preview` (TTS endpoint, per `generate_speech`).

## 13. Real usage fields observed (Core shadow-pricing observation)

- **Identify (`MIKEKILO`):** `summaryStatus=FULLY_PRICED`, `callCount=1`, `pricedCallCount=1`,
  `unpricedCallCount=0`, `attemptRiskStatus=NONE`, `attemptCount=1`, `failedAttemptCount=0`.
- **Voice (`MIKEKILO`):** `summaryStatus=PARTIALLY_PRICED`, `callCount=2`, `pricedCallCount=1`,
  `unpricedCallCount=1`, `unpricedReasons={ACTUAL_MODEL_NOT_IN_RATECARD:1}`, `attemptRiskStatus=NONE`
  (run 1 `67DBED` voice had `INDETERMINATE_COST_RISK` from a single INDETERMINATE TTS attempt;
  run `MIKEKILO` had `NONE` — TTS fully succeeded), `attemptCount=2`, `failedAttemptCount=0`.
- The `ACTUAL_MODEL_NOT_IN_RATECARD=1` reason corresponds to the TTS model not having a Rate Card
  row; the voice `PARTIALLY_PRICED` status is expected observability, not a defect.

## 14. Modality no-double-count — VERIFIED

- Probe invariant `identify_modality_totals_ok` and `voice_modality_totals_ok` PASS for both runs;
  totals reconcile at the provider-call level (input+output+reasoning accounting).
- Phase 2E-B corrective probe (preserved) also verified `input+output+reasoning==total` for the
  corrective voice run (`153+56+188=397`, `54+561=615`).

## 15. TTS source

- Run `MIKEKILO`: real Gemini TTS succeeded (`attemptRiskStatus=NONE`), audio returned through
  Core (`voice_audio_produced=PASS`, real `audio_response`). gTTS fallback is the AI service's
  documented fallback when Gemini TTS returns no usable audio part (used only in run `67DBED`
  where the TTS attempt was a single INDETERMINATE).

## 16. Full Core HTTP response — VERIFIED

Run `MIKEKILO`: both `/api/identify` and `/api/voice` returned HTTP 200 through the real Core
server with the AI response body (name/description or text_response + audio), `providerCalls`,
`providerAttempts`, and `usage` passthrough intact.

## 17. Shadow Pricing observation via real Core/Admin API — VERIFIED

`GET /api/admin/ai-shadow-pricing/observations` returned the run observations over real Core HTTP
with admin JWT: identify 2 rows, voice 2 rows across the two probe runs (see §11).

## 18. No unexpected retries observed — VERIFIED

Across all 14 cumulative Gemini requests and all three probe runs, no accidental retry was
observed: every attempt had `attemptNumber=1`, `hasRetry=false` and `failedAttemptCount=0`
on the Admin API. The single INDETERMINATE TTS attempt in run `67DBED` was a lone
`attemptNumber=1` attempt (gTTS fallback), not a retry — the probe's `voice_no_retry`
invariant was corrected to only flag `attemptNumber !== 1`.

## 19. attemptRiskStatus — VERIFIED

Identify: `NONE` (both runs). Voice: `INDETERMINATE_COST_RISK` (run `67DBED`, single
INDETERMINATE TTS) and `NONE` (run `MIKEKILO`, TTS fully succeeded). No retries in any run
(`hasRetry=false`, `failedAttemptCount=0`).

## 20. Pricing status + unpriced reasons

- Identify: `FULLY_PRICED`, 1/1 priced, no unpriced reasons.
- Voice: `PARTIALLY_PRICED`, 1/2 priced; unpriced reason `ACTUAL_MODEL_NOT_IN_RATECARD:1`
  (the TTS model has no Rate Card row). Rate Card storage was NOT modified.

## 21. Wallet-safety guarantee — full run data (run `MIKEKILO`)

Before → after on the probe admin user: `TokenWallet 0→0`, `TokenTransaction 0→0`,
`TokenReservation 0→0`, `AIBillingOperation 0→0`. Only `AiUsageLog` grew `0→3`
(1 identify + 2 voice rows). This is the admin/token-exempt identity via existing Core
routes — no billing code was modified to make the probe pass.

## 22. Wallet / token-transaction / token-reservation before/after — VERIFIED

`TokenWallet 0→0`, `TokenTransaction 0→0`, `TokenReservation 0→0`, `AIBillingOperation 0→0`
(run `MIKEKILO`). Admin token-exempt identity via existing Core routes; no bypass.

## 23. No usage-based Wallet cutover — VERIFIED (NOT ACTIVE)

Shadow pricing is observation-only. No Wallet mutation occurred and no usage-based charging was
turned on. Production Image/Voice usage-based Wallet cutover remains **NOT ACTIVE**.

## 24. Phase 7 regression suites — ALL PASS

Ran the Core token-outcome suites (AI execution contract, AI billing orchestrator, durable
billing orchestrator, AI billing operation, AI billing recovery, token reservation,
provider attempts, AI usage contracts, AI usage pricing, provider pricing call/aggregate/
arithmetic, shadow-pricing integration/observation/service/admin):
**872 passed, 0 failed, 0 cancelled, 0 skipped** (14 suites). Automated token-outcome
behavior: **VERIFIED**; production cutover: **NOT ACTIVE**.

## 25. Phase 8 — non-live HTTP boundary tests — 8/8 PASS

New `tests/phase-2e-c-http-boundary.test.ts`: real Core HTTP server + fake HTTP AI Service
(no AI-service imports mocked; no live provider calls). 8 scenarios:
1. Identify real Core HTTP round-trip reaches the fake AI HTTP service and returns
   providerCalls/providerAttempts.
2. Identify image nonce echoed verbatim through the real Core HTTP boundary.
3. Voice real Core HTTP round-trip reaches the fake AI HTTP service and returns
   providerCalls/providerAttempts plus audio.
4. Voice spoken nonce echoed verbatim through the real Core HTTP boundary.
5. Core forwards `X-Internal-Api-Key` and the caller Authorization to the AI HTTP service.
6. Admin identity: TokenWallet/TokenTransaction/TokenReservation/AIBillingOperation unchanged
   after identify + voice.
7. Identify + voice record AiUsageLog rows via the real Core HTTP boundary.
8. Upstream AI HTTP 500 → Core 502 with no usage recording and no billing mutation.

Result: **8 passed, 0 failed**.

## 26. GEMINI_MAX_RETRIES hook + TTS retry-bound fix (AI)

- Added `GEMINI_MAX_RETRIES` env override to `app/core/llm_client.py` (default 10, clamps to
  >=0, ignores non-integer values) so provider retries can be set to 0 at process start
  without editing any `.env` file.
- Fixed `generate_speech` retry bound from a hardcoded `_retry_count > 2` to
  `> self.MAX_RETRIES` — a genuine bug where `GEMINI_MAX_RETRIES=0` was NOT enforced for TTS.
- Verified with `tests/test_gemini_max_retries_override.py` (5 tests) and in the live runs:
  zero provider retries observed across all 14 cumulative Gemini requests.

## 27. Phase 11 — Core typecheck

`npx --no-install tsc --noEmit` → exit 0, no errors.

## 28. Phase 11 — full Core suite

```
timeout 600 node --env-file=.env.test --import tsx --test --test-concurrency=1 tests/*.test.ts
```
**1627 passed, 0 failed, 0 cancelled, 0 skipped** (28 suites), duration ~53s. Log:
`full-test-output.log` (worktree).

## 29. AI focused suites

- `tests/test_phase_2e_b_corrective.py` + `tests/test_gemini_max_retries_override.py`:
  **30 passed**.
- Full AI suite: **142 passed, 1 failed** (pre-existing unrelated failure in
  `test_tools.py::TestTools::test_tool_definitions_exist`, asserting `TOOL_DEFINITIONS >= 9`
  while 8 exist). This failure predates this phase (documented in Phase 2E-B) and is unrelated
  to this work; the file is untouched.

## 30. `git diff --check` — clean in both worktrees (exit 0)

## 31. Files changed (this phase)

Core worktree (uncommitted):
- `scripts/live-multimodal-http-roundtrip-probe.ts` (new — probe script).
- `tests/phase-2e-c-http-boundary.test.ts` (new — Phase 8 boundary tests).
- `docs/phase-2e-c-full-http-roundtrip-report.md` (this file).

AI worktree (uncommitted; 2E-B changes preserved):
- `app/core/llm_client.py` (modified — `GEMINI_MAX_RETRIES` env hook + `generate_speech`
  retry-bound fix `_retry_count > 2` → `> self.MAX_RETRIES`).
- `tests/test_gemini_max_retries_override.py` (new — 5 tests).
- 2E-B preserved: `scripts/phase_2e_b_probe.py`, `scripts/phase_2e_b_corrective_voice_output.json`,
  `scripts/.espeak-ng-prefix/` (gitignored), `tests/test_phase_2e_b_corrective.py`,
  `docs/phase-2e-b-live-multimodal-probes-report.md`, `.gitignore` (espeak-ng prefix),
  `.env.example` (placeholder key — leak fixed in 2E-B).

No `package.json`, lockfiles, `.env`, Prisma schema/migrations, or production billing/Rate Card
files were modified.

## 32. Secrets/redaction audit

- No secrets printed. Key presence masked as `GEMINI_API_KEYS=present`, `INTERNAL_API_KEY=present`,
  `DATABASE=core_server_test`. No raw auth headers, base64, audio, image, or confidential provider
  responses persisted.
- Probe report JSON (`/tmp/rihla-http-roundtrip-*.json`) stores only sanitized fields
  (booleans, counts, `attemptRiskStatus`, minimal summaries) — no raw provider content/media.
- Pre-existing finding (flagged, not introduced by this phase): AI `.env.example` previously
  contained a live 53-char `AQ.`-prefixed key identical to `.env`; replaced with a placeholder
  in the 2E-B session. `.env` files remain untracked.
- Temp media (PNG/WAV) and synthetic admin users are deleted in the probe `finally` and manual
  test images were removed.

## 33. Remaining blockers to READY

1. **Image nonce detection** — probe image is sent without lat/lon (design fix applied) but not
   yet live-verified. Needs one approved image call.
2. **Voice spoken-nonce echo** — pronounceable suffix + explicit echo phrase applied to the probe
   but not yet live-verified. Needs one approved audio-understanding call (+ optional TTS).

These are probe-asset/prompt tuning only — no Core or AI service changes are required.

## 34. Run history (all three probe executions)

| Run | Suffix | Gemini calls | Result |
|---|---|---:|---|
| 1 | `67DBED` | 3 | 22 pass / 3 fail (image nonce, spoken nonce, over-strict retry check) |
| 2 | `KILOVICTOR` | 0 | AI server started with no Gemini key (env-name mismatch); 0 provider contact; corrected before run 3 |
| 3 | `MIKEKILO` | 3 | 23 pass / 2 fail (image nonce, spoken nonce) |

The `voice_no_retry` invariant was over-strict in run 1 (flagged a single INDETERMINATE
TTS attempt as a retry); the probe now only flags `attemptNumber !== 1`, and runs 2/3 had
`hasRetry=false` on the Admin API. Run 2 consumed no Gemini budget.

## 35. Exact real Gemini request count

- 2E-B corrective probes: **8** (documented in `phase-2e-b-live-multimodal-probes-report.md`).
- 2E-C run `67DBED`: identify **1** + voice audio **1** + TTS **1** = **3**.
- 2E-C run `KILOVICTOR`: **0** (AI server started with no Gemini key due to env-name mismatch;
  no provider contact; corrected before the next run).
- 2E-C run `MIKEKILO`: identify **1** + voice audio **1** + TTS **1** = **3**.
- **Cumulative: 14** real Gemini requests. Zero provider retries observed.

## 36. Probe invariant results (run `MIKEKILO`)

23 PASS / 2 FAIL out of 25:

```
PASS core_health
PASS identify_http_ok (200)
PASS identify_provider_calls_present (1)
PASS identify_provider_attempts_present (1)
PASS identify_modality_totals_ok
PASS identify_no_retry
FAIL identify_image_nonce_detected
PASS voice_http_ok (200)
PASS voice_provider_calls_present (2)
PASS voice_provider_attempts_present (2)
PASS voice_modality_totals_ok
PASS voice_no_retry
FAIL voice_spoken_nonce_detected
PASS voice_audio_produced
PASS admin_observations_identify_found
PASS admin_observation_identify_callcount (callCount=1, attemptRiskStatus=NONE)
PASS admin_observation_identify_no_retry
PASS admin_observations_voice_found
PASS admin_observation_voice_callcount (callCount=2, attemptRiskStatus=NONE)
PASS admin_observation_voice_no_retry
PASS wallet_unchanged_tokenWallet
PASS wallet_unchanged_tokenTransaction
PASS wallet_unchanged_tokenReservation
PASS wallet_unchanged_aiBillingOperation
PASS aiUsageLog_written (0→3)
```

## 37. Appendix — log files

- `/tmp/rihla-core-roundtrip.log` — Core startup + shadow-pricing event logs (no secrets).
- `/tmp/rihla-ai-service-roundtrip.log` — AI startup, Qdrant init, RAG ingestion (no secrets).
- `/tmp/rihla-http-roundtrip-67DBED.json`, `/tmp/rihla-http-roundtrip-KILOVICTOR.json`,
  `/tmp/rihla-http-roundtrip-MIKEKILO.json` — sanitized machine-readable probe results.
