#!/usr/bin/env python3
"""
Lightweight local STT (faster-whisper) and TTS (Kokoro-82M ONNX) microservice for Jimmy.
Listens on http://127.0.0.1:8001
"""

import os
import io
import re
import time
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Optional
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
import soundfile as sf
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

# Kokoro's sentence_pause/clause_pause parameters only take effect when its
# internal chunker splits text across its ~510-phoneme model limit — short
# text (like Jimmy's replies, which are always short by design) never hits
# that limit, so those parameters silently do nothing and Kokoro's own
# built-in pause-on-period is all you get, which is barely perceptible
# ("immediately continues" after a period). Splitting on sentence boundaries
# ourselves and inserting real, controllable silence between each
# synthesized sentence is the only way to actually get that pause.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

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
    # Kokoro has no direct "emotion" control, but pause timing between
    # sentences/clauses meaningfully changes how expressive the delivery
    # sounds (clipped and urgent vs. slow and deliberate). The backend
    # derives these from Jimmy's selected emotion + intensity.
    sentence_pause: Optional[float] = 0.25
    clause_pause: Optional[float] = 0.1

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
        speed = req.speed or 1.0
        sentence_pause = req.sentence_pause if req.sentence_pause is not None else 0.25

        sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(clean_text) if s.strip()]
        if len(sentences) <= 1:
            samples, sample_rate = kokoro_model.create(clean_text, voice=voice, speed=speed)
        else:
            # Synthesizing each sentence is a separate ONNX inference call;
            # run them concurrently (onnxruntime releases the GIL during
            # the actual compute) instead of sequentially, so N sentences
            # cost roughly one inference's wall-clock time instead of N —
            # a sequential version of this was measured taking 7+ seconds
            # for an 8-sentence reply.
            results = [None] * len(sentences)
            sample_rate = 24000

            def _synth(i: int, sentence: str):
                part_samples, sr = kokoro_model.create(sentence, voice=voice, speed=speed)
                results[i] = (part_samples, sr)

            with ThreadPoolExecutor(max_workers=min(8, len(sentences))) as pool:
                list(pool.map(lambda args: _synth(*args), enumerate(sentences)))

            chunks = []
            for i, (part_samples, sr) in enumerate(results):
                sample_rate = sr
                chunks.append(part_samples)
                if i < len(sentences) - 1 and sentence_pause > 0:
                    silence = np.zeros(int(sentence_pause * sr), dtype=part_samples.dtype)
                    chunks.append(silence)
            samples = np.concatenate(chunks)

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
