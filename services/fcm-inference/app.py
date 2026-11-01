from __future__ import annotations

import asyncio
import base64
import hmac
import json
import math
import os
import threading
from pathlib import Path
from typing import Annotated, Any, Callable, TypeVar

import cv2
import numpy as np
import pytesseract
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from openvino import Core

import detector as entity_detector
import plates as plate_reader
import super_resolution

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MIN_PLATE_REGION_WIDTH = 24
MIN_PLATE_REGION_HEIGHT = 8
MIN_PLATE_SCORE = 0.55
SIMILARITY_THRESHOLD = 0.92
DIFFERENT_VEHICLE_THRESHOLD = 0.75
MIN_PERSON_REID_WIDTH = 64
MIN_PERSON_REID_HEIGHT = 128
MIN_VEHICLE_REID_WIDTH = 96
MIN_VEHICLE_REID_HEIGHT = 48
MIN_FACE_MATCH_WIDTH = 64
MIN_FACE_MATCH_HEIGHT = 64
MIN_FACE_MATCH_SHARPNESS = 15.0
APP_PATH = Path(__file__).resolve()
REPO_MODELS_DIR = APP_PATH.parents[2] / "models" if len(APP_PATH.parents) > 2 else APP_PATH.parent / "models"
DEFAULT_MODELS_DIR = Path("/app/models") if Path("/app/models").is_dir() else REPO_MODELS_DIR
MODELS_DIR = Path(os.getenv("MODELS_DIR", str(DEFAULT_MODELS_DIR)))
YUNET_MODEL_PATH = Path(os.getenv("YUNET_MODEL_PATH", MODELS_DIR / "face_detection_yunet_2023mar.onnx"))
SFACE_MODEL_PATH = Path(os.getenv("SFACE_MODEL_PATH", MODELS_DIR / "face_recognition_sface_2021dec.onnx"))
# Below this many pixels across, a detected face has little more than a blob of skin tone left; SFace's
# alignCrop would resize it to its 112x112 input in one low-quality step. Re-detecting on an INTER_CUBIC
# upscaled crop first (capped like plates.py's vehicle-crop upscale) gives sharper landmarks to align from.
MIN_FACE_CROP_WIDTH = float(os.getenv("MIN_FACE_CROP_WIDTH", "112"))
FACE_CROP_MAX_UPSCALE = 3.0
VEHICLE_MODEL_PATH = Path(os.getenv("VEHICLE_MODEL_PATH", MODELS_DIR / "vehicle-attributes-recognition-barrier-0039.xml"))
PERSON_MODEL_PATH = Path(os.getenv("PERSON_MODEL_PATH", MODELS_DIR / "person-detection-retail-0013.xml"))
PERSON_REID_MODEL_PATH = Path(os.getenv("PERSON_REID_MODEL_PATH", MODELS_DIR / "person-reidentification-retail-0288.xml"))
VEHICLE_REID_MODEL_PATH = Path(os.getenv("VEHICLE_REID_MODEL_PATH", MODELS_DIR / "vehicle-reid-0001.xml"))
APPEARANCE_EMBEDDING_DIMENSION = 256
_face_detector: cv2.FaceDetectorYN | None = None
_face_recognizer: cv2.FaceRecognizerSF | None = None
_face_lock = threading.Lock()
_vehicle_model: Any = None
_vehicle_compiled: Any = None
_person_compiled: Any = None
_person_reid_compiled: Any = None
_vehicle_reid_compiled: Any = None
VEHICLE_COLOURS = ("white", "gray", "yellow", "red", "green", "blue", "black")
VEHICLE_TYPES = ("car", "van", "truck", "bus")

app = FastAPI(title="FCM Inference", docs_url=None, redoc_url=None)

# Model work is CPU-bound and used to run inside the async handlers, blocking the event loop: a busy detector
# meant /health could not answer (Docker marked the container unhealthy) and every request the caller had already
# abandoned on timeout was still computed in full. Now each route hands its work to a worker thread through a
# gate: INFERENCE_CONCURRENCY runs at once (1 by default — on CPU, serial is faster in aggregate than contending),
# at most INFERENCE_MAX_WAITING queue behind it, and anything beyond that is refused at once with 503 so the
# caller falls back to its next machine instead of waiting for work that will not arrive in time.
INFERENCE_CONCURRENCY = max(1, int(os.getenv("INFERENCE_CONCURRENCY", "1") or 1))
INFERENCE_MAX_WAITING = max(0, int(os.getenv("INFERENCE_MAX_WAITING", "6") or 6))
cv2.setNumThreads(entity_detector.intra_op_threads())
_cpu_gate = asyncio.Semaphore(INFERENCE_CONCURRENCY)
_cpu_running = 0
_cpu_waiting = 0
_T = TypeVar("_T")


async def _run_cpu(work: Callable[..., _T], *args: Any) -> _T:
    global _cpu_running, _cpu_waiting
    if _cpu_waiting >= INFERENCE_MAX_WAITING:
        raise HTTPException(status_code=503, detail=f"inference busy: {_cpu_running} running, {_cpu_waiting} waiting", headers={"Retry-After": "5"})
    _cpu_waiting += 1
    admitted = False
    try:
        async with _cpu_gate:
            _cpu_waiting -= 1
            admitted = True
            _cpu_running += 1
            try:
                return await run_in_threadpool(work, *args)
            finally:
                _cpu_running -= 1
    finally:
        if not admitted:
            _cpu_waiting -= 1


class CompareRequest(BaseModel):
    embedding1: list[float] = Field(min_length=1, max_length=4096)
    embedding2: list[float] = Field(min_length=1, max_length=4096)
    image1: str | None = Field(default=None, max_length=14_000_000)
    image2: str | None = Field(default=None, max_length=14_000_000)


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
    if image.shape[0] * image.shape[1] > MAX_IMAGE_PIXELS:
        raise HTTPException(status_code=413, detail="photo dimensions exceed the 20 megapixel limit")
    return image


def _capability_unavailable(capability: str) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"success": False, "error": "capability_unavailable", "capability": capability},
    )

def _decode_image_data(value: str) -> np.ndarray | None:
    try:
        raw = value.split(",", 1)[1] if "," in value else value
        image = cv2.imdecode(np.frombuffer(base64.b64decode(raw), dtype=np.uint8), cv2.IMREAD_COLOR)
        return image
    except (ValueError, TypeError, base64.binascii.Error):
        return None

