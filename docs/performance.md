# Performance

## Eventual target: Raspberry Pi

This pipeline is meant to eventually run on a Raspberry Pi, not just this
RTX 4060 dev laptop. That's a hard constraint worth keeping in view even
though hardware bring-up is explicitly out of scope for now:

- `qwen2.5:7b-instruct-q4_K_M` (~4.7 GB) is a laptop-GPU-era choice. A Pi
  (even a Pi 5, no real GPU, shared/limited RAM) will not run a 7B model at
  usable conversational latency — this model choice is right for iterating
  on personality quality *now*, not for the eventual deployment target.
- When hardware work starts, expect to revisit the LLM choice toward either
  a much smaller local model (1-3B class, likely a fine-tune rather than
  prompt-engineered, since small models are exactly where prompt-only
  steering was shown to fail this session) or an on-device-friendly
  runtime (e.g. llama.cpp directly, quantized further), or a hybrid where
  the Pi is a thin client talking to a beefier machine on the local network
  rather than running inference itself.
- STT (`faster-whisper base.en`) and TTS (Kokoro-82M) are both plausible on
  a Pi 5 but will need their own re-benchmarking there; don't assume the
  RTX 4060 numbers transfer down.
- Keep this in mind when making architecture decisions now: prefer changes
  that degrade gracefully to a smaller model/weaker hardware over changes
  that only work because a strong GPU is available.

## Measured latencies

### CPU (early in this session, before GPU was engaged)

The GPU on this laptop is powered off by default to save battery (hybrid
graphics, toggled by `supergfxctl`), and Ollama silently falls back to CPU if
it's off when Ollama starts. Nothing in the app surfaces this — the `/health`
endpoint reports `"llm": true` either way. **Always check `ollama ps` and
confirm `100% GPU`, not `100% CPU`, before trusting any latency number.**

| Stage | Cold (first request) | Warm (steady state) |
|---|---|---|
| LLM (`qwen2.5:7b-instruct-q4_K_M`) first token | ~30–45 s (model load into RAM) | ~2–11 s |
| LLM total (short response, ~120 max tokens) | ~30–51 s | ~7–18 s |

### GPU (RTX 4060 Laptop, confirmed `100% GPU` via `ollama ps`)

Once actually on GPU, same model:

| Stage | Cold (first request, model load into VRAM) | Warm (steady state) |
|---|---|---|
| LLM first token | ~2.6 s | **46–70 ms** |
| LLM total (short response) | ~2.6 s | **1.3–2.6 s** (includes TTS) |
| TTS (Kokoro-82M ONNX, CPU) | — | ~555–1570 ms |
| Full `/api/chat` round trip (LLM + TTS) | — | 1.3–2.6 s |

This is the real number — CPU (above) was purely an artifact of the GPU
being powered off, not a reflection of the actual hardware. See
"Dedicated Ollama instance" below for why a second, separate Ollama process
is used instead of the machine's default systemd-managed one.

### Dedicated Ollama instance for Jimmy

This machine already runs a system-wide `ollama.service` (systemd, port
11434) tuned for the user's other, much larger local models — notably
`OLLAMA_KV_CACHE_TYPE=q4_0` (quantized KV cache), presumably to fit 15-17GB
MoE models in 8GB of VRAM. That quantization **measurably corrupts
`qwen2.5:7b-instruct-q4_K_M`'s output** — confirmed by direct comparison:
identical prompt, identical everything else, quantized KV cache produces
garbled/repeated-token garbage ("kukuk", "pérdidaiureuve", runs of random
words), full-precision KV cache produces clean text every time.

Rather than touch the user's global Ollama tuning (which they rely on for
other models), Jimmy runs its **own** Ollama instance on port 11435 with its
own model store (`~/.ollama-jimmy` by default, override with
`JIMMY_OLLAMA_MODELS`), started by `start.sh`. `.env`'s `LLM_BASE_URL`
points at `11435`, not the default `11434`. If you ever see garbled output
again, the first thing to check is `ollama ps` against the right port — a
KV-cache-quantized instance answering on 11435 (e.g. because someone
manually ran `ollama serve` there without the right env) will reproduce this
exact failure mode.

