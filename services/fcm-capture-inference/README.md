# FCM Capture Recognition Worker

Dedicated RunPod Serverless endpoint package for recognition assistance.

## Contract

Input action: `capture_recognition`

- `source_frame_hash` is mandatory.
- `image_base64` is the original frame or bounded crop source.
- `crop` is optional source-frame geometry.
- `tasks`: `alpr`, `face_embedding`, `vehicle_attributes`, `animal_detection`.
- `enhancement_profile`: `deterministic_capture_v1`.

The worker returns source/enhanced hashes and independent task states. The current image is intentionally deterministic and non-generative. Model heads return explicit `unavailable` states until staged and validated; no result becomes identity or plate truth.

## Model staging

Mount the same approved model asset set used by `services/fcm-inference` at `/app/models` for YuNet/SFace face capture, OpenVINO vehicle attributes, and person detection. Animal detection remains unavailable until an approved animal model is staged and benchmarked; the endpoint reports that state in `ping` and capture responses.

## Deployment

Build this directory as a separate RunPod Serverless worker and configure its endpoint URL as `RUNPOD_CAPTURE_API_URL` and its endpoint key as `RUNPOD_CAPTURE_API_KEY` in the vision runtime environment. Keep it separate from the general detection endpoint.
