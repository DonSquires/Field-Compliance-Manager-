"""Automatic number-plate reading: a trained plate detector anchored on the vehicle, then a trained OCR.

Two ONNX models, both permissively licensed and run through onnxruntime (CUDA when present, CPU otherwise):

* ``yolo-v9-*-license-plate-end2end`` (open-image-models, MIT): finds plate rectangles. It is run on the
  full frame and, when the entity detector has already found vehicles, on each vehicle crop at native
  resolution (upscaled when the vehicle is small) so a far-field plate is not lost to downsampling.
* ``cct-s-v2-global-model`` (fast-plate-ocr, MIT): reads the characters of one plate crop and returns a
  probability per character slot plus a plate-region head that knows New Zealand.

Every reading is advisory. The score is built from the weakest character, the mean character confidence and
the detector confidence, and only readings that fit a New Zealand format are promoted; the raw text and the
rejected candidates are returned so a reviewer can see what the model actually saw. Full-frame OCR is never
run: a timestamp or a road sign is not a registration.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import detector as entity_detector

MODELS_DIR = entity_detector.MODELS_DIR
PLATE_DETECTOR_MODEL = os.getenv("PLATE_DETECTOR_MODEL", "yolo-v9-s-608-license-plate-end2end")
PLATE_DETECTOR_FILES = {
    "yolo-v9-s-608-license-plate-end2end": "yolo-v9-s-608-license-plates-end2end.onnx",
    "yolo-v9-t-640-license-plate-end2end": "yolo-v9-t-640-license-plates-end2end.onnx",
    "yolo-v9-t-512-license-plate-end2end": "yolo-v9-t-512-license-plates-end2end.onnx",
    "yolo-v9-t-416-license-plate-end2end": "yolo-v9-t-416-license-plates-end2end.onnx",
    "yolo-v9-t-384-license-plate-end2end": "yolo-v9-t-384-license-plates-end2end.onnx",
    "yolo-v9-t-256-license-plate-end2end": "yolo-v9-t-256-license-plates-end2end.onnx",
}
PLATE_DETECTOR_PATH = Path(os.getenv("PLATE_DETECTOR_PATH", MODELS_DIR / PLATE_DETECTOR_FILES.get(PLATE_DETECTOR_MODEL, f"{PLATE_DETECTOR_MODEL}.onnx")))
PLATE_OCR_MODEL = os.getenv("PLATE_OCR_MODEL", "cct-s-v2-global-model")
PLATE_OCR_FILES = {
    "cct-s-v2-global-model": ("cct_s_v2_global.onnx", "cct_s_v2_global_plate_config.yaml"),
    "cct-xs-v2-global-model": ("cct_xs_v2_global.onnx", "cct_xs_v2_global_plate_config.yaml"),
}
_ocr_onnx, _ocr_config = PLATE_OCR_FILES.get(PLATE_OCR_MODEL, (f"{PLATE_OCR_MODEL}.onnx", f"{PLATE_OCR_MODEL}.yaml"))
PLATE_OCR_PATH = Path(os.getenv("PLATE_OCR_PATH", MODELS_DIR / _ocr_onnx))
PLATE_OCR_CONFIG_PATH = Path(os.getenv("PLATE_OCR_CONFIG_PATH", MODELS_DIR / _ocr_config))

PLATE_DETECT_MIN_CONFIDENCE = float(os.getenv("PLATE_DETECT_MIN_CONFIDENCE", "0.30"))
# Below this many pixels across, a plate crop has no character detail left; whatever the OCR says is a guess.
MIN_PLATE_CROP_WIDTH = int(os.getenv("MIN_PLATE_CROP_WIDTH", "48"))
MIN_PLATE_SCORE = 0.55
REVIEWABLE_PLATE_SCORE = 0.75
# A vehicle crop narrower than this is upscaled before plate detection (capped at 3x) so the detector sees
# a plate at least a few dozen pixels wide.
VEHICLE_CROP_TARGET_WIDTH = 480
MAX_UPSCALE = 3.0
PLATE_PROVIDER = "yolo_v9_plate_detector+cct_s_v2_global_ocr"

_plate_detector: Any = None
_plate_ocr: Any = None
_active_providers: dict[str, str | None] = {"detector": None, "ocr": None}


def normalize_nz_plate(raw: str) -> tuple[str, str] | None:
    """Accept a reading only when it is shaped like a New Zealand registration.

    ``standard_modern`` AAA123 (issued from 2001), ``standard_older`` AA1234, otherwise a 4–7 character
    ``personalised`` plate that still mixes letters and digits. Anything else is OCR noise, not evidence.
    """
    value = re.sub(r"[^A-Z0-9]", "", str(raw or "").upper())
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


# Characters the OCR most often swaps when the plate is small or motion-blurred, in each direction.
_TO_LETTER = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "4": "A"}
_TO_DIGIT = {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2", "S": "5", "B": "8", "G": "6", "A": "4"}


def syntax_correct(raw: str) -> tuple[str, list[str]] | None:
    """Positional disambiguation for a six-character reading that is one confusable swap away from AAA123 /
    AA1234. Returns the corrected plate and the list of swaps made, or None when no standard shape is reachable.
    Corrections are reported alongside the raw text; they are never silent."""
    value = re.sub(r"[^A-Z0-9]", "", str(raw or "").upper())
    if len(value) != 6:
        return None
    options: list[tuple[str, list[str]]] = []
    for letters in (3, 2):
        corrected = []
        swaps: list[str] = []
        for index, ch in enumerate(value):
            want_letter = index < letters
            if want_letter and ch.isdigit():
                replacement = _TO_LETTER.get(ch)
            elif not want_letter and ch.isalpha():
                replacement = _TO_DIGIT.get(ch)
            else:
                replacement = ch
            if replacement is None:
                corrected = []
                break
            if replacement != ch:
                swaps.append(f"{index}:{ch}->{replacement}")
            corrected.append(replacement)
        if corrected and len(swaps) <= 2:
            candidate = "".join(corrected)
            if normalize_nz_plate(candidate):
                options.append((candidate, swaps))
    if not options:
        return None
    # Fewest swaps wins; on a tie the modern AAA123 layout (tried first) is kept.
    return min(options, key=lambda item: len(item[1]))


def staged() -> bool:
    return all(entity_detector.path_is_file(path) for path in (PLATE_DETECTOR_PATH, PLATE_OCR_PATH, PLATE_OCR_CONFIG_PATH))


def status() -> dict[str, Any]:
    return {
        "alpr": "ready" if staged() else "not_staged",
        "alpr_provider": PLATE_PROVIDER if staged() else "local_tesseract_plate_region",
        "plate_detector_model": PLATE_DETECTOR_MODEL if entity_detector.path_is_file(PLATE_DETECTOR_PATH) else None,
        "plate_ocr_model": PLATE_OCR_MODEL if entity_detector.path_is_file(PLATE_OCR_PATH) else None,
        "plate_detector_provider": _active_providers["detector"],
        "plate_ocr_provider": _active_providers["ocr"],
    }


def _load_plate_detector() -> Any:
    global _plate_detector
    if _plate_detector is not None:
        return _plate_detector
    if not entity_detector.path_is_file(PLATE_DETECTOR_PATH):
        raise FileNotFoundError("plate detector model is not staged")
    from open_image_models.detection.core.yolo_v9.inference import YoloV9Detector

    providers = entity_detector.onnx_providers()
    _plate_detector, providers = entity_detector.create_session(
        lambda chosen: YoloV9Detector(str(PLATE_DETECTOR_PATH), ["License Plate"], conf_thresh=PLATE_DETECT_MIN_CONFIDENCE, providers=chosen, sess_options=entity_detector.session_options()), providers,
    )
    _active_providers["detector"] = entity_detector.active_provider(getattr(_plate_detector, "model", None), providers)
    return _plate_detector


def _load_plate_ocr() -> Any:
    global _plate_ocr
    if _plate_ocr is not None:
        return _plate_ocr
    if not entity_detector.path_is_file(PLATE_OCR_PATH) or not entity_detector.path_is_file(PLATE_OCR_CONFIG_PATH):
        raise FileNotFoundError("plate OCR model is not staged")
    from fast_plate_ocr import LicensePlateRecognizer

    providers = entity_detector.onnx_providers()
    _plate_ocr, providers = entity_detector.create_session(
        lambda chosen: LicensePlateRecognizer(onnx_model_path=str(PLATE_OCR_PATH), plate_config_path=str(PLATE_OCR_CONFIG_PATH), providers=chosen, sess_options=entity_detector.session_options()), providers,
    )
    _active_providers["ocr"] = entity_detector.active_provider(getattr(_plate_ocr, "model", None), providers)
    return _plate_ocr


def _iou(a: dict[str, int], b: dict[str, int]) -> float:
    return entity_detector.box_iou(a, b)


def _detect_plate_boxes(image: np.ndarray, vehicles: list[dict[str, int]] | None) -> list[dict[str, Any]]:
    """Plate rectangles in frame coordinates. Full frame first, then each vehicle crop at native (or
    upscaled) resolution; duplicates are collapsed onto the higher-confidence box."""
    detector = _load_plate_detector()
    height, width = image.shape[:2]
    found: list[dict[str, Any]] = []

    def consider(results: Any, offset_x: int, offset_y: int, scale: float, vehicle_bbox: dict[str, int] | None, source: str) -> None:
        for result in results or []:
            box = result.bounding_box
            bbox = entity_detector.bbox_from_xyxy(
                offset_x + box.x1 / scale, offset_y + box.y1 / scale, offset_x + box.x2 / scale, offset_y + box.y2 / scale, width, height,
            )
            if bbox is None or bbox["width"] < 8 or bbox["height"] < 4:
                continue
            confidence = round(float(result.confidence), 3)
            for existing in found:
                if _iou(existing["bbox"], bbox) >= 0.5:
                    if confidence > existing["confidence"]:
                        existing.update({"bbox": bbox, "confidence": confidence, "source": source})
                    if vehicle_bbox is not None and existing.get("vehicle_bbox") is None:
                        existing["vehicle_bbox"] = vehicle_bbox
                    break
            else:
                found.append({"bbox": bbox, "confidence": confidence, "vehicle_bbox": vehicle_bbox, "source": source})

    consider(detector.predict(image), 0, 0, 1.0, None, "full_frame")
    for vehicle in vehicles or []:
        try:
            x, y, w, h = (int(vehicle[key]) for key in ("x", "y", "width", "height"))
        except (KeyError, TypeError, ValueError):
            continue
        pad_x, pad_y = int(w * 0.1), int(h * 0.1)
        x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
        x1, y1 = min(width, x + w + pad_x), min(height, y + h + pad_y)
        crop = image[y0:y1, x0:x1]
        if crop.size == 0 or crop.shape[1] < 24:
            continue
        scale = 1.0
        if crop.shape[1] < VEHICLE_CROP_TARGET_WIDTH:
            scale = min(MAX_UPSCALE, VEHICLE_CROP_TARGET_WIDTH / crop.shape[1])
            crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        consider(detector.predict(crop), x0, y0, scale, {"x": x, "y": y, "width": w, "height": h}, "vehicle_crop")
    found.sort(key=lambda item: item["confidence"], reverse=True)
    return found


def _plate_crop(image: np.ndarray, bbox: dict[str, int]) -> np.ndarray:
    height, width = image.shape[:2]
    pad_x, pad_y = max(2, int(bbox["width"] * 0.08)), max(2, int(bbox["height"] * 0.15))
    x0, y0 = max(0, bbox["x"] - pad_x), max(0, bbox["y"] - pad_y)
    x1, y1 = min(width, bbox["x"] + bbox["width"] + pad_x), min(height, bbox["y"] + bbox["height"] + pad_y)
    crop = image[y0:y1, x0:x1]
    if crop.size and crop.shape[1] < 192:
        crop = cv2.resize(crop, None, fx=192 / crop.shape[1], fy=192 / crop.shape[1], interpolation=cv2.INTER_CUBIC)
    return crop


def _ocr_variants(crop: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """The raw crop and a contrast-equalised copy: dusk, headlight glare and backlit plates read differently."""
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    lightness, a, b = cv2.split(lab)
    lightness = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(lightness)
    equalised = cv2.cvtColor(cv2.merge((lightness, a, b)), cv2.COLOR_LAB2BGR)
    return [("raw", crop), ("clahe", equalised)]


def _read_crop(crop: np.ndarray) -> list[dict[str, Any]]:
    """OCR one plate crop in each variant. The model expects RGB channels-last uint8."""
    ocr = _load_plate_ocr()
    readings = []
    for variant, prepared in _ocr_variants(crop):
        rgb = cv2.cvtColor(prepared, cv2.COLOR_BGR2RGB)
        predictions = ocr.run(rgb, return_confidence=True)
        if not predictions:
            continue
        prediction = predictions[0]
        raw_text = str(getattr(prediction, "plate", "") or "").upper()
        character_indexes = [index for index, character in enumerate(raw_text) if character in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"]
        text = "".join(raw_text[index] for index in character_indexes)
        probs = np.asarray(getattr(prediction, "char_probs", None) if getattr(prediction, "char_probs", None) is not None else [], dtype=np.float32).reshape(-1)
        used = probs[character_indexes] if character_indexes and probs.size == len(raw_text) else (
            probs if raw_text == text and probs.size == len(text) else np.asarray([], dtype=np.float32)
        )
        char_min = float(used.min()) if used.size else 0.0
        char_mean = float(used.mean()) if used.size else 0.0
        region = getattr(prediction, "region", None)
        region_prob = getattr(prediction, "region_prob", None)
        readings.append({
            "variant": variant, "text": text, "char_min": round(char_min, 3), "char_mean": round(char_mean, 3),
            "char_confidences": [round(float(value), 3) for value in used[: len(text)]],
            "region": str(region) if region else None,
            "region_confidence": round(float(region_prob), 3) if region_prob is not None else None,
        })
    return readings


def _score(reading: dict[str, Any], detector_confidence: float, pattern: str, corrected: bool) -> float:
    score = 0.55 * reading["char_min"] + 0.25 * reading["char_mean"] + 0.20 * detector_confidence
    if pattern.startswith("standard_"):
        score += 0.05
    if reading.get("region") == "New Zealand" and (reading.get("region_confidence") or 0) >= 0.5:
        score += 0.05
    if corrected:
        score -= 0.10
    return round(max(0.0, min(0.99, score)), 3)


def read_plates(image: np.ndarray, vehicles: list[dict[str, int]] | None = None) -> dict[str, Any]:
    """The ALPR result for one frame. Same shape the vision worker and the consolidator already consume
    (``plate``, ``confidence``, ``plate_bbox``, ``results[]``) plus the evidence behind each reading."""
    boxes = _detect_plate_boxes(image, vehicles)
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for box in boxes[:8]:
        bbox = box["bbox"]
        crop = _plate_crop(image, bbox)
        if crop.size == 0:
            continue
        readings = _read_crop(crop)
        best: dict[str, Any] | None = None
        for reading in readings:
            if not reading["text"]:
                continue
            corrections: list[str] = []
            normalised = normalize_nz_plate(reading["text"])
            if normalised is None:
                fixed = syntax_correct(reading["text"])
                if fixed is not None:
                    normalised = normalize_nz_plate(fixed[0])
                    corrections = fixed[1]
            if normalised is None:
                rejected.append({"raw_text": reading["text"], "box": bbox, "char_confidence_min": reading["char_min"],
                                 "variant": reading["variant"], "reason": "not_nz_format"})
                continue
            plate, pattern = normalised
            score = _score(reading, box["confidence"], pattern, bool(corrections))
            candidate = {
                "plate": plate, "score": score, "box": bbox, "valid_nz_format": True, "nz_pattern": pattern,
                "raw_text": reading["text"], "corrections": corrections, "ocr_variant": reading["variant"],
                "char_confidence_min": reading["char_min"], "char_confidence_mean": reading["char_mean"],
                "char_confidences": reading["char_confidences"],
                "detector_confidence": box["confidence"], "region": reading["region"], "region_confidence": reading["region_confidence"],
                "vehicle_bbox": box.get("vehicle_bbox"), "plate_source": box["source"], "plate_width_px": bbox["width"],
            }
            if best is None or candidate["score"] > best["score"]:
                best = candidate
        if best is None:
            continue
        if best["score"] < MIN_PLATE_SCORE:
            rejected.append({"raw_text": best["raw_text"], "plate": best["plate"], "box": bbox, "score": best["score"], "reason": "below_min_score"})
            continue
        if bbox["width"] < MIN_PLATE_CROP_WIDTH:
            best["evidence_quality"] = "insufficient"
            best["quality_reason"] = "plate_too_small"
        else:
            best["evidence_quality"] = "reviewable" if best["score"] >= REVIEWABLE_PLATE_SCORE else "insufficient"
        accepted.append(best)
    # One reading per plate string: keep the strongest.
    by_plate: dict[str, dict[str, Any]] = {}
    for item in accepted:
        if item["plate"] not in by_plate or item["score"] > by_plate[item["plate"]]["score"]:
            by_plate[item["plate"]] = item
    ordered = sorted(by_plate.values(), key=lambda item: item["score"], reverse=True)
    best = ordered[0] if ordered else None
    # A plate that was located but could not be read is still evidence: the reviewer gets the box to zoom on
    # and the enhancement pass gets its crop anchor.
    located = [{"box": box["bbox"], "confidence": box["confidence"], "vehicle_bbox": box.get("vehicle_bbox"), "source": box["source"]} for box in boxes[:5]]
    if best:
        plate_status = "plate_detected"
    elif boxes:
        plate_status = "plate_unreadable"
    else:
        plate_status = "no_plate_detected"
    anchor_box = best["box"] if best else (located[0]["box"] if located else None)
    return {
        "success": True,
        "plate": best["plate"] if best else None,
        "confidence": best["score"] if best else 0,
        "plate_status": plate_status,
        "plate_bbox": anchor_box,
        "box": anchor_box,
        "evidence_quality": best["evidence_quality"] if best else "insufficient",
        "results": ordered[:5],
        "rejected": rejected[:5],
        "located_plates": located,
        "plates_detected": len(boxes),
        "alpr_provider": PLATE_PROVIDER,
        "alpr_models": {"plate_detector": PLATE_DETECTOR_MODEL, "plate_ocr": PLATE_OCR_MODEL,
                        "detector_provider": _active_providers["detector"], "ocr_provider": _active_providers["ocr"]},
        "review_required": best is None or best["score"] < REVIEWABLE_PLATE_SCORE or best["evidence_quality"] != "reviewable",
    }
