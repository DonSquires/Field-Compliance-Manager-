"""Entity triage (person / vehicle / animal) and animal species for camera footage.

Model tiers, all lazily loaded and all honest about absence:

* Detector — RF-DETR (Roboflow, Apache-2.0) exported to ONNX and run through onnxruntime: CUDA when the
  image has a GPU, CPU otherwise. ``rf-detr-large-704-coco`` is the GPU default, ``rf-detr-small-512-coco``
  the CPU default (``DETECTOR_MODEL`` picks a registry name; ``DETECTOR_MODEL_PATH`` points at any exported
  RF-DETR). Frames much larger than the model input also get a 2x2 overlapping tile pass so far-field
  people and vehicles are seen at closer to native resolution; tile detections are merged into the
  full-frame pass, never duplicated.
* CPU vehicle detector — OpenVINO ``vehicle-detection-0200``. Used only when no RF-DETR model is staged; it
  covers vehicles only, and the result says so through ``coverage``.
* Species — SpeciesNet v4.0.2a (Google, Apache-2.0) exported to ONNX at image build (``export_speciesnet_onnx.py``)
  and run through onnxruntime with the official taxonomy roll-up and country geofence (``species.py``). Without
  it, animals carry the detector's coarse COCO label mapped onto the New Zealand species table and
  ``species_status`` says so.

When a tier is not staged the result says ``model_not_staged`` and carries no detections. Nothing here
invents a sighting; identity is never decided here either — that is a human review action.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

_APP_PATH = Path(__file__).resolve()
_REPO_MODELS_DIR = _APP_PATH.parents[2] / "models" if len(_APP_PATH.parents) > 2 else _APP_PATH.parent / "models"
MODELS_DIR = Path(os.getenv("MODELS_DIR", "/app/models" if Path("/app/models").is_dir() else str(_REPO_MODELS_DIR)))
# "auto" picks the GPU model when a CUDA provider is available and the CPU model otherwise; any registry name
# from open-image-models (rf-detr-{nano-384,small-512,medium-576,large-704}-coco) can be forced instead.
DETECTOR_MODEL = os.getenv("DETECTOR_MODEL", "auto").strip()
DETECTOR_MODEL_GPU = os.getenv("DETECTOR_MODEL_GPU", "rf-detr-large-704-coco").strip()
DETECTOR_MODEL_CPU = os.getenv("DETECTOR_MODEL_CPU", "rf-detr-small-512-coco").strip()
DETECTOR_MODEL_PATH = Path(os.getenv("DETECTOR_MODEL_PATH")) if os.getenv("DETECTOR_MODEL_PATH") else None
# Floor handed to the model; per-kind acceptance thresholds below are what actually admit a detection.
DETECTOR_CONFIDENCE = float(os.getenv("DETECTOR_CONFIDENCE", "0.25"))
KIND_MIN_CONFIDENCE = {
    "person": float(os.getenv("DETECTOR_PERSON_CONFIDENCE", "0.35")),
    "vehicle": float(os.getenv("DETECTOR_VEHICLE_CONFIDENCE", "0.35")),
    # COCO animal classes fire on tree trunks and fence posts at 0.3–0.4; an animal needs a stronger case.
    "animal": float(os.getenv("DETECTOR_ANIMAL_CONFIDENCE", "0.50")),
}
# "auto": 2x2 overlapping tiles whenever the frame is at least 1.5x the model input in both dimensions;
# "0"/"off" disables the extra passes (CPU budget), any other integer forces that many tiles per side.
DETECTOR_TILES = os.getenv("DETECTOR_TILES", "auto").strip().lower()
TILE_OVERLAP = 0.15
INFERENCE_DEVICE = os.getenv("INFERENCE_DEVICE", "auto").strip().lower()  # auto | cuda | cpu
OPENVINO_VEHICLE_DETECTOR_PATH = Path(os.getenv("OPENVINO_VEHICLE_DETECTOR_PATH", MODELS_DIR / "vehicle-detection-0200.xml"))
OPENVINO_VEHICLE_CONFIDENCE = float(os.getenv("OPENVINO_VEHICLE_CONFIDENCE", "0.4"))
SPECIES_PROVIDER = os.getenv("SPECIES_PROVIDER", "auto").strip().lower()
SPECIES_MIN_CONFIDENCE = float(os.getenv("SPECIES_MIN_CONFIDENCE", "0.35"))

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
# COCO animals that can actually stand in a New Zealand paddock or forestry block. Applied only when no species
# model is staged: the others (giraffe, elephant, zebra, bear) are what the detector calls a tree trunk or a dark
# stump. With SpeciesNet staged every animal class is admitted and SpeciesNet's own "blank" verdict prunes them.
NZ_PLAUSIBLE_COCO_ANIMALS = frozenset({"bird", "cat", "dog", "horse", "sheep", "cow"})
BLANK_SUPPRESSION_SCORE = float(os.getenv("SPECIES_BLANK_SUPPRESSION_SCORE", "0.8"))
# Classes the detector confuses with sheds, fences and jetties need a stronger case than a car does.
RAW_CLASS_MIN_CONFIDENCE = {"train": 0.60, "boat": 0.50, "bicycle": 0.40}
# The tile pass exists to recover small far-field objects. A tile detection that spans most of its tile is a
# fragment of something large (which the full-frame pass already judged), so it is not admitted.
TILE_MIN_CONFIDENCE = float(os.getenv("DETECTOR_TILE_CONFIDENCE", "0.45"))
TILE_MAX_EXTENT_RATIO = 0.5


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
    Species("possum", "Brushtail possum", True, "mammal", ("brushtail possum", "common brushtail possum", "trichosurus vulpecula", "trichosurus", "phalangeridae")),
    Species("stoat", "Stoat", True, "mammal", ("mustela erminea", "ermine", "short-tailed weasel")),
    Species("ferret", "Ferret", True, "mammal", ("mustela furo", "mustela putorius furo", "mustela putorius", "western polecat", "polecat")),
    Species("weasel", "Weasel", True, "mammal", ("mustela nivalis", "least weasel")),
    Species("rat", "Rat", True, "mammal", ("ship rat", "black rat", "norway rat", "brown rat", "kiore", "pacific rat", "polynesian rat", "rattus rattus", "rattus norvegicus", "rattus exulans", "rattus", "rattus species")),
    Species("mouse", "House mouse", True, "mammal", ("house mouse", "mus musculus", "mus")),
    Species("hedgehog", "Hedgehog", True, "mammal", ("european hedgehog", "erinaceus europaeus", "erinaceus", "hedgehog family", "erinaceidae")),
    Species("deer", "Deer", True, "mammal", ("red deer", "fallow deer", "common fallow deer", "sika deer", "white-tailed deer", "sambar", "rusa", "wapiti", "elk", "cervus elaphus", "dama dama", "cervus nippon", "odocoileus virginianus", "cervidae", "cervus", "cervus species", "deer family")),
    Species("pig", "Feral pig", True, "mammal", ("feral pig", "wild boar", "wild pig", "boar", "sus scrofa", "sus", "suidae", "pig family")),
    Species("goat", "Feral goat", True, "mammal", ("feral goat", "domestic goat", "capra hircus", "capra aegagrus hircus", "capra", "capra species")),
    Species("cat", "Cat", True, "mammal", ("feral cat", "domestic cat", "felis catus", "felis silvestris catus", "felis", "felis species", "felidae", "felidae family", "cat family")),
    Species("rabbit", "Rabbit", True, "mammal", ("european rabbit", "oryctolagus cuniculus", "oryctolagus")),
    Species("hare", "Hare", True, "mammal", ("european hare", "brown hare", "lepus europaeus", "lepus", "lepus species")),
    Species("wallaby", "Wallaby", True, "mammal", ("bennett's wallaby", "red-necked wallaby", "dama wallaby", "tammar wallaby", "parma wallaby", "notamacropus", "macropus", "macropodidae", "kangaroo family")),
    Species("tahr", "Himalayan tahr", True, "mammal", ("himalayan tahr", "hemitragus jemlahicus")),
    Species("chamois", "Chamois", True, "mammal", ("rupicapra rupicapra",)),
    Species("dog", "Dog", False, "mammal", ("domestic dog", "canis familiaris", "canis lupus familiaris", "canis", "canis species", "canidae", "canidae family", "dog family")),
    Species("cattle", "Cattle", False, "mammal", ("cow", "bull", "bos taurus", "domestic cattle", "bos", "bos species")),
    Species("sheep", "Sheep", False, "mammal", ("ovis aries", "domestic sheep", "ovis", "ovis species")),
    Species("horse", "Horse", False, "mammal", ("equus caballus", "equus ferus caballus", "domestic horse", "equus", "equus species", "equidae", "equidae family", "horse family")),
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
    taxonomy_label = ";" in text
    if taxonomy_label:
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
    if taxonomy_label:
        # A taxonomy label maps only on an exact alias: "weasel family" must not become "weasel".
        return None
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


def map_detection(class_name: str | None, allow_all_animals: bool = False) -> tuple[str, str | None] | None:
    """Return (entity_kind, coarse_label) for a COCO class, or None when it is not a person/vehicle/animal.
    Without a species model the COCO animal set is narrowed to what can stand in a New Zealand scene; with one
    staged every animal class is only a hint that *something* alive is there and SpeciesNet decides what."""
    label = str(class_name or "").lower()
    mapped = COCO_TO_KIND.get(label)
    if mapped is None:
        return None
    if mapped[0] == "animal" and not allow_all_animals and label not in NZ_PLAUSIBLE_COCO_ANIMALS:
        return None
    return mapped


def bbox_from_xyxy(x0: float, y0: float, x1: float, y1: float, width: int, height: int) -> dict[str, int] | None:
    left, top = max(0, int(round(x0))), max(0, int(round(y0)))
    right, bottom = min(width, int(round(x1))), min(height, int(round(y1)))
    if right <= left or bottom <= top:
        return None
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def box_iou(a: dict[str, int], b: dict[str, int]) -> float:
    ax1, ay1 = a["x"] + a["width"], a["y"] + a["height"]
    bx1, by1 = b["x"] + b["width"], b["y"] + b["height"]
    inter_w = max(0, min(ax1, bx1) - max(a["x"], b["x"]))
    inter_h = max(0, min(ay1, by1) - max(a["y"], b["y"]))
    inter = inter_w * inter_h
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def box_containment(inner: dict[str, int], outer: dict[str, int]) -> float:
    """Share of ``inner`` that lies inside ``outer`` (1.0 = fully contained)."""
    ix1, iy1 = inner["x"] + inner["width"], inner["y"] + inner["height"]
    ox1, oy1 = outer["x"] + outer["width"], outer["y"] + outer["height"]
    inter_w = max(0, min(ix1, ox1) - max(inner["x"], outer["x"]))
    inter_h = max(0, min(iy1, oy1) - max(inner["y"], outer["y"]))
    area = inner["width"] * inner["height"]
    return (inter_w * inter_h) / area if area > 0 else 0.0


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


def path_is_file(path: Path | None) -> bool:
    try:
        return bool(path) and path.is_file()
    except OSError:
        return False


# ---------------------------------------------------------------------------------------------------------
# onnxruntime provider selection (shared with the plate models)


def _nvidia_driver_present() -> bool:
    """The CUDA wheel lists its provider even on a CPU-only host; only offer it when a driver is exposed."""
    for probe in ("/proc/driver/nvidia/version", "/dev/nvidiactl", "/dev/nvidia0"):
        try:
            if Path(probe).exists():
                return True
        except OSError:
            continue
    return bool(os.getenv("NVIDIA_VISIBLE_DEVICES") and os.getenv("NVIDIA_VISIBLE_DEVICES") not in ("void", "none"))


def onnx_providers() -> list[str]:
    """CUDA first when the wheel and the host expose it, CPU always last so a bad GPU never blocks a frame."""
    try:
        import onnxruntime as ort
    except Exception:
        return ["CPUExecutionProvider"]
    available = set(ort.get_available_providers())
    providers: list[str] = []
    want_cuda = INFERENCE_DEVICE == "cuda" or (INFERENCE_DEVICE == "auto" and _nvidia_driver_present())
    if want_cuda and "CUDAExecutionProvider" in available:
        try:  # onnxruntime-gpu[cuda,cudnn] ships the NVIDIA libraries as pip packages; make sure they are loaded
            preload = getattr(ort, "preload_dlls", None)
            if preload is not None:
                preload()
        except Exception:
            pass
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")
    return providers


def create_session(factory: Any, providers: list[str]) -> tuple[Any, list[str]]:
    """Build a model through ``factory(providers)``; if the CUDA provider cannot initialise, build it again on CPU
    and say so, rather than failing the whole tier."""
    try:
        return factory(providers), providers
    except Exception:
        if "CUDAExecutionProvider" not in providers:
            raise
        cpu_only = ["CPUExecutionProvider"]
        return factory(cpu_only), cpu_only


def intra_op_threads() -> int:
    """CPU threads one ONNX session may use: INFERENCE_INTRA_OP_THREADS, else 4, never more than the cores present.
    ONNX Runtime's default is every core per session; with the detector, plate detector, OCR and species models
    each taking all eight on the VPS, beside the video extractors, nothing finished."""
    cores = os.cpu_count() or 4
    configured = os.getenv("INFERENCE_INTRA_OP_THREADS", "").strip()
    if configured.isdigit() and int(configured) > 0:
        return max(1, min(int(configured), cores))
    return max(1, min(4, cores))


def session_options() -> Any:
    """Session options every staged model shares: the fixed intra-op budget above, one inter-op thread, sequential
    execution. Returns None when onnxruntime is absent so callers can pass it straight through."""
    try:
        import onnxruntime as ort
    except Exception:
        return None
    options = ort.SessionOptions()
    options.intra_op_num_threads = intra_op_threads()
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return options


def cuda_available() -> bool:
    return "CUDAExecutionProvider" in onnx_providers()


def active_provider(session: Any, requested: list[str]) -> str | None:
    """The provider onnxruntime actually bound (it silently falls back to CPU when CUDA cannot initialise)."""
    try:
        bound = session.get_providers() if session is not None and hasattr(session, "get_providers") else None
    except Exception:
        bound = None
    if bound:
        return str(bound[0])
    return requested[0] if requested else None


# ---------------------------------------------------------------------------------------------------------
# RF-DETR detector


def detector_model_name() -> str:
    if DETECTOR_MODEL and DETECTOR_MODEL != "auto":
        return DETECTOR_MODEL
    return DETECTOR_MODEL_GPU if cuda_available() else DETECTOR_MODEL_CPU


def _candidate_model_paths(name: str) -> list[Path]:
    paths: list[Path] = []
    if DETECTOR_MODEL_PATH is not None:
        paths.append(DETECTOR_MODEL_PATH)
    paths.append(MODELS_DIR / f"{name}.onnx")
    paths.append(Path.home() / ".cache" / "open-image-models" / name / f"{name}.onnx")
    return paths


def resolve_detector_model() -> tuple[str, Path] | None:
    """(registry name, onnx path) of the staged RF-DETR model, preferring the configured one and otherwise
    the largest RF-DETR export present in MODELS_DIR."""
    name = detector_model_name()
    for path in _candidate_model_paths(name):
        if path_is_file(path):
            return name, path
    try:
        staged = sorted(MODELS_DIR.glob("rf-detr-*-coco.onnx"), key=lambda item: item.stat().st_size, reverse=True)
    except OSError:
        staged = []
    if staged:
        return staged[0].stem, staged[0]
    return None


def _coco_labels(name: str) -> dict[int, str]:
    try:
        from open_image_models.detection.factory import DETECTION_MODELS

        labels = DETECTION_MODELS[name].class_labels
        return {int(index): str(label) for index, label in (labels.items() if isinstance(labels, dict) else enumerate(labels, start=1))}
    except Exception:
        from open_image_models.detection.factory import DETECTION_MODELS

        labels = DETECTION_MODELS["rf-detr-large-704-coco"].class_labels
        return {int(index): str(label) for index, label in labels.items()}


_detector: Any = None
_detector_meta: dict[str, Any] = {}


def _load_detector() -> Any:
    global _detector, _detector_meta
    if _detector is not None:
        return _detector
    resolved = resolve_detector_model()
    if resolved is None:
        raise FileNotFoundError("detector model is not staged")
    name, path = resolved
    from open_image_models.detection.core.rf_detr.inference import RFDETRDetector

    providers = onnx_providers()
    model, providers = create_session(
        lambda chosen: RFDETRDetector(str(path), _coco_labels(name), conf_thresh=DETECTOR_CONFIDENCE, providers=chosen, sess_options=session_options()), providers,
    )
    input_size = getattr(model, "img_size", None)
    _detector_meta = {
        "name": name, "path": str(path), "provider": active_provider(getattr(model, "model", None), providers),
        "input_size": [int(value) for value in input_size] if input_size else None,
        "intra_op_threads": intra_op_threads(),
    }
    _detector = model
    return _detector


def tile_windows(width: int, height: int, input_size: tuple[int, int] | None, setting: str = DETECTOR_TILES) -> list[dict[str, int]]:
    """Overlapping windows for a second, closer look at large frames. Empty when tiling is off or the frame is
    already close to the model input size."""
    if setting in ("0", "off", "false", "none") or not input_size:
        return []
    model_h, model_w = int(input_size[0]), int(input_size[1])
    if setting == "auto":
        if width < model_w * 1.5 or height < model_h * 1.5:
            return []
        per_side = 2
    else:
        try:
            per_side = max(1, int(setting))
        except ValueError:
            return []
        if per_side == 1:
            return []
    tile_w = int(np.ceil(width / (per_side - (per_side - 1) * TILE_OVERLAP)))
    tile_h = int(np.ceil(height / (per_side - (per_side - 1) * TILE_OVERLAP)))
    step_x = (width - tile_w) / max(1, per_side - 1)
    step_y = (height - tile_h) / max(1, per_side - 1)
    windows = []
    for row in range(per_side):
        for column in range(per_side):
            x = int(round(column * step_x))
            y = int(round(row * step_y))
            windows.append({"x": x, "y": y, "width": min(tile_w, width - x), "height": min(tile_h, height - y)})
    return windows


def suppress_duplicates(detections: list[dict[str, Any]], iou_threshold: float = 0.6) -> list[dict[str, Any]]:
    """Class-aware non-maximum suppression. DETR-family models emit no NMS of their own, so one subject at the
    frame edge can come back as two overlapping boxes; keep the stronger."""
    kept: list[dict[str, Any]] = []
    for candidate in sorted(detections, key=lambda item: item["confidence"], reverse=True):
        if any(kept_item["kind"] == candidate["kind"] and box_iou(kept_item["bbox"], candidate["bbox"]) >= iou_threshold for kept_item in kept):
            continue
        kept.append(candidate)
    return kept


def merge_detections(primary: list[dict[str, Any]], extra: list[dict[str, Any]], iou_threshold: float = 0.5, containment_threshold: float = 0.7) -> list[dict[str, Any]]:
    """Keep every primary (full-frame) detection; add an extra (tile) detection only when nothing of the same
    kind already covers it. Tiles slice big objects into fragments, which is why containment is tested too."""
    merged = list(primary)
    for candidate in sorted(extra, key=lambda item: item["confidence"], reverse=True):
        duplicate = False
        for kept in merged:
            if kept["kind"] != candidate["kind"]:
                continue
            if box_iou(kept["bbox"], candidate["bbox"]) >= iou_threshold or box_containment(candidate["bbox"], kept["bbox"]) >= containment_threshold:
                duplicate = True
                break
        if not duplicate:
            merged.append(candidate)
    merged.sort(key=lambda item: item["confidence"], reverse=True)
    return merged


def _detections_from_results(results: Any, offset_x: int, offset_y: int, width: int, height: int, source: str, window: dict[str, int] | None = None, allow_all_animals: bool = False) -> list[dict[str, Any]]:
    detections: list[dict[str, Any]] = []
    for result in results or []:
        label = str(getattr(result, "label", "") or "")
        mapped = map_detection(label, allow_all_animals)
        if mapped is None:
            continue
        kind, coarse = mapped
        score = float(getattr(result, "confidence", 0.0) or 0.0)
        threshold = max(KIND_MIN_CONFIDENCE.get(kind, DETECTOR_CONFIDENCE), RAW_CLASS_MIN_CONFIDENCE.get(label.lower(), 0.0))
        if source == "tile":
            threshold = max(threshold, TILE_MIN_CONFIDENCE)
        if score < threshold:
            continue
        box = getattr(result, "bounding_box", None)
        if box is None:
            continue
        if window is not None and (
            (box.x2 - box.x1) > window["width"] * TILE_MAX_EXTENT_RATIO or (box.y2 - box.y1) > window["height"] * TILE_MAX_EXTENT_RATIO
        ):
            continue
        bbox = bbox_from_xyxy(offset_x + box.x1, offset_y + box.y1, offset_x + box.x2, offset_y + box.y2, width, height)
        if not plausible_box(kind, bbox, width, height):
            continue
        detections.append({
            "kind": kind, "coarse_label": coarse, "confidence": round(score, 3), "bbox": bbox,
            "raw_class": label.lower(), "pass": source,
        })
    return detections


def detector_status() -> dict[str, Any]:
    resolved = resolve_detector_model()
    cpu_vehicle = _openvino_vehicle_staged()
    if resolved is not None:
        name, path = resolved
        return {
            "detector": "ready",
            "detector_model": name,
            "detector_path": str(path),
            "detector_kind": "rf_detr_onnx",
            "detector_provider": _detector_meta.get("provider") or ("CUDAExecutionProvider" if cuda_available() else "CPUExecutionProvider"),
            "detector_input_size": _detector_meta.get("input_size"),
            "detector_tiles": DETECTOR_TILES,
            "coverage": ["person", "vehicle", "animal"],
            "species": "ready" if _species_available() else "not_staged",
            "species_provider": _species_provider(),
            "species_execution_provider": _species_execution_provider(),
        }
    return {
        "detector": "vehicle_only" if cpu_vehicle else "not_staged",
        "detector_model": OPENVINO_VEHICLE_DETECTOR_PATH.name if cpu_vehicle else None,
        "detector_path": str(OPENVINO_VEHICLE_DETECTOR_PATH) if cpu_vehicle else None,
        "detector_kind": "openvino_vehicle" if cpu_vehicle else None,
        "detector_provider": "openvino:CPU" if cpu_vehicle else None,
        "detector_input_size": [256, 256] if cpu_vehicle else None,
        "detector_tiles": "off",
        "coverage": ["vehicle"] if cpu_vehicle else [],
        "species": "ready" if _species_available() else "not_staged",
        "species_provider": _species_provider(),
        "species_execution_provider": _species_execution_provider(),
    }


def _openvino_vehicle_staged() -> bool:
    return path_is_file(OPENVINO_VEHICLE_DETECTOR_PATH) and path_is_file(OPENVINO_VEHICLE_DETECTOR_PATH.with_suffix(".bin"))


def _species_provider() -> str:
    if SPECIES_PROVIDER in ("none", "off", "detector", "detector_labels"):
        return "detector_labels"
    import species as speciesnet_tier  # lazy: species.py imports this module

    if speciesnet_tier.staged():
        return f"speciesnet:{speciesnet_tier.SPECIESNET_VERSION}"
    return "detector_labels"


def _species_available() -> bool:
    return _species_provider().startswith("speciesnet")


def _species_execution_provider() -> str | None:
    import species as speciesnet_tier  # lazy: species.py imports this module

    if speciesnet_tier._provider:
        return speciesnet_tier._provider
    if not speciesnet_tier.staged():
        return None
    return onnx_providers()[0]


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
        detections.append({"kind": "vehicle", "coarse_label": None, "confidence": round(score, 3), "bbox": bbox, "raw_class": "vehicle", "pass": "full"})
    detections.sort(key=lambda item: item["confidence"], reverse=True)
    return detections


def detect(image: np.ndarray) -> dict[str, Any]:
    """Triage every person / vehicle / animal in a frame. ``coverage`` lists the kinds the staged tier can see;
    ``passes`` records how many model passes (full frame + tiles) produced the answer."""
    if resolve_detector_model() is None:
        if _openvino_vehicle_staged():
            try:
                return {"status": "ready", "coverage": ["vehicle"], "detections": detect_vehicles_openvino(image),
                        "provider": f"openvino:{OPENVINO_VEHICLE_DETECTOR_PATH.name}", "model": OPENVINO_VEHICLE_DETECTOR_PATH.stem, "passes": 1}
            except Exception as error:
                return {"status": "error", "coverage": ["vehicle"], "detections": [], "provider": OPENVINO_VEHICLE_DETECTOR_PATH.name, "error": str(error)[:300]}
        return {"status": "model_not_staged", "coverage": [], "detections": [], "provider": None}
    try:
        model = _load_detector()
        height, width = image.shape[:2]
        windows = tile_windows(width, height, _detector_meta.get("input_size"))
        crops = [image] + [image[w["y"]:w["y"] + w["height"], w["x"]:w["x"] + w["width"]] for w in windows]
        outputs = model.predict(crops) if len(crops) > 1 else [model.predict(image)]
        all_animals = _species_available()
        full = suppress_duplicates(_detections_from_results(outputs[0], 0, 0, width, height, "full", allow_all_animals=all_animals))
        extra: list[dict[str, Any]] = []
        for window, results in zip(windows, outputs[1:]):
            extra.extend(_detections_from_results(results, window["x"], window["y"], width, height, "tile", window, allow_all_animals=all_animals))
        detections = merge_detections(full, extra) if extra else full
        provider = f"rf_detr:{_detector_meta.get('name')}@{_detector_meta.get('provider')}"
        return {"status": "ready", "coverage": ["person", "vehicle", "animal"], "detections": detections, "provider": provider,
                "model": _detector_meta.get("name"), "execution_provider": _detector_meta.get("provider"), "passes": len(crops)}
    except Exception as error:  # a broken model must not take the whole frame down
        return {"status": "error", "coverage": [], "detections": [], "provider": _detector_meta.get("name") or detector_model_name(), "error": str(error)[:300]}


def _crop(image: np.ndarray, bbox: dict[str, int], padding: float = 0.15) -> np.ndarray:
    height, width = image.shape[:2]
    pad_x, pad_y = int(bbox["width"] * padding), int(bbox["height"] * padding)
    x0, y0 = max(0, bbox["x"] - pad_x), max(0, bbox["y"] - pad_y)
    x1, y1 = min(width, bbox["x"] + bbox["width"] + pad_x), min(height, bbox["y"] + bbox["height"] + pad_y)
    crop = image[y0:y1, x0:x1]
    return crop if crop.size else image


def classify_species(image: np.ndarray, bbox: dict[str, int], coarse_label: str | None = None, confidence: float | None = None, provider: str | None = None) -> dict[str, Any]:
    """Species for one animal detection: SpeciesNet (ONNX) when staged, otherwise the detector's coarse label
    mapped onto the New Zealand species table (a COCO "cow" is cattle, a "sheep" is sheep; the status says the
    answer came from a general detector, not a species model)."""
    if _species_provider().startswith("speciesnet"):
        import species as speciesnet_tier  # lazy: species.py imports this module

        try:
            return speciesnet_tier.classify_animal(image, bbox, float(confidence or 0.0))
        except Exception as error:
            return {"species": "other", "common_name": "Unidentified animal", "is_pest": None, "species_confidence": None,
                    "species_status": "error", "species_provider": _species_provider(), "error": str(error)[:300]}
    if coarse_label:
        payload = species_payload(coarse_label, confidence, provider or "detector_labels")
        if payload.get("species_status") == "candidate":
            payload["species_status"] = "detector_coarse_label"
        return payload
    return {"species": "other", "common_name": "Unidentified animal", "is_pest": None, "species_confidence": None,
            "species_status": "model_not_staged", "species_provider": None}


def triage_frame(image: np.ndarray, want_species: bool = True) -> dict[str, Any]:
    """Detections grouped by kind, with species on animals. Shape consumed by the vision worker."""
    detection = detect(image)
    people = [item for item in detection["detections"] if item["kind"] == "person"]
    vehicles = [item for item in detection["detections"] if item["kind"] == "vehicle"]
    animals = []
    suppressed = []
    for item in detection["detections"]:
        if item["kind"] != "animal":
            continue
        entry = dict(item)
        if want_species:
            entry.update(classify_species(image, item["bbox"], item.get("coarse_label"), item["confidence"], detection.get("provider")))
        elif item.get("coarse_label"):
            entry.update(species_payload(item["coarse_label"], item["confidence"], detection["provider"] or "detector"))
        # SpeciesNet has a trained "blank" class; when it is sure nothing alive is in the crop, the detector's
        # animal was a stump or a shadow. Kept visible under suppressed_animals, not counted as a sighting.
        if entry.get("species_status") == "classifier_blank" and (entry.get("species_confidence") or 0) > BLANK_SUPPRESSION_SCORE:
            entry["suppressed_reason"] = "speciesnet_blank"
            suppressed.append(entry)
            continue
        animals.append(entry)
    return {
        "detector_status": detection["status"], "detector_provider": detection.get("provider"),
        "detector_model": detection.get("model"), "detector_execution_provider": detection.get("execution_provider"),
        "detector_passes": detection.get("passes"),
        "detector_coverage": detection.get("coverage", []),
        "detector_error": detection.get("error"),
        "species_status": "ready" if _species_available() else "model_not_staged",
        "people": people, "vehicles": vehicles, "animals": animals, "suppressed_animals": suppressed,
    }
