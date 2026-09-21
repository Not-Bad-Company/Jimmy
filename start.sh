#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Starting Jimmy Ecosystem ==="

# 1. Ensure a dedicated Ollama instance is running for Jimmy, on its own
# port (11435) and model store. This is deliberately separate from any
# system-wide `ollama` you may already run (e.g. a systemd service on the
# default 11434) because that instance may have global tuning — such as
# quantized KV cache (OLLAMA_KV_CACHE_TYPE) — set for *other*, larger
# models you run. That quantization measurably corrupts this project's
# model's output (garbled/repeated tokens). Jimmy gets its own instance
# with full-precision KV cache so it stays untouched by your global config.
JIMMY_OLLAMA_PORT=11435
JIMMY_OLLAMA_MODELS="${JIMMY_OLLAMA_MODELS:-$HOME/.ollama-jimmy}"
if ! curl -s "http://127.0.0.1:${JIMMY_OLLAMA_PORT}/api/tags" > /dev/null 2>&1; then
    echo "Starting dedicated Ollama instance for Jimmy on port ${JIMMY_OLLAMA_PORT}..."
    mkdir -p "$JIMMY_OLLAMA_MODELS"
    OLLAMA_HOST="127.0.0.1:${JIMMY_OLLAMA_PORT}" OLLAMA_MODELS="$JIMMY_OLLAMA_MODELS" \
        ollama serve > /tmp/jimmy_ollama.log 2>&1 &
    sleep 2
fi

# 2. Ensure STT & TTS service is running
if ! curl -s http://127.0.0.1:8001/health > /dev/null 2>&1; then
    echo "Starting local STT & TTS microservice..."
    services/.venv/bin/python services/stt_tts_service.py > /tmp/jimmy_ai_service.log 2>&1 &
    sleep 2
fi

# 3. Check health of services
echo "Checking service health..."
curl -s http://127.0.0.1:8001/health || true
echo ""

# 4. Start Rust Backend (automatically detects port 3000 or finds next available port if in use)
echo "Launching Jimmy Rust Backend..."
exec backend/target/debug/jimmy-backend
