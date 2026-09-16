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
    _face_models,
    _infer_plate_from_image,
    _infer_vehicle_attributes,
    _triage_with_attributes,
)
import detector as entity_detector

MAX_IMAGE_PIXELS = 20_000_000


def _enhance_capture(image: np.ndarray, scale: int = 3) -> tuple[np.ndarray, dict[str, Any]]:
    source_hash = __import__('hashlib').sha256(image.tobytes()).hexdigest()
    height, width = image.shape[:2]
    upscaled = cv2.resize(image, (width * scale, height * scale), interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(upscaled, cv2.COLOR_BGR2LAB)
    lightness, green_red, blue_yellow = cv2.split(lab)
    lightness = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(lightness)
    equalized = cv2.cvtColor(cv2.merge((lightness, green_red, blue_yellow)), cv2.COLOR_LAB2BGR)
    denoised = cv2.bilateralFilter(equalized, d=5, sigmaColor=35, sigmaSpace=35)
    blurred = cv2.GaussianBlur(denoised, (0, 0), 1.1)
    enhanced = np.clip(cv2.addWeighted(denoised, 1.35, blurred, -0.35, 0), 0, 255).astype(np.uint8)
    return enhanced, {
        "profile": "deterministic_capture_v1",
        "operations": ["crop", f"resize_{scale}x", "clahe_luminance", "bilateral_denoise", "unsharp_mask"],
        "generative": False,
        "source_sha256": source_hash,
        "enhanced_sha256": __import__('hashlib').sha256(enhanced.tobytes()).hexdigest(),
        "source_width": width,
        "source_height": height,
        "output_width": enhanced.shape[1],
        "output_height": enhanced.shape[0],
    }


def _image_from_input(value: str) -> np.ndarray:
    raw = value.split(",", 1)[1] if "," in value else value
    image = cv2.imdecode(np.frombuffer(base64.b64decode(raw, validate=True), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image_base64 is not a decodable image")
    if image.shape[0] * image.shape[1] > MAX_IMAGE_PIXELS:
        raise ValueError("image dimensions exceed the 20 megapixel limit")
    return image


def _health_payload() -> dict[str, str]:
    detector_state = entity_detector.detector_status()
    return {
        "status": "ok",
        "service": "fcm-inference",
        "models_dir": str(MODELS_DIR),
        "face_models": "ready" if YUNET_MODEL_PATH.is_file() and SFACE_MODEL_PATH.is_file() else "not_staged",
        "vehicle_model": "ready" if VEHICLE_MODEL_PATH.is_file() and VEHICLE_MODEL_PATH.with_suffix('.bin').is_file() else "not_staged",
        "person_model": "ready" if PERSON_MODEL_PATH.is_file() and PERSON_MODEL_PATH.with_suffix('.bin').is_file() else "not_staged",
        "detector_model": detector_state["detector"],
        "species_model": detector_state["species"],
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
    if payload.get("action") == "capture_recognition":
        image = _image_from_input(payload.get("image_base64", ""))
        enhanced, enhancement = _enhance_capture(image)
        tasks = set(payload.get("tasks") or [])
        result = {
            "schema_version": 1,
            "source_frame_hash": payload.get("source_frame_hash"),
            "enhanced_crop_hash": enhancement["enhanced_sha256"],
            "enhancement": enhancement,
            "authority": "provisional",
            "review_required": True,
            "alpr": {"state": "candidate", "result": _infer_alpr_if_requested(enhanced) if "alpr" in tasks else None, "review_required": True},
            "face": {"state": "candidate", "result": _infer_face_if_requested(enhanced) if "face_embedding" in tasks else None, "review_required": True},
            "vehicle": {"state": "ready" if "vehicle_attributes" in tasks else "not_requested", "result": _infer_vehicle_attributes(enhanced) if "vehicle_attributes" in tasks else None, "review_required": True},
            "animals": _animals_if_requested(enhanced) if "animal_detection" in tasks else {"state": "not_requested"},
        }
        return result
    if payload.get("action") != "infer":
        return {"success": False, "error": "unsupported_action"}

    image = _image_from_input(payload.get("image_base64", ""))
    tasks = set(payload.get("tasks") or ["vehicle"])
    return _infer_frame(image, tasks)


def _infer_frame(image: np.ndarray, tasks: set[str]) -> dict[str, Any]:
    """One frame, every requested task. Detector triage (person / vehicle / animal + species) when staged;
    the legacy `vehicle` key stays populated so older workers keep working."""
    result: dict[str, Any] = {"success": True}
    triage = _triage_with_attributes(image) if tasks & {"person", "vehicle", "animal", "detect"} else None
    coverage = set((triage or {}).get("detector_coverage") or [])
    if triage is not None:
        result["detector_status"] = triage["detector_status"]
        result["detector_provider"] = triage.get("detector_provider")
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
            # No vehicle tier, or nothing detected: the full-frame attribute pass is the review-only fallback.
            result["vehicle"] = _infer_vehicle_attributes(image) if "vehicle" not in coverage else None
    if "person" in tasks:
        result["people"] = (triage or {}).get("people") if triage is not None else _detect_people(image)
        result["people_provider"] = (triage or {}).get("people_provider") or (triage or {}).get("detector_provider")
    animals = (triage or {}).get("animals") or []
    result["animals"] = animals
    result["animal_detection_status"] = (
        "model_not_staged" if "animal" not in coverage
        else ("ready" if triage["species_status"] == "ready" else "detector_only_species_not_staged")
    )
    if "face" in tasks:
        result["faces"] = []
        result["face_review_required"] = True
    return result


def _animals_if_requested(image: np.ndarray) -> dict[str, Any]:
    triage = entity_detector.triage_frame(image)
    if triage["detector_status"] != "ready" or "animal" not in (triage.get("detector_coverage") or []):
        return {"state": "unavailable", "reason": "animal_detector_not_staged" if triage["detector_status"] == "ready" else f"detector_{triage['detector_status']}", "detections": [], "review_required": True}
    return {"state": "candidate", "species_status": triage["species_status"], "detections": triage["animals"], "review_required": True}


def _infer_alpr_if_requested(image: np.ndarray) -> dict[str, Any]:
    try:
        return {"state": "candidate", "result": _infer_plate_from_image(image), "review_required": True}
    except Exception as error:
        return {"state": "unavailable", "reason": str(error), "review_required": True}


def _infer_face_if_requested(image: np.ndarray) -> dict[str, Any]:
    try:
        detector, recognizer = _face_models()
        height, width = image.shape[:2]
        detector.setInputSize((width, height))
        _, detections = detector.detect(image)
        faces = []
        for index, detection in enumerate(detections if detections is not None else []):
            aligned = recognizer.alignCrop(image, detection)
            vector = np.asarray(recognizer.feature(aligned), dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(vector))
            if not np.isfinite(vector).all() or norm == 0: continue
            vector /= norm
            faces.append({"subject_label": f"Unidentified subject #{index + 1}", "face_index": index, "bbox": {"x": float(detection[0]), "y": float(detection[1]), "width": float(detection[2]), "height": float(detection[3])}, "embedding": [round(float(value), 7) for value in vector], "review_state": "manual_review_required"})
        return {"state": "candidate", "result": {"success": True, "faces": faces, "identity_resolution": "manual_review_required"}, "review_required": True}
    except Exception as error:
        return {"state": "unavailable", "reason": str(error), "review_required": True}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})