import hashlib
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'services' / 'vision'))
from capture_enhancement import FUSION_PROFILE_NAME, PROFILE_NAME, capture_quality, enhance_capture, fuse_capture_frames
from capture_derivative import build_derivative


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

    def test_quality_ranked_alignment_and_median_fusion_reduce_noise(self):
        rng = np.random.default_rng(42)
        clean = np.zeros((96, 128, 3), dtype=np.uint8)
        cv2.rectangle(clean, (18, 20), (108, 76), (55, 130, 210), -1)
        cv2.putText(clean, 'ABC123', (25, 58), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (240, 245, 250), 2, cv2.LINE_AA)
        frames = []
        transforms = []
        for dx, dy in ((0, 0), (1.2, -0.8), (-1.0, 1.1), (0.6, 0.7), (-0.5, -1.2)):
            matrix = np.array([[1, 0, dx], [0, 1, dy]], dtype=np.float32)
            transforms.append(matrix)
            shifted = cv2.warpAffine(clean, matrix, (clean.shape[1], clean.shape[0]), borderMode=cv2.BORDER_REFLECT)
            noisy = np.clip(shifted.astype(np.int16) + rng.normal(0, 13, shifted.shape), 0, 255).astype(np.uint8)
            frames.append(noisy)

        fused, receipt = fuse_capture_frames(frames, minimum_correlation=0.60)
        clean_reference = cv2.warpAffine(clean, transforms[receipt.reference_index], (clean.shape[1], clean.shape[0]), borderMode=cv2.BORDER_REFLECT)
        reference_error = float(np.mean((frames[receipt.reference_index].astype(np.float32) - clean_reference.astype(np.float32)) ** 2))
        fused_error = float(np.mean((fused.astype(np.float32) - clean_reference.astype(np.float32)) ** 2))
        self.assertEqual(receipt.profile, FUSION_PROFILE_NAME)
        self.assertGreaterEqual(receipt.frames_aligned, 4)
        self.assertLess(fused_error, reference_error * 0.75)
        self.assertGreater(capture_quality(frames[0]), 0)
        self.assertEqual(receipt.output_sha256, hashlib.sha256(fused.tobytes()).hexdigest())

    def test_derivative_writes_separate_original_and_enhanced_artifacts(self):
        import tempfile
        clean = np.zeros((48, 64, 3), dtype=np.uint8)
        cv2.rectangle(clean, (8, 8), (55, 39), (70, 140, 210), -1)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frames = []
            for index, shift in enumerate((0, 1, -1)):
                image = cv2.warpAffine(clean, np.array([[1, 0, shift], [0, 1, 0]], dtype=np.float32), (64, 48), borderMode=cv2.BORDER_REFLECT)
                source = root / f'frame-{index}.jpg'
                cv2.imwrite(str(source), image)
                frames.append({'path': str(source), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'frame_index': index, 'timestamp_seconds': index / 5, 'bbox': {'x': 6, 'y': 6, 'width': 52, 'height': 36}})
            receipt = build_derivative({'event_id': 'vehicle-1', 'entity_kind': 'vehicle', 'frames': frames, 'scale': 3}, root / 'out')
            original = Path(receipt['original_artifact']['file'])
            enhanced = Path(receipt['enhanced_artifact']['file'])
            self.assertTrue(original.exists() and enhanced.exists())
            self.assertNotEqual(original.read_bytes(), enhanced.read_bytes())
            self.assertEqual(receipt['authority'], 'provisional')
            self.assertFalse(receipt['enhancement']['generative'])
            self.assertEqual(receipt['fusion']['frames_aligned'], 3)


if __name__ == '__main__':
    unittest.main()