def _scene_similarity(first: np.ndarray, second: np.ndarray) -> float:
    """Compare stable low-frequency scene structure, including wheel-level context."""
    first_small = cv2.resize(first, (48, 48), interpolation=cv2.INTER_AREA)
    second_small = cv2.resize(second, (48, 48), interpolation=cv2.INTER_AREA)
    first_gray = cv2.cvtColor(first_small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    second_gray = cv2.cvtColor(second_small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    first_gray = (first_gray - first_gray.mean()) / (first_gray.std() + 1e-6)
    second_gray = (second_gray - second_gray.mean()) / (second_gray.std() + 1e-6)
    return float(np.mean(first_gray * second_gray))


def _vehicle_embedding(image: np.ndarray) -> list[float]:
    """Create a stable, local 384D appearance descriptor for vehicle comparison."""
    thumbnail = cv2.resize(image, (16, 8), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    vector = thumbnail.reshape(-1)
    norm = float(np.linalg.norm(vector))
    if math.isclose(norm, 0.0):
        return [0.0] * 384
    return [round(float(value / norm), 7) for value in vector]


def _vehicle_reid_runtime() -> Any:
    global _vehicle_reid_compiled
    if _vehicle_reid_compiled is not None:
        return _vehicle_reid_compiled
    if not entity_detector.path_is_file(VEHICLE_REID_MODEL_PATH) or not entity_detector.path_is_file(VEHICLE_REID_MODEL_PATH.with_suffix('.bin')):
        raise FileNotFoundError("vehicle re-identification model is not staged")
    core = Core()
    _vehicle_reid_compiled = core.compile_model(core.read_model(str(VEHICLE_REID_MODEL_PATH)), "CPU")
    return _vehicle_reid_compiled


def _hsv_layout_embedding(crop: np.ndarray) -> list[float]:
    """Deterministic 256-d appearance descriptor used when no re-identification model is staged.

    Centre-weighted chroma histogram (12 hue x 4 saturation, chromatic pixels only) + achromatic value
    histogram (8) + normalised 8x8 grey layout (64) + gradient-orientation histogram (4x4 cells x 8 bins).
    On real trail-camera footage the same vehicle across frames scores 0.84-0.98 cosine, unrelated crops
    0.44-0.67, which sits either side of the portfolio thresholds. It is a hint for review, not identity.
    """
    if crop.size == 0 or crop.shape[0] < 4 or crop.shape[1] < 4:
        return [0.0] * APPEARANCE_EMBEDDING_DIMENSION
    square = cv2.resize(crop, (96, 96), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(square, cv2.COLOR_BGR2HSV).astype(np.float32)
    rows, cols = np.mgrid[0:96, 0:96]
    weight = np.exp(-(((cols - 47.5) / 34.0) ** 2 + ((rows - 47.5) / 34.0) ** 2) / 2.0).astype(np.float32)
    hue, saturation, value = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    chromatic = (saturation > 40) & (value > 40)
    hue_sat = np.zeros((12, 4), dtype=np.float32)
    hue_bins = np.clip((hue / 180.0 * 12).astype(int), 0, 11)
    sat_bins = np.clip(((saturation - 40.0) / 216.0 * 4).astype(int), 0, 3)
    np.add.at(hue_sat, (hue_bins[chromatic], sat_bins[chromatic]), weight[chromatic])
    value_hist = np.zeros(8, dtype=np.float32)
    value_bins = np.clip((value / 256.0 * 8).astype(int), 0, 7)
    np.add.at(value_hist, value_bins[~chromatic], weight[~chromatic])
    colour = np.concatenate([hue_sat.reshape(-1), value_hist])
    colour = np.sqrt(colour / max(float(colour.sum()), 1e-6))
    grey = cv2.cvtColor(square, cv2.COLOR_BGR2GRAY).astype(np.float32)
    layout = cv2.resize(grey, (8, 8), interpolation=cv2.INTER_AREA).reshape(-1)
    layout = (layout - layout.mean()) / (layout.std() + 1e-6) / 8.0
    gradient_x = cv2.Sobel(grey, cv2.CV_32F, 1, 0)
    gradient_y = cv2.Sobel(grey, cv2.CV_32F, 0, 1)
    magnitude = np.hypot(gradient_x, gradient_y)
    orientation = np.clip(((np.arctan2(gradient_y, gradient_x) + np.pi) % np.pi / np.pi * 8).astype(int), 0, 7)
    orientations = np.zeros((4, 4, 8), dtype=np.float32)
    for cell_row in range(4):
        for cell_col in range(4):
            window = (slice(cell_row * 24, (cell_row + 1) * 24), slice(cell_col * 24, (cell_col + 1) * 24))
            np.add.at(orientations[cell_row, cell_col], orientation[window].reshape(-1), magnitude[window].reshape(-1))
    orientations = orientations.reshape(-1)
    orientations = np.sqrt(orientations / max(float(orientations.sum()), 1e-6))
    vector = np.concatenate([colour * 1.2, layout, orientations, np.zeros(APPEARANCE_EMBEDDING_DIMENSION - 56 - 64 - 128, dtype=np.float32)])
    norm = float(np.linalg.norm(vector))
    return [round(float(component / norm), 7) for component in vector] if norm > 0 else [0.0] * APPEARANCE_EMBEDDING_DIMENSION


def _vehicle_appearance_embedding(crop: np.ndarray) -> tuple[list[float], str]:
    """256-d vehicle appearance vector for same-or-similar search when no plate can be read."""
    if crop.size == 0:
        return [], "insufficient_crop"
    try:
        runtime = _vehicle_reid_runtime()
        blob = cv2.dnn.blobFromImage(crop, 1.0, (208, 208), swapRB=False)
        vector = np.asarray(runtime([blob])[runtime.outputs[0]], dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(vector))
        if vector.shape[0] == APPEARANCE_EMBEDDING_DIMENSION and np.isfinite(vector).all() and norm > 0:
            return [round(float(value / norm), 7) for value in vector], VEHICLE_REID_MODEL_PATH.name
    except (FileNotFoundError, RuntimeError, cv2.error):
        pass
    return _hsv_layout_embedding(crop), "deterministic_hsv_layout_v1"


def _vehicle_runtime() -> Any:
    global _vehicle_model, _vehicle_compiled
    if _vehicle_compiled is not None:
        return _vehicle_compiled
    if not entity_detector.path_is_file(VEHICLE_MODEL_PATH) or not entity_detector.path_is_file(VEHICLE_MODEL_PATH.with_suffix('.bin')):
        raise FileNotFoundError("vehicle attributes model is not staged")
    _vehicle_model = Core().read_model(str(VEHICLE_MODEL_PATH))
    _vehicle_compiled = Core().compile_model(_vehicle_model, "CPU")
    return _vehicle_compiled


def _vehicle_region(image: np.ndarray) -> np.ndarray:
    regions = _locate_plate_regions(image, max_regions=1) if image.size else []
    if regions:
        x, y, width, height = regions[0]
        x0 = max(0, x - round(width * 2.5))
        x1 = min(image.shape[1], x + width + round(width * 2.5))
        y0 = max(0, y - round(height * 5))
        y1 = min(image.shape[0], y + height + round(height * 5))
        crop = image[y0:y1, x0:x1]
        if crop.size:
            return crop
    height, width = image.shape[:2]
    return image[round(height * 0.1):round(height * 0.95), round(width * 0.1):round(width * 0.9)]


def _expand_vehicle_bbox(image: np.ndarray, bbox: dict[str, Any] | None) -> np.ndarray:
    if not bbox:
        return image
    try:
        x = float(bbox['x'])
        y = float(bbox['y'])
        width = float(bbox['width'])
        height = float(bbox['height'])
    except (KeyError, TypeError, ValueError):
        return image
    if width <= 0 or height <= 0:
        return image
    padding_x = width * 3.5
    padding_y = height * 5.0
    x0 = max(0, round(x - padding_x))
    y0 = max(0, round(y - padding_y))
    x1 = min(image.shape[1], round(x + width + padding_x))
    y1 = min(image.shape[0], round(y + height + padding_y))
    crop = image[y0:y1, x0:x1]
    return crop if crop.size else image


def _trained_vehicle_attributes(image: np.ndarray, detector_crop: bool = False) -> dict[str, Any]:
    runtime = _vehicle_runtime()
    region = image if detector_crop else _vehicle_region(image)
    blob = cv2.dnn.blobFromImage(region, 1.0, (72, 72), swapRB=False)
    outputs = runtime([blob])
    by_name = {output.any_name: np.asarray(value).reshape(-1) for output, value in outputs.items()}
    colour_scores = by_name.get("color")
    type_scores = by_name.get("type")
    colour_index = int(np.argmax(colour_scores)) if colour_scores is not None else -1
    type_index = int(np.argmax(type_scores)) if type_scores is not None else -1
    colour_confidence = float(colour_scores[colour_index]) if colour_index >= 0 else 0.0
    type_confidence = float(type_scores[type_index]) if type_index >= 0 else 0.0
    return {
        "vehicle_colour": VEHICLE_COLOURS[colour_index] if colour_index >= 0 and colour_confidence >= 0.45 else None,
        "vehicle_type": VEHICLE_TYPES[type_index] if type_index >= 0 and type_confidence >= 0.45 else None,
        "vehicle_attribute_confidence": round(min(colour_confidence, type_confidence), 3),
        "vehicle_colour_confidence": round(colour_confidence, 3),
        "vehicle_type_confidence": round(type_confidence, 3),
        "vehicle_model_name": VEHICLE_MODEL_PATH.name,
    }


def _person_runtime() -> Any:
    global _person_compiled
    if _person_compiled is not None:
        return _person_compiled
    if not entity_detector.path_is_file(PERSON_MODEL_PATH) or not entity_detector.path_is_file(PERSON_MODEL_PATH.with_suffix('.bin')):
        raise FileNotFoundError("person detection model is not staged")
    core = Core()
    _person_compiled = core.compile_model(core.read_model(str(PERSON_MODEL_PATH)), "CPU")
    return _person_compiled


def _person_reid_runtime() -> Any:
    global _person_reid_compiled
    if _person_reid_compiled is not None:
        return _person_reid_compiled
    if not entity_detector.path_is_file(PERSON_REID_MODEL_PATH) or not entity_detector.path_is_file(PERSON_REID_MODEL_PATH.with_suffix('.bin')):
        raise FileNotFoundError("person re-identification model is not staged")
    core = Core()
    _person_reid_compiled = core.compile_model(core.read_model(str(PERSON_REID_MODEL_PATH)), "CPU")
    return _person_reid_compiled


def _person_reid_embedding(crop: np.ndarray) -> list[float]:
    runtime = _person_reid_runtime()
    blob = cv2.dnn.blobFromImage(crop, 1.0, (128, 256), swapRB=False)
    vector = np.asarray(runtime([blob])[runtime.outputs[0]], dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(vector).all() or math.isclose(norm, 0.0):
        raise RuntimeError("person appearance embedding is invalid")
    return [round(float(value / norm), 7) for value in vector]


def _visible_head_region(crop: np.ndarray) -> dict[str, Any]:
    head = crop[:max(1, round(crop.shape[0] * 0.2)), :]
    if head.shape[0] < 12 or head.shape[1] < 12:
        return {"state": "insufficient_resolution", "colour": None, "shape": None, "review_required": True}
    hsv = cv2.cvtColor(head, cv2.COLOR_BGR2HSV)
    brightness = float(hsv[:, :, 2].mean())
    saturation = float(hsv[:, :, 1].mean())
    if brightness < 25 or brightness > 245:
        return {"state": "insufficient_visual_information", "colour": None, "shape": None, "review_required": True}
    hue = float(hsv[:, :, 0].mean())
    if saturation < 30:
        colour = "dark" if brightness < 85 else "light" if brightness > 165 else "mid-tone"
    elif hue < 12 or hue >= 165:
        colour = "red-toned"
    elif hue < 35:
        colour = "yellow-or-orange-toned"
    elif hue < 85:
        colour = "green-toned"
    elif hue < 135:
        colour = "blue-toned"
    else:
        colour = "purple-or-pink-toned"
    edges = cv2.Canny(cv2.cvtColor(head, cv2.COLOR_BGR2GRAY), 50, 150)
    edge_density = float(np.count_nonzero(edges) / edges.size)
    shape = "high-texture-or-irregular" if edge_density > 0.18 else "compact" if edge_density < 0.06 else "moderate-outline"
    return {
        "state": "provisional_visible_head_region",
        "colour": colour,
        "shape": shape,
        "could_include_hair_headwear_or_background": True,
        "review_required": True,
    }


def _person_appearance_attributes(image: np.ndarray, bbox: dict[str, int], confidence: float | None = None) -> dict[str, Any]:
    x0 = max(0, int(bbox['x']))
    y0 = max(0, int(bbox['y']))
    x1 = min(image.shape[1], x0 + int(bbox['width']))
    y1 = min(image.shape[0], y0 + int(bbox['height']))
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        return {
            "appearance_status": "insufficient_crop",
            "height_status": "camera_calibration_required",
            "review_required": True,
        }
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(gray.mean())
    try:
        embedding = _person_reid_embedding(crop)
        embedding_model = PERSON_REID_MODEL_PATH.name
    except (FileNotFoundError, RuntimeError, cv2.error):
        # Same 256-d shape as the re-ID model so portfolio search still works, labelled as the fallback.
        embedding = _hsv_layout_embedding(crop)
        embedding_model = "deterministic_hsv_layout_v1"
    detector_confidence_ok = confidence is None or confidence >= 0.65
    embedding_usable = (
        embedding_model == PERSON_REID_MODEL_PATH.name
        and crop.shape[1] >= MIN_PERSON_REID_WIDTH
        and crop.shape[0] >= MIN_PERSON_REID_HEIGHT
        and sharpness >= 8.0
        and 20.0 <= brightness <= 240.0
        and detector_confidence_ok
    )
    resolution_score = min(1.0, crop.shape[1] / 128) * min(1.0, crop.shape[0] / 256)
    sharpness_score = min(1.0, sharpness / 100)
    brightness_score = max(0.0, 1.0 - abs(brightness - 127.5) / 127.5)
    quality_score = round(resolution_score * sharpness_score * brightness_score * (confidence if confidence is not None else 1.0), 3)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    midpoint = max(1, hsv.shape[0] // 2)
    upper = hsv[:midpoint]
    lower = hsv[midpoint:]

    def dominant_colour(region: np.ndarray) -> str:
        if region.size == 0:
            return "unknown"
        value = region[:, :, 2]
        saturation = region[:, :, 1]
        valid = value > 25
        if not np.any(valid):
            return "unknown"
        average_saturation = float(np.mean(saturation[valid]))
        average_value = float(np.mean(value[valid]))
        if average_saturation < 35:
            return "dark" if average_value < 85 else "light"
        hue = float(np.mean(region[:, :, 0][valid]))
        if hue < 12 or hue >= 165:
            return "red"
        if hue < 35:
            return "yellow_or_orange"
        if hue < 85:
            return "green"
        if hue < 135:
            return "blue"
        return "purple_or_pink"

    return {
        "appearance_status": "visual_estimate_review_required",
        "appearance_embedding": embedding,
        "appearance_embedding_dimension": len(embedding),
        "appearance_embedding_model": embedding_model,
        "appearance_embedding_usable": embedding_usable,
        "appearance_quality_score": quality_score,
        "appearance_quality_reason": None if embedding_usable else (
            "fallback_embedding" if embedding_model != PERSON_REID_MODEL_PATH.name
            else "insufficient_crop_or_visual_quality"
        ),
        "appearance_crop_width_px": int(crop.shape[1]),
        "appearance_crop_height_px": int(crop.shape[0]),
        "appearance_crop_sharpness": round(sharpness, 2),
        "appearance_crop_brightness": round(brightness, 2),
        "body_proportions": {
            "pixel_height": int(crop.shape[0]),
            "pixel_width": int(crop.shape[1]),
            "height_to_width_ratio": round(float(crop.shape[0] / max(1, crop.shape[1])), 3),
            "physical_size_status": "camera_calibration_required",
        },
        "visible_head_region": _visible_head_region(crop),
        "upper_body_colour": dominant_colour(upper),
        "lower_body_colour": dominant_colour(lower),
        "height_status": "camera_calibration_required",
        "height_estimate_meters": None,
        "review_required": True,
    }


def _detect_people(image: np.ndarray) -> list[dict[str, Any]]:
    runtime = _person_runtime()
    height, width = image.shape[:2]
    blob = cv2.dnn.blobFromImage(image, 1.0, (544, 320), swapRB=False)
    detections = np.asarray(runtime([blob])[runtime.outputs[0]]).reshape(-1, 7)
    people = []
    for detection in detections:
        confidence = float(detection[2])
        if confidence < 0.35 or int(detection[1]) != 1:
            continue
        x0 = max(0, round(float(detection[3]) * width))
        y0 = max(0, round(float(detection[4]) * height))
        x1 = min(width, round(float(detection[5]) * width))
        y1 = min(height, round(float(detection[6]) * height))
        if x1 <= x0 or y1 <= y0:
            continue
        person_bbox = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
        if not entity_detector.plausible_box("person", person_bbox, width, height):
            continue
        people.append({
            "bbox": person_bbox,
            "confidence": round(confidence, 3),
            "attributes": _person_appearance_attributes(image, person_bbox, confidence),
        })
    return people


def _vehicle_colour(image: np.ndarray) -> tuple[str | None, float]:
    height, width = image.shape[:2]
    x0, x1 = round(width * 0.15), round(width * 0.85)
    y0, y1 = round(height * 0.25), round(height * 0.9)
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        return None, 0.0
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    value = hsv[:, 2]
    saturation = hsv[:, 1]
    valid = value > 25
    if not np.any(valid):
        return None, 0.0
    value = value[valid]
    saturation = saturation[valid]
    hue = hsv[valid, 0]
    achromatic = saturation < 35
    counts: dict[str, int] = {
        "black": int(np.sum(value < 55)),
        "white": int(np.sum(achromatic & (value >= 170))),
        "silver": int(np.sum(achromatic & (value >= 90) & (value < 170))),
        "grey": int(np.sum(achromatic & (value >= 55) & (value < 90))),
        "red": int(np.sum((saturation >= 35) & ((hue < 10) | (hue >= 170)))),
        "orange": int(np.sum((saturation >= 35) & (hue >= 10) & (hue < 25))),
        "yellow": int(np.sum((saturation >= 35) & (hue >= 25) & (hue < 40))),
        "green": int(np.sum((saturation >= 35) & (hue >= 40) & (hue < 85))),
        "blue": int(np.sum((saturation >= 35) & (hue >= 85) & (hue < 135))),
        "purple": int(np.sum((saturation >= 35) & (hue >= 135) & (hue < 170))),
    }
    colour, count = max(counts.items(), key=lambda item: item[1])
    confidence = count / len(value)
    return (colour, round(float(confidence), 3)) if confidence >= 0.12 else ("mixed", round(float(confidence), 3))


def _infer_vehicle_attributes(
    image: np.ndarray,
    detector_crop: bool = False,
    detection_confidence: float | None = None,
) -> dict[str, Any]:
    height, width = image.shape[:2]
    trained = _trained_vehicle_attributes(image, detector_crop)
    colour, heuristic_confidence = _vehicle_colour(image)
    if trained["vehicle_colour"] is None and colour is not None:
        trained["vehicle_colour"] = colour
        trained["vehicle_colour_confidence"] = round(heuristic_confidence, 3)
    appearance_embedding, appearance_model = _vehicle_appearance_embedding(image)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.size else np.empty((0, 0), dtype=np.uint8)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var()) if gray.size else 0.0
    brightness = float(gray.mean()) if gray.size else 0.0
    detector_confidence_ok = detection_confidence is None or detection_confidence >= 0.65
    appearance_usable = (
        detector_crop
        and appearance_model == VEHICLE_REID_MODEL_PATH.name
        and width >= MIN_VEHICLE_REID_WIDTH
        and height >= MIN_VEHICLE_REID_HEIGHT
        and sharpness >= 8.0
        and 20.0 <= brightness <= 240.0
        and detector_confidence_ok
    )
    resolution_score = min(1.0, width / 192) * min(1.0, height / 96)
    sharpness_score = min(1.0, sharpness / 100)
    brightness_score = max(0.0, 1.0 - abs(brightness - 127.5) / 127.5)
    quality_score = round(
        resolution_score * sharpness_score * brightness_score
        * (detection_confidence if detection_confidence is not None else 1.0), 3,
    )
    return {
        "embedding": _vehicle_embedding(image),
        "embedding_quality": round(min(1.0, max(0.0, (width * height) / (1280 * 720))), 3),
        "appearance_embedding": appearance_embedding,
        "appearance_embedding_model": appearance_model,
        "appearance_embedding_usable": appearance_usable,
        "appearance_quality_score": quality_score,
        "appearance_quality_reason": None if appearance_usable else (
            "fallback_embedding" if appearance_model != VEHICLE_REID_MODEL_PATH.name
            else "insufficient_crop_or_visual_quality"
        ),
        "appearance_crop_width_px": width,
        "appearance_crop_height_px": height,
        "appearance_crop_sharpness": round(sharpness, 2),
        "appearance_crop_brightness": round(brightness, 2),
        "detection": {
            "bbox": {"x": 0, "y": 0, "width": width, "height": height},
            "confidence": 0.25,
        },
        "vehicle_crop_status": "detector_crop" if detector_crop else "full_frame_review_only",
        "vehicle_make": None,
        "vehicle_model": None,
        "vehicle_year": None,
        "vehicle_colour": trained["vehicle_colour"],
        "vehicle_type": trained["vehicle_type"],
        "vehicle_attribute_confidence": trained["vehicle_attribute_confidence"],
        "vehicle_colour_confidence": trained["vehicle_colour_confidence"],
        "vehicle_type_confidence": trained["vehicle_type_confidence"],
        "vehicle_model_name": trained["vehicle_model_name"],
        "inference_provider": "openvino_vehicle_attributes_0039",
        "review_required": True,
        "attribute_status": "trained_colour_type_identity_manual_review",
        "sticker": {"presence": None, "color": None, "detection_confidence": None},
    }


def _normalize_nz_plate(raw: str) -> tuple[str, str] | None:
    return plate_reader.normalize_nz_plate(raw)


def _face_models() -> tuple[Any, Any]:
    global _face_detector, _face_recognizer
    if _face_detector is not None and _face_recognizer is not None:
        return _face_detector, _face_recognizer
    if not entity_detector.path_is_file(YUNET_MODEL_PATH) or not entity_detector.path_is_file(SFACE_MODEL_PATH):
        raise FileNotFoundError("YuNet/SFace ONNX models are not staged")
    if not hasattr(cv2, "FaceDetectorYN_create") or not hasattr(cv2, "FaceRecognizerSF_create"):
        raise RuntimeError("installed OpenCV does not provide YuNet/SFace APIs")
    _face_detector = cv2.FaceDetectorYN_create(str(YUNET_MODEL_PATH), "", (320, 320), 0.85, 0.3, 5000)
    _face_recognizer = cv2.FaceRecognizerSF_create(str(SFACE_MODEL_PATH), "")
    return _face_detector, _face_recognizer


def _upscale_face_region(image: np.ndarray, detection: np.ndarray, detector: Any) -> tuple[np.ndarray, np.ndarray] | None:
    """Pad and upscale the small crop around one detected face, then re-detect on just that crop so
    alignCrop has sharper, higher-resolution landmarks to work from. Returns None (caller keeps the
    original detection) whenever the crop is degenerate or re-detection finds nothing to align on."""
    height, width = image.shape[:2]
    x, y, box_width, box_height = (float(value) for value in detection[:4])
    if box_width <= 0 or box_height <= 0:
        return None
    pad_x, pad_y = box_width * 0.3, box_height * 0.3
    x0, y0 = max(0, int(x - pad_x)), max(0, int(y - pad_y))
    x1, y1 = min(width, int(x + box_width + pad_x)), min(height, int(y + box_height + pad_y))
    crop = image[y0:y1, x0:x1]
    if crop.size == 0 or crop.shape[1] < 8 or crop.shape[0] < 8:
        return None
    scale = min(FACE_CROP_MAX_UPSCALE, MIN_FACE_CROP_WIDTH / box_width)
    if scale <= 1.0:
        return None
    upscaled = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    detector.setInputSize((upscaled.shape[1], upscaled.shape[0]))
    _, refined = detector.detect(upscaled)
    if refined is None or len(refined) == 0:
        return None
    best = max(refined, key=lambda item: item[-1])
    return upscaled, best


def _face_person_boxes(image: np.ndarray, person_bboxes: list[dict[str, Any]] | None) -> list[dict[str, int]]:
    if person_bboxes is None:
        triage = entity_detector.triage_frame(image)
        coverage = set(triage.get("detector_coverage") or [])
        if triage.get("detector_status") == "ready" and "person" in coverage:
            person_bboxes = triage.get("people") or []
        else:
            try:
                person_bboxes = _detect_people(image)
            except (FileNotFoundError, RuntimeError, cv2.error):
                return []
    height, width = image.shape[:2]
    normalized = []
    for item in person_bboxes:
        raw = item.get("bbox") if isinstance(item, dict) and isinstance(item.get("bbox"), dict) else item
        if not isinstance(raw, dict):
            continue
        try:
            x, y, box_width, box_height = (float(raw[key]) for key in ("x", "y", "width", "height"))
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (x, y, box_width, box_height)) or box_width <= 0 or box_height <= 0:
            continue
        x0, y0 = max(0, int(x)), max(0, int(y))
        x1, y1 = min(width, int(x + box_width)), min(height, int(y + box_height))
        if x1 - x0 < 16 or y1 - y0 < 32:
            continue
        candidate = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
        duplicate = False
        for existing in normalized:
            overlap_width = max(0, min(existing["x"] + existing["width"], x1) - max(existing["x"], x0))
            overlap_height = max(0, min(existing["y"] + existing["height"], y1) - max(existing["y"], y0))
            intersection = overlap_width * overlap_height
            union = existing["width"] * existing["height"] + candidate["width"] * candidate["height"] - intersection
            if union > 0 and intersection / union >= 0.75:
                duplicate = True
                break
        if not duplicate:
            normalized.append(candidate)
    return normalized


def _face_quality(region: np.ndarray, detection: np.ndarray) -> dict[str, Any]:
    x, y, box_width, box_height = (float(value) for value in detection[:4])
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(region.shape[1], int(x + box_width)), min(region.shape[0], int(y + box_height))
    crop = region[y0:y1, x0:x1]
    if crop.size == 0:
        return {"face_quality_score": 0.0, "face_crop_sharpness": 0.0, "face_crop_brightness": 0.0, "face_frontality_score": 0.0, "usable_for_matching": False}
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(gray.mean())
    if len(detection) >= 15 and box_width > 0:
        right_eye, left_eye = detection[4:6], detection[6:8]
        nose = detection[8:10]
        right_mouth, left_mouth = detection[10:12], detection[12:14]
        eye_midpoint = (float(right_eye[0]) + float(left_eye[0])) / 2
        mouth_midpoint = (float(right_mouth[0]) + float(left_mouth[0])) / 2
        yaw_offset = abs(float(nose[0]) - eye_midpoint) / box_width
        mouth_offset = abs(mouth_midpoint - eye_midpoint) / box_width
        eye_tilt = abs(float(right_eye[1]) - float(left_eye[1])) / box_width
        frontality = max(0.0, min(1.0, 1.0 - yaw_offset * 2.5 - mouth_offset * 1.3 - eye_tilt * 1.5))
        eye_separation = abs(float(right_eye[0]) - float(left_eye[0])) / box_width
        if eye_separation < 0.2:
            frontality = min(frontality, 0.3)
    else:
        frontality = 0.0
    detector_confidence = max(0.0, min(1.0, float(detection[-1])))
    size_score = min(1.0, box_width / 112) * min(1.0, box_height / 112)
    sharpness_score = min(1.0, sharpness / 100)
    brightness_score = max(0.0, 1.0 - abs(brightness - 127.5) / 127.5)
    quality_score = round(detector_confidence * size_score * sharpness_score * brightness_score * frontality, 3)
    usable = (
        box_width >= MIN_FACE_MATCH_WIDTH
        and box_height >= MIN_FACE_MATCH_HEIGHT
        and detector_confidence >= 0.85
        and sharpness >= MIN_FACE_MATCH_SHARPNESS
        and 25.0 <= brightness <= 235.0
        and frontality >= 0.5
    )
    return {
        "face_quality_score": quality_score,
        "face_crop_sharpness": round(sharpness, 2),
        "face_crop_brightness": round(brightness, 2),
        "face_frontality_score": round(frontality, 3),
        "usable_for_matching": usable,
    }


def _crop_to_bbox(image: np.ndarray, bbox: dict[str, Any], padding: float = 0.1) -> np.ndarray:
    try:
        x, y, width, height = (int(bbox[key]) for key in ('x', 'y', 'width', 'height'))
    except (KeyError, TypeError, ValueError):
        return image
    pad_x, pad_y = int(width * padding), int(height * padding)
    x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
    x1, y1 = min(image.shape[1], x + width + pad_x), min(image.shape[0], y + height + pad_y)
    crop = image[y0:y1, x0:x1]
    return crop if crop.size else image


def _triage_with_attributes(image: np.ndarray) -> dict[str, Any]:
    """Detector triage enriched with the staged attribute models: re-ID embeddings for people, colour/type
    and appearance embeddings for vehicles, species for animals. Falls back to the OpenVINO person detector
    when no general detector is staged so people are never silently dropped."""
    triage = entity_detector.triage_frame(image)
    coverage = set(triage.get("detector_coverage") or [])
    if triage["detector_status"] == "ready" and "person" in coverage:
        for person in triage["people"]:
            person["attributes"] = _person_appearance_attributes(image, person["bbox"], person.get("confidence"))
        triage["people_provider"] = triage.get("detector_provider")
    else:
        try:
            triage["people"] = _detect_people(image)
            triage["people_provider"] = "openvino_person_detection_0013"
        except (FileNotFoundError, RuntimeError, cv2.error):
            triage["people"] = []
            triage["people_provider"] = None
    for vehicle in triage["vehicles"]:
        crop = _crop_to_bbox(image, vehicle["bbox"])
        try:
            attributes = _infer_vehicle_attributes(crop, detector_crop=True, detection_confidence=vehicle.get("confidence"))
        except (FileNotFoundError, RuntimeError, cv2.error):
            embedding, model_name = _vehicle_appearance_embedding(crop)
            attributes = {"appearance_embedding": embedding, "appearance_embedding_model": model_name, "attribute_status": "vehicle_attribute_model_not_staged"}
        attributes["detection"] = {"bbox": vehicle["bbox"], "confidence": vehicle["confidence"]}
        attributes["vehicle_crop_status"] = "detector_crop"
        vehicle["attributes"] = attributes
    return triage


def _health_payload() -> dict[str, Any]:
    """Which tiers are staged and which execution provider they run on, as reported by /health."""
    detector_state = entity_detector.detector_status()
    plate_state = plate_reader.status()
    return {
        "status": "ok",
        "service": "fcm-inference",
        "models_dir": str(MODELS_DIR),
        "face_models": "ready" if entity_detector.path_is_file(YUNET_MODEL_PATH) and entity_detector.path_is_file(SFACE_MODEL_PATH) else "not_staged",
        "vehicle_model": "ready" if entity_detector.path_is_file(VEHICLE_MODEL_PATH) and entity_detector.path_is_file(VEHICLE_MODEL_PATH.with_suffix('.bin')) else "not_staged",
        "person_model": "ready" if entity_detector.path_is_file(PERSON_MODEL_PATH) and entity_detector.path_is_file(PERSON_MODEL_PATH.with_suffix('.bin')) else "not_staged",
        "person_reidentification_model": "ready" if entity_detector.path_is_file(PERSON_REID_MODEL_PATH) and entity_detector.path_is_file(PERSON_REID_MODEL_PATH.with_suffix('.bin')) else "not_staged",
        "vehicle_reidentification_model": "ready" if entity_detector.path_is_file(VEHICLE_REID_MODEL_PATH) and entity_detector.path_is_file(VEHICLE_REID_MODEL_PATH.with_suffix('.bin')) else "not_staged",
        "detector_model": detector_state["detector"],
        "detector_name": detector_state.get("detector_model"),
        "detector_kind": detector_state.get("detector_kind"),
        "detector_provider": detector_state.get("detector_provider"),
        "detector_coverage": detector_state.get("coverage", []),
        "detector_tiles": detector_state.get("detector_tiles"),
        "species_model": detector_state["species"],
        "species_provider": detector_state.get("species_provider"),
        "species_execution_provider": detector_state.get("species_execution_provider"),
        "alpr": plate_state["alpr"],
        "alpr_provider": plate_state["alpr_provider"],
        "plate_detector_model": plate_state["plate_detector_model"],
        "plate_ocr_model": plate_state["plate_ocr_model"],
        "cuda": entity_detector.cuda_available(),
        "super_resolution": super_resolution.status(MODELS_DIR),
        "cpu_threads_per_session": entity_detector.intra_op_threads(),
        "queue": {"running": _cpu_running, "waiting": _cpu_waiting, "concurrency": INFERENCE_CONCURRENCY, "max_waiting": INFERENCE_MAX_WAITING},
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    return _health_payload()


def _detect_sync(image: np.ndarray) -> dict[str, Any]:
    triage = _triage_with_attributes(image)
    if plate_reader.staged():
        try:
            triage["alpr"] = plate_reader.read_plates(image, [vehicle["bbox"] for vehicle in triage.get("vehicles") or []])
        except Exception as error:  # ALPR failing must not hide the triage
            triage["alpr"] = {"success": False, "error": str(error)[:300], "alpr_provider": plate_reader.PLATE_PROVIDER}
    return triage


@app.post("/infer/detect")
async def detect_entities(
    photo: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    """Person / vehicle / animal triage with species, plus plate reading anchored on the detected vehicles when
    the trained ALPR tier is staged. Advisory: a human confirms every identity."""
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    triage = await _run_cpu(_detect_sync, image)
    return JSONResponse({"success": True, "review_required": True, **triage})


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
    different_vehicle = similarity <= DIFFERENT_VEHICLE_THRESHOLD
    scene_similarity = None
    scene_confidence = "unavailable"
    if payload.image1 and payload.image2:
        first_image = _decode_image_data(payload.image1)
        second_image = _decode_image_data(payload.image2)
        if first_image is not None and second_image is not None:
            scene_similarity = round(_scene_similarity(first_image, second_image), 6)
            scene_confidence = "same" if scene_similarity >= 0.82 else "changed" if scene_similarity <= 0.45 else "inconclusive"
            if scene_confidence == "same":
                different_vehicle = False
            elif scene_confidence == "changed":
                different_vehicle = different_vehicle and not same_vehicle
            else:
                same_vehicle = False
                different_vehicle = False
    confidence = "same" if same_vehicle else "different" if different_vehicle else "inconclusive"
    return {
        "same_vehicle": same_vehicle if same_vehicle or different_vehicle else None,
        "similarity": round(similarity, 6),
        "scene_similarity": scene_similarity,
        "scene_confidence": scene_confidence,
        "confidence": confidence,
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


def _locate_plate_regions(image: np.ndarray, max_regions: int = 5) -> list[tuple[int, int, int, int]]:
    """Finds rectangular, plate-shaped candidate regions using classical edge/contour geometry.

    This is a purpose-built, self-hosted heuristic (no external model weights, no license) that
    stands in for a trained plate detector: license plates are solid rectangles with a fairly
    consistent aspect ratio, so edge density + contour shape is a reasonable, fully local signal
    for where to crop before OCR, instead of running OCR across an entire uncropped photo.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    filtered = cv2.bilateralFilter(gray, 11, 17, 17)
    edges = cv2.Canny(filtered, 30, 200)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    image_area = image.shape[0] * image.shape[1]
    scored: list[tuple[float, tuple[int, int, int, int]]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w == 0 or h == 0:
            continue
        area = w * h
        aspect_ratio = w / h
        area_ratio = area / image_area if image_area else 0
        if not (1.8 <= aspect_ratio <= 6.0) or not (0.0005 <= area_ratio <= 0.25):
            continue
        contour_area = cv2.contourArea(contour)
        fill_ratio = (contour_area / area) if area else 0.0
        # Plates are solid, mostly-filled rectangles close to a ~3:1 ratio; score candidates by
        # how well they match both traits rather than accepting any rectangle-shaped edge blob.
        plate_likeness = fill_ratio * max(0.0, 1 - abs(aspect_ratio - 3.0) / 3.0)
        scored.append((plate_likeness, (x, y, w, h)))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [box for _, box in scored[:max_regions]]


def _read_plate_candidates(gray_image: np.ndarray, psm: int) -> list[tuple[str, float]]:
    enlarged = cv2.resize(gray_image, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    prepared = cv2.threshold(enlarged, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    data = pytesseract.image_to_data(
        prepared,
        config=f"--psm {psm} -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        output_type=pytesseract.Output.DICT,
    )
    return list(zip(data.get("text", []), data.get("conf", [])))


def _infer_plate_from_image(image: np.ndarray, vehicles: list[dict[str, int]] | None = None) -> dict[str, Any]:
    """ALPR for one frame. The trained plate detector + OCR pair when staged (anchored on the detector's
    vehicle boxes when they are known); the classical tesseract heuristic only as the not-staged fallback.

    A missing plate is a valid result. Full-frame OCR is deliberately excluded:
    timestamps, road signs, and watermarks are not registration evidence.
    """
    if plate_reader.staged():
        return plate_reader.read_plates(image, vehicles)
    return _infer_plate_legacy(image)


def _infer_plate_legacy(image: np.ndarray) -> dict[str, Any]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    candidates: dict[str, dict[str, Any]] = {}

    def consider(raw: str, confidence: Any, box: tuple[int, int, int, int]) -> None:
        normalized = _normalize_nz_plate(raw.strip())
        if not normalized:
            return
        try:
            score = max(0.0, min(1.0, float(confidence) / 100))
        except (TypeError, ValueError):
            score = 0.0
        plate, pattern = normalized
        adjusted = min(0.99, score + (0.15 if pattern.startswith("standard_") else 0.0) + 0.1)
        if adjusted < MIN_PLATE_SCORE:
            return
        candidates[plate] = {
            "plate": plate,
            "score": round(adjusted, 2),
            "pattern": pattern,
            "box": {"x": box[0], "y": box[1], "width": box[2], "height": box[3]},
        }

    for box in _locate_plate_regions(image):
        x, y, width, height = box
        if width < MIN_PLATE_REGION_WIDTH or height < MIN_PLATE_REGION_HEIGHT:
            continue
        pad_x, pad_y = round(width * 0.08), round(height * 0.2)
        x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
        x1, y1 = min(gray.shape[1], x + width + pad_x), min(gray.shape[0], y + height + pad_y)
        region = gray[y0:y1, x0:x1]
        if region.size == 0:
            continue
        for raw, confidence in _read_plate_candidates(region, psm=7):
            consider(raw, confidence, box)

    ordered = sorted(candidates.values(), key=lambda item: item["score"], reverse=True)
    best = ordered[0] if ordered else None
    return {
        "success": True,
        "plate": best["plate"] if best else None,
        "confidence": best["score"] if best else 0,
        "plate_status": "plate_detected" if best else "no_plate_detected",
        "plate_bbox": best["box"] if best else None,
        "evidence_quality": "reviewable" if best and best["score"] >= 0.75 else "insufficient",
        "results": [
            {"plate": item["plate"], "score": item["score"], "box": item["box"],
             "valid_nz_format": True, "nz_pattern": item["pattern"]}
            for item in ordered[:5]
        ],
        "alpr_provider": "local_tesseract_plate_region",
        "review_required": best is None or best["score"] < 0.75,
    }


@app.post("/infer/alpr")
async def alpr(
    photo: Annotated[UploadFile, File()],
    vehicle_bboxes: Annotated[str | None, Form()] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    vehicles = None
    if vehicle_bboxes:
        try:
            parsed = json.loads(vehicle_bboxes)
            vehicles = [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else None
        except json.JSONDecodeError:
            raise HTTPException(status_code=422, detail="vehicle_bboxes must be valid JSON")
    try:
        result = await _run_cpu(_infer_plate_from_image, image, vehicles)
    except (pytesseract.TesseractError, OSError, RuntimeError, cv2.error) as error:
        raise HTTPException(status_code=503, detail=f"ALPR unavailable: {error}") from error
    return JSONResponse(result)


def _face_sync(image: np.ndarray, person_bboxes: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    with _face_lock:
        return _face_sync_locked(image, person_bboxes)


def _face_sync_locked(image: np.ndarray, person_bboxes: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    detector, recognizer = _face_models()
    person_boxes = _face_person_boxes(image, person_bboxes)
    results: list[dict[str, Any]] = []
    index = 0
    for person in person_boxes:
        pad_x, pad_y = round(person["width"] * 0.08), round(person["height"] * 0.02)
        x0 = max(0, person["x"] - pad_x)
        y0 = max(0, person["y"] - pad_y)
        x1 = min(image.shape[1], person["x"] + person["width"] + pad_x)
        y1 = min(image.shape[0], person["y"] + round(person["height"] * 0.38))
        region = image[y0:y1, x0:x1]
        if region.size == 0:
            continue
        detector.setInputSize((region.shape[1], region.shape[0]))
        _, detections = detector.detect(region)
        for detection in detections if detections is not None else []:
            quality = _face_quality(region, detection)
            if not quality["usable_for_matching"]:
                continue
            align_image, align_detection = region, detection
            alignment_basis = "person_head_region"
            if 0 < detection[2] < MIN_FACE_CROP_WIDTH:
                enhanced = _upscale_face_region(region, detection, detector)
                if enhanced is not None:
                    align_image, align_detection = enhanced
                    alignment_basis = "deterministic_upscaled_head_region"
            aligned = recognizer.alignCrop(align_image, align_detection)
            embedding = recognizer.feature(aligned)
            vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(vector))
            if not np.isfinite(vector).all() or math.isclose(norm, 0.0):
                continue
            vector = vector / norm
            face_x, face_y, box_width, box_height = [float(value) for value in detection[:4]]
            index += 1
            results.append({
                "subject_label": f"Unidentified subject #{index}",
                "face_index": index,
                "bbox": {
                    "x": round(x0 + face_x, 3), "y": round(y0 + face_y, 3),
                    "width": round(box_width, 3), "height": round(box_height, 3),
                },
                "embedding": [round(float(value), 7) for value in vector],
                "embedding_dimension": int(vector.size),
                "detector_confidence": round(float(detection[-1]), 6),
                "face_crop_width_px": round(box_width, 3),
                "face_crop_height_px": round(box_height, 3),
                "alignment_basis": alignment_basis,
                "face_detector_model": YUNET_MODEL_PATH.name,
                "face_embedding_model": SFACE_MODEL_PATH.name,
                "candidate_person_record_id": None,
                "review_state": "manual_review_required",
                "matching_gate_version": "face_quality_v1",
                **quality,
            })
    detector.setInputSize((image.shape[1], image.shape[0]))
    return results


@app.post("/infer/face")
async def face(
    photo: Annotated[UploadFile, File()],
    person_bboxes: Annotated[str | None, Form()] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    parsed_boxes = None
    if person_bboxes is not None:
        try:
            parsed_boxes = json.loads(person_bboxes)
            if not isinstance(parsed_boxes, list) or any(not isinstance(item, dict) for item in parsed_boxes):
                raise ValueError("person_bboxes must be a JSON array of bounding boxes")
        except (json.JSONDecodeError, ValueError) as error:
            raise HTTPException(status_code=422, detail="person_bboxes must be a JSON array of bounding boxes") from error
    try:
        results = await _run_cpu(_face_sync, image, parsed_boxes)
        return JSONResponse({
            "success": True, "faces": results, "identity_resolution": "manual_review_required",
            "face_detection_scope": "person_head_regions", "matching_gate_version": "face_quality_v1",
        })
    except FileNotFoundError:
        return _capability_unavailable("yunet_sface_models")
    except (RuntimeError, cv2.error) as error:
        raise HTTPException(status_code=503, detail=f"face inference unavailable: {error}") from error


@app.post("/infer")
async def infer(
    photo: Annotated[UploadFile, File()],
    vehicle_bbox: Annotated[str | None, Form()] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    bbox = None
    if vehicle_bbox:
        try:
            parsed = json.loads(vehicle_bbox)
            bbox = parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            raise HTTPException(status_code=422, detail="vehicle_bbox must be valid JSON")
    cropped = _expand_vehicle_bbox(image, bbox)
    result = await _run_cpu(_infer_vehicle_attributes, cropped)
    result["vehicle_crop_status"] = "plate_anchored_crop" if bbox else "full_frame_review_only"
    return JSONResponse({"success": True, "data": result})


@app.post("/infer/people")
async def people(
    photo: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    try:
        detections = await _run_cpu(_detect_people, image)
        return JSONResponse({
            "success": True,
            "people": detections,
            "detector": "openvino_person_detection_0013",
            "animals": [],
            "animal_detection_status": "model_not_staged",
        })
    except FileNotFoundError:
        return _capability_unavailable("person_detection_model")
    except (RuntimeError, cv2.error) as error:
        raise HTTPException(status_code=503, detail=f"person detection unavailable: {error}") from error


@app.post("/infer/person-signature")
async def person_signature(
    photo: Annotated[UploadFile, File()],
    person_bbox: Annotated[str, Form()],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    try:
        parsed = json.loads(person_bbox)
        if not isinstance(parsed, dict):
            raise ValueError
        bbox = {key: int(parsed[key]) for key in ('x', 'y', 'width', 'height')}
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="person_bbox must contain integer x, y, width, and height") from error
    attributes = await _run_cpu(_person_appearance_attributes, image, bbox)
    return JSONResponse({
        "success": True,
        "authority": "provisional_similarity_only",
        "identity_resolution": "manual_review_required",
        "attributes": attributes,
        "prohibited_inferences": ["identity_truth", "weight", "health", "ethnicity", "age", "gender"],
    })


def _infer_face_if_requested(image: np.ndarray, person_bboxes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    try:
        faces = _face_sync(image, person_bboxes)
        return {"state": "candidate", "result": {"success": True, "faces": faces, "identity_resolution": "manual_review_required"}, "review_required": True}
    except Exception as error:
        return {"state": "unavailable", "reason": str(error), "review_required": True}


def _infer_frame(image: np.ndarray, tasks: set[str]) -> dict[str, Any]:
    """One frame, every requested task: the per-frame answer shape the vision watcher reads from /infer/batch
    (services/vision/vision_job_watcher.js), whichever machine (laptop GPU or VPS CPU) runs this service."""
    result: dict[str, Any] = {"success": True}
    triage = _triage_with_attributes(image) if tasks & {"person", "vehicle", "animal", "detect", "plate"} else None
    coverage = set((triage or {}).get("detector_coverage") or [])
    if triage is not None:
        result["detector_status"] = triage["detector_status"]
        result["detector_provider"] = triage.get("detector_provider")
        result["detector_model"] = triage.get("detector_model")
        result["detector_execution_provider"] = triage.get("detector_execution_provider")
        result["detector_passes"] = triage.get("detector_passes")
        result["detector_coverage"] = sorted(coverage)
        result["species_status"] = triage["species_status"]
        if triage.get("detector_error"):
            result["detector_error"] = triage["detector_error"]
    if "vehicle" in tasks or "plate" in tasks:
        vehicles = (triage or {}).get("vehicles") or []
        if vehicles:
            result["vehicles"] = vehicles
            result["vehicle"] = vehicles[0]["attributes"]
        else:
            result["vehicles"] = []
            result["vehicle"] = _infer_vehicle_attributes(image) if "vehicle" not in coverage else None
    if "plate" in tasks or "alpr" in tasks:
        try:
            result["alpr"] = _infer_plate_from_image(image, [vehicle["bbox"] for vehicle in (triage or {}).get("vehicles") or []])
        except Exception as error:
            result["alpr"] = {"success": False, "error": str(error)[:300], "review_required": True}
    if "person" in tasks:
        result["people"] = (triage or {}).get("people") if triage is not None else _detect_people(image)
        result["people_provider"] = (triage or {}).get("people_provider") or (triage or {}).get("detector_provider")
    animals = (triage or {}).get("animals") or []
    result["animals"] = animals
    if (triage or {}).get("suppressed_animals"):
        result["suppressed_animals"] = triage["suppressed_animals"]
    result["animal_detection_status"] = (
        "model_not_staged" if "animal" not in coverage
        else ("ready" if triage["species_status"] == "ready" else "detector_only_species_not_staged")
    )
    if "face" in tasks:
        face = _infer_face_if_requested(image, (triage or {}).get("people") if triage is not None else None)
        if face.get("state") == "candidate":
            result["face"] = face["result"]
        else:
            result["face"] = {"success": False, "error": face.get("reason"), "faces": []}
        result["faces"] = result["face"].get("faces", [])
        result["face_review_required"] = True
    return result


def _enhance_and_recognise(image: np.ndarray, tasks: set[str]) -> dict[str, Any]:
    enhanced, receipt = super_resolution.enhance(image, MODELS_DIR)
    encoded, jpeg = cv2.imencode('.jpg', enhanced, [cv2.IMWRITE_JPEG_QUALITY, 94])
    if not encoded:
        raise RuntimeError('enhanced derivative could not be encoded')
    return {
        "success": True,
        "schema_version": 2,
        "authority": "provisional",
        "review_required": True,
        "enhancement": receipt,
        "enhanced_image_base64": base64.b64encode(jpeg.tobytes()).decode('ascii'),
        "recognition": {
            "source": _infer_frame(image, tasks),
            "enhanced": _infer_frame(enhanced, tasks),
            "decision_rule": "human_review_of_source_and_enhanced_candidates",
        },
    }


@app.post("/infer/enhance")
async def enhance_capture(
    photo: Annotated[UploadFile, File()],
    tasks: Annotated[str | None, Form()] = None,
    source_frame_hash: Annotated[str | None, Form()] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    try:
        parsed_tasks = json.loads(tasks) if tasks else ["person", "vehicle", "animal", "plate", "face"]
        if not isinstance(parsed_tasks, list) or not all(isinstance(task, str) for task in parsed_tasks):
            raise ValueError
    except (ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="tasks must be a JSON string array") from error
    result = await _run_cpu(_enhance_and_recognise, image, set(parsed_tasks))
    result["source_frame_hash"] = source_frame_hash
    return JSONResponse(result)


class BatchFrameInput(BaseModel):
    frame_id: str
    image_base64: str


class BatchInferRequest(BaseModel):
    frames: list[BatchFrameInput] = Field(default_factory=list, max_length=64)
    tasks: list[str] | None = None


def _batch_sync(frames: list[BatchFrameInput], tasks: set[str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for frame in frames:
        image = _decode_image_data(frame.image_base64)
        if image is None:
            results.append({"frame_id": frame.frame_id, "result": {"success": False, "error": "undecodable_image"}})
            continue
        try:
            results.append({"frame_id": frame.frame_id, "result": _infer_frame(image, tasks)})
        except Exception as error:
            results.append({"frame_id": frame.frame_id, "result": {"success": False, "error": str(error)[:300]}})
    return results


@app.post("/infer/batch")
async def infer_batch(
    payload: BatchInferRequest,
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """One call answers a whole batch of frames, so the Tailscale-reachable laptop GPU tier triages and
    recognises a job's frames with one detector model and few round trips."""
    _authorize(authorization, x_inference_api_key)
    if not payload.frames:
        return {"success": True, "results": []}
    tasks = set(payload.tasks or ["person", "vehicle", "animal", "plate", "face"])
    results = await _run_cpu(_batch_sync, payload.frames, tasks)
    return {"success": True, "results": results}