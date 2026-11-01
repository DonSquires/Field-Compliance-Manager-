#!/usr/bin/env python3
from __future__ import annotations

import os
import hashlib
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
    'vehicle-reid-0001.onnx': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/public/2022.1/vehicle-reid-0001/osnet_ain_x1_0_vehicle_reid.onnx',
}
# Entity detector and ALPR tier (always staged; every weight below is Apache-2.0 or MIT and runs on onnxruntime).
#  - RF-DETR COCO exports from open-image-models: large-704 for GPU workers, small-512 for CPU hosts. Both are
#    baked so one image serves both tiers; detector.py picks by execution provider (DETECTOR_MODEL overrides).
#  - yolo-v9-s-608 licence-plate detector and the cct-s-v2-global plate OCR (+ its config) from fast-plate-ocr.
#  - vehicle-detection-0200: OpenVINO CPU vehicle detector kept as the last-resort fallback when no RF-DETR
#    export is present in MODELS_DIR (for example an old models volume).
#  - SpeciesNet v4.0.2a (Google, Apache-2.0): labels, taxonomy and geofence files come from the Addax Data
#    Science mirror on Hugging Face (pinned revision; the Kaggle original needs an account). The classifier
#    itself is exported to ONNX by export_speciesnet_onnx.py in the Dockerfile's export stage and copied into
#    MODELS_DIR as speciesnet_v4.0.2a_always_crop.onnx; on a host, copy it out of a built image.
SPECIESNET_MIRROR = os.getenv('SPECIESNET_MIRROR', 'https://huggingface.co/Addax-Data-Science/SPECIESNET-v4-0-2-A/resolve/c56465f3efdee012fcfb99e0e84867aed5fafcb7')
SPECIESNET_FILES = {
    'always_crop_99710272_22x8_v12_epoch_00148.labels.20251208.txt': f'{SPECIESNET_MIRROR}/always_crop_99710272_22x8_v12_epoch_00148.labels.20251208.txt',
    'taxonomy_release.20251208.txt': f'{SPECIESNET_MIRROR}/taxonomy_release.20251208.txt',
    'geofence_release.20251208.json': f'{SPECIESNET_MIRROR}/geofence_release.20251208.json',
}
SPECIESNET_CHECKPOINT = ('always_crop_99710272_22x8_v12_epoch_00148.pt', f'{SPECIESNET_MIRROR}/always_crop_99710272_22x8_v12_epoch_00148.pt')
# Reference camera-trap crops (LILA BC, CDLA-Permissive) used by export_speciesnet_onnx.py's parity check.
SPECIESNET_EXAMPLES = {f'examples/{index}.jpg': f'{SPECIESNET_MIRROR}/examples/{index}.jpg' for index in (1, 2, 3, 4)}
RF_DETR_MODELS = tuple(name.strip() for name in os.getenv('RF_DETR_MODELS', 'rf-detr-large-704-coco,rf-detr-small-512-coco').split(',') if name.strip())
FILES.update({
    f'{name}.onnx': f'https://github.com/ankandrew/open-image-models/releases/download/assets/{name}.onnx' for name in RF_DETR_MODELS
})
FILES.update({
    'yolo-v9-s-608-license-plates-end2end.onnx': 'https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-s-608-license-plates-end2end.onnx',
    'cct_s_v2_global.onnx': 'https://github.com/ankandrew/cnn-ocr-lp/releases/download/arg-plates/cct_s_v2_global.onnx',
    'cct_s_v2_global_plate_config.yaml': 'https://github.com/ankandrew/cnn-ocr-lp/releases/download/arg-plates/cct_s_v2_global_plate_config.yaml',
    'vehicle-detection-0200.xml': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/3/vehicle-detection-0200/FP16/vehicle-detection-0200.xml',
    'vehicle-detection-0200.bin': 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2021.4/models_bin/3/vehicle-detection-0200/FP16/vehicle-detection-0200.bin',
    # Real-ESRGAN upstream is BSD-3-Clause. This pinned ONNX conversion is packaged by the MIT-licensed
    # mimageviewer repository at a fixed commit; checksum verification below makes the artifact immutable.
    'realesrgan_x4plus.onnx': 'https://media.githubusercontent.com/media/MikageSawatari/mimageviewer/8d95fffe5571e72924c2922a7cb06485fbe210c7/models/realesrgan_x4plus.onnx',
})
FILES.update(SPECIESNET_FILES)
# Anything under this size is an error page, not a model.
MIN_BYTES = {'.onnx': 100_000, '.bin': 10_000, '.xml': 1_000, '.yaml': 200, '.txt': 100_000, '.json': 1_000_000, '.pt': 100_000_000, '.jpg': 20_000}
OPTIONAL_FILES: dict[str, str] = {}
EXPECTED_SHA256 = {
    'realesrgan_x4plus.onnx': '0a06c68f463a14bf5563b78d77d61ba4394024e148383c4308d6d3783eac2dc5',
}
EXPECTED_SHA384 = {
    'vehicle-reid-0001.onnx': '0515ce72f653c39780d5b87dfed7255d396dd2b1e8b6e91fbaacdfad1da189166343157273c02f3b0fede3050ef7abb7',
}


def has_expected_checksum(path: Path, filename: str) -> bool:
    if filename in EXPECTED_SHA256:
        return hashlib.sha256(path.read_bytes()).hexdigest() == EXPECTED_SHA256[filename]
    if filename in EXPECTED_SHA384:
        return hashlib.sha384(path.read_bytes()).hexdigest() == EXPECTED_SHA384[filename]
    return True


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + '.part')
    with urlopen(url, timeout=120) as response, partial.open('wb') as handle:
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            handle.write(chunk)
    size = partial.stat().st_size
    if size < MIN_BYTES.get(destination.suffix, 1):
        partial.unlink(missing_ok=True)
        raise RuntimeError(f'{destination.name} downloaded {size} bytes; expected a model file')
    if not has_expected_checksum(partial, destination.name):
        partial.unlink(missing_ok=True)
        raise RuntimeError(f'{destination.name} checksum mismatch')
    partial.replace(destination)
    print(f'downloaded {destination.name} ({size / 1_000_000:.1f} MB)')


if __name__ == '__main__':
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if os.getenv('SPECIESNET_CHECKPOINT_ONLY') == '1':
        # Export stage: only the PyTorch checkpoint + its sidecar files, into MODELS_DIR.
        targets = dict(SPECIESNET_FILES)
        targets[SPECIESNET_CHECKPOINT[0]] = SPECIESNET_CHECKPOINT[1]
        targets.update(SPECIESNET_EXAMPLES)
    else:
        targets = FILES
    for filename, url in targets.items():
        destination = MODELS_DIR / filename
        if destination.exists() and destination.stat().st_size >= MIN_BYTES.get(destination.suffix, 1) and has_expected_checksum(destination, filename):
            print(f'skipping {filename} (already present)')
            continue
        download_file(url, destination)
    if os.getenv('STAGE_OPTIONAL_MODELS') == '1':
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
