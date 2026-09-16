import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'services' / 'fcm-inference'))
import detector  # noqa: E402


class SpeciesMappingTests(unittest.TestCase):
    def test_nz_pest_list_marks_forestry_pests(self):
        for label, key in [('possum', 'possum'), ('Trichosurus vulpecula', 'possum'), ('stoat', 'stoat'), ('Mustela erminea', 'stoat'),
                           ('ship rat', 'rat'), ('Rattus norvegicus', 'rat'), ('red deer', 'deer'), ('wild boar', 'pig'), ('feral goat', 'goat'),
                           ('feral cat', 'cat'), ('european hedgehog', 'hedgehog'), ('brown hare', 'hare'), ("bennett's wallaby", 'wallaby')]:
            species = detector.normalise_species(label)
            self.assertIsNotNone(species, label)
            self.assertEqual(species.key, key, label)
            self.assertTrue(species.is_pest, f'{label} is a NZ pest')

    def test_non_target_species_are_not_pests(self):
        for label, key in [('dog', 'dog'), ('Canis familiaris', 'dog'), ('cattle', 'cattle'), ('sheep', 'sheep'), ('horse', 'horse'), ('bird', 'bird')]:
            species = detector.normalise_species(label)
            self.assertEqual(species.key, key, label)
            self.assertFalse(species.is_pest, label)

    def test_speciesnet_taxonomy_string_prefers_common_name_then_genus_species(self):
        possum = detector.normalise_species('5a0f5e3f;mammalia;diprotodontia;phalangeridae;trichosurus;vulpecula;common brushtail possum')
        self.assertEqual(possum.key, 'possum')
        rat = detector.normalise_species('uuid;mammalia;rodentia;muridae;rattus;;rattus species')
        self.assertEqual(rat.key, 'rat')
        bird = detector.normalise_species('uuid;aves;passeriformes;;;;')
        self.assertEqual(bird.key, 'bird')
        self.assertIsNone(detector.normalise_species('uuid;mammalia;carnivora;;;;'))

    def test_unknown_labels_and_empty_input_stay_unmapped(self):
        self.assertIsNone(detector.normalise_species(None))
        self.assertIsNone(detector.normalise_species(''))
        self.assertIsNone(detector.normalise_species('giraffe'))

    def test_species_payload_never_promotes_a_low_confidence_or_unknown_label(self):
        candidate = detector.species_payload('stoat', 0.91, 'test')
        self.assertEqual((candidate['species'], candidate['is_pest'], candidate['species_status']), ('stoat', True, 'candidate'))
        below = detector.species_payload('stoat', 0.2, 'test')
        self.assertEqual((below['species'], below['is_pest'], below['species_status']), ('other', False, 'below_threshold'))
        unknown = detector.species_payload('dragon', 0.99, 'test')
        self.assertEqual((unknown['species'], unknown['species_status'], unknown['raw_label']), ('other', 'unmapped_label', 'dragon'))


