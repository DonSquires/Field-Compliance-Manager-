"""Entity triage (person / vehicle / animal) and animal species for camera footage.

Three optional model tiers, all lazily loaded and all honest about absence:

* Detector — MegaDetector (v5a/v6, classes animal/person/vehicle; built for camera-trap and trail-camera
  footage, which is exactly the forestry setting) or any Ultralytics COCO detector as a fallback. Set
  ``DETECTOR_MODEL_PATH``; the kind is inferred from the file name or forced with ``DETECTOR_KIND``.
* CPU vehicle detector — OpenVINO ``vehicle-detection-0200`` (no torch). Used when no general detector is
  staged; it covers vehicles only, and the result says so through ``coverage``.
* Species — SpeciesNet (Google camera-trap classifier, geofenced to New Zealand so only plausible taxa
  are reported) via the ``speciesnet`` package when ``SPECIES_PROVIDER=speciesnet``; or an Ultralytics
  classification model at ``SPECIES_MODEL_PATH`` whose class names are species labels.

When a tier is not staged the result says ``model_not_staged`` and carries no detections. Nothing here
invents a sighting; identity is never decided here either — that is a human review action.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

_APP_PATH = Path(__file__).resolve()
_REPO_MODELS_DIR = _APP_PATH.parents[2] / "models" if len(_APP_PATH.parents) > 2 else _APP_PATH.parent / "models"
MODELS_DIR = Path(os.getenv("MODELS_DIR", "/app/models" if Path("/app/models").is_dir() else str(_REPO_MODELS_DIR)))
DETECTOR_MODEL_PATH = Path(os.getenv("DETECTOR_MODEL_PATH", MODELS_DIR / "md_v5a.0.0.pt"))
DETECTOR_KIND = os.getenv("DETECTOR_KIND", "").strip().lower()
DETECTOR_CONFIDENCE = float(os.getenv("DETECTOR_CONFIDENCE", "0.25"))
OPENVINO_VEHICLE_DETECTOR_PATH = Path(os.getenv("OPENVINO_VEHICLE_DETECTOR_PATH", MODELS_DIR / "vehicle-detection-0200.xml"))
OPENVINO_VEHICLE_CONFIDENCE = float(os.getenv("OPENVINO_VEHICLE_CONFIDENCE", "0.4"))
SPECIES_PROVIDER = os.getenv("SPECIES_PROVIDER", "auto").strip().lower()
SPECIES_MODEL_PATH = Path(os.getenv("SPECIES_MODEL_PATH", MODELS_DIR / "species_classifier.pt"))
SPECIESNET_MODEL = os.getenv("SPECIESNET_MODEL", "kaggle:google/speciesnet/pyTorch/v4.0.1a")
SPECIES_COUNTRY = os.getenv("SPECIES_COUNTRY", "NZL")
SPECIES_MIN_CONFIDENCE = float(os.getenv("SPECIES_MIN_CONFIDENCE", "0.35"))

MEGADETECTOR_CLASSES = {0: "animal", 1: "person", 2: "vehicle"}
# A box covering (almost) the whole frame is the camera pressed against something, not an entity to identify.
MAX_BOX_AREA_RATIO = 0.85
# Below this a "person" is a few pixels of tree line; real people at trail-camera range are far taller.
MIN_PERSON_HEIGHT_RATIO = 0.05
MIN_BOX_AREA_RATIO = 0.001
COCO_TO_KIND = {
    "person": ("person", None),
    "bicycle": ("vehicle", "bicycle"), "car": ("vehicle", "car"), "motorcycle": ("vehicle", "motorcycle"),
    "bus": ("vehicle", "bus"), "train": ("vehicle", "train"), "truck": ("vehicle", "truck"), "boat": ("vehicle", "boat"),
    "bird": ("animal", "bird"), "cat": ("animal", "cat"), "dog": ("animal", "dog"), "horse": ("animal", "horse"),
    "sheep": ("animal", "sheep"), "cow": ("animal", "cattle"), "elephant": ("animal", "elephant"), "bear": ("animal", "bear"),
    "zebra": ("animal", "zebra"), "giraffe": ("animal", "giraffe"),
}


@dataclass(frozen=True)
class Species:
    key: str
    common_name: str
    is_pest: bool
    group: str
    aliases: tuple[str, ...] = ()


# New Zealand forestry / conservation pest animals first (Predator Free 2050 targets, regional pest
# management plans), then the common non-target species a trail camera sees. Keys are what the database
# stores in cctv_entity_observations.animal_type.
NZ_SPECIES: tuple[Species, ...] = (
    Species("possum", "Brushtail possum", True, "mammal", ("brushtail possum", "common brushtail possum", "trichosurus vulpecula")),
    Species("stoat", "Stoat", True, "mammal", ("mustela erminea", "ermine", "short-tailed weasel")),
    Species("ferret", "Ferret", True, "mammal", ("mustela furo", "mustela putorius furo", "mustela putorius")),
    Species("weasel", "Weasel", True, "mammal", ("mustela nivalis", "least weasel")),
    Species("rat", "Rat", True, "mammal", ("ship rat", "black rat", "norway rat", "brown rat", "kiore", "pacific rat", "rattus rattus", "rattus norvegicus", "rattus exulans", "rattus")),
    Species("mouse", "House mouse", True, "mammal", ("house mouse", "mus musculus")),
    Species("hedgehog", "Hedgehog", True, "mammal", ("european hedgehog", "erinaceus europaeus")),
    Species("deer", "Deer", True, "mammal", ("red deer", "fallow deer", "sika deer", "white-tailed deer", "sambar", "rusa", "wapiti", "elk", "cervus elaphus", "dama dama", "cervus nippon", "odocoileus virginianus", "cervidae")),
    Species("pig", "Feral pig", True, "mammal", ("feral pig", "wild boar", "wild pig", "boar", "sus scrofa")),
    Species("goat", "Feral goat", True, "mammal", ("feral goat", "capra hircus", "capra aegagrus hircus")),
    Species("cat", "Cat", True, "mammal", ("feral cat", "domestic cat", "felis catus", "felis silvestris catus")),
    Species("rabbit", "Rabbit", True, "mammal", ("european rabbit", "oryctolagus cuniculus")),
    Species("hare", "Hare", True, "mammal", ("european hare", "brown hare", "lepus europaeus")),
    Species("wallaby", "Wallaby", True, "mammal", ("bennett's wallaby", "red-necked wallaby", "dama wallaby", "tammar wallaby", "parma wallaby", "notamacropus", "macropus")),
    Species("tahr", "Himalayan tahr", True, "mammal", ("himalayan tahr", "hemitragus jemlahicus")),
    Species("chamois", "Chamois", True, "mammal", ("rupicapra rupicapra",)),
    Species("dog", "Dog", False, "mammal", ("domestic dog", "canis familiaris", "canis lupus familiaris")),
    Species("cattle", "Cattle", False, "mammal", ("cow", "bull", "bos taurus")),
    Species("sheep", "Sheep", False, "mammal", ("ovis aries",)),
    Species("horse", "Horse", False, "mammal", ("equus caballus", "equus ferus caballus")),
    Species("bird", "Bird", False, "bird", ("aves",)),
    Species("other", "Unidentified animal", False, "unknown", ("animal", "blank", "unknown")),
)

_SPECIES_BY_KEY = {species.key: species for species in NZ_SPECIES}
_SPECIES_BY_ALIAS: dict[str, Species] = {}
for _species in NZ_SPECIES:
    _SPECIES_BY_ALIAS[_species.key] = _species
    _SPECIES_BY_ALIAS[_species.common_name.lower()] = _species
    for _alias in _species.aliases:
        _SPECIES_BY_ALIAS[_alias] = _species


def normalise_species(label: str | None) -> Species | None:
    """Map a model label to a New Zealand species entry.

    Accepts plain labels (``"possum"``, ``"Rattus rattus"``) and SpeciesNet 7-part taxonomy strings
    (``"uuid;class;order;family;genus;species;common name"``): the common name, then genus+species, then
    genus, then family are tried in that order so a species-level answer wins over a family fallback.
    """
    if not label:
        return None
    text = str(label).strip().lower()
    if not text:
        return None
    candidates: list[str] = []
    if ";" in text:
        parts = [part.strip() for part in text.split(";")]
        if len(parts) >= 7:
            _uuid, taxon_class, order, family, genus, species, common = parts[:7]
            if common:
                candidates.append(common)
            if genus and species:
                candidates.append(f"{genus} {species}")
            if genus:
                candidates.append(genus)
            if family:
                candidates.append(family)
            if taxon_class == "aves":
                candidates.append("aves")
        else:
            candidates.extend(part for part in parts if part)
    else:
        candidates.append(text)
    for candidate in candidates:
        if candidate in _SPECIES_BY_ALIAS:
            return _SPECIES_BY_ALIAS[candidate]
    for candidate in candidates:
        for alias, species in _SPECIES_BY_ALIAS.items():
            if len(alias) >= 4 and (alias in candidate or candidate in alias):
                return species
    return None


def species_payload(label: str | None, confidence: float | None, provider: str) -> dict[str, Any]:
    """The species fields written onto an animal detection. Unknown labels stay 'other', never a guess."""
    species = normalise_species(label)
    score = float(confidence) if confidence is not None and np.isfinite(confidence) else None
    if species is None or (score is not None and score < SPECIES_MIN_CONFIDENCE):
        return {
            "species": "other", "common_name": "Unidentified animal", "is_pest": False,
            "species_confidence": score, "raw_label": label, "species_status": "below_threshold" if species else "unmapped_label",
            "species_provider": provider,
        }
    return {
        "species": species.key, "common_name": species.common_name, "is_pest": species.is_pest, "group": species.group,
        "species_confidence": score, "raw_label": label, "species_status": "candidate", "species_provider": provider,
    }


def detector_kind_for(path: Path, forced: str = DETECTOR_KIND) -> str:
    if forced in ("megadetector", "coco"):
        return forced
    name = path.name.lower()
    return "megadetector" if name.startswith("md") or "megadetector" in name else "coco"


def map_detection(kind: str, class_index: int, class_name: str | None) -> tuple[str, str | None] | None:
    """Return (entity_kind, coarse_label) for a raw class, or None when the class is not a person/vehicle/animal."""
    if kind == "megadetector":
        entity = MEGADETECTOR_CLASSES.get(int(class_index))
        return (entity, None) if entity else None
    mapped = COCO_TO_KIND.get(str(class_name or "").lower())
    return mapped


def bbox_from_xyxy(x0: float, y0: float, x1: float, y1: float, width: int, height: int) -> dict[str, int] | None:
    left, top = max(0, int(round(x0))), max(0, int(round(y0)))
    right, bottom = min(width, int(round(x1))), min(height, int(round(y1)))
    if right <= left or bottom <= top:
        return None
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def plausible_box(kind: str, bbox: dict[str, int] | None, width: int, height: int) -> bool:
    """Size sanity for a detection: not the whole frame, not a speck; people must be person-sized."""
    if bbox is None or width <= 0 or height <= 0:
        return False
    area_ratio = (bbox["width"] * bbox["height"]) / float(width * height)
    if area_ratio >= MAX_BOX_AREA_RATIO or area_ratio < MIN_BOX_AREA_RATIO:
        return False
    if kind == "person" and bbox["height"] < height * MIN_PERSON_HEIGHT_RATIO:
        return False
    return True


def detector_status() -> dict[str, Any]:
    staged = DETECTOR_MODEL_PATH.is_file()
    cpu_vehicle = _openvino_vehicle_staged()
    return {
        "detector": "ready" if staged else ("vehicle_only" if cpu_vehicle else "not_staged"),
        "detector_model": DETECTOR_MODEL_PATH.name if staged else (OPENVINO_VEHICLE_DETECTOR_PATH.name if cpu_vehicle else None),
        "detector_kind": detector_kind_for(DETECTOR_MODEL_PATH) if staged else ("openvino_vehicle" if cpu_vehicle else None),
        "coverage": ["person", "vehicle", "animal"] if staged else (["vehicle"] if cpu_vehicle else []),
        "species": "ready" if _species_available() else "not_staged",
        "species_provider": _species_provider(),
    }


def _openvino_vehicle_staged() -> bool:
    return OPENVINO_VEHICLE_DETECTOR_PATH.is_file() and OPENVINO_VEHICLE_DETECTOR_PATH.with_suffix(".bin").is_file()


def _species_provider() -> str:
    if SPECIES_PROVIDER in ("speciesnet", "classifier"):
        return SPECIES_PROVIDER
    if SPECIES_MODEL_PATH.is_file():
        return "classifier"
    try:
        import speciesnet  # noqa: F401
        return "speciesnet"
    except Exception:
        return "none"


def _species_available() -> bool:
    provider = _species_provider()
    if provider == "classifier":
        return SPECIES_MODEL_PATH.is_file()
    return provider == "speciesnet"


_detector_model: Any = None
_detector_names: dict[int, str] = {}
_species_model: Any = None
_speciesnet_model: Any = None
_openvino_vehicle_model: Any = None


def _load_openvino_vehicle_detector() -> Any:
    global _openvino_vehicle_model
    if _openvino_vehicle_model is not None:
        return _openvino_vehicle_model
    if not _openvino_vehicle_staged():
        raise FileNotFoundError("openvino vehicle detector is not staged")
    from openvino import Core

    core = Core()
    _openvino_vehicle_model = core.compile_model(core.read_model(str(OPENVINO_VEHICLE_DETECTOR_PATH)), "CPU")
    return _openvino_vehicle_model


def detect_vehicles_openvino(image: np.ndarray, confidence: float = OPENVINO_VEHICLE_CONFIDENCE) -> list[dict[str, Any]]:
    """vehicle-detection-0200: input 1x3x256x256 BGR, output [1,1,N,7] rows of
    [image_id, label(0=vehicle), conf, x_min, y_min, x_max, y_max] with normalised coordinates."""
    import cv2

    model = _load_openvino_vehicle_detector()
    height, width = image.shape[:2]
    blob = cv2.dnn.blobFromImage(image, 1.0, (256, 256), swapRB=False)
    rows = np.asarray(model([blob])[model.outputs[0]]).reshape(-1, 7)
    detections = []
    for row in rows:
        score = float(row[2])
        if score < confidence:
            continue
        bbox = bbox_from_xyxy(row[3] * width, row[4] * height, row[5] * width, row[6] * height, width, height)
        if not plausible_box("vehicle", bbox, width, height):
            continue
        detections.append({"kind": "vehicle", "coarse_label": None, "confidence": round(score, 3), "bbox": bbox, "raw_class": "vehicle"})
    detections.sort(key=lambda item: item["confidence"], reverse=True)
    return detections


def _load_detector() -> Any:
    global _detector_model, _detector_names
    if _detector_model is not None:
        return _detector_model
    if not DETECTOR_MODEL_PATH.is_file():
        raise FileNotFoundError("detector model is not staged")
    from ultralytics import YOLO  # heavy import, only when a model exists

    _detector_model = YOLO(str(DETECTOR_MODEL_PATH))
    names = getattr(_detector_model, "names", None) or {}
    _detector_names = {int(index): str(name) for index, name in (names.items() if isinstance(names, dict) else enumerate(names))}
    return _detector_model


def detect(image: np.ndarray, confidence: float = DETECTOR_CONFIDENCE) -> dict[str, Any]:
    """Triage every person / vehicle / animal in a frame. ``coverage`` lists the kinds the staged tier can see."""
    if not DETECTOR_MODEL_PATH.is_file():
        if _openvino_vehicle_staged():
            try:
                return {"status": "ready", "coverage": ["vehicle"], "detections": detect_vehicles_openvino(image),
                        "provider": f"openvino:{OPENVINO_VEHICLE_DETECTOR_PATH.name}"}
            except Exception as error:
                return {"status": "error", "coverage": ["vehicle"], "detections": [], "provider": OPENVINO_VEHICLE_DETECTOR_PATH.name, "error": str(error)[:300]}
        return {"status": "model_not_staged", "coverage": [], "detections": [], "provider": None}
    try:
        model = _load_detector()
        kind = detector_kind_for(DETECTOR_MODEL_PATH)
        height, width = image.shape[:2]
        results = model.predict(image, conf=confidence, verbose=False)
        detections: list[dict[str, Any]] = []
        for result in results:
            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue
            xyxy = boxes.xyxy.cpu().numpy() if hasattr(boxes.xyxy, "cpu") else np.asarray(boxes.xyxy)
            scores = boxes.conf.cpu().numpy() if hasattr(boxes.conf, "cpu") else np.asarray(boxes.conf)
            classes = boxes.cls.cpu().numpy() if hasattr(boxes.cls, "cpu") else np.asarray(boxes.cls)
            for (x0, y0, x1, y1), score, class_index in zip(xyxy, scores, classes):
                class_index = int(class_index)
                mapped = map_detection(kind, class_index, _detector_names.get(class_index))
                bbox = bbox_from_xyxy(x0, y0, x1, y1, width, height)
                if mapped is None or not plausible_box(mapped[0], bbox, width, height):
                    continue
                entity_kind, coarse = mapped
                detections.append({
                    "kind": entity_kind, "coarse_label": coarse, "confidence": round(float(score), 3), "bbox": bbox,
                    "raw_class": _detector_names.get(class_index, str(class_index)),
                })
        detections.sort(key=lambda item: item["confidence"], reverse=True)
        return {"status": "ready", "coverage": ["person", "vehicle", "animal"], "detections": detections, "provider": f"{kind}:{DETECTOR_MODEL_PATH.name}"}
    except Exception as error:  # a broken model must not take the whole frame down
        return {"status": "error", "coverage": [], "detections": [], "provider": DETECTOR_MODEL_PATH.name, "error": str(error)[:300]}


def _crop(image: np.ndarray, bbox: dict[str, int], padding: float = 0.15) -> np.ndarray:
    height, width = image.shape[:2]
    pad_x, pad_y = int(bbox["width"] * padding), int(bbox["height"] * padding)
    x0, y0 = max(0, bbox["x"] - pad_x), max(0, bbox["y"] - pad_y)
    x1, y1 = min(width, bbox["x"] + bbox["width"] + pad_x), min(height, bbox["y"] + bbox["height"] + pad_y)
    crop = image[y0:y1, x0:x1]
    return crop if crop.size else image


def classify_species(image: np.ndarray, bbox: dict[str, int]) -> dict[str, Any]:
    """Species for one animal detection, from whichever species tier is staged."""
    provider = _species_provider()
    crop = _crop(image, bbox)
    if provider == "speciesnet":
        return _classify_with_speciesnet(crop)
    if provider == "classifier" and SPECIES_MODEL_PATH.is_file():
        return _classify_with_classifier(crop)
    return {"species": "other", "common_name": "Unidentified animal", "is_pest": None, "species_confidence": None,
            "species_status": "model_not_staged", "species_provider": None}


def _classify_with_classifier(crop: np.ndarray) -> dict[str, Any]:
    global _species_model
    try:
        if _species_model is None:
            from ultralytics import YOLO

            _species_model = YOLO(str(SPECIES_MODEL_PATH))
        result = _species_model.predict(crop, verbose=False)[0]
        probs = getattr(result, "probs", None)
        if probs is None:
            raise RuntimeError("classifier returned no probabilities")
        top_index = int(probs.top1)
        names = _species_model.names
        label = names[top_index] if isinstance(names, (list, tuple)) else names.get(top_index)
        return species_payload(label, float(probs.top1conf), f"classifier:{SPECIES_MODEL_PATH.name}")
    except Exception as error:
        return {"species": "other", "common_name": "Unidentified animal", "is_pest": None, "species_confidence": None,
                "species_status": "error", "species_provider": SPECIES_MODEL_PATH.name, "error": str(error)[:300]}


def _classify_with_speciesnet(crop: np.ndarray) -> dict[str, Any]:
    global _speciesnet_model
    try:
        import cv2
        from speciesnet import SpeciesNet

        if _speciesnet_model is None:
            _speciesnet_model = SpeciesNet(SPECIESNET_MODEL, components="classifier")
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as handle:
            cv2.imwrite(handle.name, crop)
            temp_path = handle.name
        try:
            output = _speciesnet_model.classify(filepaths=[temp_path], country=SPECIES_COUNTRY, run_mode="single_thread")
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        prediction = (output.get("predictions") or [{}])[0]
        classes = (prediction.get("classifications") or {}).get("classes") or []
        scores = (prediction.get("classifications") or {}).get("scores") or []
        if not classes:
            raise RuntimeError("speciesnet returned no classes")
        return species_payload(classes[0], float(scores[0]) if scores else None, f"speciesnet:{SPECIESNET_MODEL}")
    except Exception as error:
        return {"species": "other", "common_name": "Unidentified animal", "is_pest": None, "species_confidence": None,
                "species_status": "error", "species_provider": "speciesnet", "error": str(error)[:300]}


def triage_frame(image: np.ndarray, want_species: bool = True) -> dict[str, Any]:
    """Detections grouped by kind, with species on animals. Shape consumed by the vision worker."""
    detection = detect(image)
    people = [item for item in detection["detections"] if item["kind"] == "person"]
    vehicles = [item for item in detection["detections"] if item["kind"] == "vehicle"]
    animals = []
    for item in detection["detections"]:
        if item["kind"] != "animal":
            continue
        entry = dict(item)
        if want_species:
            entry.update(classify_species(image, item["bbox"]))
        elif item.get("coarse_label"):
            entry.update(species_payload(item["coarse_label"], item["confidence"], detection["provider"] or "detector"))
        animals.append(entry)
    return {
        "detector_status": detection["status"], "detector_provider": detection.get("provider"),
        "detector_coverage": detection.get("coverage", []),
        "detector_error": detection.get("error"),
        "species_status": "ready" if _species_available() else "model_not_staged",
        "people": people, "vehicles": vehicles, "animals": animals,
    }
