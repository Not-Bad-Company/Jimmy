# Local AI Engine Specifications & Benchmarks

Rocky runs 100% locally without cloud dependencies once weights are present.

---

## 1. Local LLM Runtime

- **Default Model**: `qwen2.5:7b-instruct-q4_K_M` (upgraded from `Qwen2.5-3B-Instruct` — see "Why 7B, not 3B" below)
- **Quantization**: `Q4_K_M` (~5.1 GB RAM/VRAM footprint)
- **Runtime**: Ollama, OpenAI-compatible API on `http://127.0.0.1:11434/v1`, `response_format: {"type": "json_object"}` enforced on every request.
- **Reasoning**: Disabled (`reasoning: false`).
- **Parameters**:
  - `temperature`: 0.6
  - `top_p`: 0.9
  - `max_tokens`: 120
  - `streaming`: true

### Why 7B, not 3B

`qwen2.5:3b` at temperature 0.3 could not reliably hold the Jimmy character —
it produced stock assistant phrasing ("I'm sorry, but I need more context to
understand...", "I don't have enough information") even with a well-written
personality prompt and few-shot examples. `qwen2.5:7b-instruct-q4_K_M` with
the same prompt held the character consistently across a range of test
prompts (see `docs/performance.md` for the actual test transcript). This is a
direct trade of latency for character adherence — see the "Why 3B was
rejected" numbers below if a future pass wants to try a different tradeoff
(e.g. a fine-tuned 3B, or few-shot-heavy prompting with an even smaller
model).

### Latency profile — CAVEAT: CPU-only measurement, not the RTX 4060

Measured in a sandboxed environment with no GPU passthrough (`ollama ps`
reported `100% CPU` for every model tested; `nvidia-smi` failed outright).
These are **not** representative of the target RTX 4060 and must be
re-measured on real hardware — see `docs/performance.md` for the full
breakdown and the benchmark commands to run.

- Warm first token: ~2–11 s (CPU)
- Warm total generation (short response): ~7–18 s (CPU)

The previous version of this doc claimed "~270–320 ms" first-token latency.
That number was not reproducible and does not match anything measured this
session — treat it as unverified/incorrect, not as a regression from a
previously-working faster state.

---

## 2. Speech-to-Text (STT)

**Current default: Mistral's Voxtral API** (`STT_PROVIDER=mistral`), for the
same reason as the LLM move — the Pi deployment target can't run local STT
compute either. `POST /v1/audio/transcriptions`, model
`voxtral-mini-latest`, **$0.003/minute** (batch). Measured: 435-501ms
transcription latency for short utterances — comparable to local
faster-whisper, no local compute needed. Implemented in
`backend/src/ai/stt.rs`'s `MistralSTTProvider`.

Found and fixed a real bug while wiring this up: the frontend actually
records `audio/webm;codecs=opus` (`frontend/src/audio/recorder.ts`), not
WAV, but both STT providers were hardcoding `mime_str("audio/wav")` when
uploading regardless of actual content. Local faster-whisper tolerated this
silently (decodes via ffmpeg, sniffs real format from content rather than
trusting the declared Content-Type), but a stricter remote API might not
have. Fixed by deriving the real mime type from the uploaded filename's
extension (`mime_for_filename()` in `stt.rs`), used by both providers now.

**Local fallback** (`STT_PROVIDER=local`), still available and unchanged:
- **Engine**: `faster-whisper` (CTranslate2 backend)
- **Model**: `base.en` (English-only, ~140 MB)
- **Compute Type**: `int8` on CPU or `float16` on CUDA
- **Average Transcription Latency**: ~350 ms – 450 ms for short conversational utterances (1–3 seconds of speech)

---

## 3. Text-to-Speech (TTS)

- **Engine**: `kokoro-onnx` (Kokoro-82M ONNX runtime)
- **Model Files**: `kokoro-v1.0.onnx` (~310 MB) + `voices-v1.0.bin` (~27 MB)
- **Default Prototype Voice**: `bm_george` (British Male George — concise, direct, articulate tone)
- **Available Voices**: 54 distinct voices included in the voice bank (`am_adam`, `af_bella`, `bm_george`, `bm_fable`, etc.)
- **Average Synthesis Latency**: ~600 ms – 900 ms for typical Rocky sentences (10–15 words)

---

## 4. End-to-End Latency Breakdown

Actually measured this session (CPU-only sandbox — see caveat above), from a
real `/api/voice-turn` integration test run ("Hello Rocky!"):

| Phase | Duration |
| :--- | :--- |
| **STT Transcription** | 940 ms |
| **LLM Time-to-First-Token** | 1999 ms |
| **LLM Complete Response** | 7353 ms |
| **Kokoro TTS Synthesis** | 937 ms |
| **Total Voice-to-Voice Turn** | **9240 ms** |

This is well above the brief's target ("sub-second first speech" after
warmup). It is very likely CPU-vs-GPU, not an architectural problem — Ollama
never touched the GPU in this sandbox. Re-run
`services/.venv/bin/python tests/test_full_system.py` on the RTX 4060 machine
and update this table with real numbers before treating latency as solved.

