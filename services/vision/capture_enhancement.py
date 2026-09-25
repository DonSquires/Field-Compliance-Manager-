"""Deterministic, non-generative recognition-capture enhancement.

This module improves a crop for ALPR/face capture only. It never replaces the
source frame and never claims that enhancement created new evidential detail.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, asdict
from typing import Sequence

import cv2
import numpy as np


PROFILE_NAME = "deterministic_capture_v1"
FUSION_PROFILE_NAME = "aligned_temporal_median_v1"


@dataclass(frozen=True)
class EnhancementReceipt:
    profile: str
    operations: tuple[str, ...]
    generative: bool
    source_sha256: str
    enhanced_sha256: str
    source_width: int
    source_height: int
    output_width: int
    output_height: int

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class FusionReceipt:
    profile: str
    frames_supplied: int
    frames_considered: int
    frames_aligned: int
    reference_index: int
    quality_scores: tuple[float, ...]
    alignment_correlations: tuple[float, ...]
    rejected_indices: tuple[int, ...]
    output_sha256: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _sha256(image: np.ndarray) -> str:
    return hashlib.sha256(image.tobytes()).hexdigest()


def capture_quality(image: np.ndarray) -> float:
    """Sharp, well-exposed, information-rich frames rank ahead; clipped/flat frames fall behind."""
    if not isinstance(image, np.ndarray) or image.size == 0:
        return 0.0
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = np.asarray(gray, dtype=np.uint8)
    sharpness = min(float(cv2.Laplacian(gray, cv2.CV_32F).var()) / 900.0, 1.0)
    p5, p50, p95 = np.percentile(gray, (5, 50, 95))
    dynamic_range = min(max(float(p95 - p5), 0.0) / 150.0, 1.0)
    exposure = max(0.0, 1.0 - abs(float(p50) - 120.0) / 120.0)
    clipped = float(np.mean((gray <= 2) | (gray >= 253)))
    return round(max(0.0, 0.5 * sharpness + 0.3 * dynamic_range + 0.2 * exposure - clipped), 6)


def fuse_capture_frames(
    frames: Sequence[np.ndarray],
    *,
    max_frames: int = 12,
    minimum_correlation: float = 0.72,
) -> tuple[np.ndarray, FusionReceipt]:
    """Align the best crops to one reference and take a robust temporal median.

    Median fusion removes sensor noise and transient compression blocks without inventing structures. Frames
    that cannot be aligned are recorded and excluded rather than blurred into the derivative.
    """
    valid = [(index, frame) for index, frame in enumerate(frames) if isinstance(frame, np.ndarray) and frame.size and frame.ndim in (2, 3)]
    if not valid:
        raise ValueError("capture fusion requires at least one non-empty image")
    if max_frames < 1 or max_frames > 32:
        raise ValueError("max_frames must be between 1 and 32")
    if not 0.0 <= minimum_correlation <= 1.0:
        raise ValueError("minimum_correlation must be between 0 and 1")

    ranked = sorted(((capture_quality(frame), index, frame) for index, frame in valid), key=lambda item: (-item[0], item[1]))[:max_frames]
    reference_score, reference_index, reference = ranked[0]
    if reference.ndim == 2:
        reference = cv2.cvtColor(reference, cv2.COLOR_GRAY2BGR)
    height, width = reference.shape[:2]
    reference_gray = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    aligned = [reference.astype(np.float32)]
    correlations = [1.0]
    rejected: list[int] = []
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5)

    for _, index, source in ranked[1:]:
        working = cv2.cvtColor(source, cv2.COLOR_GRAY2BGR) if source.ndim == 2 else source
        if working.shape[:2] != (height, width):
            working = cv2.resize(working, (width, height), interpolation=cv2.INTER_AREA if working.shape[0] > height else cv2.INTER_CUBIC)
        candidate_gray = cv2.cvtColor(working, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        warp = np.eye(2, 3, dtype=np.float32)
        try:
            correlation, warp = cv2.findTransformECC(reference_gray, candidate_gray, warp, cv2.MOTION_AFFINE, criteria, None, 3)
            if not np.isfinite(correlation) or correlation < minimum_correlation:
                rejected.append(index)
                continue
            registered = cv2.warpAffine(working, warp, (width, height), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT)
            aligned.append(registered.astype(np.float32))
            correlations.append(round(float(correlation), 6))
        except cv2.error:
            rejected.append(index)

    fused = np.clip(np.median(np.stack(aligned, axis=0), axis=0), 0, 255).astype(np.uint8)
    receipt = FusionReceipt(
        profile=FUSION_PROFILE_NAME,
        frames_supplied=len(frames),
        frames_considered=len(ranked),
        frames_aligned=len(aligned),
        reference_index=reference_index,
        quality_scores=tuple(round(float(score), 6) for score, _, _ in ranked),
        alignment_correlations=tuple(correlations),
        rejected_indices=tuple(sorted(rejected)),
        output_sha256=_sha256(fused),
    )
    return fused, receipt


def enhance_capture(crop: np.ndarray, *, scale: int = 3) -> tuple[np.ndarray, EnhancementReceipt]:
    if not isinstance(crop, np.ndarray) or crop.size == 0:
        raise ValueError("capture crop must be a non-empty image")
    if crop.ndim not in (2, 3):
        raise ValueError("capture crop must be grayscale or BGR")
    if scale not in (2, 3, 4):
        raise ValueError("capture scale must be 2, 3, or 4")

    source_height, source_width = crop.shape[:2]
    operations = ["crop", f"resize_{scale}x", "clahe_luminance", "bilateral_denoise", "unsharp_mask"]
    source = crop.copy()
    if crop.ndim == 2:
        working = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
    else:
        working = crop.copy()

    upscaled = cv2.resize(working, (source_width * scale, source_height * scale), interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(upscaled, cv2.COLOR_BGR2LAB)
    lightness, green_red, blue_yellow = cv2.split(lab)
    lightness = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(lightness)
    equalized = cv2.cvtColor(cv2.merge((lightness, green_red, blue_yellow)), cv2.COLOR_LAB2BGR)
    denoised = cv2.bilateralFilter(equalized, d=5, sigmaColor=35, sigmaSpace=35)
    blurred = cv2.GaussianBlur(denoised, (0, 0), 1.1)
    enhanced = cv2.addWeighted(denoised, 1.35, blurred, -0.35, 0)
    enhanced = np.clip(enhanced, 0, 255).astype(np.uint8)

    receipt = EnhancementReceipt(
        profile=PROFILE_NAME,
        operations=tuple(operations),
        generative=False,
        source_sha256=_sha256(source),
        enhanced_sha256=_sha256(enhanced),
        source_width=source_width,
        source_height=source_height,
        output_width=enhanced.shape[1],
        output_height=enhanced.shape[0],
    )
    return enhanced, receipt
