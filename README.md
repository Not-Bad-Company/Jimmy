# Rocky (Jimmy) — Autonomous Robotic Companion

Rocky is a desktop-web robotic companion software brain and animated OLED eye interface. He features local speech recognition, a local instruction LLM tuned with Rocky's direct, pragmatic personality, real-time structured emotional expressions, and local text-to-speech audio synthesis.

```
USER SPEAKS (Microphone)
       ↓
Local Speech-to-Text (faster-whisper)
       ↓
Rocky Receives Text
       ↓
Local LLM (Qwen2.5-3B-Instruct) + Personality Prompt
       ↓
Emotional State & Gaze Determined ({ emotion, intensity, gaze })
       ↓
Animated Robotic Eyes Immediately React (RoboEyes 128x64 Canvas)
       ↓
Text-to-Speech (Kokoro-82M ONNX)
       ↓
Rocky Speaks & Eyes Animate Sync
       ↓
Return to Idle Automatically
```

---

## Highlights

- **100% Local Inference**: Runs entirely on the host machine (optimized for NVIDIA RTX 4060 / CPU). No cloud dependencies.
- **Expressive OLED Face**: Canonical 128×64 logical resolution canvas adapted from the open-source **FluxGarage RoboEyes** library (GPL-3.0), ready to be transferred directly to physical 128x64 SSD1306/SSD1327 OLED screens in future phases.
- **Sub-Second LLM Latency**: First token typically emitted in **~270–320 ms**; full response completed in under **1 second**.
- **Distinct Personality**: Dedicated prompt inspired by Rocky's character characteristics (concise, direct, highly intelligent, simple grammar, occasional repetition for emphasis, original dialogue).
- **Structured Emotion System**: Backend validates explicit states (`neutral`, `happy`, `sad`, `angry`, `surprised`, `curious`, `confused`, `sleepy`, `thinking`, `listening`, `speaking`, `error`) and gaze directions.
- **Deterministic Mock Mode**: The entire UI and API can be run and tested without any GPU, models, microphone, or external services.

---

## Quickstart

### 1. Requirements
- Rust (1.80+)
- Node.js (v20+)
- Python 3.12 with `uv`
- Ollama with `qwen2.5:3b`

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

# Pull local Qwen2.5 3B model
ollama pull qwen2.5:3b

# 3. Build frontend
npm --prefix frontend install
npm --prefix frontend run build

# 4. Build backend
cargo build --manifest-path backend/Cargo.toml
```

### 3. Running Rocky
```bash
# Terminal 1: Ollama
ollama serve

# Terminal 2: Local STT & TTS Service
services/.venv/bin/python services/stt_tts_service.py

# Terminal 3: Rocky Rust Backend
backend/target/debug/rocky-backend
```

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
- **Rocky Project**: Open software prototype for personal robotic experimentation.
