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
    'person-reidentification-retail-0288.xml': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2022.3/models_bin/1/person-reidentification-retail-0288/FP16/person-reidentification-retail-0288.xml',
    'person-reidentification-retail-0288.bin': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2022.3/models_bin/1/person-reidentification-retail-0288/FP16/person-reidentification-retail-0288.bin',
    'vehicle-attributes-recognition-barrier-0039.xml': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/1/vehicle-attributes-recognition-barrier-0039/FP32/vehicle-attributes-recognition-barrier-0039.xml',
    'vehicle-attributes-recognition-barrier-0039.bin': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/1/vehicle-attributes-recognition-barrier-0039/FP32/vehicle-attributes-recognition-barrier-0039.bin',
}
# Optional tiers (WITH_DETECTOR=1 / STAGE_OPTIONAL_MODELS=1). A failed optional download is reported, not fatal.
#  - MegaDetector v5a: person / vehicle / animal triage trained on camera-trap and trail-camera footage
#    (MIT, https://github.com/agentmorris/MegaDetector). Needs requirements-detector.txt (ultralytics + torch).
#  - vehicle-detection-0200: CPU OpenVINO vehicle detector (vehicles only) used when MegaDetector is absent.
#  - Open Model Zoo has no vehicle re-identification model; the service uses a deterministic 256-d appearance
#    descriptor unless VEHICLE_REID_MODEL_PATH points at an IR with a 256-d output.
#  - SpeciesNet weights are distributed through Kaggle and cannot be fetched anonymously; install the
#    `speciesnet` package (requirements-detector.txt) and set SPECIES_PROVIDER=speciesnet to use them.
OPTIONAL_FILES = {
    'md_v5a.0.0.pt': 'https://github.com/agentmorris/MegaDetector/releases/download/v5.0/md_v5a.0.0.pt',
}
# Always staged: small, CPU-only, verified against the model.yml of Open Model Zoo 2021.4.
FILES.update({
    'vehicle-detection-0200.xml': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/3/vehicle-detection-0200/FP16/vehicle-detection-0200.xml',
    'vehicle-detection-0200.bin': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/3/vehicle-detection-0200/FP16/vehicle-detection-0200.bin',
})


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
    if os.getenv('WITH_DETECTOR') == '1' or os.getenv('STAGE_OPTIONAL_MODELS') == '1':
        for filename, url in OPTIONAL_FILES.items():
            destination = MODELS_DIR / filename
            if destination.exists():
                print(f'skipping {filename} (already present)')
                continue
            try:
                download_file(url, destination)
            except Exception as error:  # optional tier: report and continue; the service says not_staged
                destination.unlink(missing_ok=True)
                print(f'optional model {filename} not staged: {error}')
