#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
from urllib.request import urlopen

script_path = Path(__file__).resolve()
repo_root = script_path.parents[2] if len(script_path.parents) > 2 else Path.cwd()
default_dir = Path('/app/models')
if os.access('/app', os.W_OK):
    resolved_default = default_dir
else:
    resolved_default = repo_root / 'models'
MODELS_DIR = Path(os.getenv('MODELS_DIR', str(resolved_default)))
FILES = {
    'face_detection_yunet_2023mar.onnx': 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    'face_recognition_sface_2021dec.onnx': 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    'person-detection-retail-0013.xml': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/1/person-detection-retail-0013/FP16/person-detection-retail-0013.xml',
    'person-detection-retail-0013.bin': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/1/person-detection-retail-0013/FP16/person-detection-retail-0013.bin',
    'vehicle-attributes-recognition-barrier-0039.xml': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/1/vehicle-attributes-recognition-barrier-0039/FP32/vehicle-attributes-recognition-barrier-0039.xml',
    'vehicle-attributes-recognition-barrier-0039.bin': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/1/vehicle-attributes-recognition-barrier-0039/FP32/vehicle-attributes-recognition-barrier-0039.bin',
}


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(url) as response, destination.open('wb') as handle:
        while True:
            chunk = response.read(1024 * 64)
            if not chunk:
                break
            handle.write(chunk)
    print(f'downloaded {destination.name}')


if __name__ == '__main__':
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    for filename, url in FILES.items():
        destination = MODELS_DIR / filename
        if destination.exists():
            print(f'skipping {filename} (already present)')
            continue
        download_file(url, destination)
