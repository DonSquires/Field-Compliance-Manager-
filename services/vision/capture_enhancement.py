"""Deterministic, non-generative recognition-capture enhancement.

This module improves a crop for ALPR/face capture only. It never replaces the
source frame and never claims that enhancement created new evidential detail.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, asdict

import cv2
import numpy as np


PROFILE_NAME = "deterministic_capture_v1"


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


def _sha256(image: np.ndarray) -> str:
    return hashlib.sha256(image.tobytes()).hexdigest()


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
