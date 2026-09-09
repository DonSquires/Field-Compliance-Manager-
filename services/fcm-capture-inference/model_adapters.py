"""Optional capture-lane model adapters.

The capture endpoint owns enhancement and provenance. Recognition heads reuse the
same staged model families as fcm-inference when model assets are mounted; each
head reports unavailable independently instead of failing the entire capture.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


MODEL_ROOT = Path(os.getenv("MODELS_DIR", "/app/models"))
MODEL_PATHS = {
    "face_detection": MODEL_ROOT / "face_detection_yunet_2023mar.onnx",
    "face_embedding": MODEL_ROOT / "face_recognition_sface_2021dec.onnx",
    "vehicle_attributes": MODEL_ROOT / "vehicle-attributes-recognition-barrier-0039.xml",
    "vehicle_attributes_bin": MODEL_ROOT / "vehicle-attributes-recognition-barrier-0039.bin",
    "person_detection": MODEL_ROOT / "person-detection-retail-0013.xml",
    "person_detection_bin": MODEL_ROOT / "person-detection-retail-0013.bin",
    "animal_detection": MODEL_ROOT / "animal-detection.onnx",
}


def capability_status() -> dict[str, dict[str, Any]]:
    return {
        "alpr": {"state": "available", "provider": "capture-worker-alpr-adapter", "review_required": True},
        "face_embedding": {
            "state": "ready" if all(MODEL_PATHS[key].is_file() for key in ("face_detection", "face_embedding")) else "unavailable",
            "provider": "opencv_yunet_sface",
            "review_required": True,
        },
        "vehicle_attributes": {
            "state": "ready" if all(MODEL_PATHS[key].is_file() for key in ("vehicle_attributes", "vehicle_attributes_bin")) else "unavailable",
            "provider": "openvino_vehicle_attributes_0039",
            "review_required": True,
        },
        "person_detection": {
            "state": "ready" if all(MODEL_PATHS[key].is_file() for key in ("person_detection", "person_detection_bin")) else "unavailable",
            "provider": "openvino_person_detection_0013",
            "review_required": True,
        },
        "animal_detection": {
            "state": "ready" if MODEL_PATHS["animal_detection"].is_file() else "unavailable",
            "provider": "staged_animal_adapter",
            "review_required": True,
        },
    }
