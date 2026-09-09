# CCTV Capture Recognition Endpoint

## Purpose

The capture endpoint is a second inference lane for recognition assistance. It receives a bounded crop from an original CCTV frame, applies deterministic enhancement, and runs ALPR, face embedding, and optional animal/vehicle recognition models.

It does not replace the original frame, create identity truth, confirm a plate, or make an enforcement decision.

## Request

```json
{
  "schema_version": 1,
  "source_evidence_id": "uuid",
  "source_job_id": "uuid",
  "source_frame_hash": "sha256",
  "relative_timestamp_seconds": 42.5,
  "crop": {"x": 100, "y": 220, "width": 320, "height": 180},
  "tasks": ["alpr", "face_embedding", "vehicle_attributes", "animal_detection"],
  "enhancement_profile": "deterministic_capture_v1"
}
```

## Response

```json
{
  "schema_version": 1,
  "source_frame_hash": "sha256",
  "enhanced_crop_hash": "sha256",
  "enhancement": {
    "profile": "deterministic_capture_v1",
    "operations": ["crop", "resize_3x", "clahe_luminance", "bilateral_denoise", "unsharp_mask"],
    "generative": false
  },
  "alpr": {"state": "candidate", "text": null, "confidence": 0, "review_required": true},
  "face": {"state": "candidate", "embedding": [], "candidate_matches": [], "review_required": true},
  "vehicle": {"state": "candidate", "attributes": {}, "review_required": true},
  "animals": {"state": "candidate", "detections": [], "review_required": true},
  "authority": "provisional"
}
```

## Rules

- The source frame hash is mandatory.
- Enhanced crops are recognition aids, not original evidence.
- Every result is provisional and review-required.
- Face matching may suggest candidates but cannot assign identity.
- ALPR may suggest text but cannot confirm a plate.
- Enhancement must be deterministic and non-generative by default.
- Store transform profile, model versions, hashes, crop geometry, timestamp, and provider.
- If enhancement or a model fails, return an explicit `unavailable` state; do not fabricate a clean result.
- Approved exports may include both original frame and enhanced crop with their separate hashes.
