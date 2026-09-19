import math
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'services' / 'vision'))
import video_motion_extractor
from video_motion_extractor import (
    FrameClock,
    FrameStats,
    QualityEvent,
    SequentialFrames,
    TemporalQualityGate,
    _frame_stats,
    _timestamp_seconds,
    extract_motion_summary,
    static_quality_state,
)


class VideoMotionExtractorTimestampTests(unittest.TestCase):
    def test_uses_decoder_timestamp_after_first_frame(self):
        capture = Mock()
        capture.get.return_value = 2750.0

        self.assertEqual(_timestamp_seconds(capture, frame_index=30, fps=25.0), 2.75)

    def test_falls_back_to_frame_rate_for_zero_timestamp(self):
        capture = Mock()
        capture.get.return_value = 0.0

        self.assertTrue(math.isclose(_timestamp_seconds(capture, frame_index=30, fps=25.0), 1.2))

    def test_frame_clock_interpolates_between_the_decoded_frames_either_side(self):
        clock = FrameClock(3.0)
        for index in (0, 1, 2, 10):
            clock.record(index, index / 2.8)
        self.assertAlmostEqual(clock.at(10), 10 / 2.8)
        # A position the decoder skipped sits proportionally between its decoded neighbours...
        self.assertAlmostEqual(clock.at(6), 6 / 2.8)
        # ...and past the last decoded frame the nominal period is all that is known.
        self.assertAlmostEqual(clock.at(11), 10 / 2.8 + 1 / 3)
        self.assertAlmostEqual(FrameClock(3.0).at(9), 3.0)


class ScriptedCapture:
    """A VideoCapture whose clock runs at `real_fps` while it declares `nominal_fps`, and whose read() fails
    once at `fail_at`, advancing the position by `skip` frames the way the worker's decoder does on a damaged
    access unit. Frames carry their index as a slowly changing grey patch."""

    def __init__(self, frames, real_fps, nominal_fps, fail_at=None, skip=0):
        self.frames = frames
        self.real_fps = real_fps
        self.nominal_fps = nominal_fps
        self.fail_at = fail_at
        self.skip = skip
        self.position = 0
        self.last = None
        self.failed = False

    def isOpened(self):
        return True

    def release(self):
        pass

    def getBackendName(self):
        return 'scripted'

    def read(self):
        if self.fail_at is not None and self.position == self.fail_at and not self.failed:
            self.failed = True
            self.position += self.skip
            return False, None
        if self.position >= len(self.frames):
            return False, None
        self.last = self.position
        self.position += 1
        return True, self.frames[self.last].copy()

    def get(self, prop):
        if prop == cv2.CAP_PROP_FPS:
            return self.nominal_fps
        if prop == cv2.CAP_PROP_FRAME_COUNT:
            return len(self.frames)
        if prop == cv2.CAP_PROP_FRAME_WIDTH:
            return self.frames[0].shape[1]
        if prop == cv2.CAP_PROP_FRAME_HEIGHT:
            return self.frames[0].shape[0]
        if prop == cv2.CAP_PROP_POS_FRAMES:
            return self.position
        if prop == cv2.CAP_PROP_POS_MSEC:
            return (self.last / self.real_fps) * 1000.0 if self.last is not None else 0.0
        return 0.0


class SequentialFramesTests(unittest.TestCase):
    def test_hands_out_the_frame_at_the_requested_clock_even_after_a_skip(self):
        frames = [np.full((8, 8, 3), i, dtype=np.uint8) for i in range(30)]
        reader = SequentialFrames(ScriptedCapture(frames, real_fps=3.0, nominal_fps=3.0, fail_at=10, skip=4), 3.0)
        seconds, frame = reader.take_at(2.0)
        self.assertAlmostEqual(seconds, 2.0)
        self.assertEqual(int(frame[0, 0, 0]), 6)
        # Frames 10-13 are lost to the damaged unit: they are reported missing, not replaced by the 4th read after them.
        self.assertIsNone(reader.take_at(11 / 3))
        self.assertFalse(reader.exhausted)
        self.assertEqual(reader.failures, 4)
        seconds, frame = reader.take_at(14 / 3)
        self.assertEqual(int(frame[0, 0, 0]), 14)
        self.assertAlmostEqual(seconds, 14 / 3)
        seconds, frame = reader.take_at(20 / 3)
        self.assertEqual(int(frame[0, 0, 0]), 20)
        self.assertIsNone(reader.take_at(99.0))
        self.assertTrue(reader.exhausted)


