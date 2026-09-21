#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Starting Jimmy Ecosystem ==="

# 1. Ensure Ollama is running
if ! curl -s http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
    echo "Starting Ollama server..."
    ollama serve > /dev/null 2>&1 &
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
