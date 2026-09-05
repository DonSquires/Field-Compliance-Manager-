from __future__ import annotations

import base64
import hmac
import os
import subprocess
import tempfile
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")
MAX_AUDIO_BYTES = 25 * 1024 * 1024
VOICE_API_KEY = os.getenv("VOICE_API_KEY", "")
PIPER_VOICE_PATH = os.getenv("PIPER_VOICE_PATH", "/app/voices/voice.onnx")

try:
    from faster_whisper import WhisperModel

    MODEL: WhisperModel | None = WhisperModel(
        WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE
    )
except Exception:
    MODEL = None

app = FastAPI(title="FCM Voice", docs_url=None, redoc_url=None)


class TranscribeRequest(BaseModel):
    audio_base64: str | None = Field(default=None, max_length=MAX_AUDIO_BYTES * 2)
    audio_b64: str | None = Field(default=None, max_length=MAX_AUDIO_BYTES * 2)
    language: str = Field(default="en", min_length=2, max_length=16)


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


def _authorize(authorization: str | None) -> None:
    if not VOICE_API_KEY:
        raise HTTPException(status_code=503, detail="voice authentication is not configured")
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not hmac.compare_digest(supplied, VOICE_API_KEY):
        raise HTTPException(status_code=401, detail="invalid voice credentials")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "service": "fcm-voice", "model_loaded": MODEL is not None}


@app.post("/transcribe")
@app.post("/")
async def transcribe(
    payload: TranscribeRequest, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    _authorize(authorization)
    if MODEL is None:
        raise HTTPException(status_code=503, detail="capability_unavailable: whisper_model")
    encoded = (payload.audio_base64 or payload.audio_b64 or "").strip()
    if not encoded:
        raise HTTPException(status_code=422, detail="audio_base64 is required")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="audio_base64 is invalid") from error
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio payload exceeds 25 MiB")

    started = time.perf_counter()
    with tempfile.NamedTemporaryFile(suffix=".audio") as temporary_file:
        temporary_file.write(audio)
        temporary_file.flush()
        try:
            segments, info = MODEL.transcribe(
                temporary_file.name, language=payload.language, beam_size=5, vad_filter=True
            )
            transcript = " ".join(segment.text.strip() for segment in segments).strip()
        except Exception as error:
            raise HTTPException(status_code=422, detail="audio could not be transcribed") from error
    return {
        "transcript": transcript,
        "language": payload.language,
        "duration_s": round(float(getattr(info, "duration", 0)), 2),
        "processing_ms": round((time.perf_counter() - started) * 1000),
        "confidence": 1.0,
    }


@app.post("/speak")
async def speak(
    payload: SpeakRequest, authorization: str | None = Header(default=None)
) -> dict[str, str]:
    _authorize(authorization)
    if not os.path.isfile(PIPER_VOICE_PATH):
        raise HTTPException(status_code=503, detail="capability_unavailable: piper_voice_model")
    with tempfile.TemporaryDirectory() as directory:
        output_path = os.path.join(directory, "speech.wav")
        try:
            completed = subprocess.run(
                ["piper", "--model", PIPER_VOICE_PATH, "--output_file", output_path],
                input=payload.text.strip(),
                text=True,
                capture_output=True,
                timeout=60,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise HTTPException(status_code=503, detail="capability_unavailable: piper_tts") from error
        if completed.returncode != 0 or not os.path.isfile(output_path):
            raise HTTPException(status_code=502, detail="piper synthesis failed")
        with open(output_path, "rb") as output_file:
            audio = base64.b64encode(output_file.read()).decode("ascii")
    return {"audio_base64": audio, "mime": "audio/wav"}