class DetectorMappingTests(unittest.TestCase):
    def test_megadetector_classes_and_coco_classes_map_to_entity_kinds(self):
        self.assertEqual(detector.map_detection('megadetector', 0, None), ('animal', None))
        self.assertEqual(detector.map_detection('megadetector', 1, None), ('person', None))
        self.assertEqual(detector.map_detection('megadetector', 2, None), ('vehicle', None))
        self.assertIsNone(detector.map_detection('megadetector', 7, None))
        self.assertEqual(detector.map_detection('coco', 0, 'person'), ('person', None))
        self.assertEqual(detector.map_detection('coco', 7, 'truck'), ('vehicle', 'truck'))
        self.assertEqual(detector.map_detection('coco', 16, 'dog'), ('animal', 'dog'))
        self.assertIsNone(detector.map_detection('coco', 39, 'bottle'))

    def test_detector_kind_is_inferred_from_the_weights_file_name(self):
        self.assertEqual(detector.detector_kind_for(Path('md_v5a.0.0.pt'), forced=''), 'megadetector')
        self.assertEqual(detector.detector_kind_for(Path('MDV6-yolov10-c.pt'), forced=''), 'megadetector')
        self.assertEqual(detector.detector_kind_for(Path('yolo11n.pt'), forced=''), 'coco')
        self.assertEqual(detector.detector_kind_for(Path('yolo11n.pt'), forced='megadetector'), 'megadetector')

    def test_bbox_from_xyxy_clamps_to_the_frame_and_drops_empty_boxes(self):
        self.assertEqual(detector.bbox_from_xyxy(-5, 10, 50, 60, 100, 100), {'x': 0, 'y': 10, 'width': 50, 'height': 50})
        self.assertEqual(detector.bbox_from_xyxy(90, 90, 200, 200, 100, 100), {'x': 90, 'y': 90, 'width': 10, 'height': 10})
        self.assertIsNone(detector.bbox_from_xyxy(50, 50, 50, 80, 100, 100))

    def test_plausible_box_rejects_whole_frame_specks_and_pixel_high_people(self):
        self.assertTrue(detector.plausible_box('vehicle', {'x': 200, 'y': 220, 'width': 300, 'height': 180}, 960, 540))
        self.assertFalse(detector.plausible_box('vehicle', {'x': 0, 'y': 0, 'width': 960, 'height': 540}, 960, 540), 'camera pressed against something')
        self.assertFalse(detector.plausible_box('vehicle', {'x': 10, 'y': 10, 'width': 8, 'height': 8}, 960, 540), 'a speck')
        self.assertFalse(detector.plausible_box('person', {'x': 39, 'y': 2, 'width': 13, 'height': 21}, 960, 540), 'tree-line false positive')
        self.assertTrue(detector.plausible_box('person', {'x': 632, 'y': 151, 'width': 58, 'height': 193}, 768, 432))
        self.assertFalse(detector.plausible_box('person', None, 960, 540))

    def test_missing_models_report_not_staged_and_return_no_detections(self):
        original = (detector.DETECTOR_MODEL_PATH, detector.OPENVINO_VEHICLE_DETECTOR_PATH)
        detector.DETECTOR_MODEL_PATH = Path('/nonexistent/md_v5a.0.0.pt')
        detector.OPENVINO_VEHICLE_DETECTOR_PATH = Path('/nonexistent/vehicle-detection-0200.xml')
        try:
            result = detector.detect(np.zeros((64, 64, 3), dtype=np.uint8))
            self.assertEqual(result, {'status': 'model_not_staged', 'coverage': [], 'detections': [], 'provider': None})
            triage = detector.triage_frame(np.zeros((64, 64, 3), dtype=np.uint8))
            self.assertEqual((triage['detector_status'], triage['people'], triage['vehicles'], triage['animals']), ('model_not_staged', [], [], []))
            status = detector.detector_status()
            self.assertEqual((status['detector'], status['coverage']), ('not_staged', []))
        finally:
            detector.DETECTOR_MODEL_PATH, detector.OPENVINO_VEHICLE_DETECTOR_PATH = original

    def test_openvino_vehicle_tier_covers_vehicles_only(self):
        # The OpenVINO vehicle detector is exercised for real when its IR is staged (MODELS_DIR); otherwise
        # the status contract is what matters: coverage is vehicle-only, so animals stay not_staged.
        status = detector.detector_status()
        if status['detector'] == 'vehicle_only':
            self.assertEqual(status['coverage'], ['vehicle'])
            frame = np.full((256, 256, 3), 120, dtype=np.uint8)
            result = detector.detect(frame)
            self.assertEqual((result['status'], result['coverage']), ('ready', ['vehicle']))
            self.assertTrue(result['provider'].startswith('openvino:'))
        self.assertIn(status['detector'], ('ready', 'vehicle_only', 'not_staged'))


if __name__ == '__main__':
    unittest.main()
