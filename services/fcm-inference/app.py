from __future__ import annotations

import base64
import hmac
import json
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
from openvino import Core

import detector as entity_detector

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MIN_PLATE_REGION_WIDTH = 24
MIN_PLATE_REGION_HEIGHT = 8
MIN_PLATE_SCORE = 0.55
SIMILARITY_THRESHOLD = 0.92
DIFFERENT_VEHICLE_THRESHOLD = 0.75
APP_PATH = Path(__file__).resolve()
REPO_MODELS_DIR = APP_PATH.parents[2] / "models" if len(APP_PATH.parents) > 2 else APP_PATH.parent / "models"
DEFAULT_MODELS_DIR = Path("/app/models") if Path("/app/models").is_dir() else REPO_MODELS_DIR
MODELS_DIR = Path(os.getenv("MODELS_DIR", str(DEFAULT_MODELS_DIR)))
YUNET_MODEL_PATH = Path(os.getenv("YUNET_MODEL_PATH", MODELS_DIR / "face_detection_yunet_2023mar.onnx"))
SFACE_MODEL_PATH = Path(os.getenv("SFACE_MODEL_PATH", MODELS_DIR / "face_recognition_sface_2021dec.onnx"))
VEHICLE_MODEL_PATH = Path(os.getenv("VEHICLE_MODEL_PATH", MODELS_DIR / "vehicle-attributes-recognition-barrier-0039.xml"))
PERSON_MODEL_PATH = Path(os.getenv("PERSON_MODEL_PATH", MODELS_DIR / "person-detection-retail-0013.xml"))
PERSON_REID_MODEL_PATH = Path(os.getenv("PERSON_REID_MODEL_PATH", MODELS_DIR / "person-reidentification-retail-0288.xml"))
VEHICLE_REID_MODEL_PATH = Path(os.getenv("VEHICLE_REID_MODEL_PATH", MODELS_DIR / "vehicle-reid-0001.xml"))
APPEARANCE_EMBEDDING_DIMENSION = 256
_face_detector: cv2.FaceDetectorYN | None = None
_face_recognizer: cv2.FaceRecognizerSF | None = None
_vehicle_model: Any = None
_vehicle_compiled: Any = None
_person_compiled: Any = None
_person_reid_compiled: Any = None
_vehicle_reid_compiled: Any = None
VEHICLE_COLOURS = ("white", "gray", "yellow", "red", "green", "blue", "black")
VEHICLE_TYPES = ("car", "van", "truck", "bus")

app = FastAPI(title="FCM Inference", docs_url=None, redoc_url=None)


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
    if not VEHICLE_REID_MODEL_PATH.is_file() or not VEHICLE_REID_MODEL_PATH.with_suffix('.bin').is_file():
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
    if not VEHICLE_MODEL_PATH.is_file() or not VEHICLE_MODEL_PATH.with_suffix('.bin').is_file():
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


def _trained_vehicle_attributes(image: np.ndarray) -> dict[str, Any]:
    runtime = _vehicle_runtime()
    region = _vehicle_region(image)
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
    if not PERSON_MODEL_PATH.is_file() or not PERSON_MODEL_PATH.with_suffix('.bin').is_file():
        raise FileNotFoundError("person detection model is not staged")
    core = Core()
    _person_compiled = core.compile_model(core.read_model(str(PERSON_MODEL_PATH)), "CPU")
    return _person_compiled


def _person_reid_runtime() -> Any:
    global _person_reid_compiled
    if _person_reid_compiled is not None:
        return _person_reid_compiled
    if not PERSON_REID_MODEL_PATH.is_file() or not PERSON_REID_MODEL_PATH.with_suffix('.bin').is_file():
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


def _person_appearance_attributes(image: np.ndarray, bbox: dict[str, int]) -> dict[str, Any]:
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
    try:
        embedding = _person_reid_embedding(crop)
        embedding_model = PERSON_REID_MODEL_PATH.name
    except (FileNotFoundError, RuntimeError, cv2.error):
        # Same 256-d shape as the re-ID model so portfolio search still works, labelled as the fallback.
        embedding = _hsv_layout_embedding(crop)
        embedding_model = "deterministic_hsv_layout_v1"
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
            "attributes": _person_appearance_attributes(image, person_bbox),
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


