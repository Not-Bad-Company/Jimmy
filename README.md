# Jimmy — Autonomous Robotic Companion

Jimmy is a desktop-web robotic companion software brain and animated OLED eye interface. He features local speech recognition, a local instruction LLM tuned with Jimmy's direct, pragmatic personality, real-time structured emotional expressions, and local text-to-speech audio synthesis.

```
USER SPEAKS (Microphone)
       ↓
Local Speech-to-Text (faster-whisper)
       ↓
Jimmy Receives Text
       ↓
Local LLM (Qwen2.5-3B-Instruct) + Personality Prompt
       ↓
Emotional State & Gaze Determined ({ emotion, intensity, gaze })
       ↓
Animated Robotic Eyes Immediately React (RoboEyes 128x64 Canvas)
       ↓
Text-to-Speech (Kokoro-82M ONNX)
       ↓
Jimmy Speaks & Eyes Animate Sync
       ↓
Return to Idle Automatically
```

---

## Highlights

- **100% Local Inference**: Runs entirely on the host machine (optimized for NVIDIA RTX 4060 / CPU). No cloud dependencies.
- **Expressive OLED Face**: Canonical 128×64 logical resolution canvas adapted from the open-source **FluxGarage RoboEyes** library (GPL-3.0), ready to be transferred directly to physical 128x64 SSD1306/SSD1327 OLED screens in future phases.
- **LLM Latency (RTX 4060, GPU — confirmed via `ollama ps` showing `100% GPU`)**: warm first token **46–70 ms**, full `/api/chat` round trip including TTS **1.3–2.6 s**. Note: the dGPU is powered off by default on this laptop to save battery — if you ever see multi-second latency, run `ollama ps` first and confirm it says GPU, not CPU. See `docs/performance.md` for the CPU-fallback numbers and how GPU access is wired up (a dedicated Ollama instance on port 11435, separate from any other Ollama instance on this machine — see `docs/performance.md`'s "Dedicated Ollama instance" section for why).
- **Distinct Personality**: Dedicated prompt inspired by Jimmy's character characteristics (concise, direct, highly intelligent, simple grammar, occasional repetition for emphasis, original dialogue).
- **Structured Emotion System**: Backend validates explicit states (`neutral`, `happy`, `sad`, `angry`, `surprised`, `curious`, `confused`, `sleepy`, `thinking`, `listening`, `speaking`, `error`) and gaze directions.
- **Deterministic Mock Mode**: The entire UI and API can be run and tested without any GPU, models, microphone, or external services.

---

## Quickstart

### 1. Requirements
- Rust (1.80+)
- Node.js (v20+)
- Python 3.12 with `uv`
- Ollama with `qwen2.5:7b-instruct-q4_K_M`

### 2. Setup
```bash
# 1. Environment file
cp .env.example .env

# 2. Python environment & local model files
mkdir -p services && uv venv services/.venv --python 3.12
uv pip install --python services/.venv faster-whisper kokoro-onnx soundfile fastapi uvicorn python-multipart websockets

# Download Kokoro ONNX model weights (~330MB)
mkdir -p models
curl -L -o models/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o models/voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

# Pull the model into Jimmy's OWN dedicated Ollama instance (port 11435),
# not your default one on 11434. This matters: if you already run Ollama
# system-wide with tuning for other/larger models (e.g. quantized KV cache
# to fit big models in VRAM), that tuning measurably corrupts this model's
# output. See docs/performance.md's "Dedicated Ollama instance" section.
OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MODELS="$HOME/.ollama-jimmy" ollama pull qwen2.5:7b-instruct-q4_K_M

# 3. Build frontend
npm --prefix frontend install
npm --prefix frontend run build

# 4. Build backend
cargo build --manifest-path backend/Cargo.toml
```

### 3. Running Jimmy

`start.sh` starts everything (Jimmy's dedicated Ollama instance on 11435,
the STT/TTS service, and the backend) in one shot:
```bash
./start.sh
```

Or manually, in separate terminals:
```bash
# Terminal 1: Jimmy's dedicated Ollama instance (NOT the system default)
OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MODELS="$HOME/.ollama-jimmy" ollama serve

# Terminal 2: Local STT & TTS Service
services/.venv/bin/python services/stt_tts_service.py

# Terminal 3: Jimmy Rust Backend
backend/target/debug/jimmy-backend
```

For frontend iteration with hot-reload, also run `npm --prefix frontend run dev`
and use `http://127.0.0.1:5173` instead of `:3000` — Vite proxies `/api` and
`/ws` through to the backend automatically.

Note: on hybrid-graphics laptops the dGPU may be powered off by default.
Check `ollama ps` after your first request — it should say `100% GPU`, not
`100% CPU`. See `docs/performance.md` if it doesn't.

Open **`http://127.0.0.1:3000`** in your browser.

---

## Architecture & Documentation

- [System Architecture](docs/architecture.md)
- [Local AI Specifications & Benchmarks](docs/local-ai.md)
- [OLED Eye Renderer & RoboEyes Adaptation](docs/face.md)
- [Developer Guide & Testing](docs/development.md)

---

## Testing

Run unit & integration tests:
```bash
# Rust tests
cargo test --manifest-path backend/Cargo.toml

# Full system automated end-to-end test
services/.venv/bin/python tests/test_full_system.py
```

---

## License & Attribution

- **FluxGarage RoboEyes**: Original C++ library by Dennis Hoelscher ([FluxGarage](https://www.fluxgarage.com)), licensed under GPL-3.0.
- **Jimmy Project**: Open software prototype for personal robotic experimentation.