class ContainerClockIntegrationTests(unittest.TestCase):
    def test_segment_and_frame_times_follow_the_container_clock_not_index_over_nominal_fps(self):
        real_fps, nominal_fps = 2.8, 3.0
        rng = np.random.default_rng(3)
        scene = _colour_scene(rng)
        # A square walks 6 px per frame from index 60 to 74: its position identifies the frame it came from.
        frames = [_with_square(scene, 20 + (index - 60) * 6) if 60 <= index < 75 else scene.copy() for index in range(120)]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(video_motion_extractor.cv2, 'VideoCapture', lambda _path: ScriptedCapture(frames, real_fps, nominal_fps, fail_at=64, skip=3)):
            video = Path(directory) / 'scripted.dav'
            video.write_bytes(b'x')
            summary = extract_motion_summary(video, output_dir=Path(directory) / 'frames', warmup_frames=15, pre_roll=1.0, post_roll=1.0)
            self.assertEqual(len(summary.motion_segments), 1, summary.motion_segments)
            segment = summary.motion_segments[0]
            # Motion starts at index 60: on the container clock that is 21.4 s, not 20.0 s (index / nominal fps).
            self.assertAlmostEqual(segment.start_time_seconds, 60 / real_fps - 1.0, delta=0.4)
            self.assertTrue(segment.frames)
            saved_indices = [artifact.frame_index for artifact in segment.frames]
            self.assertTrue(all(index not in saved_indices for index in (64, 65, 66)), 'frames the decoder skipped are not replaced by later ones')
            for artifact in segment.frames:
                self.assertAlmostEqual(artifact.relative_timestamp_seconds, artifact.frame_index / real_fps, delta=0.5 / nominal_fps)
                if 60 <= artifact.frame_index < 75:
                    saved = cv2.imread(artifact.file_path)
                    white = np.where(saved[90, :, :].min(axis=1) > 200)[0]
                    self.assertTrue(len(white), 'the saved frame should show the moving square')
                    self.assertEqual(60 + round((int(white[0]) - 20) / 6), artifact.frame_index, 'the saved image is the frame the motion was detected in')
            self.assertTrue(summary.extraction_truncated, 'a skipped access unit is reported as truncation')


FPS = 15
WIDTH, HEIGHT = 320, 180


def _colour_scene(rng: np.random.Generator) -> np.ndarray:
    # A textured colour background so the frame has saturation and contrast like daylight footage.
    base = rng.integers(40, 200, size=(HEIGHT // 8, WIDTH // 8, 3), dtype=np.uint8)
    scene = cv2.resize(base, (WIDTH, HEIGHT), interpolation=cv2.INTER_LINEAR)
    scene[:, :, 2] = np.clip(scene[:, :, 2].astype(int) + 40, 0, 255)  # warm cast keeps saturation up
    return scene


def _mono(scene: np.ndarray, brightness_shift: int) -> np.ndarray:
    grey = cv2.cvtColor(scene, cv2.COLOR_BGR2GRAY)
    grey = np.clip(grey.astype(int) + brightness_shift, 0, 255).astype(np.uint8)
    return cv2.cvtColor(grey, cv2.COLOR_GRAY2BGR)


def _with_square(scene: np.ndarray, x: int) -> np.ndarray:
    frame = scene.copy()
    cv2.rectangle(frame, (x, 60), (x + 40, 120), (255, 255, 255), thickness=-1)
    return frame


def _write_synthetic_video(path: Path) -> dict[str, float]:
    """0-3s static colour | 3-5s moving square | 5-10s static | 10s IR switch to mono | 12.5s one glitch frame
    | 15-17s moving square (mono) | 17-19s static."""
    rng = np.random.default_rng(7)
    colour = _colour_scene(rng)
    mono = _mono(colour, -35)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), FPS, (WIDTH, HEIGHT))
    total = 19 * FPS
    glitch_frame = int(12.5 * FPS)
    for index in range(total):
        second = index / FPS
        if second < 10:
            frame = _with_square(colour, 20 + int((second - 3) * 100)) if 3 <= second < 5 else colour
        elif index == glitch_frame:
            frame = np.full((HEIGHT, WIDTH, 3), 235, dtype=np.uint8)
        else:
            frame = _with_square(mono, 20 + int((second - 15) * 100)) if 15 <= second < 17 else mono
        writer.write(frame)
    writer.release()
    return {'ir_switch_at': 10.0, 'glitch_at': glitch_frame / FPS}


