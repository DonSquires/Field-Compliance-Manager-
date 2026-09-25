from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import onnxruntime as ort


MODEL_NAME = "RealESRGAN_x4plus"
MODEL_FILE = "realesrgan_x4plus.onnx"
MODEL_SHA256 = "0a06c68f463a14bf5563b78d77d61ba4394024e148383c4308d6d3783eac2dc5"
PROFILE_AI = "realesrgan_x4plus_onnx_v1"
PROFILE_FALLBACK = "deterministic_capture_v1"
MAX_INPUT_EDGE = 512
MAX_OUTPUT_EDGE = 2048

_session: ort.InferenceSession | None = None
_session_error: str | None = None


def _sha256_pixels(image: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(image).tobytes()).hexdigest()


def _model_path(models_dir: Path) -> Path:
    return Path(os.getenv("SUPER_RESOLUTION_MODEL_PATH", models_dir / MODEL_FILE))


def _providers() -> list[str]:
    available = set(ort.get_available_providers())
    preferred = [provider for provider in ("CUDAExecutionProvider", "CPUExecutionProvider") if provider in available]
    return preferred or list(available)


def _load_session(models_dir: Path) -> ort.InferenceSession:
    global _session, _session_error
    if _session is not None:
        return _session
    path = _model_path(models_dir)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != MODEL_SHA256:
        _session_error = f"model checksum mismatch: {digest}"
        raise RuntimeError(_session_error)
    try:
        _session = ort.InferenceSession(str(path), providers=_providers())
        _session_error = None
        return _session
    except Exception as error:
        _session_error = str(error)
        raise


def status(models_dir: Path) -> dict[str, Any]:
    path = _model_path(models_dir)
    return {
        "state": "ready" if path.is_file() and _session_error is None else "not_staged" if not path.is_file() else "error",
        "model": MODEL_NAME,
        "profile": PROFILE_AI,
        "execution_provider": _session.get_providers()[0] if _session is not None else None,
        "error": _session_error,
    }


def _deterministic_fallback(image: np.ndarray, reason: str) -> tuple[np.ndarray, dict[str, Any]]:
    height, width = image.shape[:2]
    scale = min(3.0, MAX_OUTPUT_EDGE / max(height, width))
    output = cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(output, cv2.COLOR_BGR2LAB)
    lightness, channel_a, channel_b = cv2.split(lab)
    lightness = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(lightness)
    output = cv2.cvtColor(cv2.merge((lightness, channel_a, channel_b)), cv2.COLOR_LAB2BGR)
    output = cv2.bilateralFilter(output, 5, 35, 35)
    blurred = cv2.GaussianBlur(output, (0, 0), 1.1)
    output = np.clip(cv2.addWeighted(output, 1.35, blurred, -0.35, 0), 0, 255).astype(np.uint8)
    return output, {
        "profile": PROFILE_FALLBACK,
        "model": None,
        "model_sha256": None,
        "execution_provider": "opencv_cpu",
        "operations": ["bicubic_resize", "clahe_luminance", "bilateral_denoise", "unsharp_mask"],
        "generative": False,
        "fallback_reason": reason,
        "source_sha256": _sha256_pixels(image),
        "enhanced_sha256": _sha256_pixels(output),
        "source_width": width,
        "source_height": height,
        "output_width": output.shape[1],
        "output_height": output.shape[0],
    }


def enhance(image: np.ndarray, models_dir: Path) -> tuple[np.ndarray, dict[str, Any]]:
    if not isinstance(image, np.ndarray) or image.size == 0 or image.ndim != 3:
        raise ValueError("super-resolution input must be a non-empty BGR image")
    source_height, source_width = image.shape[:2]
    scale_down = min(1.0, MAX_INPUT_EDGE / max(source_height, source_width))
    working = image if scale_down == 1.0 else cv2.resize(image, (round(source_width * scale_down), round(source_height * scale_down)), interpolation=cv2.INTER_AREA)
    try:
        session = _load_session(models_dir)
        rgb = cv2.cvtColor(working, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        tensor = np.transpose(rgb, (2, 0, 1))[None, ...]
        output = session.run(None, {session.get_inputs()[0].name: tensor})[0][0]
        output = np.clip(np.transpose(output, (1, 2, 0)), 0.0, 1.0)
        enhanced = cv2.cvtColor(np.round(output * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
        operations = (["bounded_input_resize"] if scale_down < 1.0 else []) + ["realesrgan_4x"]
        if max(enhanced.shape[:2]) > MAX_OUTPUT_EDGE:
            ratio = MAX_OUTPUT_EDGE / max(enhanced.shape[:2])
            enhanced = cv2.resize(enhanced, (round(enhanced.shape[1] * ratio), round(enhanced.shape[0] * ratio)), interpolation=cv2.INTER_AREA)
            operations.append("bounded_output_resize")
        return enhanced, {
            "profile": PROFILE_AI,
            "model": MODEL_NAME,
            "model_sha256": MODEL_SHA256,
            "execution_provider": session.get_providers()[0],
            "operations": operations,
            "generative": True,
            "source_sha256": _sha256_pixels(image),
            "enhanced_sha256": _sha256_pixels(enhanced),
            "source_width": source_width,
            "source_height": source_height,
            "output_width": enhanced.shape[1],
            "output_height": enhanced.shape[0],
        }
    except Exception as error:
        return _deterministic_fallback(image, str(error)[:300])
