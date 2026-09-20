#!/usr/bin/env python3
"""Extract bounded motion windows and optional hashed JPEG frame artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError as error:
    raise RuntimeError(
        "Missing vision dependencies. Install services/vision/requirements.txt."
    ) from error


# Decoder threads per capture. OpenCV's FFmpeg backend otherwise opens one decode thread per core, so three
# extractors on an eight-core box run 24 decode threads against the detector's own threads and none of them
# finish; two per capture keeps a 2304x1296 HEVC stream decoding well ahead of the 3 fps it carries.
DECODE_THREADS = max(1, int(os.getenv("VISION_DECODE_THREADS", "2") or 2))
cv2.setNumThreads(DECODE_THREADS)


def open_capture(video_path: Path) -> "cv2.VideoCapture":
    """The FFmpeg backend with a fixed decode-thread budget; other backends ignore the property."""
    if hasattr(cv2, "CAP_PROP_N_THREADS"):
        return cv2.VideoCapture(str(video_path), cv2.CAP_FFMPEG, [cv2.CAP_PROP_N_THREADS, DECODE_THREADS])
    return cv2.VideoCapture(str(video_path))


class VideoExtractionError(RuntimeError):
    """Raised when a video cannot be safely processed."""


@dataclass(frozen=True)
class FrameArtifact:
    frame_index: int
    relative_timestamp_seconds: float
    sha256_hash: str
    file_path: str
    visual_quality: str = "usable"
    visual_quality_reason: str | None = None
    quality_state: str = "clear"
    sharpness_score: float = 0.0


@dataclass
class MotionSegment:
    start_time_seconds: float
    end_time_seconds: float
    frames: list[FrameArtifact] = field(default_factory=list)
    frames_truncated: bool = False


@dataclass
class QualityEvent:
    kind: str
    start_time_seconds: float
    end_time_seconds: float
    frame_start: int
    frame_end: int


@dataclass
class MotionSummary:
    total_duration: float
    motion_segments: list[MotionSegment]
    total_frames_parsed: int
    extraction_truncated: bool = False
    source_filename: str = ""
    codec_fourcc: str = "unknown"
    decoder_backend: str = "unknown"
    frame_width: int = 0
    frame_height: int = 0
    frames_per_second: float = 0.0
    quality_events: list[QualityEvent] = field(default_factory=list)
    quality_counts: dict[str, int] = field(default_factory=dict)
    # Positions the decoder could not read (damaged access units). Their frames are absent, never substituted.
    frames_skipped: int = 0

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)


QUALITY_STATES = ("clear", "glitch", "flare", "ir_switch", "degraded")
# Whole-frame change thresholds on a 64x36 grey thumbnail (0-255): a walking person moves a few
# percent of pixels (mean delta well under 5); a corrupt frame or a day/night switch moves most of them.
SPIKE_DELTA = 24.0
SATURATION_FLIP = 15.0
PERSIST_FRAMES = 3
IR_COOLDOWN_SECONDS = 2.0


@dataclass(frozen=True)
class FrameStats:
    brightness: float
    saturation: float
    contrast: float
    colour_cast: float


def _frame_stats(frame: np.ndarray) -> tuple[FrameStats, np.ndarray]:
    small = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
    grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    means = small.reshape(-1, 3).mean(axis=0)
    dominant = max(float(means.max()), 1.0)
    others = max(float(np.delete(means, int(means.argmax())).mean()), 1.0)
    return FrameStats(float(grey.mean()), float(hsv[:, :, 1].mean()), float(grey.std()), dominant / others), grey


def static_quality_state(stats: FrameStats) -> tuple[str, str | None]:
    """Quality visible in one frame on its own: blackout/occlusion, overexposure, colour cast."""
    if stats.contrast < 5:
        return "degraded", "near_uniform_frame_possible_occlusion_or_blackout"
    if stats.brightness > 235 and stats.saturation < 25:
        return "flare", "overexposed_low_information_frame_possible_glare"
    if stats.colour_cast >= 1.8:
        return "flare", "dominant_colour_cast_possible_glare_or_ir_filter_artifact"
    return "clear", None


class TemporalQualityGate:
    """Online detector for whole-frame disturbances the background model must not learn or report.

    A one- or two-frame whole-frame change that snaps back is a decode glitch. A change that persists
    with a colour<->monochrome flip is an IR (day/night) switch: the background model is reset and motion
    is ignored while it re-learns. Any other persistent change is a scene change (camera handled or moved,
    lights): it is recorded, its frames are marked degraded so nothing is inferred from them, and motion
    counting resumes once the picture holds still again.
    """

    def __init__(self, fps: float):
        self.cooldown_frames = max(1, round(IR_COOLDOWN_SECONDS * fps))
        self.reference_grey: np.ndarray | None = None
        self.reference_saturation: float | None = None
        self.pending: list[int] = []
        self.cooldown = 0
        self.states: dict[int, str] = {}
        self.events: list[QualityEvent] = []

    def observe(self, frame_index: int, stats: FrameStats, grey: np.ndarray, fps: float) -> tuple[str, bool, bool]:
        """Return (quality_state, learn_background, count_motion) for this frame."""
        delta = float(np.abs(grey - self.reference_grey).mean()) if self.reference_grey is not None else 0.0
        saturation_jump = abs(stats.saturation - self.reference_saturation) if self.reference_saturation is not None else 0.0
        if self.reference_grey is not None and (delta >= SPIKE_DELTA or saturation_jump >= SATURATION_FLIP):
            self.pending.append(frame_index)
            if len(self.pending) >= PERSIST_FRAMES:
                flipped = min(stats.saturation, self.reference_saturation or 0.0) < SATURATION_FLIP <= max(stats.saturation, self.reference_saturation or 0.0)
                kind = "ir_switch" if flipped else "scene_change"
                state = "ir_switch" if flipped else "degraded"
                for index in self.pending:
                    self.states[index] = state
                self.events.append(QualityEvent(kind, round(self.pending[0] / fps, 3), round(frame_index / fps, 3), self.pending[0], frame_index))
                self.pending = []
                self.reference_grey, self.reference_saturation = grey, stats.saturation
                if flipped:
                    self.cooldown = self.cooldown_frames
                    return "ir_switch", False, False
                return "degraded", True, False
            return "clear", False, False
        if self.pending:
            for index in self.pending:
                self.states[index] = "glitch"
            self.events.append(QualityEvent("glitch", round(self.pending[0] / fps, 3), round(self.pending[-1] / fps, 3), self.pending[0], self.pending[-1]))
            self.pending = []
        self.reference_grey, self.reference_saturation = grey, stats.saturation
        state, _reason = static_quality_state(stats)
        if self.cooldown > 0:
            self.cooldown -= 1
            return state, True, False
        return state, True, state == "clear"

    def finish(self, fps: float) -> None:
        if self.pending:
            for index in self.pending:
                self.states[index] = "glitch"
            self.events.append(QualityEvent("glitch", round(self.pending[0] / fps, 3), round(self.pending[-1] / fps, 3), self.pending[0], self.pending[-1]))
            self.pending = []
        # A camera being handled yields a run of three-frame bursts; report it as one disturbance.
        merged: list[QualityEvent] = []
        for event in sorted(self.events, key=lambda item: item.frame_start):
            last = merged[-1] if merged else None
            if last and last.kind == event.kind and event.start_time_seconds - last.end_time_seconds <= 1.0:
                merged[-1] = QualityEvent(last.kind, last.start_time_seconds, max(last.end_time_seconds, event.end_time_seconds), last.frame_start, max(last.frame_end, event.frame_end))
            else:
                merged.append(event)
        self.events = merged


def _validate_input(video_path: Path, max_input_bytes: int) -> None:
    if max_input_bytes <= 0:
        raise ValueError("max_input_bytes must be positive")
    if not video_path.is_file():
        raise VideoExtractionError(f"Video file does not exist: {video_path}")
    size = video_path.stat().st_size
    if size == 0:
        raise VideoExtractionError(f"Video file is empty: {video_path}")
    if size > max_input_bytes:
        raise VideoExtractionError(
            f"Video exceeds configured input limit of {max_input_bytes} bytes"
        )


def _timestamp_seconds(capture: cv2.VideoCapture, frame_index: int, fps: float) -> float:
    timestamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
    if np.isfinite(timestamp) and timestamp >= 0 and (frame_index == 0 or timestamp > 0):
        return timestamp
    # Some backends report 0 or an invalid timestamp for compressed streams.
    return frame_index / fps


class FrameClock:
    """Container time of each decoded frame, as the first pass saw it.

    DVR streams are not a steady nominal rate: this Dahua card runs ~2.8 fps against a declared 3, and the
    decoder drops damaged access units, so `index / fps` runs up to half a minute early over a recording.
    The container clock (PTS) matches the camera's on-screen clock, so every time FCM reports comes from it.
    """

    def __init__(self, fps: float):
        self.fps = fps
        self.times: dict[int, float] = {}
        self._keys: list[int] | None = None

    def record(self, index: int, seconds: float) -> None:
        self.times[index] = seconds
        self._keys = None

    def at(self, index: int) -> float:
        if index in self.times:
            return self.times[index]
        if not self.times:
            return index / self.fps
        if self._keys is None:
            self._keys = sorted(self.times)
        position = int(np.searchsorted(self._keys, index))
        if position == 0:
            key = self._keys[0]
            return self.times[key] - (key - index) / self.fps
        before = self._keys[position - 1]
        if position < len(self._keys):
            # A position the decoder skipped: place it proportionally between the frames either side of it.
            after = self._keys[position]
            return self.times[before] + (self.times[after] - self.times[before]) * (index - before) / (after - before)
        return self.times[before] + (index - before) / self.fps


class SequentialFrames:
    """Second-pass reader that hands out frames by container clock, not by how many reads it took.

    A damaged access unit makes `read()` fail while the backend advances past several positions; counting
    attempts then pairs a motion window with frames from later in the recording. Matching on the clock the
    first pass recorded keeps the saved frame the one the motion was detected in.
    """

    MAX_CONSECUTIVE_FAILURES = 4096

    def __init__(self, capture: cv2.VideoCapture, fps: float):
        self.capture = capture
        self.fps = fps
        self.decoded = 0
        self.failures = 0
        self.pending: tuple[float, np.ndarray] | None = None
        self.exhausted = False

    def _next(self) -> tuple[float, np.ndarray] | None:
        if self.pending is not None:
            return self.pending
        consecutive = 0
        while not self.exhausted:
            success, frame = self.capture.read()
            if success:
                seconds = _timestamp_seconds(self.capture, self.decoded + self.failures, self.fps)
                self.decoded += 1
                self.pending = (seconds, frame)
                return self.pending
            position = self.capture.get(cv2.CAP_PROP_POS_FRAMES)
            consecutive += 1
            if np.isfinite(position) and position > self.decoded + self.failures and consecutive <= self.MAX_CONSECUTIVE_FAILURES:
                self.failures = int(position) - self.decoded
                continue
            self.exhausted = True
        return None

    def take_at(self, target_seconds: float) -> tuple[float, np.ndarray] | None:
        """The unconsumed frame whose clock is `target_seconds` (within half a frame period). `None` when that
        frame is missing from the stream or the stream has ended; check `exhausted` to tell the two apart. A
        later frame is left pending for the target it does belong to, never handed out as a stand-in."""
        tolerance = 0.5 / self.fps
        while True:
            item = self._next()
            if item is None:
                return None
            seconds, _frame = item
            if seconds < target_seconds - tolerance:
                self.pending = None
                continue
            if seconds > target_seconds + tolerance:
                return None
            self.pending = None
            return item


def _codec_name(capture: cv2.VideoCapture) -> str:
    code = int(capture.get(cv2.CAP_PROP_FOURCC))
    if code <= 0:
        return "unknown"
    return "".join(chr((code >> (8 * index)) & 0xFF) for index in range(4)).strip() or "unknown"


def _merge_windows(windows: list[tuple[int, int]], frame_count: int) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for start, end in sorted(windows):
        start = max(0, start)
        end = min(frame_count - 1, end)
        if start > end:
            continue
        if merged and start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def _sample_frame_indices(start: int, end: int, limit: int) -> list[int]:
    """Spread a capped artifact budget across the complete motion window."""
    if start > end or limit <= 0:
        return []
    count = min(end - start + 1, limit)
    return np.linspace(start, end, num=count, dtype=np.int64).tolist()


def _write_frame(
    frame: np.ndarray,
    output_dir: Path,
    quality: int,
    width: int | None,
    height: int | None,
    scan_quality_state: str | None = None,
) -> tuple[str, str, str, str | None, str, float]:
    if not 1 <= quality <= 100:
        raise ValueError("output_quality must be between 1 and 100")
    rendered = frame
    if width or height:
        target_width = width or round(frame.shape[1] * (height / frame.shape[0]))
        target_height = height or round(frame.shape[0] * (width / frame.shape[1]))
        if target_width <= 0 or target_height <= 0:
            raise ValueError("scale dimensions must be positive")
        rendered = cv2.resize(
            frame, (target_width, target_height), interpolation=cv2.INTER_AREA
        )
    stats, _grey = _frame_stats(rendered)
    sharpness_score = float(cv2.Laplacian(_grey, cv2.CV_32F).var())
    quality_state, visual_quality_reason = static_quality_state(stats)
    # The scan saw this frame in sequence; a glitch, IR switch or scene-change burst it found there outranks the still test.
    if scan_quality_state in ("glitch", "ir_switch"):
        quality_state, visual_quality_reason = scan_quality_state, f"temporal_{scan_quality_state}"
    elif scan_quality_state == "degraded" and quality_state == "clear":
        quality_state, visual_quality_reason = "degraded", "temporal_scene_change"
    visual_quality = "usable" if quality_state == "clear" else "degraded"
    encoded, jpeg = cv2.imencode(".jpg", rendered, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not encoded:
        raise VideoExtractionError("failed to encode extracted frame")
    content = jpeg.tobytes()
    digest = hashlib.sha256(content).hexdigest()
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / f"{digest}.jpg"
    if destination.exists() and destination.read_bytes() != content:
        raise VideoExtractionError(f"hash collision at frame path: {destination}")
    if not destination.exists():
        temporary = destination.with_suffix(".jpg.tmp")
        temporary.write_bytes(content)
        os.replace(temporary, destination)
    return digest, str(destination), visual_quality, visual_quality_reason, quality_state, round(sharpness_score, 3)


def extract_motion_summary(
    input_path: str | os.PathLike[str],
    *,
    output_dir: str | os.PathLike[str] | None = None,
    motion_pixel_ratio: float = 0.003,
    max_gap_seconds: float = 1.0,
    warmup_frames: int = 30,
    pre_roll: float = 2.0,
    post_roll: float = 2.0,
    max_segment_frames: int = 300,
    max_job_frames: int = 3000,
    output_quality: int = 85,
    scale_width: int | None = None,
    scale_height: int | None = None,
    max_input_bytes: int = 32 * 1024 * 1024 * 1024,
) -> MotionSummary:
    """Scan sequentially, then write frames only inside padded motion windows."""
    if not 0 < motion_pixel_ratio <= 1:
        raise ValueError("motion_pixel_ratio must be greater than 0 and at most 1")
    if min(max_gap_seconds, pre_roll, post_roll) < 0:
        raise ValueError("time values must not be negative")
    if warmup_frames < 0 or max_segment_frames <= 0 or max_job_frames <= 0:
        raise ValueError("warmup_frames must be non-negative and frame caps positive")
    video_path = Path(input_path).expanduser().resolve()
    _validate_input(video_path, max_input_bytes)
    capture = open_capture(video_path)
    if not capture.isOpened():
        capture.release()
        raise VideoExtractionError(f"Unable to read video headers: {video_path}")
    fps = capture.get(cv2.CAP_PROP_FPS)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    codec_fourcc = _codec_name(capture)
    decoder_backend = capture.getBackendName()
    if not np.isfinite(fps) or fps <= 0:
        capture.release()
        raise VideoExtractionError(f"Video has an invalid frame rate: {video_path}")

    subtractor = cv2.createBackgroundSubtractorMOG2(
        history=300, varThreshold=24, detectShadows=False
    )
    gate = TemporalQualityGate(fps)
    clock = FrameClock(fps)
    frame_states: list[str] = []
    moving: list[int] = []
    frame_index = 0
    last_timestamp = 0.0
    try:
        while True:
            success, frame = capture.read()
            if not success:
                # DVR H.265 streams can contain isolated damaged access units. Keep
                # scanning when the backend can advance; stop only at end-of-stream.
                next_position = capture.get(cv2.CAP_PROP_POS_FRAMES)
                if np.isfinite(next_position) and next_position > frame_index:
                    frame_index = int(next_position)
                    continue
                break
            timestamp = max(last_timestamp, _timestamp_seconds(capture, frame_index, fps))
            last_timestamp = timestamp
            clock.record(frame_index, timestamp)
            stats, grey = _frame_stats(frame)
            state, learn, count_motion = gate.observe(frame_index, stats, grey, fps)
            if state == "ir_switch":
                # Day/night switch: the learned background is now wrong; start over.
                subtractor = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=24, detectShadows=False)
            mask = subtractor.apply(frame) if learn else subtractor.apply(frame, learningRate=0)
            while len(frame_states) < frame_index:
                frame_states.append("clear")
            frame_states.append(state)
            if count_motion and frame_index >= warmup_frames and cv2.countNonZero(mask) / mask.size >= motion_pixel_ratio:
                moving.append(frame_index)
            frame_index += 1
    except (cv2.error, MemoryError, OSError) as error:
        raise VideoExtractionError(f"Failed while decoding {video_path}: {error}") from error
    finally:
        capture.release()
    gate.finish(fps)
    # Quality events were timed by index inside the gate; report them on the container clock like everything else.
    gate.events = [
        QualityEvent(event.kind, round(clock.at(event.frame_start), 3), round(clock.at(event.frame_end), 3), event.frame_start, event.frame_end)
        for event in gate.events
    ]
    # Spike frames are labelled only once the gate knows whether they snapped back.
    for index, state in gate.states.items():
        if index < len(frame_states):
            frame_states[index] = state
    quality_counts = {state: 0 for state in QUALITY_STATES}
    for state in frame_states:
        quality_counts[state] = quality_counts.get(state, 0) + 1

    if frame_index == 0:
        raise VideoExtractionError(f"No decodable frames found in video: {video_path}")
    frame_count = frame_count if frame_count > 0 else frame_index
    raw_segments: list[tuple[int, int]] = []
    if moving:
        start = previous = moving[0]
        for index in moving[1:]:
            if index / fps - previous / fps > max_gap_seconds:
                raw_segments.append((start, previous))
                start = index
            previous = index
        raw_segments.append((start, previous))

    windows = _merge_windows(
        [
            (start - round(pre_roll * fps), end + round(post_roll * fps))
            for start, end in raw_segments
        ],
        frame_count,
    )
    segments = [MotionSegment(round(clock.at(start), 3), round(clock.at(end), 3)) for start, end in windows]
    artifacts_dir = Path(output_dir).expanduser().resolve() if output_dir else None
    job_frames = 0
    truncated = False
    frames_skipped = 0
    if artifacts_dir and windows:
        capture = open_capture(video_path)
        reader = SequentialFrames(capture, fps)
        try:
            for segment, (start, end) in zip(segments, windows):
                remaining_budget = max_job_frames - job_frames
                frame_indices = _sample_frame_indices(
                    start, end, min(max_segment_frames, remaining_budget)
                )
                if len(frame_indices) < end - start + 1:
                    segment.frames_truncated = True
                    truncated = True
                for index in frame_indices:
                    item = reader.take_at(clock.at(index))
                    if item is None:
                        segment.frames_truncated = True
                        if reader.exhausted:
                            truncated = True
                            break
                        continue
                    frame_seconds, decoded_frame = item
                    digest, file_path, visual_quality, visual_quality_reason, quality_state, sharpness_score = _write_frame(
                        decoded_frame, artifacts_dir, output_quality, scale_width, scale_height,
                        gate.states.get(index),
                    )
                    segment.frames.append(
                        FrameArtifact(index, round(frame_seconds, 3), digest, file_path, visual_quality, visual_quality_reason, quality_state, sharpness_score)
                    )
                    job_frames += 1
                if job_frames >= max_job_frames:
                    break
            frames_skipped = reader.failures
        except (cv2.error, MemoryError, OSError) as error:
            raise VideoExtractionError(
                f"Failed while writing frame artifacts: {error}"
            ) from error
        finally:
            capture.release()

    return MotionSummary(
        total_duration=round(last_timestamp + 1 / fps, 3),
        motion_segments=segments,
        total_frames_parsed=frame_index,
        extraction_truncated=truncated,
        source_filename=video_path.name,
        codec_fourcc=codec_fourcc,
        decoder_backend=decoder_backend,
        frame_width=frame_width,
        frame_height=frame_height,
        frames_per_second=round(float(fps), 6),
        quality_events=gate.events,
        quality_counts=quality_counts,
        frames_skipped=frames_skipped,
    )


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_path")
    parser.add_argument("--output-dir")
    parser.add_argument("--motion-pixel-ratio", type=float, default=0.003)
    parser.add_argument("--max-gap-seconds", type=float, default=1.0)
    parser.add_argument("--warmup-frames", type=int, default=30)
    parser.add_argument("--pre-roll", type=float, default=2.0)
    parser.add_argument("--post-roll", type=float, default=2.0)
    parser.add_argument("--max-segment-frames", type=int, default=300)
    parser.add_argument("--max-job-frames", type=int, default=3000)
    parser.add_argument("--output-quality", type=int, default=85)
    parser.add_argument("--scale-width", type=int)
    parser.add_argument("--scale-height", type=int)
    parser.add_argument("--max-input-bytes", type=int, default=32 * 1024 * 1024 * 1024)
    return parser.parse_args()


def main() -> int:
    arguments = _parse_arguments()
    try:
        summary = extract_motion_summary(**vars(arguments))
    except (ValueError, VideoExtractionError) as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 1
    print(summary.to_json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