class TemporalQualityGateTests(unittest.TestCase):
    def test_static_quality_state_vocabulary(self):
        self.assertEqual(static_quality_state(FrameStats(120, 40, 30, 1.1)), ('clear', None))
        self.assertEqual(static_quality_state(FrameStats(120, 40, 2, 1.1))[0], 'degraded')
        self.assertEqual(static_quality_state(FrameStats(245, 5, 30, 1.1))[0], 'flare')
        self.assertEqual(static_quality_state(FrameStats(120, 40, 30, 2.2))[0], 'flare')

    def test_single_frame_spike_is_a_glitch_and_never_counts_as_motion(self):
        gate = TemporalQualityGate(FPS)
        steady = np.full((36, 64), 100, dtype=np.float32)
        spike = np.full((36, 64), 240, dtype=np.float32)
        stats = FrameStats(100, 40, 30, 1.0)
        self.assertEqual(gate.observe(0, stats, steady, FPS), ('clear', True, True))
        self.assertEqual(gate.observe(1, stats, spike, FPS), ('clear', False, False))
        self.assertEqual(gate.observe(2, stats, steady, FPS), ('clear', True, True))
        self.assertEqual(gate.states, {1: 'glitch'})
        self.assertEqual([event.kind for event in gate.events], ['glitch'])

    def test_persistent_saturation_flip_is_an_ir_switch_with_cooldown(self):
        gate = TemporalQualityGate(FPS)
        colour = np.full((36, 64), 100, dtype=np.float32)
        mono = np.full((36, 64), 70, dtype=np.float32)
        gate.observe(0, FrameStats(100, 45, 30, 1.0), colour, FPS)
        results = [gate.observe(index, FrameStats(70, 1, 30, 1.0), mono, FPS) for index in range(1, 4)]
        self.assertEqual(results[-1], ('ir_switch', False, False))
        self.assertEqual({1, 2, 3}, set(gate.states))
        self.assertTrue(all(state == 'ir_switch' for state in gate.states.values()))
        self.assertEqual([event.kind for event in gate.events], ['ir_switch'])
        # Motion is ignored while the background model re-learns, then counted again.
        settling = [gate.observe(index, FrameStats(70, 1, 30, 1.0), mono, FPS) for index in range(4, 4 + gate.cooldown_frames)]
        self.assertTrue(all(result == ('clear', True, False) for result in settling))
        self.assertEqual(gate.observe(99, FrameStats(70, 1, 30, 1.0), mono, FPS), ('clear', True, True))

    def test_persistent_change_without_saturation_flip_is_a_degraded_scene_change(self):
        gate = TemporalQualityGate(FPS)
        before = np.full((36, 64), 100, dtype=np.float32)
        after = np.full((36, 64), 160, dtype=np.float32)
        gate.observe(0, FrameStats(100, 45, 30, 1.0), before, FPS)
        results = [gate.observe(index, FrameStats(160, 45, 30, 1.0), after, FPS) for index in range(1, 4)]
        self.assertEqual(results[-1], ('degraded', True, False))
        self.assertTrue(all(state == 'degraded' for state in gate.states.values()))
        self.assertEqual([event.kind for event in gate.events], ['scene_change'])
        # The picture holds still afterwards: back to clear and motion counts again, no cooldown.
        self.assertEqual(gate.observe(4, FrameStats(160, 45, 30, 1.0), after, FPS), ('clear', True, True))

    def test_finish_merges_a_run_of_bursts_into_one_disturbance(self):
        gate = TemporalQualityGate(FPS)
        gate.events = [
            QualityEvent('scene_change', 87.9, 88.037, 1290, 1292), QualityEvent('scene_change', 89.877, 90.013, 1319, 1321),
            QualityEvent('scene_change', 90.081, 90.217, 1322, 1324), QualityEvent('glitch', 32.707, 32.707, 480, 480),
            QualityEvent('scene_change', 120.0, 120.2, 1760, 1763),
        ]
        gate.finish(FPS)
        self.assertEqual([(event.kind, event.start_time_seconds, event.end_time_seconds, event.frame_end) for event in gate.events],
                         [('glitch', 32.707, 32.707, 480), ('scene_change', 87.9, 88.037, 1292), ('scene_change', 89.877, 90.217, 1324), ('scene_change', 120.0, 120.2, 1763)])

    def test_frame_stats_reads_saturation_and_contrast(self):
        colour = _colour_scene(np.random.default_rng(1))
        stats, grey = _frame_stats(colour)
        self.assertGreater(stats.saturation, 15)
        self.assertGreater(stats.contrast, 5)
        self.assertEqual(grey.shape, (36, 64))
        mono_stats, _ = _frame_stats(_mono(colour, 0))
        self.assertLess(mono_stats.saturation, 2)


