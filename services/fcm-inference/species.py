"""Species identification for animal detections: SpeciesNet v4.0.2a on onnxruntime.

SpeciesNet (Google, Apache-2.0; Gadot et al. 2024, doi:10.1049/cvi2.12318) is the camera-trap species
classifier behind Wildlife Insights: EfficientNetV2-M, 2,498 labels, trained on 65M+ camera-trap images.
The checkpoint is exported to ONNX at image build time (`export_speciesnet_onnx.py`, parity-checked against
the PyTorch reference) so the runtime needs no torch. The label, taxonomy and geofence files ship unchanged.

Decision rules are a port of `speciesnet.ensemble_prediction_combiner` / `speciesnet.geofence_utils` for the
case this service is in — a general detector has already said "animal" — so the answers match the official
package: geofencing to the configured country (ISO 3166-1 alpha-3, default NZL) rolls an implausible species
up to the first plausible taxonomic level instead of inventing a local species; weak answers roll up to genus
/ family / order; below that the result is the detector's plain "animal".

Every answer carries the full 7-part SpeciesNet label, the decision source (classifier, classifier+geofence+
rollup_to_family, ...), the top-5 candidates and the execution provider. Mapping onto the platform's New
Zealand species table happens in detector.species_payload(); anything that does not map stays "other".
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import detector as entity_detector

MODELS_DIR = entity_detector.MODELS_DIR
SPECIESNET_VERSION = "4.0.2a"
SPECIESNET_ONNX_PATH = Path(os.getenv("SPECIESNET_ONNX_PATH", MODELS_DIR / "speciesnet_v4.0.2a_always_crop.onnx"))
SPECIESNET_LABELS_PATH = Path(os.getenv("SPECIESNET_LABELS_PATH", MODELS_DIR / "always_crop_99710272_22x8_v12_epoch_00148.labels.20251208.txt"))
SPECIESNET_TAXONOMY_PATH = Path(os.getenv("SPECIESNET_TAXONOMY_PATH", MODELS_DIR / "taxonomy_release.20251208.txt"))
SPECIESNET_GEOFENCE_PATH = Path(os.getenv("SPECIESNET_GEOFENCE_PATH", MODELS_DIR / "geofence_release.20251208.json"))
SPECIES_COUNTRY = os.getenv("SPECIES_COUNTRY", "NZL").strip().upper() or None
SPECIES_ADMIN1_REGION = os.getenv("SPECIES_ADMIN1_REGION", "").strip().upper() or None
SPECIES_GEOFENCE = os.getenv("SPECIES_GEOFENCE", "1").strip().lower() not in ("0", "off", "false")
IMG_SIZE = 480
TOP_K = 5

# Fixed labels from speciesnet.constants.Classification (uuid;class;order;family;genus;species;common name).
BLANK = "f1856211-cfb7-4a5b-9158-c0f72fd09ee6;;;;;;blank"
ANIMAL = "1f689929-883d-4dae-958c-3d57ab5b6c16;;;;;;animal"
HUMAN = "990ae9dd-7a59-4344-afcb-1b7b21368000;mammalia;primates;hominidae;homo;sapiens;human"
VEHICLE = "e2895ed5-780b-48f6-8a11-9e27cb594511;;;;;;vehicle"
UNKNOWN = "f2efdae9-efb8-48fb-8a91-eccf79ab4ffb;no cv result;no cv result;no cv result;no cv result;no cv result;no cv result"

_session: Any = None
_labels: list[str] = []
_taxonomy_map: dict[str, str] = {}
_geofence_map: dict[str, dict[str, Any]] = {}
_provider: str | None = None


def staged() -> bool:
    return all(entity_detector.path_is_file(path) for path in (SPECIESNET_ONNX_PATH, SPECIESNET_LABELS_PATH, SPECIESNET_TAXONOMY_PATH, SPECIESNET_GEOFENCE_PATH))


def status() -> dict[str, Any]:
    return {
        "species": "ready" if staged() else "not_staged",
        "species_provider": f"speciesnet:{SPECIESNET_VERSION}" if staged() else "detector_labels",
        "species_execution_provider": _provider,
        "species_country": SPECIES_COUNTRY,
        "species_admin1_region": SPECIES_ADMIN1_REGION,
        "species_geofence": SPECIES_GEOFENCE,
    }


# ------------------------------------------------------------------------------------------------ taxonomy


def taxa_from_label(label: str) -> str:
    return ";".join(label.split(";")[1:6])


def load_taxonomy_map(path: Path) -> dict[str, str]:
    """speciesnet.ensemble._load_taxonomy_from_file: taxa string -> canonical label."""
    labels = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    taxonomy_map = {taxa_from_label(label): label for label in labels}
    for label in (BLANK, VEHICLE, UNKNOWN):
        taxonomy_map.pop(taxa_from_label(label), None)
    for label in (HUMAN, ANIMAL):
        taxonomy_map[taxa_from_label(label)] = label
    return taxonomy_map


def get_ancestor_at_level(label: str, taxonomy_level: str, taxonomy_map: dict[str, str]) -> str | None:
    parts = label.split(";")
    if len(parts) != 7:
        raise ValueError(f"Expected label made of 7 parts, but found only {len(parts)}: {label}")
    if taxonomy_level == "species":
        ancestor = parts[1:6]
        if not ancestor[4]:
            return None
    elif taxonomy_level == "genus":
        ancestor = parts[1:5] + [""]
        if not ancestor[3]:
            return None
    elif taxonomy_level == "family":
        ancestor = parts[1:4] + ["", ""]
        if not ancestor[2]:
            return None
    elif taxonomy_level == "order":
        ancestor = parts[1:3] + ["", "", ""]
        if not ancestor[1]:
            return None
    elif taxonomy_level == "class":
        ancestor = parts[1:2] + ["", "", "", ""]
        if not ancestor[0]:
            return None
    elif taxonomy_level == "kingdom":
        ancestor = ["", "", "", "", ""]
        if not parts[1] and label != ANIMAL:
            return None
    else:
        return None
    return taxonomy_map.get(";".join(ancestor))


def should_geofence(label: str, country: str | None, admin1_region: str | None, geofence_map: dict[str, Any], enable: bool) -> bool:
    if not enable or not country:
        return False
    rules = geofence_map.get(taxa_from_label(label))
    if rules is None:
        return False
    allow = rules.get("allow")
    if allow:
        if country not in allow:
            return True
        allowed_regions = allow[country]
        if admin1_region and allowed_regions and admin1_region not in allowed_regions:
            return True
    block = rules.get("block")
    if block and country in block:
        blocked_regions = block[country]
        if not blocked_regions:
            return True
        if admin1_region and admin1_region in blocked_regions:
            return True
    return False


def roll_up(labels: list[str], scores: list[float], country: str | None, admin1_region: str | None, levels: list[str],
            non_blank_threshold: float, taxonomy_map: dict[str, str], geofence_map: dict[str, Any], enable: bool) -> tuple[str, float, str] | None:
    for level in levels:
        accumulated: dict[str, float] = {}
        for label, score in zip(labels, scores):
            ancestor = get_ancestor_at_level(label, level, taxonomy_map)
            if ancestor:
                accumulated[ancestor] = accumulated.get(ancestor, 0.0) + score
        best_label, best_score = None, 0.0
        for ancestor, score in accumulated.items():
            if score > best_score and not should_geofence(ancestor, country, admin1_region, geofence_map, enable):
                best_label, best_score = ancestor, score
        if best_label and best_score > non_blank_threshold:
            return best_label, best_score, f"classifier+rollup_to_{level}"
    return None


def geofence_classification(labels: list[str], scores: list[float], country: str | None, admin1_region: str | None,
                            taxonomy_map: dict[str, str], geofence_map: dict[str, Any], enable: bool) -> tuple[str, float, str]:
    if should_geofence(labels[0], country, admin1_region, geofence_map, enable):
        rolled = roll_up(labels, scores, country, admin1_region, ["family", "order", "class", "kingdom"], scores[0] - 1e-10, taxonomy_map, geofence_map, enable)
        if rolled:
            label, score, source = rolled
            return label, score, "classifier+geofence+" + source[len("classifier+"):]
        return UNKNOWN, scores[0], "classifier+geofence+rollup_failed"
    return labels[0], scores[0], "classifier"


def combine_for_animal_detection(labels: list[str], scores: list[float], detection_score: float, country: str | None,
                                 admin1_region: str | None, taxonomy_map: dict[str, str], geofence_map: dict[str, Any], enable: bool) -> tuple[str, float, str]:
    """speciesnet.ensemble_prediction_combiner.combine_predictions_for_single_item with a top detection of
    class ``animal`` (the only case this service reaches; the human/vehicle branches never apply)."""
    top_label, top_score = labels[0], scores[0]
    if detection_score < 0.2 and top_label == BLANK and top_score > 0.5:
        return BLANK, top_score, "classifier"
    if top_label == BLANK and top_score > 0.99:
        return BLANK, top_score, "classifier"
    if top_label not in (BLANK, HUMAN, VEHICLE):
        if top_score > 0.8 or (top_score > 0.65 and detection_score > 0.2):
            return geofence_classification(labels, scores, country, admin1_region, taxonomy_map, geofence_map, enable)
    rolled = roll_up(labels, scores, country, admin1_region, ["genus", "family", "order", "class", "kingdom"], 0.65, taxonomy_map, geofence_map, enable)
    if rolled:
        return rolled
    if detection_score > 0.5:
        return ANIMAL, detection_score, "detector"
    return UNKNOWN, top_score, "classifier"


# ------------------------------------------------------------------------------------------------ inference


def _load() -> Any:
    global _session, _labels, _taxonomy_map, _geofence_map, _provider
    if _session is not None:
        return _session
    if not staged():
        raise FileNotFoundError("SpeciesNet ONNX / labels / taxonomy / geofence are not staged")
    import onnxruntime as ort

    providers = entity_detector.onnx_providers()
    _session, providers = entity_detector.create_session(lambda chosen: ort.InferenceSession(str(SPECIESNET_ONNX_PATH), providers=chosen, sess_options=entity_detector.session_options()), providers)
    _provider = entity_detector.active_provider(_session, providers)
    _labels = [line.strip() for line in SPECIESNET_LABELS_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
    _taxonomy_map = load_taxonomy_map(SPECIESNET_TAXONOMY_PATH)
    _geofence_map = json.loads(SPECIESNET_GEOFENCE_PATH.read_text(encoding="utf-8"))
    return _session


def preprocess(crop_bgr: np.ndarray) -> np.ndarray:
    """RGB, bilinear resize to 480x480, [0,1] float32, HWC — the reference pipeline within ~0.007 probability."""
    rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (IMG_SIZE, IMG_SIZE), interpolation=cv2.INTER_LINEAR)
    return resized.astype(np.float32) / 255.0


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)


def common_name(label: str) -> str:
    parts = label.split(";")
    return parts[6] if len(parts) == 7 and parts[6] else (parts[-1] or "unknown")


def classify_crops(crops: list[np.ndarray], detection_scores: list[float]) -> list[dict[str, Any]]:
    """One SpeciesNet decision per animal crop (batched through the dynamic-batch ONNX graph)."""
    session = _load()
    if not crops:
        return []
    batch = np.stack([preprocess(crop) for crop in crops], axis=0)
    logits = session.run(["logits"], {"images_nhwc": batch})[0]
    probabilities = _softmax(np.asarray(logits, dtype=np.float32))
    results = []
    for row, detection_score in zip(probabilities, detection_scores):
        order = np.argsort(-row)
        labels = [_labels[index] for index in order]
        scores = [float(row[index]) for index in order]
        label, score, source = combine_for_animal_detection(labels, scores, float(detection_score), SPECIES_COUNTRY, SPECIES_ADMIN1_REGION, _taxonomy_map, _geofence_map, SPECIES_GEOFENCE)
        results.append({
            "label": label, "score": round(float(score), 4), "source": source, "common_name": common_name(label),
            "top": [{"label": labels[i], "common_name": common_name(labels[i]), "score": round(scores[i], 4)} for i in range(min(TOP_K, len(labels)))],
            "country": SPECIES_COUNTRY, "admin1_region": SPECIES_ADMIN1_REGION, "geofence": SPECIES_GEOFENCE,
            "provider": f"speciesnet:{SPECIESNET_VERSION}+onnxruntime@{_provider}",
        })
    return results


def classify_animal(image: np.ndarray, bbox: dict[str, int], detection_score: float) -> dict[str, Any]:
    """Species fields for one animal detection, in the shape the vision worker stores."""
    height, width = image.shape[:2]
    x0, y0 = max(0, int(bbox["x"])), max(0, int(bbox["y"]))
    x1, y1 = min(width, x0 + int(bbox["width"])), min(height, y0 + int(bbox["height"]))
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        crop = image
    result = classify_crops([crop], [detection_score])[0]
    label, source = result["label"], result["source"]
    if label == BLANK:
        payload = {"species": "other", "common_name": "Unidentified animal", "is_pest": None, "species_confidence": result["score"],
                   "species_status": "classifier_blank", "raw_label": label}
    elif label in (HUMAN, VEHICLE, UNKNOWN):
        payload = {"species": "other", "common_name": "Unidentified animal", "is_pest": None, "species_confidence": result["score"],
                   "species_status": "classifier_disagrees" if label != UNKNOWN else "unknown", "raw_label": label}
    elif label == ANIMAL:
        payload = {"species": "other", "common_name": "Unidentified animal", "is_pest": None, "species_confidence": result["score"],
                   "species_status": "animal_only", "raw_label": label}
    else:
        payload = entity_detector.species_payload(label, result["score"], result["provider"])
        if payload["species"] == "other":
            # A real taxon the New Zealand table does not name (or a family/order roll-up): keep SpeciesNet's own name.
            payload["common_name"] = result["common_name"].capitalize()
            payload["species_status"] = "taxon_above_species" if "rollup" in source else "unmapped_taxon"
    payload["species_provider"] = result["provider"]
    payload["speciesnet"] = {k: result[k] for k in ("label", "common_name", "score", "source", "top", "country", "admin1_region", "geofence")}
    return payload