## Two correctness bugs found while chasing GPU latency

Switching to GPU exposed two real bugs that CPU's slower pace had been
masking:

1. **SSE line-buffering bug** (`backend/src/ai/llm.rs`): the streaming
   response parser called `.lines()` on each individual HTTP chunk
   independently. At GPU speed, a single `data: {...}` SSE line can arrive
   split across two separate chunk reads; the second half then fails to
   parse as JSON on its own and was silently dropped — losing that token
   permanently. Fixed with a persistent buffer across chunks that only
   consumes complete lines. This was always a latent bug; CPU generation was
   just slow enough that lines rarely straddled a chunk boundary.
2. **Conversation-history poisoning** (`backend/src/api/routes.rs` +
   `backend/src/ai/llm.rs`): if a single LLM generation ever came back
   degenerate (empty, or bare JSON punctuation with no real words — this
   can happen from ordinary sampling variance, independent of bug #1), the
   backend stored that garbage verbatim as the assistant's turn in
   conversation history. Every subsequent request then included that
   garbage in its prompt context, and the model — primed by its own
   malformed prior turn — kept producing garbage too. One bad generation
   silently and permanently broke the rest of the conversation until a
   manual `/api/conversation/clear`. Fixed in `parse_structured_output`:
   any output with no alphabetic characters at all now falls back to a
   short safe line ("Hm. Say again?") instead of being stored as-is. This
   stops the cascade; it does not explain why a generation goes degenerate
   in the first place — that looked like ordinary temperature-0.6 sampling
   variance in testing, not a systemic issue, but keep an eye on it.

## Streaming TTS: not implemented, and why

The brief calls for LLM-stream → sentence-chunk → TTS → playback overlap so
audio starts before the full LLM response is generated. This is **not**
implemented; `backend/src/api/routes.rs` calls `tts.synthesize()` once,
after the full LLM response text is available (see `/api/chat` and
`/api/voice-turn` handlers).

Reasons this was deliberately left as a known gap rather than rushed in:

1. **Jimmy's responses are already short by design** (personality prompt
   targets 1–2 short sentences, `LLM_MAX_TOKENS=120`). TTS is ~1–1.5 s of a
   ~7–18 s total; the overlap window is small relative to LLM time, so the
   win is smaller than it would be for a chatbot generating paragraphs.
2. **The LLM speaks structured JSON**, not plain text
   (`{"response": "...", "emotion": ...}`). Sentence-boundary chunking
   requires incrementally parsing a partial JSON string value out of the
   token stream (handling escapes, unclosed quotes, the field arriving
   before you know whether more sentences follow) — meaningfully more complex
   than chunking plain streamed text, and easy to get subtly wrong.
3. This environment has no audio output to verify a streaming implementation
   actually sounds right (no gaps, no clipped first word) rather than just
   "doesn't crash."

**If/when this gets built**, the right shape is: incrementally scan the
`token_callback` stream in `backend/src/ai/llm.rs` for the closing quote of
the `"response"` field, split whatever text has arrived on sentence-ending
punctuation, fire `tts.synthesize()` per completed sentence, and stream WAV
chunks to the frontend over the existing WebSocket as separate `audio_chunk`
events for gapless sequential playback. Do this only after real latency
numbers exist for the actual scenario (7B model on the RTX 4060) — if warm
LLM total time drops to ~1-2s on GPU as expected, the payoff shrinks further
and it may not be worth the complexity at all.

## What to benchmark once GPU access exists

```bash
ollama ps                      # confirm 100% GPU, not CPU
time curl -s http://127.0.0.1:3000/api/chat -X POST \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello.","synthesize_audio":false}'
```
Run 5-10x back to back (warm) and note `llm_first_token_ms` / `llm_total_ms`
from the response body.
