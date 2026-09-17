# CCTV Inference Tier — design, evidence standard and operations

_Status: built and deployed to the CPU tier 2026-09-17 (commit after `253628f`); GPU tier image published,
worker verification pending a RunPod account top-up (see §7). Owner instruction: "make our system the best
you can make it … provide that level of inference" (2026-09-16)._

This document is the authority for `services/fcm-inference` (the model service), the RunPod serverless
worker that runs the same code on a GPU, and the parts of `services/vision` that consume its answers.
It replaces the MegaDetector/ultralytics plan that was never staged.

## 1. What the tier is for

One motion frame in, one **advisory** answer out: every person, vehicle and animal in the frame, each with a
box, a confidence, the model that produced it and the execution provider it ran on; a registration reading
anchored on a vehicle when one is legible; face embeddings for the reviewer's portfolio matching; species
where a species model is staged. Nothing here decides identity — `record_cctv_entity_observations` stores
candidates, and a human accepts or rejects them (`review_cctv_entity_observation`).

The evidence posture follows the forensic-image practice the platform is measured against: the ENFSI Best
Practice Manual for Forensic Image and Video Enhancement (BPM-DI-01) and the SWGDE/FISWG guidance it draws
on — enhancement is deterministic and disclosed, the original is never altered, and every derived value
carries its provenance and its uncertainty. In code that means: raw OCR text is returned next to the
normalised plate; every positional correction is listed; the weakest character's confidence is reported,
not just the mean; a plate that was *located* but not *read* still returns its box so the reviewer can zoom
on the original; and `evidence_quality` is `insufficient` whenever the plate crop is smaller than 48 px
wide, however confident the OCR claims to be.

## 2. Models (all permissive licences; no AGPL anywhere in the image)

| Role | Model | Licence | Runtime | Where it runs |
|---|---|---|---|---|
| Entity detector (person / vehicle / animal) | RF-DETR COCO, `rf-detr-large-704-coco` | Apache-2.0 (weights via open-image-models, MIT wrapper) | onnxruntime CUDA | RunPod GPU workers |
| Entity detector, CPU tier | RF-DETR COCO, `rf-detr-small-512-coco` | Apache-2.0 | onnxruntime CPU | VPS `fcm-inference` |
| Plate detector | `yolo-v9-s-608-license-plate-end2end` | MIT | onnxruntime | both |
| Plate OCR | `cct-s-v2-global-model` (fast-plate-ocr; region head includes New Zealand) | MIT | onnxruntime | both |
| Face detect / embed | YuNet 2023mar / SFace 2021dec (opencv_zoo) | Apache-2.0 | OpenCV | both |
| Person re-ID / vehicle colour-type | OpenVINO person-reidentification-retail-0288, vehicle-attributes-recognition-barrier-0039 | Apache-2.0 | OpenVINO CPU | both |
| Vehicle-only fallback | OpenVINO vehicle-detection-0200 | Apache-2.0 | OpenVINO CPU | only when no RF-DETR export is present in `MODELS_DIR` |
| Species (optional) | SpeciesNet, geofenced `NZL` | Apache-2.0, weights via Kaggle (credentialled) | torch | not staged; animals carry the detector's coarse label and say so |

Rejected: Ultralytics YOLO (AGPL-3.0 — incompatible with a closed SaaS), Plate Recognizer / cloud ALPR
(evidence leaves the custodian's control), tesseract on contour heuristics (kept only as the not-staged
fallback; it is what produced the "inaccurate inference" the owner reported).

CPU trial on the real TAPO sample (2304x1296, 16-core Codespace): RF-DETR nano 81 ms, small 145 ms,
medium 195 ms, large 297 ms per full frame; the VPS CPU tier (small-512, 5 passes) is ~0.9–1.2 s per
2304x1296 frame and ~0.4 s per 640x360 snapshot. Large-704 gave the highest confidence on the same frames
(person 0.93–0.96, car 0.96, truck 0.87–0.94) and is the GPU default.

## 3. Detection rules (`services/fcm-inference/detector.py`)

