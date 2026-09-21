# Rocky Developer Guide

## 1. Prerequisites

- **Rust toolchain** (1.80+): `rustc`, `cargo`
- **Node.js** (v20+) & `npm`
- **Python** (3.11 or 3.12) with `uv`
- **Ollama** or `llama-server` (optional for mock mode, required for local LLM)

---

## 2. Quick Setup

### Step 1: Environment File
```bash
cp .env.example .env
```

### Step 2: Install Python Dependencies & Download Model Weights
```bash
# Create virtual environment and install faster-whisper & kokoro-onnx
mkdir -p services && uv venv services/.venv --python 3.12
uv pip install --python services/.venv faster-whisper kokoro-onnx soundfile fastapi uvicorn python-multipart websockets

# Download lightweight Kokoro ONNX model files (~330MB total)
mkdir -p models
curl -L -o models/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o models/voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

# Pull local LLM (Qwen2.5-3B-Instruct)
ollama pull qwen2.5:3b
```

### Step 3: Build Frontend
```bash
npm --prefix frontend install
npm --prefix frontend run build
```

### Step 4: Build Backend
```bash
cargo build --manifest-path backend/Cargo.toml
```

---

## 3. Running Rocky

### Mode A: Full Local AI (Default)

1. Start Ollama:
   ```bash
   ollama serve
   ```

2. Start the STT & TTS Service:
   ```bash
   services/.venv/bin/python services/stt_tts_service.py
   ```

3. Start Rocky Backend:
   ```bash
   backend/target/debug/rocky-backend
   ```

4. Open your browser:
   `http://127.0.0.1:3000`

### Mode B: Deterministic Mock Mode (No Models, No GPU Needed)

In `.env`, set:
```env
LLM_PROVIDER=mock
STT_PROVIDER=mock
TTS_PROVIDER=mock
```

Start the backend:
```bash
backend/target/debug/rocky-backend
```
Open `http://127.0.0.1:3000`. You can interact with Rocky using the text box or test buttons with 0 external dependencies.

---

## 4. Running Automated Tests

### Rust Unit & Integration Tests:
```bash
cargo test --manifest-path backend/Cargo.toml
```

### Full System Automated Integration Test:
```bash
services/.venv/bin/python tests/test_full_system.py
```

### Linting & Formatting:
```bash
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo clippy --manifest-path backend/Cargo.toml
```
