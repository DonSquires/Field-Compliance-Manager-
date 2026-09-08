import math
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).parents[1] / 'services' / 'vision'))
from video_motion_extractor import _timestamp_seconds


class VideoMotionExtractorTimestampTests(unittest.TestCase):
    def test_uses_decoder_timestamp_after_first_frame(self):
        capture = Mock()
        capture.get.return_value = 2750.0

        self.assertEqual(_timestamp_seconds(capture, frame_index=30, fps=25.0), 2.75)

    def test_falls_back_to_frame_rate_for_zero_timestamp(self):
        capture = Mock()
        capture.get.return_value = 0.0

        self.assertTrue(math.isclose(_timestamp_seconds(capture, frame_index=30, fps=25.0), 1.2))


if __name__ == '__main__':
    unittest.main()