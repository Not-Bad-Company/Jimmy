#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Starting Rocky Ecosystem ==="

# 1. Ensure Ollama is running
if ! curl -s http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
    echo "Starting Ollama server..."
    ollama serve > /dev/null 2>&1 &
    sleep 2
fi

# 2. Ensure STT & TTS service is running
if ! curl -s http://127.0.0.1:8001/health > /dev/null 2>&1; then
    echo "Starting local STT & TTS microservice..."
    services/.venv/bin/python services/stt_tts_service.py > /tmp/rocky_ai_service.log 2>&1 &
    sleep 2
fi

# 3. Check health of services
echo "Checking service health..."
curl -s http://127.0.0.1:8001/health || true
echo ""

# 4. Start Rust Backend
echo "Launching Rocky Rust Backend on http://127.0.0.1:3000..."
exec backend/target/debug/rocky-backend