class SyntheticVideoTests(unittest.TestCase):
    def test_ir_switch_and_glitch_do_not_open_motion_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / 'synthetic.avi'
            markers = _write_synthetic_video(video)
            summary = extract_motion_summary(video, output_dir=Path(directory) / 'frames', warmup_frames=FPS)

        kinds = [event.kind for event in summary.quality_events]
        self.assertIn('ir_switch', kinds, f'expected an IR switch event, got {summary.quality_events}')
        self.assertIn('glitch', kinds, f'expected a glitch event, got {summary.quality_events}')
        ir_event = next(event for event in summary.quality_events if event.kind == 'ir_switch')
        self.assertAlmostEqual(ir_event.start_time_seconds, markers['ir_switch_at'], delta=0.25)
        glitch_event = next(event for event in summary.quality_events if event.kind == 'glitch')
        self.assertAlmostEqual(glitch_event.start_time_seconds, markers['glitch_at'], delta=0.1)
        self.assertGreaterEqual(summary.quality_counts['ir_switch'], 3)
        self.assertGreaterEqual(summary.quality_counts['glitch'], 1)

        windows = [(segment.start_time_seconds, segment.end_time_seconds) for segment in summary.motion_segments]
        self.assertEqual(len(windows), 2, f'expected the two real movements only, got {windows}')
        # Real movement at 3-5s and 15-17s, each padded by 2s of pre/post roll.
        self.assertLess(windows[0][0], 3.0)
        self.assertLess(windows[0][1], 7.6, 'the IR switch at 10s must not extend the first window')
        self.assertGreater(windows[1][0], 12.6, 'the glitch at 12.5s must not open or extend the second window')
        self.assertLess(windows[1][0], 15.0)

        artifacts = [frame for segment in summary.motion_segments for frame in segment.frames]
        self.assertTrue(artifacts)
        self.assertTrue(all(frame.quality_state in ('clear', 'glitch', 'flare', 'ir_switch', 'degraded') for frame in artifacts))
        self.assertTrue(all(frame.visual_quality == ('usable' if frame.quality_state == 'clear' else 'degraded') for frame in artifacts))


if __name__ == '__main__':
    unittest.main()