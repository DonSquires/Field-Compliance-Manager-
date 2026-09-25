# CCTV Capture Recognition Endpoint (schema v2)

## Purpose

The capture endpoint is the recognition-derivative lane. The vision watcher first quality-ranks and aligns
up to 12 source crops, then sends the fused crop to the laptop GPU. Real-ESRGAN produces a 4× interpretive
derivative; RunPod is the final GPU fallback; deterministic enhancement is the availability fallback.
That final fallback remains the receipted `deterministic_capture_v1` profile and is labelled non-generative.

It does not replace the original frame, create identity truth, confirm a plate, or make an enforcement decision.

## Request

```json
{
  "schema_version": 2,
  "source_evidence_id": "uuid",
  "source_job_id": "uuid",
  "source_frame_hash": "sha256",
  "relative_timestamp_seconds": 42.5,
  "crop": {"x": 100, "y": 220, "width": 320, "height": 180},
  "tasks": ["alpr", "face_embedding", "vehicle_attributes", "animal_detection"],
  "enhancement_profile": "realesrgan_x4plus_onnx_v1"
}
```

## Response

```json
{
  "schema_version": 2,
  "source_frame_hash": "sha256",
  "enhanced_crop_hash": "sha256",
  "enhancement": {
    "profile": "realesrgan_x4plus_onnx_v1",
    "model": "RealESRGAN_x4plus",
    "model_sha256": "0a06c68f463a14bf5563b78d77d61ba4394024e148383c4308d6d3783eac2dc5",
    "execution_provider": "CUDAExecutionProvider",
    "operations": ["realesrgan_4x"],
    "generative": true
  },
  "enhanced_image_base64": "...ephemeral response only; upload to private Storage...",
  "recognition": {
    "source": {"alpr": {}, "faces": [], "animals": []},
    "enhanced": {"alpr": {}, "faces": [], "animals": []},
    "decision_rule": "human_review_of_source_and_enhanced_candidates"
  },
  "authority": "provisional"
}
```

## Rules

- The source frame hash is mandatory.
- Enhanced crops are recognition aids, not original evidence.
- Every result is provisional and review-required.
- Face matching may suggest candidates but cannot assign identity.
- ALPR may suggest text but cannot confirm a plate.
- Laptop GPU is primary; RunPod is fallback, never the default route.
- Temporal alignment/fusion is deterministic and fully receipted.
- Real-ESRGAN output is generative and must be labelled interpretive. It cannot establish identity, plate or species truth.
- Source and enhanced recognition answers remain separate; agreement raises confidence but never confirms.
- Store transform profile, model versions, hashes, crop geometry, timestamp, and provider.
- Store original and enhanced JPEGs as separate private objects; never inline them in Postgres.
- If enhancement or a model fails, return an explicit `unavailable` state; do not fabricate a clean result.
- Approved exports may include both original frame and enhanced crop with their separate hashes.
