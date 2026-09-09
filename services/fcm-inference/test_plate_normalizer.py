import importlib.util
from pathlib import Path

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location('appmod', Path(__file__).with_name('app.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_standard_nz_formats_are_valid():
    assert mod._normalize_nz_plate('ABC123') == ('ABC123', 'standard_modern')
    assert mod._normalize_nz_plate('AB1234') == ('AB1234', 'standard_older')
    assert mod._normalize_nz_plate('TL316') == ('TL316', 'personalised')


def test_short_ocr_noise_is_rejected():
    assert mod._normalize_nz_plate('SY') is None
    assert mod._normalize_nz_plate('AN') is None
    assert mod._normalize_nz_plate('LL') is None
    assert mod._normalize_nz_plate('240') is None
    assert mod._normalize_nz_plate('4228') is None
    assert mod._normalize_nz_plate('4ST') is None
    assert mod._normalize_nz_plate('N43') is None


def test_movement_compare_has_an_inconclusive_band():
    assert mod.SIMILARITY_THRESHOLD > mod.DIFFERENT_VEHICLE_THRESHOLD


def test_scene_similarity_recognizes_same_and_changed_context():
    first = np.zeros((80, 120, 3), dtype=np.uint8)
    first[:, :60] = (40, 120, 200)
    first[:, 60:] = (180, 80, 30)
    same = first.copy()
    changed = cv2.rotate(first, cv2.ROTATE_180)

    assert mod._scene_similarity(first, same) > 0.99
    assert mod._scene_similarity(first, changed) < 0.5


def test_vehicle_inference_returns_embedding_and_explicit_review_state():
    image = np.zeros((80, 120, 3), dtype=np.uint8)
    image[:] = (255, 255, 255)
    result = mod._infer_vehicle_attributes(image)

    assert len(result['embedding']) == 384
    assert result['vehicle_make'] is None
    assert result['vehicle_model'] is None
    assert result['vehicle_year'] is None
    assert result['vehicle_colour'] == 'white'
    assert result['review_required'] is True


def test_alpr_rejects_full_frame_text_without_plate_region(monkeypatch):
    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    monkeypatch.setattr(mod, '_locate_plate_regions', lambda _image: [])
    monkeypatch.setattr(mod, '_read_plate_candidates', lambda _image, psm: [('RIVER', '99')])

    result = mod._infer_plate_from_image(image)

    assert result['plate'] is None
    assert result['plate_status'] == 'no_plate_detected'
    assert result['plate_bbox'] is None
    assert result['evidence_quality'] == 'insufficient'


def test_alpr_requires_a_plate_bbox_for_accepted_reading(monkeypatch):
    image = np.zeros((720, 1280, 3), dtype=np.uint8)
    monkeypatch.setattr(mod, '_locate_plate_regions', lambda _image: [(300, 400, 120, 32)])
    monkeypatch.setattr(mod, '_read_plate_candidates', lambda _image, psm: [('ABC123', '90')])

    result = mod._infer_plate_from_image(image)

    assert result['plate'] == 'ABC123'
    assert result['plate_bbox'] == {'x': 300, 'y': 400, 'width': 120, 'height': 32}
    assert result['plate_status'] == 'plate_detected'


def test_person_appearance_is_explicitly_calibration_aware():
    image = np.zeros((120, 60, 3), dtype=np.uint8)
    image[:60] = (255, 0, 0)
    result = mod._person_appearance_attributes(image, {'x': 0, 'y': 0, 'width': 60, 'height': 120})

    assert result['appearance_status'] == 'visual_estimate_review_required'
    assert result['height_status'] == 'camera_calibration_required'
    assert result['height_estimate_meters'] is None
    assert result['appearance_embedding_dimension'] == 1536
    assert result['review_required'] is True


def test_animal_capability_is_explicitly_unavailable_until_model_staged():
    assert mod._capability_unavailable('animal_detection_model').status_code == 503
