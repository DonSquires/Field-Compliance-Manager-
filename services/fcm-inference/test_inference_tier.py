"""Unit tests for the entity detector and ALPR tier. No model weights are needed: the ONNX sessions are
replaced with fakes, so these run in CI and on machines without the models staged."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import detector  # noqa: E402
import plates  # noqa: E402

spec = importlib.util.spec_from_file_location('appmod', HERE / 'app.py')
appmod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(appmod)


def _result(label: str, confidence: float, x1: float, y1: float, x2: float, y2: float) -> SimpleNamespace:
    return SimpleNamespace(label=label, confidence=confidence, bounding_box=SimpleNamespace(x1=x1, y1=y1, x2=x2, y2=y2))


# --------------------------------------------------------------------------------------------- detector


def test_nz_implausible_coco_animals_are_dropped_and_plausible_ones_map():
    assert detector.map_detection('giraffe') is None
    assert detector.map_detection('bear') is None
    assert detector.map_detection('cow') == ('animal', 'cattle')
    assert detector.map_detection('sheep') == ('animal', 'sheep')
    assert detector.map_detection('truck') == ('vehicle', 'truck')
    assert detector.map_detection('person') == ('person', None)
    assert detector.map_detection('traffic light') is None


def test_tile_windows_only_for_frames_much_larger_than_the_model_input():
    assert detector.tile_windows(640, 360, (512, 512), 'auto') == []
    windows = detector.tile_windows(2304, 1296, (704, 704), 'auto')
    assert len(windows) == 4
    assert windows[0]['x'] == 0 and windows[0]['y'] == 0
    assert windows[-1]['x'] + windows[-1]['width'] == 2304
    assert windows[-1]['y'] + windows[-1]['height'] == 1296
    # neighbouring tiles overlap
    assert windows[0]['x'] + windows[0]['width'] > windows[1]['x']
    assert detector.tile_windows(2304, 1296, (704, 704), 'off') == []


def test_per_kind_thresholds_and_tile_fragment_guard():
    width, height = 2304, 1296
    full = detector._detections_from_results(
        [_result('person', 0.36, 100, 100, 180, 400), _result('cat', 0.42, 10, 10, 60, 60), _result('train', 0.5, 0, 500, 1800, 1200)],
        0, 0, width, height, 'full',
    )
    assert [item['raw_class'] for item in full] == ['person']  # cat below 0.5 animal floor, train below 0.6
    window = {'x': 0, 'y': 0, 'width': 1200, 'height': 700}
    tile = detector._detections_from_results(
        [_result('car', 0.9, 10, 10, 900, 400), _result('car', 0.7, 50, 50, 250, 170), _result('car', 0.4, 300, 300, 500, 420)],
        window['x'], window['y'], width, height, 'tile', window,
    )
    assert [item['confidence'] for item in tile] == [0.7]  # fragment spanning the tile and a sub-0.45 box are dropped
    assert tile[0]['pass'] == 'tile'
    # A vehicle box under the 0.35 % area floor (steam-plume scale) is noise, however confident.
    small = detector._detections_from_results([_result('car', 0.9, 50, 50, 150, 110)], 0, 0, width, height, 'full')
    assert small == []


def test_duplicates_are_suppressed_and_tiles_only_add_uncovered_objects():
    edge_a = {'kind': 'person', 'coarse_label': None, 'confidence': 0.49, 'bbox': {'x': 0, 'y': 48, 'width': 32, 'height': 178}, 'raw_class': 'person', 'pass': 'full'}
    edge_b = {'kind': 'person', 'coarse_label': None, 'confidence': 0.41, 'bbox': {'x': 0, 'y': 46, 'width': 32, 'height': 217}, 'raw_class': 'person', 'pass': 'full'}
    car = {'kind': 'vehicle', 'coarse_label': 'car', 'confidence': 0.96, 'bbox': {'x': 800, 'y': 600, 'width': 700, 'height': 300}, 'raw_class': 'car', 'pass': 'full'}
    kept = detector.suppress_duplicates([edge_b, edge_a, car])
    assert [item['confidence'] for item in kept] == [0.96, 0.49]

    fragment = {'kind': 'vehicle', 'coarse_label': 'car', 'confidence': 0.8, 'bbox': {'x': 810, 'y': 610, 'width': 300, 'height': 280}, 'raw_class': 'car', 'pass': 'tile'}
    far_field = {'kind': 'vehicle', 'coarse_label': 'car', 'confidence': 0.61, 'bbox': {'x': 60, 'y': 700, 'width': 40, 'height': 24}, 'raw_class': 'car', 'pass': 'tile'}
    merged = detector.merge_detections(kept, [fragment, far_field])
    assert far_field in merged and fragment not in merged
    assert len(merged) == 3


def test_detect_reports_not_staged_without_any_model(monkeypatch):
    monkeypatch.setattr(detector, 'resolve_detector_model', lambda: None)
    monkeypatch.setattr(detector, '_openvino_vehicle_staged', lambda: False)
    result = detector.detect(np.zeros((360, 640, 3), dtype=np.uint8))
    assert result == {'status': 'model_not_staged', 'coverage': [], 'detections': [], 'provider': None}


def test_detect_runs_full_frame_plus_tiles_through_a_fake_session(monkeypatch):
    calls = []

    class FakeModel:
        img_size = (704, 704)

        def predict(self, images):
            calls.append(len(images) if isinstance(images, list) else 1)
            if isinstance(images, list):
                return [[_result('person', 0.93, 900, 300, 1000, 700), _result('giraffe', 0.4, 0, 0, 300, 900)]] + [[] for _ in images[1:]]
            return [_result('person', 0.93, 900, 300, 1000, 700)]

    monkeypatch.setattr(detector, 'resolve_detector_model', lambda: ('rf-detr-large-704-coco', Path('/nonexistent.onnx')))
    monkeypatch.setattr(detector, '_load_detector', lambda: FakeModel())
    monkeypatch.setattr(detector, '_detector_meta', {'name': 'rf-detr-large-704-coco', 'provider': 'CPUExecutionProvider', 'input_size': [704, 704]})
    result = detector.detect(np.zeros((1296, 2304, 3), dtype=np.uint8))
    assert result['status'] == 'ready'
    assert result['passes'] == 5 and calls == [5]
    assert [item['raw_class'] for item in result['detections']] == ['person']
    assert result['coverage'] == ['person', 'vehicle', 'animal']
    assert result['provider'] == 'rf_detr:rf-detr-large-704-coco@CPUExecutionProvider'


def test_animal_without_species_model_carries_the_detector_label_honestly(monkeypatch):
    monkeypatch.setattr(detector, '_species_provider', lambda: 'detector_labels')
    payload = detector.classify_species(np.zeros((100, 100, 3), dtype=np.uint8), {'x': 0, 'y': 0, 'width': 10, 'height': 10}, 'cattle', 0.8, 'rf_detr')
    assert payload['species'] == 'cattle' and payload['species_status'] == 'detector_coarse_label'
    payload = detector.classify_species(np.zeros((100, 100, 3), dtype=np.uint8), {'x': 0, 'y': 0, 'width': 10, 'height': 10}, None, None, None)
    assert payload['species_status'] == 'model_not_staged'


# --------------------------------------------------------------------------------------------- species (SpeciesNet rules)

import species  # noqa: E402

POSSUM = 'a1;mammalia;diprotodontia;phalangeridae;trichosurus;vulpecula;common brushtail possum'
TRICHOSURUS = 'a2;mammalia;diprotodontia;phalangeridae;trichosurus;;trichosurus species'
PHALANGERIDAE = 'a3;mammalia;diprotodontia;phalangeridae;;;possum family'
ZEBRA = 'b1;mammalia;perissodactyla;equidae;equus;quagga;plains zebra'
EQUIDAE = 'b2;mammalia;perissodactyla;equidae;;;horse family'
STOAT = 'c1;mammalia;carnivora;mustelidae;mustela;erminea;stoat'
POLECAT = 'c2;mammalia;carnivora;mustelidae;mustela;putorius;western polecat'
MUSTELIDAE = 'c3;mammalia;carnivora;mustelidae;;;weasel family'
MAMMALIA = 'd1;mammalia;;;;;mammal'
TAXONOMY = [POSSUM, TRICHOSURUS, PHALANGERIDAE, ZEBRA, EQUIDAE, STOAT, POLECAT, MUSTELIDAE, MAMMALIA, species.BLANK, species.HUMAN, species.VEHICLE, species.UNKNOWN]


def _taxonomy_map():
    return {species.taxa_from_label(label): label for label in TAXONOMY if label not in (species.BLANK, species.VEHICLE, species.UNKNOWN)} | {species.taxa_from_label(species.ANIMAL): species.ANIMAL}


GEOFENCE = {species.taxa_from_label(ZEBRA): {'allow': {'KEN': [], 'TZA': []}}, species.taxa_from_label(STOAT): {'allow': {'NZL': [], 'GBR': []}}}


def test_geofence_rolls_an_implausible_species_up_to_its_family():
    labels = [ZEBRA, EQUIDAE, MAMMALIA]
    scores = [0.9, 0.05, 0.02]
    label, score, source = species.combine_for_animal_detection(labels, scores, 0.9, 'NZL', None, _taxonomy_map(), GEOFENCE, True)
    assert label == EQUIDAE and source == 'classifier+geofence+rollup_to_family'
    assert abs(score - 0.95) < 1e-6
    # same answer is a plains zebra where zebras live
    assert species.combine_for_animal_detection(labels, scores, 0.9, 'KEN', None, _taxonomy_map(), GEOFENCE, True)[0] == ZEBRA
    # and with the geofence disabled
    assert species.combine_for_animal_detection(labels, scores, 0.9, 'NZL', None, _taxonomy_map(), GEOFENCE, False)[0] == ZEBRA


def test_weak_species_scores_roll_up_to_genus_and_then_to_the_detector():
    labels = [POSSUM, TRICHOSURUS, PHALANGERIDAE, STOAT]
    scores = [0.4, 0.3, 0.1, 0.05]
    label, score, source = species.combine_for_animal_detection(labels, scores, 0.9, 'NZL', None, _taxonomy_map(), GEOFENCE, True)
    assert label == TRICHOSURUS and source == 'classifier+rollup_to_genus' and abs(score - 0.7) < 1e-6
    label, score, source = species.combine_for_animal_detection([STOAT, POLECAT, MAMMALIA], [0.3, 0.2, 0.1], 0.9, 'NZL', None, _taxonomy_map(), GEOFENCE, True)
    assert label == species.ANIMAL and source == 'detector' and score == 0.9
    assert species.combine_for_animal_detection([species.BLANK, POSSUM], [0.995, 0.005], 0.9, 'NZL', None, _taxonomy_map(), GEOFENCE, True)[0] == species.BLANK


def test_confident_species_passes_straight_through_and_maps_onto_the_nz_table(monkeypatch):
    class FakeSession:
        def run(self, outputs, feeds):
            batch = feeds['images_nhwc']
            assert batch.shape[1:] == (480, 480, 3) and batch.dtype == np.float32 and batch.max() <= 1.0
            logits = np.full((batch.shape[0], len(TAXONOMY)), -5.0, dtype=np.float32)
            logits[:, TAXONOMY.index(POLECAT)] = 6.0
            logits[:, TAXONOMY.index(STOAT)] = 2.0
            return [logits]

    monkeypatch.setattr(species, '_session', FakeSession())
    monkeypatch.setattr(species, '_labels', list(TAXONOMY))
    monkeypatch.setattr(species, '_taxonomy_map', _taxonomy_map())
    monkeypatch.setattr(species, '_geofence_map', GEOFENCE)
    monkeypatch.setattr(species, '_provider', 'CPUExecutionProvider')
    monkeypatch.setattr(species, 'SPECIES_COUNTRY', 'NZL')
    image = np.zeros((720, 1280, 3), dtype=np.uint8)
    payload = species.classify_animal(image, {'x': 100, 'y': 100, 'width': 200, 'height': 120}, 0.77)
    assert payload['species'] == 'ferret' and payload['is_pest'] is True and payload['species_status'] == 'candidate'
    assert payload['speciesnet']['source'] == 'classifier' and payload['speciesnet']['label'] == POLECAT
    assert payload['speciesnet']['top'][0]['common_name'] == 'western polecat' and len(payload['speciesnet']['top']) == 5
    assert payload['species_provider'].startswith('speciesnet:4.0.2a+onnxruntime@CPUExecutionProvider')


def test_family_rollup_keeps_speciesnet_name_without_claiming_a_species(monkeypatch):
    class FakeSession:
        def run(self, outputs, feeds):
            logits = np.full((1, len(TAXONOMY)), -5.0, dtype=np.float32)
            logits[0, TAXONOMY.index(ZEBRA)] = 6.0
            logits[0, TAXONOMY.index(EQUIDAE)] = 1.0
            return [logits]

    monkeypatch.setattr(species, '_session', FakeSession())
    monkeypatch.setattr(species, '_labels', list(TAXONOMY))
    monkeypatch.setattr(species, '_taxonomy_map', _taxonomy_map())
    monkeypatch.setattr(species, '_geofence_map', GEOFENCE)
    monkeypatch.setattr(species, 'SPECIES_COUNTRY', 'NZL')
    payload = species.classify_animal(np.zeros((300, 300, 3), dtype=np.uint8), {'x': 0, 'y': 0, 'width': 100, 'height': 100}, 0.9)
    # A zebra is not plausible in New Zealand: SpeciesNet rolls up to the family; the NZ table names equids "horse".
    assert payload['speciesnet']['source'] == 'classifier+geofence+rollup_to_family'
    assert payload['speciesnet']['label'] == EQUIDAE
    assert payload['species'] == 'horse' and payload['species_status'] == 'candidate'


def test_species_status_reports_not_staged_without_files(monkeypatch):
    monkeypatch.setattr(species, 'staged', lambda: False)
    assert species.status()['species'] == 'not_staged'
    monkeypatch.setattr(detector, 'SPECIES_PROVIDER', 'auto')
    assert detector._species_provider() == 'detector_labels'


# --------------------------------------------------------------------------------------------- plates


def test_standard_nz_formats_are_valid():
    assert plates.normalize_nz_plate('ABC123') == ('ABC123', 'standard_modern')
    assert plates.normalize_nz_plate('AB1234') == ('AB1234', 'standard_older')
    assert plates.normalize_nz_plate('TL316') == ('TL316', 'personalised')
    assert appmod._normalize_nz_plate('ABC123') == ('ABC123', 'standard_modern')


def test_short_ocr_noise_is_rejected():
    for noise in ('SY', 'AN', 'LL', '240', '4228', '4ST', 'N43', 'ABCDEFGH', ''):
        assert plates.normalize_nz_plate(noise) is None


def test_syntax_correction_only_repairs_one_or_two_confusable_swaps():
    assert plates.syntax_correct('ABC12O') == ('ABC120', ['5:O->0'])
    assert plates.syntax_correct('A8C123') == ('ABC123', ['1:8->B'])
    assert plates.syntax_correct('AB12S4') == ('AB1254', ['4:S->5'])
    assert plates.syntax_correct('ABC123') is None or plates.syntax_correct('ABC123') == ('ABC123', [])
    assert plates.syntax_correct('AXCTYU') is None  # not reachable
    assert plates.syntax_correct('AB12') is None


class FakePlateDetector:
    def __init__(self, boxes_by_call):
        self.boxes_by_call = list(boxes_by_call)
        self.calls = []

    def predict(self, image):
        self.calls.append(image.shape)
        boxes = self.boxes_by_call.pop(0) if self.boxes_by_call else []
        return [SimpleNamespace(confidence=conf, bounding_box=SimpleNamespace(x1=x1, y1=y1, x2=x2, y2=y2)) for (conf, x1, y1, x2, y2) in boxes]


class FakeOcr:
    def __init__(self, text, probs, region='New Zealand', region_prob=0.9):
        self.text, self.probs, self.region, self.region_prob = text, probs, region, region_prob

    def run(self, image, return_confidence=False):
        assert image.ndim == 3 and image.shape[2] == 3
        return [SimpleNamespace(plate=self.text, char_probs=np.asarray(self.probs, dtype=np.float32), region=self.region, region_prob=self.region_prob)]


def test_read_plates_anchors_on_vehicle_crop_and_scores_from_character_confidence(monkeypatch):
    image = np.zeros((720, 1280, 3), dtype=np.uint8)
    # full-frame pass sees nothing; the padded vehicle crop (288px wide, upscaled to 480 => scale 1.6667)
    # finds the plate in crop coordinates
    fake_detector = FakePlateDetector([[], [(0.82, 100, 200, 260, 250)]])
    monkeypatch.setattr(plates, '_load_plate_detector', lambda: fake_detector)
    monkeypatch.setattr(plates, '_load_plate_ocr', lambda: FakeOcr('ABC123____', [0.99, 0.98, 0.97, 0.99, 0.96, 0.95, 1, 1, 1, 1]))
    vehicle = {'x': 400, 'y': 300, 'width': 240, 'height': 160}
    result = plates.read_plates(image, [vehicle])
    assert result['plate'] == 'ABC123'
    assert result['plate_status'] == 'plate_detected'
    assert result['evidence_quality'] == 'reviewable'
    assert result['review_required'] is False
    best = result['results'][0]
    assert best['vehicle_bbox'] == vehicle and best['plate_source'] == 'vehicle_crop'
    assert best['char_confidence_min'] == 0.95 and best['nz_pattern'] == 'standard_modern' and best['corrections'] == []
    # crop coordinates map back into the frame: origin (376, 284), divided by the 1.6667 upscale
    assert best['box'] == {'x': 436, 'y': 404, 'width': 96, 'height': 30}
    assert fake_detector.calls[1][1] == 480  # the vehicle crop was upscaled to the detector's target width
    assert result['plate_bbox'] == best['box'] and result['box'] == best['box']
    assert result['alpr_provider'] == plates.PLATE_PROVIDER


def test_read_plates_reports_unreadable_when_the_plate_is_located_but_the_reading_is_weak(monkeypatch):
    image = np.zeros((1296, 2304, 3), dtype=np.uint8)
    fake_detector = FakePlateDetector([[(0.62, 1248, 766, 1273, 774)]])
    monkeypatch.setattr(plates, '_load_plate_detector', lambda: fake_detector)
    monkeypatch.setattr(plates, '_load_plate_ocr', lambda: FakeOcr('J44F5_____', [0.3, 0.5, 0.4, 0.35, 0.6, 1, 1, 1, 1, 1], region='Unknown', region_prob=0.2))
    result = plates.read_plates(image, None)
    assert result['plate'] is None
    assert result['plate_status'] == 'plate_unreadable'
    assert result['plates_detected'] == 1
    assert result['plate_bbox'] == {'x': 1248, 'y': 766, 'width': 25, 'height': 8}
    assert result['rejected'][0]['reason'] == 'below_min_score'
    assert result['evidence_quality'] == 'insufficient' and result['review_required'] is True


def test_read_plates_flags_tiny_plates_even_when_ocr_is_confident(monkeypatch):
    image = np.zeros((720, 1280, 3), dtype=np.uint8)
    monkeypatch.setattr(plates, '_load_plate_detector', lambda: FakePlateDetector([[(0.9, 600, 400, 630, 410)]]))
    monkeypatch.setattr(plates, '_load_plate_ocr', lambda: FakeOcr('ABC123____', [0.99] * 10))
    result = plates.read_plates(image, None)
    assert result['plate'] == 'ABC123'
    assert result['evidence_quality'] == 'insufficient'
    assert result['results'][0]['quality_reason'] == 'plate_too_small'
    assert result['review_required'] is True


def test_read_plates_rejects_non_nz_text_but_keeps_it_visible(monkeypatch):
    image = np.zeros((720, 1280, 3), dtype=np.uint8)
    monkeypatch.setattr(plates, '_load_plate_detector', lambda: FakePlateDetector([[(0.9, 600, 400, 760, 450)]]))
    monkeypatch.setattr(plates, '_load_plate_ocr', lambda: FakeOcr('RIVER_____', [0.99] * 10))
    result = plates.read_plates(image, None)
    assert result['plate'] is None
    assert result['rejected'][0] == {'raw_text': 'RIVER', 'box': {'x': 600, 'y': 400, 'width': 160, 'height': 50}, 'char_confidence_min': 0.99, 'variant': 'raw', 'reason': 'not_nz_format'} or result['rejected'][0]['reason'] == 'not_nz_format'


def test_app_falls_back_to_legacy_alpr_when_the_trained_tier_is_not_staged(monkeypatch):
    monkeypatch.setattr(appmod.plate_reader, 'staged', lambda: False)
    image = np.zeros((720, 1280, 3), dtype=np.uint8)
    monkeypatch.setattr(appmod, '_locate_plate_regions', lambda _image: [(300, 400, 120, 32)])
    monkeypatch.setattr(appmod, '_read_plate_candidates', lambda _image, psm: [('ABC123', '90')])
    result = appmod._infer_plate_from_image(image)
    assert result['plate'] == 'ABC123'
    assert result['plate_bbox'] == {'x': 300, 'y': 400, 'width': 120, 'height': 32}
    assert result['alpr_provider'] == 'local_tesseract_plate_region'

    monkeypatch.setattr(appmod, '_locate_plate_regions', lambda _image: [])
    monkeypatch.setattr(appmod, '_read_plate_candidates', lambda _image, psm: [('RIVER', '99')])
    result = appmod._infer_plate_from_image(image)
    assert result['plate'] is None and result['plate_status'] == 'no_plate_detected'


def test_app_routes_to_trained_alpr_with_vehicle_boxes_when_staged(monkeypatch):
    seen = {}

    def fake_read(image, vehicles=None):
        seen['vehicles'] = vehicles
        return {'success': True, 'plate': 'KLM456', 'confidence': 0.9, 'plate_bbox': None, 'results': [], 'alpr_provider': plates.PLATE_PROVIDER}

    monkeypatch.setattr(appmod.plate_reader, 'staged', lambda: True)
    monkeypatch.setattr(appmod.plate_reader, 'read_plates', fake_read)
    result = appmod._infer_plate_from_image(np.zeros((10, 10, 3), dtype=np.uint8), [{'x': 1, 'y': 2, 'width': 3, 'height': 4}])
    assert result['plate'] == 'KLM456' and seen['vehicles'] == [{'x': 1, 'y': 2, 'width': 3, 'height': 4}]


def test_health_payload_names_every_tier_and_provider(monkeypatch):
    payload = appmod._health_payload()
    for key in ('detector_model', 'detector_name', 'detector_provider', 'detector_coverage', 'alpr', 'alpr_provider', 'plate_detector_model', 'plate_ocr_model', 'cuda', 'species_model'):
        assert key in payload
    assert payload['alpr'] in ('ready', 'not_staged')


# --------------------------------------------------------------------------------------------- legacy checks kept


def test_movement_compare_has_an_inconclusive_band():
    assert appmod.SIMILARITY_THRESHOLD > appmod.DIFFERENT_VEHICLE_THRESHOLD


def test_vehicle_inference_returns_embedding_and_explicit_review_state():
    image = np.full((80, 120, 3), 255, dtype=np.uint8)
    try:
        result = appmod._infer_vehicle_attributes(image)
    except (FileNotFoundError, RuntimeError) as error:
        pytest.skip(f'OpenVINO attribute model not staged: {error}')
    assert len(result['embedding']) == 384
    assert result['vehicle_make'] is None
    assert result['vehicle_colour'] == 'white'
    assert result['review_required'] is True
