import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'services' / 'fcm-inference'))
import super_resolution


class _Input:
    name = 'input'


class _FakeGpuSession:
    def get_inputs(self):
        return [_Input()]

    def get_providers(self):
        return ['CUDAExecutionProvider']

    def run(self, _outputs, feeds):
        source = feeds['input']
        return [np.repeat(np.repeat(source, 4, axis=2), 4, axis=3)]


class SuperResolutionTests(unittest.TestCase):
    def tearDown(self):
        super_resolution._session = None
        super_resolution._session_error = None

    def test_missing_model_falls_back_deterministically_and_says_not_generative(self):
        image = np.full((20, 30, 3), (30, 90, 170), dtype=np.uint8)
        with tempfile.TemporaryDirectory() as directory:
            first, first_receipt = super_resolution.enhance(image, Path(directory))
            second, second_receipt = super_resolution.enhance(image, Path(directory))
        self.assertEqual(first.tolist(), second.tolist())
        self.assertEqual(first_receipt, second_receipt)
        self.assertFalse(first_receipt['generative'])
        self.assertEqual(first_receipt['profile'], super_resolution.PROFILE_FALLBACK)
        self.assertEqual(first_receipt['execution_provider'], 'opencv_cpu')

    def test_gpu_model_path_is_labelled_generative_with_provider_and_hash(self):
        super_resolution._session = _FakeGpuSession()
        image = np.zeros((10, 12, 3), dtype=np.uint8)
        image[2:8, 3:9] = (20, 120, 220)
        enhanced, receipt = super_resolution.enhance(image, Path('/unused'))
        self.assertEqual(enhanced.shape[:2], (40, 48))
        self.assertTrue(receipt['generative'])
        self.assertEqual(receipt['profile'], super_resolution.PROFILE_AI)
        self.assertEqual(receipt['execution_provider'], 'CUDAExecutionProvider')
        self.assertEqual(receipt['model_sha256'], super_resolution.MODEL_SHA256)
        self.assertEqual(receipt['enhanced_sha256'], super_resolution._sha256_pixels(enhanced))


if __name__ == '__main__':
    unittest.main()