---

## 5. LLM Provider: Mistral API (current default, replaces local Ollama)

Switched from local Ollama to Mistral's cloud API (`LLM_PROVIDER=mistral`)
because this project's actual deployment target is a Raspberry Pi, which
cannot run a 7B local model. `backend/src/ai/llm.rs`'s
`OpenAICompatibleProvider` (renamed from `LocalLlamaCppProvider` — it was
already just a generic OpenAI-compatible chat-completions client) now
supports an optional Bearer token, used for `MISTRAL_KEY`. No other code
changes were needed since Mistral's `/v1/chat/completions` API is schema-
compatible with what was already being sent (messages, temperature, top_p,
max_tokens, stream, `response_format: json_object`). Added
`reasoning_effort: "none"` to the request (wired to the previously-unused
`LLM_REASONING` config flag) since Mistral Small 4 is a hybrid
instruct/reasoning model and the brief requires non-chain-of-thought output.

- **Model**: `mistral-small-latest` (resolves to Mistral Small 4 as of this
  writing). **$0.15/M input, $0.60/M output** — verified directly against
  `mistral.ai/pricing/api`, not a third-party blog.
- **Latency** (network round-trip from this dev machine): 263-514ms first
  token, 476-698ms total for a short response. Comparable to the local GPU
  setup, without needing a GPU at all — the right tradeoff for a Pi target.

### Known gotcha: new accounts can get stuck at 0 req/min

A brand-new Mistral account can show **real, nonzero rate limits on the
Admin > Limits page** while the actual API gateway enforces
`x-ratelimit-limit-req-minute: 0` on every request — confirmed with curl
using Mistral's own docs example verbatim, across two different API keys,
with the Usage dashboard showing 0 total requests ever received (rejected
at the gateway, never reaching their logging layer). This took real
troubleshooting time to resolve and wasn't a code issue at any point:

1. Adding a **prepaid credit balance is not sufficient** on its own —
   Mistral's own help center is explicit: *"Adding credits does not raise
   your rate limits... tiers track cumulative billing from usage, not
   prepaid credit top-ups."*
2. The actual fix is a **separate, explicit "Enable pay-as-you-go" toggle**
   in Studio's Subscription/Billing page (distinct from "Vibe," Mistral's
   unrelated chat-assistant product with its own subscription — don't
   enable that one, it does nothing for API access).
3. Even after enabling pay-as-you-go, it took **~1-2 minutes to propagate**
   (confirmed via polling every 25s) before the rate limit actually went
   from 0 to a real number (100 req/min, in this case).

If a fresh Mistral setup ever shows this again: check Admin > Billing for
"pay-as-you-go" specifically (not just a credit balance), and give it a
minute or two after enabling before assuming it's still broken.

---

## 6. Deterministic Mock Mode

Rocky includes a mock mode allowing complete developer testing with zero external services, zero GPU, and zero model weights:
- **LLM**: Emits realistic canned Rocky responses with simulated token streaming (~40ms first token, ~150ms total).
- **STT**: Returns deterministic transcription in ~85ms.
- **TTS**: Emits valid 16-bit 16kHz PCM WAV audio in ~60ms.
- **Activation**: Set `LLM_PROVIDER=mock`, `STT_PROVIDER=mock`, `TTS_PROVIDER=mock` in `.env`.
