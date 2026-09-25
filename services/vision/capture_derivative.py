#!/usr/bin/env python3
"""Build one recognition derivative from the best source-frame crops.

The original crop and enhanced derivative are separate artifacts. Fusion/enhancement are deterministic;
recognition remains a later provisional step. JSON goes to stdout so the Node watcher can persist receipts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from capture_enhancement import enhance_capture, fuse_capture_frames


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 256), b''):
            digest.update(chunk)
    return digest.hexdigest()


def crop_frame(image: np.ndarray, bbox: dict[str, Any] | None, padding: float = 0.12) -> np.ndarray:
    if image is None or image.size == 0:
        raise ValueError('source frame is empty')
    height, width = image.shape[:2]
    if not bbox:
        return image.copy()
    x = float(bbox.get('x', 0)); y = float(bbox.get('y', 0))
    box_width = max(1.0, float(bbox.get('width', width))); box_height = max(1.0, float(bbox.get('height', height)))
    pad_x = box_width * padding; pad_y = box_height * padding
    left = max(0, int(np.floor(x - pad_x))); top = max(0, int(np.floor(y - pad_y)))
    right = min(width, int(np.ceil(x + box_width + pad_x))); bottom = min(height, int(np.ceil(y + box_height + pad_y)))
    if right <= left or bottom <= top:
        raise ValueError('capture crop is outside the source frame')
    return image[top:bottom, left:right].copy()


def build_derivative(manifest: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    entries = manifest.get('frames') or []
    if not isinstance(entries, list) or not entries:
        raise ValueError('capture manifest requires frames')
    crops: list[np.ndarray] = []
    usable_entries: list[dict[str, Any]] = []
    for entry in entries[:32]:
        source_path = Path(str(entry.get('path') or '')).resolve()
        image = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
        if image is None:
            continue
        try:
            crops.append(crop_frame(image, entry.get('bbox')))
            usable_entries.append(entry)
        except (ValueError, cv2.error):
            continue
    if not crops:
        raise ValueError('no capture frames could be decoded and cropped')

    fused, fusion_receipt = fuse_capture_frames(crops, max_frames=min(12, len(crops)))
    original = crops[fusion_receipt.reference_index]
    enhanced, enhancement_receipt = enhance_capture(fused, scale=int(manifest.get('scale') or 3))
    output_dir.mkdir(parents=True, exist_ok=True)
    original_path = output_dir / 'original.jpg'
    fused_path = output_dir / 'fused.jpg'
    enhanced_path = output_dir / 'enhanced.jpg'
    if not cv2.imwrite(str(original_path), original, [cv2.IMWRITE_JPEG_QUALITY, 95]):
        raise RuntimeError('failed to encode original crop')
    if not cv2.imwrite(str(fused_path), fused, [cv2.IMWRITE_JPEG_QUALITY, 95]):
        raise RuntimeError('failed to encode fused crop')
    if not cv2.imwrite(str(enhanced_path), enhanced, [cv2.IMWRITE_JPEG_QUALITY, 95]):
        raise RuntimeError('failed to encode enhanced derivative')

    reference = usable_entries[fusion_receipt.reference_index]
    return {
        'schema_version': 1,
        'event_id': manifest.get('event_id'),
        'entity_kind': manifest.get('entity_kind'),
        'authority': 'provisional',
        'review_required': True,
        'source_frame_hash': reference.get('sha256'),
        'source_frame_index': reference.get('frame_index'),
        'source_timestamp_seconds': reference.get('timestamp_seconds'),
        'source_bbox': reference.get('bbox'),
        'source_frames': [entry.get('sha256') for entry in usable_entries if entry.get('sha256')],
        'fusion': fusion_receipt.to_dict(),
        'enhancement': enhancement_receipt.to_dict(),
        'original_artifact': {
            'file': str(original_path), 'sha256': _file_sha256(original_path), 'bytes': original_path.stat().st_size,
            'width': int(original.shape[1]), 'height': int(original.shape[0]),
        },
        'fused_artifact': {
            'file': str(fused_path), 'sha256': _file_sha256(fused_path), 'bytes': fused_path.stat().st_size,
            'width': int(fused.shape[1]), 'height': int(fused.shape[0]),
        },
        'enhanced_artifact': {
            'file': str(enhanced_path), 'sha256': _file_sha256(enhanced_path), 'bytes': enhanced_path.stat().st_size,
            'width': int(enhanced.shape[1]), 'height': int(enhanced.shape[0]),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output-dir', required=True)
    arguments = parser.parse_args()
    manifest = json.loads(Path(arguments.manifest).read_text(encoding='utf-8'))
    print(json.dumps(build_derivative(manifest, Path(arguments.output_dir)), separators=(',', ':')))


if __name__ == '__main__':
    main()
