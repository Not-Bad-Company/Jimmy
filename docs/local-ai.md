# Local AI Engine Specifications & Benchmarks

Rocky runs 100% locally without cloud dependencies once weights are present.

---

## 1. Local LLM Runtime

- **Default Model**: `Qwen2.5-3B-Instruct`
- **Quantization**: `Q4_K_M` (1.9 GB VRAM/RAM footprint)
- **Runtime**: Ollama or `llama.cpp` (`llama-server`) exposing an OpenAI-compatible API on `http://127.0.0.1:11434/v1`.
- **Reasoning**: Disabled (`reasoning: false`). Qwen2.5-3B-Instruct is a fast, highly capable direct instruction model without chain-of-thought overhead.
- **Parameters**:
  - `temperature`: 0.3
  - `top_p`: 0.9
  - `max_tokens`: 120
  - `streaming`: true

### Latency Profile
- **Warm First Token**: ~270 ms – 320 ms
- **Total Generation (10–20 tokens)**: ~750 ms – 1100 ms
- **Throughput**: ~25–35 tokens/second on Intel Core i7-12700H / RTX 4060

---

## 2. Speech-to-Text (STT)

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

Measured on typical conversational turn ("That is a bad idea."):

| Phase | Duration |
| :--- | :--- |
| **STT Transcription** | ~365 ms |
| **LLM Time-to-First-Token** | ~271 ms |
| **LLM Complete Response** | ~758 ms |
| **Kokoro TTS Synthesis** | ~641 ms |
| **Total Voice-to-Voice Turn** | **~1769 ms** |

---

## 5. Deterministic Mock Mode

Rocky includes a mock mode allowing complete developer testing with zero external services, zero GPU, and zero model weights:
- **LLM**: Emits realistic canned Rocky responses with simulated token streaming (~40ms first token, ~150ms total).
- **STT**: Returns deterministic transcription in ~85ms.
- **TTS**: Emits valid 16-bit 16kHz PCM WAV audio in ~60ms.
- **Activation**: Set `LLM_PROVIDER=mock`, `STT_PROVIDER=mock`, `TTS_PROVIDER=mock` in `.env`.
