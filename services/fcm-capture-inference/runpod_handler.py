from __future__ import annotations

import base64
from typing import Any

import cv2
import numpy as np
import runpod

from capture_enhancement import enhance_capture
from model_adapters import capability_status

MAX_IMAGE_PIXELS = 20_000_000
MAX_CROP_PIXELS = 8_000_000


def _decode(value: str) -> np.ndarray:
    raw = value.split(",", 1)[1] if "," in value else value
    image = cv2.imdecode(np.frombuffer(base64.b64decode(raw, validate=True), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image_base64 is not a decodable image")
    if image.shape[0] * image.shape[1] > MAX_IMAGE_PIXELS:
        raise ValueError("image dimensions exceed the 20 megapixel limit")
    return image


def _crop(image: np.ndarray, crop: dict[str, Any] | None) -> np.ndarray:
    if not crop:
        return image
    x = max(0, int(crop.get("x", 0)))
    y = max(0, int(crop.get("y", 0)))
    width = max(1, int(crop.get("width", image.shape[1])))
    height = max(1, int(crop.get("height", image.shape[0])))
    x2 = min(image.shape[1], x + width)
    y2 = min(image.shape[0], y + height)
    if x >= x2 or y >= y2:
        raise ValueError("capture crop is outside the source image")
    result = image[y:y2, x:x2]
    if result.shape[0] * result.shape[1] > MAX_CROP_PIXELS:
        raise ValueError("capture crop exceeds the 8 megapixel limit")
    return result


def handler(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input") or {}
    if payload.get("action") == "ping":
        return {"status": "ok", "service": "fcm-capture-inference", "enhancement": "deterministic_capture_v1", "capabilities": capability_status()}
    if payload.get("action") != "capture_recognition":
        return {"success": False, "error": "unsupported_action"}
    source_hash = str(payload.get("source_frame_hash") or "")
    if len(source_hash) != 64:
        return {"success": False, "error": "source_frame_hash_required"}
    try:
        source = _decode(str(payload.get("image_base64") or ""))
        crop = _crop(source, payload.get("crop"))
        enhanced, receipt = enhance_capture(crop)
        tasks = set(payload.get("tasks") or [])
        response: dict[str, Any] = {
            "schema_version": 1,
            "source_frame_hash": source_hash,
            "enhanced_crop_hash": receipt.enhanced_sha256,
            "enhancement": receipt.as_dict(),
            "authority": "provisional",
            "review_required": True,
            "capabilities": capability_status(),
        }
        response["alpr"] = {"state": "unavailable", "reason": "alpr_model_not_staged", "review_required": True} if "alpr" in tasks else {"state": "not_requested"}
        response["face"] = {"state": "unavailable", "reason": "face_model_not_staged", "candidate_matches": [], "review_required": True} if "face_embedding" in tasks else {"state": "not_requested"}
        response["vehicle"] = {"state": "unavailable", "reason": "vehicle_attributes_model_not_staged", "review_required": True} if "vehicle_attributes" in tasks else {"state": "not_requested"}
        response["animals"] = {"state": "unavailable", "reason": "animal_model_not_staged", "detections": [], "review_required": True} if "animal_detection" in tasks else {"state": "not_requested"}
        return response
    except (ValueError, cv2.error) as error:
        return {"success": False, "state": "unavailable", "reason": str(error), "review_required": True, "authority": "provisional"}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
