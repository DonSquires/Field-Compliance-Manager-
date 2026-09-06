from __future__ import annotations

import hmac
import math
import os
from pathlib import Path
import re
from typing import Annotated, Any

import cv2
import numpy as np
import pytesseract
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

MAX_IMAGE_BYTES = 10 * 1024 * 1024
SIMILARITY_THRESHOLD = 0.92
MODELS_DIR = Path(os.getenv("MODELS_DIR", "/app/models"))
YUNET_MODEL_PATH = Path(os.getenv("YUNET_MODEL_PATH", MODELS_DIR / "face_detection_yunet_2023mar.onnx"))
SFACE_MODEL_PATH = Path(os.getenv("SFACE_MODEL_PATH", MODELS_DIR / "face_recognition_sface_2021dec.onnx"))
_face_detector: cv2.FaceDetectorYN | None = None
_face_recognizer: cv2.FaceRecognizerSF | None = None

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


def _normalize_nz_plate(raw: str) -> tuple[str, str] | None:
    value = re.sub(r"[^A-Z0-9]", "", raw.upper())
    if not 2 <= len(value) <= 7:
        return None
    if re.fullmatch(r"[A-Z]{3}[0-9]{3}", value):
        return value, "standard_modern"
    if re.fullmatch(r"[A-Z]{2}[0-9]{4}", value):
        return value, "standard_older"
    if re.fullmatch(r"[A-Z0-9]{2,6}", value):
        return value, "personalised"
    return None


def _face_models() -> tuple[Any, Any]:
    global _face_detector, _face_recognizer
    if _face_detector is not None and _face_recognizer is not None:
        return _face_detector, _face_recognizer
    if not YUNET_MODEL_PATH.is_file() or not SFACE_MODEL_PATH.is_file():
        raise FileNotFoundError("YuNet/SFace ONNX models are not staged")
    if not hasattr(cv2, "FaceDetectorYN_create") or not hasattr(cv2, "FaceRecognizerSF_create"):
        raise RuntimeError("installed OpenCV does not provide YuNet/SFace APIs")
    _face_detector = cv2.FaceDetectorYN_create(str(YUNET_MODEL_PATH), "", (320, 320), 0.85, 0.3, 5000)
    _face_recognizer = cv2.FaceRecognizerSF_create(str(SFACE_MODEL_PATH), "")
    return _face_detector, _face_recognizer


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "fcm-inference",
        "face_models": "ready" if YUNET_MODEL_PATH.is_file() and SFACE_MODEL_PATH.is_file() else "not_staged",
    }


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
    image = await _read_image(photo)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    enlarged = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    prepared = cv2.threshold(enlarged, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    try:
        data = pytesseract.image_to_data(
            prepared,
            config="--psm 6 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            output_type=pytesseract.Output.DICT,
        )
    except (pytesseract.TesseractError, OSError) as error:
        raise HTTPException(status_code=503, detail=f"ALPR unavailable: {error}") from error

    candidates: dict[str, dict[str, Any]] = {}
    for raw, confidence in zip(data.get("text", []), data.get("conf", [])):
        normalized = _normalize_nz_plate(raw.strip())
        try:
            score = max(0.0, min(1.0, float(confidence) / 100))
        except (TypeError, ValueError):
            score = 0.0
        if normalized and score >= 0.35:
            plate, pattern = normalized
            adjusted = min(0.99, score + (0.15 if pattern.startswith("standard_") else 0.0))
            if plate not in candidates or adjusted > candidates[plate]["score"]:
                candidates[plate] = {"plate": plate, "score": round(adjusted, 2), "pattern": pattern}
    ordered = sorted(candidates.values(), key=lambda item: item["score"], reverse=True)
    best = ordered[0] if ordered else None
    return JSONResponse({
        "success": True,
        "plate": best["plate"] if best else None,
        "confidence": best["score"] if best else 0,
        "results": [
            {"plate": item["plate"], "score": item["score"], "box": None,
             "valid_nz_format": True, "nz_pattern": item["pattern"]}
            for item in ordered[:5]
        ],
        "alpr_provider": "local_tesseract",
        "review_required": best is None or best["score"] < 0.75,
    })


@app.post("/infer/face")
async def face(
    photo: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    try:
        detector, recognizer = _face_models()
        height, width = image.shape[:2]
        detector.setInputSize((width, height))
        _, detections = detector.detect(image)
        results: list[dict[str, Any]] = []
        for index, detection in enumerate(detections if detections is not None else []):
            aligned = recognizer.alignCrop(image, detection)
            embedding = recognizer.feature(aligned)
            vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(vector))
            if not np.isfinite(vector).all() or math.isclose(norm, 0.0):
                continue
            vector = vector / norm
            x, y, box_width, box_height = [round(float(value), 3) for value in detection[:4]]
            results.append({
                "subject_label": f"Unidentified subject #{index + 1}",
                "face_index": index,
                "bbox": {"x": x, "y": y, "width": box_width, "height": box_height},
                "embedding": [round(float(value), 7) for value in vector],
                "embedding_dimension": int(vector.size),
                "candidate_person_record_id": None,
                "review_state": "manual_review_required",
            })
        return JSONResponse({"success": True, "faces": results, "identity_resolution": "manual_review_required"})
    except FileNotFoundError:
        return _capability_unavailable("yunet_sface_models")
    except (RuntimeError, cv2.error) as error:
        raise HTTPException(status_code=503, detail=f"face inference unavailable: {error}") from error


@app.post("/infer")
async def infer(
    photo: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    await _read_image(photo)
    return _capability_unavailable("vehicle_attribute_model")