* **Model pick.** `DETECTOR_MODEL=auto` chooses `DETECTOR_MODEL_GPU` (large-704) when a CUDA provider *and*
  an NVIDIA driver are present, otherwise `DETECTOR_MODEL_CPU` (small-512). Any staged RF-DETR export can be
  forced by name or by `DETECTOR_MODEL_PATH`. If the configured model is missing, the largest
  `rf-detr-*-coco.onnx` in `MODELS_DIR` is used; if none, the OpenVINO vehicle-only tier answers with
  `coverage: ["vehicle"]`; if that is missing too, `status: model_not_staged` (never an empty "no
  detections").
* **Provider honesty.** `onnx_providers()` offers CUDA only when `/proc/driver/nvidia/version`,
  `/dev/nvidia*` or `NVIDIA_VISIBLE_DEVICES` proves a driver; `create_session()` retries on CPU if CUDA
  fails to initialise. The bound provider is reported on `/health`, in the RunPod `ping`, and on every
  result (`detector_execution_provider`, `detector_provider = rf_detr:<model>@<provider>`).
* **Far-field tile pass.** Frames at least 1.5x the model input in both dimensions get a 2x2 overlapping
  (15 %) tile pass in the same batch (`passes: 5`). Tile detections must clear 0.45, must not span more than
  half the tile (fragment guard), and are merged only when no same-kind full-frame detection overlaps them
  (IoU ≥ 0.5) or contains them (≥ 70 %). `DETECTOR_TILES=off` disables it for a CPU budget.
* **Class policy.** COCO → kind map; animals limited to `bird, cat, dog, horse, sheep, cow` (giraffe/
  elephant/zebra/bear are what the detector calls a tree trunk — the "giraffe 0.41" false positive in the
  sample). Floors: person 0.35, vehicle 0.35, animal 0.50; per-class `train 0.60, boat 0.50, bicycle 0.40`.
  `plausible_box` drops whole-frame boxes (≥ 85 % area), specks (< 0.1 %) and "people" shorter than 5 % of
  the frame.
* **NMS.** DETR-family models emit no suppression; `suppress_duplicates` (class-aware IoU 0.6) removes the
  edge duplicates seen in the sample (two boxes on one person at x=0).

## 4. Plate reading (`services/fcm-inference/plates.py`)

1. Plate detector on the full frame **and** on each detector vehicle crop (10 % pad; crops narrower than
   480 px are upscaled up to 3x before detection). Boxes are mapped back to frame coordinates; duplicates
   (IoU ≥ 0.5) collapse onto the stronger one and keep their `vehicle_bbox`.
2. Per plate box: crop with 8 %/15 % padding from the **original** frame, upscale to ≥ 192 px wide, OCR two
   variants (raw, CLAHE-equalised) in RGB as the model expects; keep the higher-scoring reading.
3. Gate: `normalize_nz_plate` (AAA123 `standard_modern`, AA1234 `standard_older`, 4–7 mixed
   `personalised`); if that fails, `syntax_correct` tries at most two confusable swaps against the two
   standard layouts (fewest swaps wins) and lists them in `corrections` with a −0.10 score penalty.
4. Score = 0.55·min(char) + 0.25·mean(char) + 0.20·detector, +0.05 standard layout, +0.05 region head says
   New Zealand ≥ 0.5, capped 0.99. Accept ≥ 0.55; `evidence_quality: reviewable` ≥ 0.75 **and** plate width
   ≥ 48 px, else `insufficient`. `review_required` is true unless reviewable.
5. Response keeps the shape the worker and consolidator already read (`plate, confidence, plate_bbox, box,
   results[]`) and adds `plate_status` (`plate_detected | plate_unreadable | no_plate_detected`),
   `rejected[]` (raw text + reason), `located_plates[]`, `alpr_models` (names + bound providers),
   `alpr_provider = yolo_v9_plate_detector+cct_s_v2_global_ocr`.

Sample truth (honest, not flattering): the two TAPO plates in the corpus are 25 px and ~30 px wide at native
resolution; the reader locates them, reads `J44F5` / `CTV81` with weak characters and correctly reports
`plate_unreadable` rather than promoting a guess. A 2304x1296 camera at that range cannot produce a
registration; the console's enhancement/zoom gets the located box.

## 5. Consumers

* RunPod `infer_batch` (`runpod_handler.py`) now returns `alpr` and `face` blocks per frame in addition to
  the triage; `ping` returns the full health payload including providers.
* `services/vision/vision_job_watcher.js` prefers the GPU answer (`runpodResult.alpr/face`), then
  `/infer/detect`'s embedded `alpr` on the VPS, and only then calls `/infer/alpr` — passing the detector's
  `vehicle_bboxes` so the VPS reader is anchored too.
* `services/vision/motion_consolidator.js` writes ALPR provenance onto plated vehicle events and observation
  attributes: `alpr_provider, alpr_models, alpr_evidence_quality, plate_raw_text, plate_corrections,
  plate_char_confidence_min, plate_width_px, detector_provider`.

## 6. Packaging and deployment

* `services/fcm-inference/Dockerfile`: `python:3.12-slim`; `--build-arg GPU=1` installs
  `onnxruntime-gpu[cuda,cudnn]==1.26.0` (last CUDA 12 line; 1.27+ is CUDA 13) as its own layer;
  `GPU=0` installs plain `onnxruntime`. `download_models.py` bakes RF-DETR large+small, the plate pair, the
  OCR pair and the OpenVINO models into `/app/models` with size checks. Images: CPU 773 MB, GPU 2.8 GB.
* Registry: `git.fcmanager.co.nz/iron-eagle-security-ltd/fcm-inference` (CPU) and `fcm-inference-gpu`
  (GPU), tagged `<sha7>` and `latest`; `.gitea/workflows/publish_workload_containers.yml` builds both.
  nginx `/v2/` on the VPS now has `client_max_body_size 0` (the CUDA layer exceeded the old 2 GB cap).
* VPS (`docker-compose.full.yml`): host volume `/opt/fcm/models` **overlays** the baked models, so new
  weights must be staged there (`MODELS_DIR=/opt/fcm/models python3 services/fcm-inference/download_models.py`
  — done 2026-09-16, 330 MB). Env: `DETECTOR_MODEL=rf-detr-small-512-coco`, `DETECTOR_TILES=auto`,
  `INFERENCE_DEVICE=cpu`.
* RunPod: template `bwway2hiwx` → `fcm-inference-gpu@sha256:e798f41f…`, env `DETECTOR_MODEL=rf-detr-large-704-coco`;
  endpoint `katqqnmds1dphs` set to 1 GPU per worker (was 2), GPU types 4090 / RTX 6000 Ada / L40S / A40
  (all CUDA 12), network-volume pin removed (models are in the image), idle 30 s, execution timeout 600 s.

## 7. Open items / honest gaps

* **RunPod balance is negative (−$0.07 at 2026-09-17 00:10 UTC)** — no serverless worker will start until
  the account is topped up; 15 jobs sit `IN_QUEUE`. The CUDA execution path is therefore verified only as
  far as the image's own CPU fallback; first `ping` after top-up must show
  `detector_provider: CUDAExecutionProvider`.
* The Gitea registry vhost hard-codes a `proxy_set_header Authorization "Basic …"` for `/v2/`, which makes
  every anonymous registry request act as one user (that is how RunPod pulls with
  `containerRegistryAuthId: ""`). It should be replaced by a RunPod registry credential and removed —
  owner decision, blast radius = every anonymous pull/push.
* Species: only coarse detector labels until SpeciesNet (Kaggle-credentialled) or an NZ pest classifier is
  staged; `species_status` says `detector_coarse_label` / `model_not_staged`.
* Tracking across frames is still the consolidator's IoU/embedding association; a Kalman/ByteTrack-style
  tracker on the detector boxes is the next step to cut duplicate observations.
* No live plate has yet been read from the TAPO corpus because none is legible at that resolution; the
  reader is proven with fake sessions (`test_inference_tier.py`) and on real frames for location only.
