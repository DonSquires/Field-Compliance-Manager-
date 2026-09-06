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


class VideoExtractionError(RuntimeError):
    """Raised when a video cannot be safely processed."""


@dataclass(frozen=True)
class FrameArtifact:
    frame_index: int
    relative_timestamp_seconds: float
    sha256_hash: str
    file_path: str


@dataclass
class MotionSegment:
    start_time_seconds: float
    end_time_seconds: float
    frames: list[FrameArtifact] = field(default_factory=list)
    frames_truncated: bool = False


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

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)


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
    if frame_index == 0 and np.isfinite(timestamp) and timestamp >= 0:
        return timestamp
    # Some backends report 0 or a repeated timestamp for compressed streams.
    return frame_index / fps


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


def _write_frame(
    frame: np.ndarray,
    output_dir: Path,
    quality: int,
    width: int | None,
    height: int | None,
) -> tuple[str, str]:
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
    return digest, str(destination)


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
    capture = cv2.VideoCapture(str(video_path))
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
    moving: list[int] = []
    frame_index = 0
    last_timestamp = 0.0
    try:
        while True:
            success, frame = capture.read()
            if not success:
                break
            timestamp = max(last_timestamp, _timestamp_seconds(capture, frame_index, fps))
            last_timestamp = timestamp
            mask = subtractor.apply(frame)
            if frame_index >= warmup_frames and cv2.countNonZero(mask) / mask.size >= motion_pixel_ratio:
                moving.append(frame_index)
            frame_index += 1
    except (cv2.error, MemoryError, OSError) as error:
        raise VideoExtractionError(f"Failed while decoding {video_path}: {error}") from error
    finally:
        capture.release()

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
    segments = [MotionSegment(start / fps, end / fps) for start, end in windows]
    artifacts_dir = Path(output_dir).expanduser().resolve() if output_dir else None
    job_frames = 0
    truncated = False
    if artifacts_dir and windows:
        capture = cv2.VideoCapture(str(video_path))
        try:
            for segment, (start, end) in zip(segments, windows):
                segment_limit = min(end, start + max_segment_frames - 1)
                if segment_limit < end:
                    segment.frames_truncated = True
                    truncated = True
                capture.set(cv2.CAP_PROP_POS_FRAMES, start)
                for index in range(start, segment_limit + 1):
                    if job_frames >= max_job_frames:
                        segment.frames_truncated = True
                        truncated = True
                        break
                    success, frame = capture.read()
                    if not success:
                        raise VideoExtractionError(f"Unable to decode frame {index}")
                    digest, file_path = _write_frame(
                        frame, artifacts_dir, output_quality, scale_width, scale_height
                    )
                    segment.frames.append(
                        FrameArtifact(index, round(index / fps, 3), digest, file_path)
                    )
                    job_frames += 1
                if job_frames >= max_job_frames:
                    break
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
