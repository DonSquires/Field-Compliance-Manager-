from __future__ import annotations

import hmac
import math
import os
from typing import Annotated, Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

MAX_IMAGE_BYTES = 10 * 1024 * 1024
SIMILARITY_THRESHOLD = 0.92

app = FastAPI(title="FCM Inference", docs_url=None, redoc_url=None)


class CompareRequest(BaseModel):
    embedding1: list[float] = Field(min_length=1, max_length=4096)
    embedding2: list[float] = Field(min_length=1, max_length=4096)


def _configured_key() -> str:
    key = os.getenv("INFERENCE_API_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="inference authentication is not configured")
    return key


def _authorize(authorization: str | None, api_key: str | None) -> None:
    supplied = api_key or (authorization.removeprefix("Bearer ") if authorization else "")
    if not hmac.compare_digest(supplied, _configured_key()):
        raise HTTPException(status_code=401, detail="invalid inference credentials")


async def _read_image(photo: UploadFile) -> np.ndarray:
    if not photo.content_type or not photo.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="photo must be an image")
    content = await photo.read(MAX_IMAGE_BYTES + 1)
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="photo exceeds the 10 MiB limit")
    image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=422, detail="photo is not a decodable image")
    return image


def _capability_unavailable(capability: str) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"success": False, "error": "capability_unavailable", "capability": capability},
    )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "fcm-inference"}


@app.post("/infer/compare")
async def compare_embeddings(
    payload: CompareRequest,
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _authorize(authorization, x_inference_api_key)
    if len(payload.embedding1) != len(payload.embedding2):
        raise HTTPException(status_code=422, detail="embeddings must have equal dimensions")

    first = np.asarray(payload.embedding1, dtype=np.float32)
    second = np.asarray(payload.embedding2, dtype=np.float32)
    if not np.isfinite(first).all() or not np.isfinite(second).all():
        raise HTTPException(status_code=422, detail="embeddings must contain finite values")
    denominator = float(np.linalg.norm(first) * np.linalg.norm(second))
    if math.isclose(denominator, 0.0):
        raise HTTPException(status_code=422, detail="embeddings must not be zero vectors")

    similarity = float(np.dot(first, second) / denominator)
    same_vehicle = similarity >= SIMILARITY_THRESHOLD
    return {
        "same_vehicle": same_vehicle,
        "similarity": round(similarity, 6),
        "confidence": "same" if same_vehicle else "different",
    }


@app.post("/infer/watermark")
async def watermark(
    photo: Annotated[UploadFile, File()],
    watermark_text: Annotated[str, Form(min_length=1, max_length=512)],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> Response:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    text = watermark_text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="watermark_text must not be blank")

    height, width = image.shape[:2]
    scale = max(0.45, min(1.0, width / 1600))
    thickness = max(1, round(scale * 2))
    baseline_y = max(24, height - 16)
    cv2.putText(image, text, (16, baseline_y), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), thickness + 2, cv2.LINE_AA)
    cv2.putText(image, text, (16, baseline_y), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), thickness, cv2.LINE_AA)
    encoded, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not encoded:
        raise HTTPException(status_code=500, detail="watermark encoding failed")
    return Response(content=jpeg.tobytes(), media_type="image/jpeg")


@app.post("/infer/alpr")
async def alpr(
    photo: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    await _read_image(photo)
    return _capability_unavailable("alpr_model")


@app.post("/infer")
async def infer(
    photo: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    await _read_image(photo)
    return _capability_unavailable("vehicle_attribute_model")