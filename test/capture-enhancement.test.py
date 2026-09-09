import hashlib
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'services' / 'vision'))
from capture_enhancement import PROFILE_NAME, enhance_capture


class CaptureEnhancementTests(unittest.TestCase):
    def test_enhancement_is_deterministic_non_generative_and_provenanced(self):
        crop = np.zeros((20, 30, 3), dtype=np.uint8)
        crop[5:15, 8:22] = (80, 110, 160)
        first, first_receipt = enhance_capture(crop, scale=3)
        second, second_receipt = enhance_capture(crop, scale=3)

        self.assertEqual(PROFILE_NAME, first_receipt.profile)
        self.assertFalse(first_receipt.generative)
        self.assertEqual(first.tolist(), second.tolist())
        self.assertEqual(first_receipt.to_dict(), second_receipt.to_dict())
        self.assertEqual(first_receipt.source_sha256, hashlib.sha256(crop.tobytes()).hexdigest())
        self.assertEqual(first.shape[:2], (60, 90))
        self.assertNotEqual(first_receipt.source_sha256, first_receipt.enhanced_sha256)

    def test_rejects_empty_and_unsupported_scale(self):
        with self.assertRaises(ValueError):
            enhance_capture(np.empty((0, 0, 3), dtype=np.uint8))
        with self.assertRaises(ValueError):
            enhance_capture(np.zeros((4, 4, 3), dtype=np.uint8), scale=5)


if __name__ == '__main__':
    unittest.main()
