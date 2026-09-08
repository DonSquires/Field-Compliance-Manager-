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
