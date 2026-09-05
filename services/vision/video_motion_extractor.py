#!/usr/bin/env python3
"""Extract timestamped motion segments from a local video file."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

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
class MotionSegment:
    start_time_seconds: float
    end_time_seconds: float


@dataclass(frozen=True)
class MotionSummary:
    total_duration: float
    motion_segments: list[MotionSegment]
    total_frames_parsed: int

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)


def _validate_input(video_path: Path, max_input_bytes: int) -> None:
    if max_input_bytes <= 0:
        raise ValueError("max_input_bytes must be positive")
    if not video_path.is_file():
        raise VideoExtractionError(f"Video file does not exist: {video_path}")
    if video_path.stat().st_size == 0:
        raise VideoExtractionError(f"Video file is empty: {video_path}")
    if video_path.stat().st_size > max_input_bytes:
        raise VideoExtractionError(
            f"Video exceeds configured input limit of {max_input_bytes} bytes"
        )


def _timestamp_seconds(capture: cv2.VideoCapture, frame_index: int, fps: float) -> float:
    timestamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
    if timestamp >= 0:
        return timestamp
    return frame_index / fps


def extract_motion_summary(
    input_path: str | os.PathLike[str],
    *,
    motion_pixel_ratio: float = 0.003,
    max_gap_seconds: float = 1.0,
    warmup_frames: int = 30,
    max_input_bytes: int = 32 * 1024 * 1024 * 1024,
) -> MotionSummary:
    """Process a video sequentially and return merged motion timestamp ranges."""
    if not 0 < motion_pixel_ratio <= 1:
        raise ValueError("motion_pixel_ratio must be greater than 0 and at most 1")
    if max_gap_seconds < 0 or warmup_frames < 0:
        raise ValueError("max_gap_seconds and warmup_frames must not be negative")

    video_path = Path(input_path).expanduser().resolve()
    _validate_input(video_path, max_input_bytes)
    capture = cv2.VideoCapture(str(video_path))

    if not capture.isOpened():
        capture.release()
        raise VideoExtractionError(f"Unable to read video headers: {video_path}")

    fps = capture.get(cv2.CAP_PROP_FPS)
    if not np.isfinite(fps) or fps <= 0:
        capture.release()
        raise VideoExtractionError(f"Video has an invalid frame rate: {video_path}")

    subtractor = cv2.createBackgroundSubtractorMOG2(
        history=300, varThreshold=24, detectShadows=False
    )
    segments: list[MotionSegment] = []
    segment_start: float | None = None
    segment_end: float | None = None
    frame_index = 0
    last_timestamp = 0.0

    try:
        while True:
            success, frame = capture.read()
            if not success:
                break

            timestamp = max(last_timestamp, _timestamp_seconds(capture, frame_index, fps))
            last_timestamp = timestamp
            foreground_mask = subtractor.apply(frame)
            moving_pixels = cv2.countNonZero(foreground_mask)
            is_moving = (
                frame_index >= warmup_frames
                and moving_pixels / foreground_mask.size >= motion_pixel_ratio
            )

            if is_moving:
                if segment_start is None:
                    segment_start = timestamp
                segment_end = timestamp
            elif segment_start is not None and timestamp - segment_end > max_gap_seconds:
                segments.append(MotionSegment(segment_start, segment_end))
                segment_start = None
                segment_end = None

            frame_index += 1
    except (cv2.error, MemoryError, OSError) as error:
        raise VideoExtractionError(f"Failed while decoding {video_path}: {error}") from error
    finally:
        capture.release()

    if frame_index == 0:
        raise VideoExtractionError(f"No decodable frames found in video: {video_path}")
    if segment_start is not None and segment_end is not None:
        segments.append(MotionSegment(segment_start, segment_end))

    return MotionSummary(
        total_duration=round(last_timestamp + (1 / fps), 3),
        motion_segments=segments,
        total_frames_parsed=frame_index,
    )


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_path", help="Path to an MP4, AVI, or other OpenCV-supported video")
    parser.add_argument("--motion-pixel-ratio", type=float, default=0.003)
    parser.add_argument("--max-gap-seconds", type=float, default=1.0)
    parser.add_argument("--warmup-frames", type=int, default=30)
    parser.add_argument("--max-input-bytes", type=int, default=32 * 1024 * 1024 * 1024)
    return parser.parse_args()


def main() -> int:
    arguments = _parse_arguments()
    try:
        summary = extract_motion_summary(
            arguments.input_path,
            motion_pixel_ratio=arguments.motion_pixel_ratio,
            max_gap_seconds=arguments.max_gap_seconds,
            warmup_frames=arguments.warmup_frames,
            max_input_bytes=arguments.max_input_bytes,
        )
    except (ValueError, VideoExtractionError) as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 1

    print(summary.to_json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())