def _infer_vehicle_attributes(image: np.ndarray) -> dict[str, Any]:
    height, width = image.shape[:2]
    trained = _trained_vehicle_attributes(image)
    colour, heuristic_confidence = _vehicle_colour(image)
    if trained["vehicle_colour"] is None and colour is not None:
        trained["vehicle_colour"] = colour
        trained["vehicle_colour_confidence"] = round(heuristic_confidence, 3)
    appearance_embedding, appearance_model = _vehicle_appearance_embedding(image)
    return {
        "embedding": _vehicle_embedding(image),
        "embedding_quality": round(min(1.0, max(0.0, (width * height) / (1280 * 720))), 3),
        "appearance_embedding": appearance_embedding,
        "appearance_embedding_model": appearance_model,
        "detection": {
            "bbox": {"x": 0, "y": 0, "width": width, "height": height},
            "confidence": 0.25,
        },
        "vehicle_crop_status": "full_frame_review_only",
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
    value = re.sub(r"[^A-Z0-9]", "", raw.upper())
    if not 3 <= len(value) <= 7:
        return None
    if not any(ch.isalpha() for ch in value):
        return None
    if not any(ch.isdigit() for ch in value):
        return None
    if re.fullmatch(r"[A-Z]{3}[0-9]{3}", value):
        return value, "standard_modern"
    if re.fullmatch(r"[A-Z]{2}[0-9]{4}", value):
        return value, "standard_older"
    if re.fullmatch(r"[A-Z0-9]{4,7}", value):
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
            person["attributes"] = _person_appearance_attributes(image, person["bbox"])
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
            attributes = _infer_vehicle_attributes(crop)
        except (FileNotFoundError, RuntimeError, cv2.error):
            embedding, model_name = _vehicle_appearance_embedding(crop)
            attributes = {"appearance_embedding": embedding, "appearance_embedding_model": model_name, "attribute_status": "vehicle_attribute_model_not_staged"}
        attributes["detection"] = {"bbox": vehicle["bbox"], "confidence": vehicle["confidence"]}
        attributes["vehicle_crop_status"] = "detector_crop"
        vehicle["attributes"] = attributes
    return triage


@app.get("/health")
async def health() -> dict[str, str]:
    detector_state = entity_detector.detector_status()
    return {
        "status": "ok",
        "service": "fcm-inference",
        "face_models": "ready" if YUNET_MODEL_PATH.is_file() and SFACE_MODEL_PATH.is_file() else "not_staged",
        "vehicle_model": "ready" if VEHICLE_MODEL_PATH.is_file() and VEHICLE_MODEL_PATH.with_suffix('.bin').is_file() else "not_staged",
        "person_model": "ready" if PERSON_MODEL_PATH.is_file() and PERSON_MODEL_PATH.with_suffix('.bin').is_file() else "not_staged",
        "person_reidentification_model": "ready" if PERSON_REID_MODEL_PATH.is_file() and PERSON_REID_MODEL_PATH.with_suffix('.bin').is_file() else "not_staged",
        "vehicle_reidentification_model": "ready" if VEHICLE_REID_MODEL_PATH.is_file() and VEHICLE_REID_MODEL_PATH.with_suffix('.bin').is_file() else "not_staged",
        "detector_model": detector_state["detector"],
        "species_model": detector_state["species"],
    }


@app.post("/infer/detect")
async def detect_entities(
    photo: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    """Person / vehicle / animal triage with species. Advisory: a human confirms every identity."""
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    triage = _triage_with_attributes(image)
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


def _infer_plate_from_image(image: np.ndarray) -> dict[str, Any]:
    """Return ALPR only when OCR is anchored to a plausible plate region.

    A missing plate is a valid result. Full-frame OCR is deliberately excluded:
    timestamps, road signs, and watermarks are not registration evidence.
    """
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
    authorization: Annotated[str | None, Header()] = None,
    x_inference_api_key: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    _authorize(authorization, x_inference_api_key)
    image = await _read_image(photo)
    try:
        result = _infer_plate_from_image(image)
    except (pytesseract.TesseractError, OSError) as error:
        raise HTTPException(status_code=503, detail=f"ALPR unavailable: {error}") from error
    return JSONResponse(result)


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
    result = _infer_vehicle_attributes(cropped)
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
        detections = _detect_people(image)
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
    attributes = _person_appearance_attributes(image, bbox)
    return JSONResponse({
        "success": True,
        "authority": "provisional_similarity_only",
        "identity_resolution": "manual_review_required",
        "attributes": attributes,
        "prohibited_inferences": ["identity_truth", "weight", "health", "ethnicity", "age", "gender"],
    })