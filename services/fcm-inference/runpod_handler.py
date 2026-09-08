from __future__ import annotations

import base64
from typing import Any

import cv2
import numpy as np
import runpod

from app import (
    MODELS_DIR,
    PERSON_MODEL_PATH,
    SFACE_MODEL_PATH,
    VEHICLE_MODEL_PATH,
    YUNET_MODEL_PATH,
    _detect_people,
    _infer_vehicle_attributes,
)


def _image_from_input(value: str) -> np.ndarray:
    raw = value.split(",", 1)[1] if "," in value else value
    image = cv2.imdecode(np.frombuffer(base64.b64decode(raw, validate=True), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image_base64 is not a decodable image")
    return image


def _health_payload() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "fcm-inference",
        "models_dir": str(MODELS_DIR),
        "face_models": "ready" if YUNET_MODEL_PATH.is_file() and SFACE_MODEL_PATH.is_file() else "not_staged",
        "vehicle_model": "ready" if VEHICLE_MODEL_PATH.is_file() and VEHICLE_MODEL_PATH.with_suffix('.bin').is_file() else "not_staged",
        "person_model": "ready" if PERSON_MODEL_PATH.is_file() and PERSON_MODEL_PATH.with_suffix('.bin').is_file() else "not_staged",
    }


def handler(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input") or {}
    if payload.get("action") == "ping":
        return _health_payload()
    if payload.get("action") == "infer_batch":
        tasks = set(payload.get("tasks") or ["vehicle"])
        results = []
        for frame in payload.get("frames") or []:
            result = _infer_frame(_image_from_input(frame.get("image_base64", "")), tasks)
            results.append({"frame_id": frame.get("frame_id"), "result": result})
        return {"success": True, "results": results}
    if payload.get("action") != "infer":
        return {"success": False, "error": "unsupported_action"}

    image = _image_from_input(payload.get("image_base64", ""))
    tasks = set(payload.get("tasks") or ["vehicle"])
    return _infer_frame(image, tasks)


def _infer_frame(image: np.ndarray, tasks: set[str]) -> dict[str, Any]:
    result: dict[str, Any] = {"success": True}
    if "vehicle" in tasks or "plate" in tasks:
        result["vehicle"] = _infer_vehicle_attributes(image)
    if "person" in tasks:
        result["people"] = _detect_people(image)
    if "face" in tasks:
        result["faces"] = []
        result["face_review_required"] = True
    return result


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})