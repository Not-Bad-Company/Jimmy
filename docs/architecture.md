# Rocky System Architecture

Rocky is an autonomous robotic companion software brain and expressive OLED face designed for real-time natural spoken interaction.

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

## 1. System Components

### 1.1 Rust Axum Backend (`backend/`)
- **Web Framework**: Axum 0.8 on Tokio runtime with Tower HTTP middleware (CORS, TraceLayer, ServeDir).
- **Robot State Machine** (`backend/src/robot/`):
  - Manages states: `IDLE`, `LISTENING`, `THINKING`, `SPEAKING`, `ERROR`.
  - Manages emotions: `NEUTRAL`, `HAPPY`, `SAD`, `ANGRY`, `SURPRISED`, `CURIOUS`, `CONFUSED`, `SLEEPY`, `THINKING`, `LISTENING`, `SPEAKING`, `ERROR`.
  - Manages gaze: `CENTER`, `UP`, `DOWN`, `LEFT`, `RIGHT`, diagonal orientations.
  - Watchdog timer: Automatically rescues from stuck states (30s timeout on listening, 60s timeout on thinking/speaking).
  - Broadcasts events to all active WebSocket clients via `tokio::sync::broadcast`.
- **AI Abstractions** (`backend/src/ai/`):
  - `LLMProvider`: `LocalLlamaCppProvider` (connects to local OpenAI-compatible endpoint) and `MockLLMProvider`.
  - `STTProvider`: `FasterWhisperProvider` (HTTP client to local STT service) and `MockSTTProvider`.
  - `TTSProvider`: `LocalTTSProvider` (HTTP client to local Kokoro service) and `MockTTSProvider`.
- **Conversation Store** (`backend/src/conversation/`):
  - In-memory conversation history with automatic pruning to conserve model context and keep inference fast.

### 1.2 Local STT & TTS Service (`services/stt_tts_service.py`)
- Python FastAPI micro-daemon on `http://127.0.0.1:8001`.
- **STT**: `faster-whisper` running `base.en` with int8 compute (sub-400ms latency).
- **TTS**: `kokoro-onnx` running `kokoro-v1.0.onnx` with `voices-v1.0.bin` (sub-700ms synthesis).

### 1.3 Web Face & Interaction Frontend (`frontend/`)
- Pure TypeScript, Vite, HTML5 Canvas 2D.
- Canonical **128 × 64** logical resolution rendered to screen with aspect-ratio preservation.
- Adapted from **FluxGarage RoboEyes** (Dennis Hoelscher, GPL-3.0) with custom speaking pulse, gaze transitions, and emotion overlays.
- Real-time WebSocket connection to `/ws` with automatic reconnection.
- Push-to-Talk microphone recording via MediaRecorder API.
- Audio playback synchronization with speaking eye animations.

---

## 2. API Contract

### 2.1 REST Endpoints
- `GET /health`: Returns health status of backend, LLM, STT, and TTS.
- `GET /api/status`: Current robot state, emotion, and active models.
- `GET /api/conversation`: Message history array.
- `POST /api/conversation/clear`: Clears conversation history and returns robot to IDLE.
- `POST /api/chat`: Text chat fallback. Body: `{"message": "...", "synthesize_audio": true}`.
- `POST /api/voice-turn`: Full spoken turn. Receives multipart `audio` file, executes STT → LLM → TTS, returns text, emotion, audio base64, and latency breakdown.
- `POST /api/synthesize`: Standalone TTS synthesis. Body: `{"text": "...", "voice": "bm_george"}`. Returns `audio/wav`.
- `GET /api/voices`: Returns available Kokoro voice identifiers.
- `POST /api/robot/override`: Developer override for state, emotion, intensity, and gaze.

### 2.2 WebSocket Protocol (`/ws`)
- **Server to Client**:
  - `initial_state`: Emitted on connect.
  - `state_change`: Emitted on state/emotion transitions.
  - `token`: Streaming LLM response tokens.
  - `transcription`: Emitted when user audio is transcribed.
  - `response_complete`: Emitted when LLM finishes, contains full text, emotion, and latency metrics.
- **Client to Server**:
  - `force_emotion`: `{"type": "force_emotion", "payload": {"emotion": "happy", "intensity": 0.8}}`
  - `force_state`: `{"type": "force_state", "payload": {"state": "thinking"}}`
  - `speech_finished`: `{"type": "speech_finished"}`
