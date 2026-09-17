#!/usr/bin/env python3
"""Export SpeciesNet v4.0.2a (always_crop, EfficientNetV2-M, Apache-2.0) from the torch.fx GraphModule
checkpoint to ONNX and prove parity against the PyTorch reference on the mirror's example crops.

Runs in a torch-equipped stage only (Docker export stage or a local venv); the runtime image never needs torch.
Input contract (identical to google/cameratrapai classifier.py): NHWC float32 [N,480,480,3], RGB scaled to
[0,1] after a bilinear (no antialias) resize to 480x480 and a uint8 round-trip. Output: logits [N,2498].
"""
from __future__ import annotations

import json
import pathlib
import platform
import sys
import time

import numpy as np
import torch

if platform.system() != "Windows":  # checkpoint was saved on Windows
    pathlib.WindowsPath = pathlib.PosixPath  # type: ignore[misc]

SRC = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("/tmp/speciesnet")
OUT = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else SRC / "speciesnet_v4.0.2a_always_crop.onnx"
CKPT = SRC / "always_crop_99710272_22x8_v12_epoch_00148.pt"
IMG_SIZE = 480


def preprocess_reference(path: pathlib.Path) -> np.ndarray:
    """Exact reference preprocessing (torchvision) -> HWC float32 in [0,1]."""
    import torchvision.transforms.functional as TF
    from PIL import Image

    image = Image.open(path).convert("RGB")
    tensor = TF.convert_image_dtype(TF.pil_to_tensor(image), torch.float32)
    tensor = TF.resize(tensor, [IMG_SIZE, IMG_SIZE], antialias=False)
    tensor = TF.convert_image_dtype(tensor, torch.uint8)
    return (tensor.permute(1, 2, 0).numpy().astype(np.float32) / 255.0)


def preprocess_runtime(path: pathlib.Path) -> np.ndarray:
    """What the inference service will do with OpenCV (BGR uint8 -> RGB -> bilinear resize -> [0,1])."""
    import cv2

    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (IMG_SIZE, IMG_SIZE), interpolation=cv2.INTER_LINEAR)
    return resized.astype(np.float32) / 255.0


def main() -> None:
    model = torch.load(CKPT, map_location="cpu", weights_only=False)
    model.eval()
    dummy = torch.zeros(1, IMG_SIZE, IMG_SIZE, 3, dtype=torch.float32)
    with torch.no_grad():
        logits = model(dummy)
    assert tuple(logits.shape) == (1, 2498), logits.shape
    torch.onnx.export(
        model, (dummy,), str(OUT), input_names=["images_nhwc"], output_names=["logits"],
        dynamic_axes={"images_nhwc": {0: "batch"}, "logits": {0: "batch"}}, opset_version=17, dynamo=False,
    )
    import onnx

    proto = onnx.load(str(OUT))
    onnx.checker.check_model(proto)
    print(f"exported {OUT.name} ({OUT.stat().st_size / 1e6:.1f} MB), opset {proto.opset_import[0].version}")

    import onnxruntime as ort

    session = ort.InferenceSession(str(OUT), providers=["CPUExecutionProvider"])
    labels = [line.strip() for line in (SRC / "always_crop_99710272_22x8_v12_epoch_00148.labels.20251208.txt").read_text(encoding="utf-8").splitlines() if line.strip()]
    examples = sorted((SRC / "examples").glob("*.jpg"))
    if len(examples) < 2:
        raise SystemExit(f"parity check needs the reference crops in {SRC / 'examples'}; found {len(examples)}")
    report = []
    for example in examples:
        ref = preprocess_reference(example)
        with torch.no_grad():
            ref_probs = torch.softmax(model(torch.from_numpy(ref).unsqueeze(0)), dim=1).numpy()[0]
        start = time.perf_counter()
        onnx_logits = session.run(["logits"], {"images_nhwc": ref[None]})[0][0]
        elapsed = time.perf_counter() - start
        onnx_probs = np.exp(onnx_logits - onnx_logits.max()); onnx_probs /= onnx_probs.sum()
        rt_logits = session.run(["logits"], {"images_nhwc": preprocess_runtime(example)[None]})[0][0]
        rt_probs = np.exp(rt_logits - rt_logits.max()); rt_probs /= rt_probs.sum()
        top_ref, top_onnx, top_rt = int(ref_probs.argmax()), int(onnx_probs.argmax()), int(rt_probs.argmax())
        report.append({
            "example": example.name, "onnx_ms": round(elapsed * 1000),
            "ref_top": labels[top_ref].split(";")[-1], "ref_score": round(float(ref_probs[top_ref]), 4),
            "onnx_top": labels[top_onnx].split(";")[-1], "onnx_score": round(float(onnx_probs[top_onnx]), 4),
            "max_abs_prob_diff_torch_vs_onnx": float(np.abs(ref_probs - onnx_probs).max()),
            "cv2_top": labels[top_rt].split(";")[-1], "cv2_score": round(float(rt_probs[top_rt]), 4),
            "max_abs_prob_diff_torchvision_vs_cv2": float(np.abs(ref_probs - rt_probs).max()),
        })
        print(json.dumps(report[-1]))
    assert all(item["ref_top"] == item["onnx_top"] for item in report), "ONNX top-1 diverged from torch"
    assert all(item["max_abs_prob_diff_torch_vs_onnx"] < 1e-3 for item in report), "ONNX probabilities diverged"
    (OUT.with_suffix(".parity.json")).write_text(json.dumps({"source": CKPT.name, "opset": proto.opset_import[0].version, "report": report}, indent=1))


if __name__ == "__main__":
    main()
