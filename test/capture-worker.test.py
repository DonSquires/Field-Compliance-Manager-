import base64
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'services' / 'fcm-capture-inference'))
from runpod_handler import handler


class CaptureWorkerTests(unittest.TestCase):
    def test_capture_response_is_provisional_and_hash_provenanced(self):
        image = np.zeros((20, 30, 3), dtype=np.uint8)
        image[5:15, 8:22] = (80, 110, 160)
        encoded, buffer = cv2.imencode('.jpg', image)
        self.assertTrue(encoded)
        result = handler({'input': {
            'action': 'capture_recognition',
            'source_frame_hash': 'a' * 64,
            'image_base64': base64.b64encode(buffer.tobytes()).decode('ascii'),
            'tasks': ['alpr', 'face_embedding', 'vehicle_attributes', 'animal_detection'],
        }})
        self.assertEqual(result['authority'], 'provisional')
        self.assertEqual(result['enhancement']['generative'], False)
        self.assertEqual(result['alpr']['state'], 'unavailable')
        self.assertEqual(result['face']['state'], 'unavailable')
        self.assertEqual(result['animals']['state'], 'unavailable')
        self.assertEqual(len(result['enhanced_crop_hash']), 64)

    def test_rejects_missing_source_hash(self):
        result = handler({'input': {'action': 'capture_recognition', 'image_base64': 'bad'}})
        self.assertEqual(result['error'], 'source_frame_hash_required')


if __name__ == '__main__':
    unittest.main()
