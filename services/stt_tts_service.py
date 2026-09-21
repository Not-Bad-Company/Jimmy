#!/usr/bin/env python3
"""
Lightweight local STT (faster-whisper) and TTS (Kokoro-82M ONNX) microservice for Jimmy.
Listens on http://127.0.0.1:8001
"""

import os
import io
import time
import logging
from typing import Optional
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
import soundfile as sf
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("jimmy-ai-service")

from contextlib import asynccontextmanager

# Paths
MODELS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
KOKORO_MODEL_PATH = os.path.join(MODELS_DIR, "kokoro-v1.0.onnx")
KOKORO_VOICES_PATH = os.path.join(MODELS_DIR, "voices-v1.0.bin")
WHISPER_MODEL_NAME = os.getenv("STT_MODEL", "base.en")
WHISPER_DEVICE = os.getenv("STT_DEVICE", "cpu")  # cpu or cuda
WHISPER_COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8" if WHISPER_DEVICE == "cpu" else "float16")

# Global instances
whisper_model: Optional[WhisperModel] = None
kokoro_model: Optional[Kokoro] = None
available_voices: list[str] = []

@asynccontextmanager
async def lifespan(app: FastAPI):
    global whisper_model, kokoro_model, available_voices
    logger.info("Initializing Local STT & TTS Service...")

    # Load faster-whisper
    try:
        logger.info(f"Loading Whisper model '{WHISPER_MODEL_NAME}' on {WHISPER_DEVICE} ({WHISPER_COMPUTE_TYPE})...")
        whisper_model = WhisperModel(WHISPER_MODEL_NAME, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
        logger.info("Whisper model loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load Whisper model: {e}")

    # Load Kokoro TTS
    try:
        if os.path.exists(KOKORO_MODEL_PATH) and os.path.exists(KOKORO_VOICES_PATH):
            logger.info(f"Loading Kokoro ONNX model from {KOKORO_MODEL_PATH}...")
            kokoro_model = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)
            available_voices = kokoro_model.get_voices() if hasattr(kokoro_model, "get_voices") else ["bm_george", "af_bella", "am_adam"]
            logger.info(f"Kokoro model loaded with {len(available_voices)} voices.")
        else:
            logger.warning(f"Kokoro model files not found at {MODELS_DIR}")
    except Exception as e:
        logger.error(f"Failed to load Kokoro model: {e}")
    yield

app = FastAPI(title="Jimmy STT/TTS Local Service", version="1.0.0", lifespan=lifespan)

@app.get("/health")
def health():
    return {
        "status": "ok",
        "stt": {
            "loaded": whisper_model is not None,
            "model": WHISPER_MODEL_NAME,
            "device": WHISPER_DEVICE,
        },
        "tts": {
            "loaded": kokoro_model is not None,
            "model": "kokoro-v1.0",
            "voices_count": len(available_voices),
        }
    }

@app.get("/voices")
def list_voices():
    return {"voices": available_voices}

class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = "bm_george"
    speed: Optional[float] = 1.0

@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    if not kokoro_model:
        raise HTTPException(status_code=503, detail="TTS model is not loaded")

    clean_text = req.text.strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Empty text provided")

    start_time = time.perf_counter()
    try:
        voice = req.voice or "bm_george"
        samples, sample_rate = kokoro_model.create(clean_text, voice=voice, speed=req.speed or 1.0)
        
        # Encode to WAV buffer
        buf = io.BytesIO()
        sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
        wav_bytes = buf.getvalue()
        
        duration_s = len(samples) / float(sample_rate)
        latency_ms = round((time.perf_counter() - start_time) * 1000, 2)
        
        headers = {
            "X-Latency-Ms": str(latency_ms),
            "X-Audio-Duration-S": str(round(duration_s, 2)),
            "Content-Type": "audio/wav",
            "Cache-Control": "no-cache",
        }
        return Response(content=wav_bytes, media_type="audio/wav", headers=headers)
    except Exception as e:
        logger.error(f"TTS synthesis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if not whisper_model:
        raise HTTPException(status_code=503, detail="STT model is not loaded")

    start_time = time.perf_counter()
    try:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file")

        audio_file = io.BytesIO(audio_bytes)
        segments, info = whisper_model.transcribe(audio_file, beam_size=1, language="en")
        
        text_parts = [segment.text.strip() for segment in segments]
        transcription = " ".join(text_parts).strip()
        latency_ms = round((time.perf_counter() - start_time) * 1000, 2)
        
        return {
            "text": transcription,
            "language": info.language if info else "en",
            "duration": round(info.duration, 2) if info else 0.0,
            "latency_ms": latency_ms,
        }
    except Exception as e:
        logger.error(f"STT transcription error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
