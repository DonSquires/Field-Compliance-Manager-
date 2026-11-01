# CCTV Inference Tier — design, evidence standard and operations

_Status: built and deployed to both tiers 2026-09-17 (commit `6363ae2`): VPS CPU tier live, RunPod GPU tier
verified on CUDA (RF-DETR large-704, plate reader, SpeciesNet all on `CUDAExecutionProvider`). Owner
instruction: "make our system the best you can make it … provide that level of inference" (2026-09-16);
species model had to be one that "does not require payment" (2026-09-17)._

This document is the authority for `services/fcm-inference` (the model service), the RunPod serverless
worker that runs the same code on a GPU, and the parts of `services/vision` that consume its answers.
It replaces the MegaDetector/ultralytics plan that was never staged.

**Owner ruling 2026-09-25 — laptop GPU first.** The technician laptop GPU is the primary model tier. The
VPS CPU tier is the locally controlled resilience tier; paid RunPod is used only for frames the laptop and
VPS could not answer. Observation enhancement follows the same order: laptop GPU → RunPod fallback →
deterministic worker fallback. `VISION_INFERENCE_POLICY=local_gpu_first` is the platform default; the laptop
watcher uses its co-located GPU service first and RunPod only for unanswered work.

**Owner ruling 2026-11-01 — one detector per job, accuracy measured from human decisions.** Superseding the
2026-09-25 default for video: `VISION_INFERENCE_POLICY=gpu_consistent` is the default. Every frame of a job is
read by one pinned GPU detector (`rf-detr-large-704-coco`; the laptop GPU first, RunPod running the same model
when the laptop cannot answer); the VPS CPU small model is never mixed into a job, and a frame no GPU answered
defers the job instead of finishing it. The local vision-language model is Qwen3-VL on the laptop's Ollama;
Ollama Cloud is permitted only for person-free, plate-masked vehicle crops, per organisation opt-in, with a
receipt written before the crop leaves. Completed jobs are reprocessed with engine v2 while every human
decision is kept. Owner scope: accuracy engine, model governance, accuracy measurement, reviewer workspace and
the local VLM upgrade. Details, the expected-versus-present record and the remaining gaps are in §9.

**Owner ruling 2026-11-01 (stack) — RunPod is retired.** "Runpod is not part of the stack … stack is supabase,
vps hpanel, Laptop GPU, Ollama cloud, opne ai, github, vercel." This supersedes every RunPod route in this
document, including the GPU fallback in the two rulings above, §2, §6, §7 and §8: those passages are kept as
the history of what ran, not as the current design. Present behaviour:

* `gpu_consistent` (default) reads every frame on the laptop GPU only; a frame the laptop did not answer on a
  GPU execution provider (an answer reporting CPU, or no provider at all, is refused) stays unanswered and the
  job is deferred. `local_gpu_first` asks the laptop, then the VPS CPU tier; `vps_first` and `vps_only` use
  the VPS only. No policy calls a third-party GPU host.
* Recognition enhancement is laptop GPU Real-ESRGAN, then the deterministic `deterministic_capture_v1`
  profile. `runpod_handler.py`, the `fcm-capture-inference` worker and `runpod-qa-worker/` are deleted; the
  inference image now starts uvicorn directly.
* `check-services-health` never calls a RunPod host: if `INFERENCE_SERVICE_URL` still names one it reports
  `retired_provider`. It otherwise reads `GET /health` on the configured inference service.
* Historic `runpod_fallback` / `runpod` provenance stays readable (labelled legacy) and the database CHECK keeps
  accepting it for existing rows; nothing new writes it.
* Face recognition, person re-identification, ANPR and vehicle recognition remain in scope and are being
  improved on this stack (laptop GPU first; OpenAI and Ollama Cloud only under the egress rules in §9.2).

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
| Entity detector (person / vehicle / animal) | RF-DETR COCO, `rf-detr-large-704-coco` | Apache-2.0 (weights via open-image-models, MIT wrapper) | onnxruntime CUDA | laptop GPU (RunPod GPU workers until the 2026-11-01 stack ruling) |
| Entity detector, CPU tier | RF-DETR COCO, `rf-detr-small-512-coco` | Apache-2.0 | onnxruntime CPU | VPS `fcm-inference` |
| Plate detector | `yolo-v9-s-608-license-plate-end2end` | MIT | onnxruntime | both |
| Plate OCR | `cct-s-v2-global-model` (fast-plate-ocr; region head includes New Zealand) | MIT | onnxruntime | both |
| Face detect / embed | YuNet 2023mar / SFace 2021dec (opencv_zoo) | Apache-2.0 | OpenCV | both |
| Person re-ID / vehicle colour-type | OpenVINO person-reidentification-retail-0288, vehicle-attributes-recognition-barrier-0039 | Apache-2.0 | OpenVINO CPU | both |
| Vehicle-only fallback | OpenVINO vehicle-detection-0200 | Apache-2.0 | OpenVINO CPU | only when no RF-DETR export is present in `MODELS_DIR` |
| Species | SpeciesNet v4.0.2a `always_crop` (Google; EfficientNetV2-M, 2,498 labels, camera-trap trained), exported to ONNX at image build from the Addax Data Science Hugging Face mirror (Apache-2.0, pinned revision `c56465f`), geofenced `NZL` | Apache-2.0 | onnxruntime | both |
| Recognition still super-resolution | Real-ESRGAN x4plus, pinned ONNX SHA-256 `0a06c68f…eac2dc5` (upstream BSD-3-Clause; MIT-packaged conversion at fixed commit) | BSD-3-Clause / MIT packaging | onnxruntime CUDA, CPU fallback | laptop GPU; deterministic fallback (RunPod fallback retired 2026-11-01) |

Rejected: Ultralytics YOLO (AGPL-3.0 — incompatible with a closed SaaS), Plate Recognizer / cloud ALPR
(evidence leaves the custodian's control), tesseract on contour heuristics (kept only as the not-staged
fallback; it is what produced the "inaccurate inference" the owner reported), the Kaggle distribution of
SpeciesNet (needs an account; the Apache-2.0 mirror does not), third-party ONNX re-exports of SpeciesNet
(unknown preprocessing — we export from the checkpoint and prove parity ourselves), BioCLIP zero-shot (MIT,
free, but a general biology CLIP rather than a camera-trap classifier; kept as the fallback idea).

CPU trial on the real TAPO sample (2304x1296, 16-core Codespace): RF-DETR nano 81 ms, small 145 ms,
medium 195 ms, large 297 ms per full frame; the VPS CPU tier (small-512, 5 passes) is ~0.9–1.2 s per
2304x1296 frame and ~0.4 s per 640x360 snapshot. Large-704 gave the highest confidence on the same frames
(person 0.93–0.96, car 0.96, truck 0.87–0.94) and is the GPU default.

## 2a. Recognition still pipeline

Only observations that enter human review receive derivatives (default 8/job, hard cap 20). Up to 12
usable source crops around the observation window are quality-ranked, affine-aligned and temporal-median
fused (`aligned_temporal_median_v1`). Frames that cannot align at the minimum correlation are excluded and
named in the receipt. The fused crop is sent to Real-ESRGAN on the laptop GPU; OpenCV levels/denoise/sharpen
is the non-generative fallback (the RunPod fallback was retired by the 2026-11-01 stack ruling).

ALPR, face and animal/vehicle recognition run independently on the source crop and enhanced derivative.
Both answers and their agreement are stored; disagreement never auto-resolves. The original and enhanced
JPEGs are separate private Storage objects under the evidence id. `cctv_observation_derivatives` stores
source/enhanced hashes, model/provider, fusion/enhancement receipts and recognition results. The source
video/frame stays authoritative. Real-ESRGAN output is labelled generative/interpretive and always requires
human confirmation.

The worker then projects each plated `cctv_entity_observations` row into the shared
perception spine with `record_cctv_alpr_perception_envelopes`. The projection is
one replay-safe `cctv_alpr` envelope per observation and source hash; it does not
replace CCTV custody, derivatives or review. `verified_candidate` requires
reviewable evidence, a crop at least 48 px wide, minimum character confidence
of 0.55, temporal consensus, source/enhanced agreement and no conflicting plate.
Every machine result remains review-required. The existing
`review_cctv_entity_observation` decision is projected into the shared field and
append-only review receipt, so there is one human authority rather than a second
independent approval path.

Person observations follow the same projection boundary through
`record_cctv_person_perception_envelopes`. A `cctv_person` envelope records
source/frame hashes, place and time, detector/provider/model names, crop width,
deterministic alignment basis, quality, presence, face-detected state and a
pseudonymous portfolio candidate. It records only portfolio candidate count and
top similarity—not candidate names or identities. Raw face and appearance
embeddings remain exclusively in the existing biometric-governance columns and
never enter the shared envelope. Face similarity cannot become a
`verified_candidate`: relevant-condition and demographic calibration is still
absent. The existing person-observation review can approve presence/face
detection, while `person.identity_reference` is emitted only after an explicit
human `link_person`/`new_person` identity action. Provisional portfolio evidence
is then superseded rather than promoted.

## 3. Detection rules (`services/fcm-inference/detector.py`)

* **Model pick.** `DETECTOR_MODEL=auto` chooses `DETECTOR_MODEL_GPU` (large-704) when a CUDA provider *and*
  an NVIDIA driver are present, otherwise `DETECTOR_MODEL_CPU` (small-512). Any staged RF-DETR export can be
  forced by name or by `DETECTOR_MODEL_PATH`. If the configured model is missing, the largest
  `rf-detr-*-coco.onnx` in `MODELS_DIR` is used; if none, the OpenVINO vehicle-only tier answers with
  `coverage: ["vehicle"]`; if that is missing too, `status: model_not_staged` (never an empty "no
  detections").
* **Provider honesty.** `onnx_providers()` offers CUDA only when `/proc/driver/nvidia/version`,
  `/dev/nvidia*` or `NVIDIA_VISIBLE_DEVICES` proves a driver; `create_session()` retries on CPU if CUDA
  fails to initialise. The bound provider is reported on `/health` and on every
  result (`detector_execution_provider`, `detector_provider = rf_detr:<model>@<provider>`).
* **Far-field tile pass.** Frames at least 1.5x the model input in both dimensions get a 2x2 overlapping
  (15 %) tile pass in the same batch (`passes: 5`). Tile detections must clear 0.45, must not span more than
  half the tile (fragment guard), and are merged only when no same-kind full-frame detection overlaps them
  (IoU ≥ 0.5) or contains them (≥ 70 %). `DETECTOR_TILES=off` disables it for a CPU budget.
* **Class policy.** COCO → kind map. Without a species model, animals are limited to `bird, cat, dog, horse,
  sheep, cow` (giraffe/elephant/zebra/bear are what the detector calls a tree trunk — the "giraffe 0.41"
  false positive in the sample); with SpeciesNet staged every COCO animal class is admitted as "something
  alive is here" and SpeciesNet decides what, and a crop SpeciesNet calls `blank` above 0.8 is moved to
  `suppressed_animals` (visible, not counted). Floors: person 0.35, vehicle 0.35, animal 0.50; per-class
  `train 0.60, boat 0.50, bicycle 0.40`. `plausible_box` drops whole-frame boxes (≥ 85 % area), specks
  (< 0.1 %) and "people" shorter than 5 % of the frame.
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

## 5. Species (`services/fcm-inference/species.py`)

* **Export.** `export_speciesnet_onnx.py` runs in a torch-only Docker stage: downloads the checkpoint (a
  torch.fx GraphModule produced by onnx2torch) plus labels / taxonomy / geofence / four reference crops from
  the pinned mirror revision, exports opset-17 ONNX with a dynamic batch, and refuses to finish unless the
  torch and ONNX top-1 agree on every reference crop with max probability delta < 1e-3 (measured 2e-6). The
  report is shipped as `speciesnet_v4.0.2a_always_crop.parity.json`. Runtime preprocessing (OpenCV RGB,
  bilinear 480x480, /255, NHWC) is within 0.007 probability of the torchvision reference.
* **Decision rules** are a port of `speciesnet.ensemble_prediction_combiner` / `geofence_utils` for a
  detection of class animal: blank > 0.99 → blank; top > 0.8 (or > 0.65 with detection > 0.2) → geofence
  check → roll up to family/order/class/kingdom when the species is implausible for the configured country
  (`SPECIES_COUNTRY=NZL`, optional `SPECIES_ADMIN1_REGION` ISO 3166-2); otherwise roll up genus → kingdom at
  0.65; otherwise the detector's plain `animal`. Sample: a plains-zebra crop under `NZL` becomes
  `equidae family` via `classifier+geofence+rollup_to_family`; under `KEN` it stays `plains zebra`.
* **NZ table.** `detector.normalise_species` maps the 7-part label onto `NZ_SPECIES` by **exact** alias only
  (common name, `genus species`, genus, family); a roll-up such as `weasel family` stays `other` with
  SpeciesNet's own name and `species_status: taxon_above_species` rather than becoming "weasel". Aliases
  cover the mirror's naming (`western polecat` = ferret, `rattus species` = rat, `red-necked wallaby`,
  `equidae` = horse, `phalangeridae` = possum, …). Every answer carries `speciesnet: {label, common_name,
  score, source, top[5], country, admin1_region, geofence}` and `species_provider =
  speciesnet:4.0.2a+onnxruntime@<provider>`.
* **Coverage caveat.** SpeciesNet's label set has no stoat-vs-ferret-vs-weasel guarantee at night-IR quality
  and no tahr; those land at genus/family with the raw label attached. That is reported, not papered over.

## 6. Consumers

* `/infer/batch` returns `alpr` and `face` blocks per frame in addition to the triage, and `/health` returns
  the full payload including execution providers. (Until the 2026-11-01 stack ruling the RunPod
  `runpod_handler.py` exposed the same answer as `infer_batch`; it is deleted.)
* **Vehicle-attribute evidence.** The worker preserves OpenVINO colour/type
  confidence, model/provider, crop and inference status instead of flattening
  them into an unlabelled observation. Make/model from the vision LLM remains
  `vision_llm_hint_unverified`; heuristic colour/type remains distinguishable
  from `openvino_vehicle_attributes_0039`. All five supported fields (make,
  model, colour, body type and year) enter `cctv_vehicle_attributes` receipts
  as review-required candidates. Plate acceptance establishes vehicle identity
  only. Only `confirm_cctv_vehicle_attributes` may promote reviewed attributes
  to `canonical_vehicles`, and a correction preserves the original machine
  candidate as superseded evidence.
* **Where the work runs (owner ruling 2026-09-20, GPU cost).** `services/vision/vision_job_watcher.js`
  runs under `VISION_INFERENCE_POLICY`: `vps_first` (default) — the VPS `/infer/detect` triages every
  sampled frame and RunPod is asked only about frames the VPS left unanswered; `vps_only` never calls
  RunPod; `gpu_first` restores the earlier order. A VPS answer is reshaped to the `infer_batch` result
  (`localTriageResult`) with `triage_provider: 'vps'`, so recognition and the consolidator read either
  machine's answer identically and every provenance label (`alpr.provider`, `face.provider`,
  `people.provider`, `inference.provider`) names the machine that actually looked. Both machines are
  metered per job (`usage.gpu_calls/frames_sent/gpu_ms` and `usage.vps_calls/vps_ms`) and the plan
  records `coverage` (frames selected / triaged / untriaged, by provider).
* **A frame nobody examined is a gap, not a "no sighting".** Before this ruling one RunPod timeout opened
  the five-minute circuit breaker, the remaining batches were skipped, and the job completed with
  `person_events: 0` for frames no detector had seen (2026-09-20: 38 of 139 jobs, most with 0 of 120
  frames examined; a person walking through frame at 14:15:16 on `d000722` went unreported). Now, when
  `coverage.frames_untriaged > 0` after a retry pass, the job is deferred through
  `defer_cctv_inference_job` (label says how many frames went unanswered) and retried, keeping the
  checkpointed answers. Those 38 were re-queued with
  `scripts/rerun-prefix-cctv-jobs.mjs --scope unexamined --apply` (audited `cctv_inference_rerun`).
* Recognition order within a frame is unchanged: the triage answer's own `alpr`/`face` first, then
  `/infer/detect`'s embedded `alpr`, and only then `/infer/alpr` — passing the detector's
  `vehicle_bboxes` so the VPS reader is anchored too.
* `services/vision/motion_consolidator.js` writes ALPR provenance onto plated vehicle events and observation
  attributes: `alpr_provider, alpr_models, alpr_evidence_quality, plate_raw_text, plate_corrections,
  plate_char_confidence_min, plate_width_px, detector_provider`.

## 7. Packaging and deployment

* `services/fcm-inference/Dockerfile`: stage 1 (`speciesnet-export`, torch CPU) produces the SpeciesNet
  ONNX + parity report; stage 2 is `python:3.12-slim` with `--build-arg GPU=1` installing
  `onnxruntime-gpu[cuda,cudnn]==1.26.0` (last CUDA 12 line; 1.27+ is CUDA 13) as its own layer, `GPU=0`
  plain `onnxruntime`. `download_models.py` bakes RF-DETR large+small, the plate pair, the OCR pair, the
  SpeciesNet sidecars and the OpenVINO models into `/app/models` with size checks. Images: CPU ~1.0 GB,
  GPU ~3.0 GB.
* Registry: `git.fcmanager.co.nz/iron-eagle-security-ltd/fcm-inference` (CPU) and `fcm-inference-gpu`
  (GPU), tagged `<sha7>` and `latest`; `.gitea/workflows/publish_workload_containers.yml` builds both.
  nginx `/v2/` on the VPS has `client_max_body_size 0` (the CUDA layer exceeded the old 2 GB cap) and **no
  longer injects a fixed `Authorization` header** — anonymous registry access is refused (401); RunPod pulls
  with a read-only `read:package` Gitea token registered as container registry auth `gitea-fcmanager-pull`.
* VPS (`docker-compose.full.yml`): host volume `/opt/fcm/models` **overlays** the baked models, so new
  weights must be staged there (`MODELS_DIR=/opt/fcm/models python3 services/fcm-inference/download_models.py`
  for downloadable files; the SpeciesNet ONNX + parity report are `docker cp`'d out of the built image).
  Env: `DETECTOR_MODEL=rf-detr-small-512-coco`, `DETECTOR_TILES=auto`, `INFERENCE_DEVICE=cpu`.
* **CPU budget on the VPS (2026-09-21, after the queue stall).** On 2026-09-20/21 the queue stopped
  draining: 14 jobs queued 8–27 h, 3 stuck in `extracting_motion`, 31 failed as `motion extractor timed
  out` or `The operation was aborted due to timeout`, `fcm-inference` marked unhealthy, 1–3 minute clips
  taking ~20 minutes to scan. Two causes, both measured on the box. (1) The hypervisor was giving the VM
  about half a core: `vmstat 1 3` showed **steal 93 %** (since-boot steal 2 %), no container cpu limits, no
  cgroup throttling — a Hostinger-side condition (noisy neighbour or fair-use throttling after three days at
  saturation), fixable only by the provider or by moving the work. (2) Our own oversubscription: ONNX
  Runtime defaults to every core per session (detector, plate detector, OCR and SpeciesNet each took eight),
  every OpenCV capture opened one FFmpeg decode thread per core (three extractors → 24), and the FastAPI
  routes ran the models *on the event loop*, so `/health` could not answer, the watcher's 30 s timeouts
  fired, and the server kept computing requests nobody was waiting for — a feedback loop. Commit `43895aec`
  gives the pipeline an explicit budget: `detector.session_options()` (`INFERENCE_INTRA_OP_THREADS`,
  default 4; inter-op 1; sequential) on every staged session; every CPU route runs in a worker thread
  behind a gate (`INFERENCE_CONCURRENCY=1`, `INFERENCE_MAX_WAITING=6`, beyond that an immediate 503 with
  `Retry-After` so the caller moves to its next machine); `/health` stays on the loop and reports
  `queue {running, waiting}` and `cpu_threads_per_session`; the extractor opens captures with
  `CAP_PROP_N_THREADS=VISION_DECODE_THREADS` (2); the watcher's per-frame `/infer/alpr`, `/infer/face`,
  `/infer/people` and `/infer` calls go through the tolerant `classifyLocally`, so a timeout or 503 is that
  frame's answer (`success:false`, logged `inference_route_unavailable`) rather than a failed job; compose
  runs two jobs at once (`VISION_WORKER_CONCURRENCY=2`; note `/opt/fcm/.env` on the VPS overrides the compose
  default — it was still 3 there after the deploy and was set to 2 by hand on 2026-09-21). Steady-state target: eight cores = 2 jobs × 2
  decode threads + 4 detector threads. Stale `processing` leases are recovered by
  `recover_stale_cctv_inference_jobs`, which the watcher calls on every poll — so a reaper only runs while a
  watcher is running; with the watcher stopped, orphans were reset by an audited SQL update
  (`audit_log.action = 'cctv_inference_rerun'`), never by hand-editing results. Commit `28633986` adds the
  last piece: the watcher samples `/proc/stat` around each extraction, and an extractor timeout during which
  the host withheld ≥ `VISION_STARVED_STEAL_RATIO` (0.5) of the CPU **defers** the job for
  `VISION_STARVED_DEFER_SECONDS` (1 h, `extractor_starved_deferred`) instead of failing it — the video was
  never the problem. A timeout with the CPU available still fails, as it should.
* **Release-time claim gate (PR #298 review, 2026-11-01).** The release lane deploys `cctv-vision`
  (`fcm-inference` + `fcm-vision-watcher`) only after `pause_cctv_inference_claims('release-lane', …)`
  (migration `20261102170000`) has stopped new claims and the `processing` video queue has drained.
  `claim_cctv_inference_job` takes a shared advisory lock and returns no job while an unexpired pause
  exists; the pause takes the lock exclusively, so a claim already in flight commits first and the drain
  read sees it. Every watcher version, including the laptop worker, honours the gate without a code
  change. The pause expires after 45 minutes if the lane dies; the lane resumes claims on every exit path,
  and defers the release if the pause, queue read or drain fails. A failed or unhealthy replacement rolls
  back to the previous release while claims are still paused.
* RunPod: template `bwway2hiwx` → `fcm-inference-gpu@sha256:944b93bb…` (commit `6363ae2`), env
  `DETECTOR_MODEL=rf-detr-large-704-coco`; endpoint `katqqnmds1dphs` set to 1 GPU per worker (was 2), GPU
  types 4090 / RTX 6000 Ada / L40S / A40 (all CUDA 12), network-volume pin removed, idle 30 s, execution
  timeout 600 s. Verified 2026-09-17: `ping` → `detector_provider: CUDAExecutionProvider`, `cuda: true`;
  a 6-frame `infer_batch` executed in 5.1 s with RF-DETR, plate reader and SpeciesNet all on CUDA and
  detections identical to the CPU run.

## 8. Open items / honest gaps

* ~~Tracking across frames is still the consolidator's IoU/embedding association~~ — replaced by the engine v2
  tracker (§9, `services/vision/entity_tracker.js`, 2026-11-01).
* No live plate has yet been read from the TAPO corpus because none is legible at that resolution; the
  reader is proven with fake sessions (`test_inference_tier.py`) and on real frames for location only.
* Species accuracy on NZ night-IR footage is unmeasured (no labelled NZ corpus in the repo); the first real
  possum/stoat clips should be kept as a regression set with the reviewer's verdicts.
* RunPod was retired from the stack by the owner ruling of 2026-11-01 (§9); its cold-start tuning no longer
  applies.

## 9. Engine v2 accuracy (owner ruling 2026-11-01)

Owner request: "review cctv and the inference system, we need this to be more accurate … enterprise grade".
The owner chose: `gpu_consistent` tier policy (defer rather than mix in the VPS small model); Qwen3-VL on the
laptop as the local vision-language model; Ollama Cloud only for person-free, plate-masked vehicle crops with
per-organisation opt-in and receipts; all five scope items (accuracy engine, model governance, accuracy
measurement, reviewer workspace, local VLM); reprocessing of completed jobs keeping human decisions.

### 9.1 What production showed before (read-only aggregates, 2026-11-01)

* 521 sightings (209 animal, 92 person, 220 vehicle); only 18 had a human decision (17 accepted, 1 rejected),
  so no confidence figure shown to reviewers was calibrated against anything.
* Single clips were triaged by two detector models (for example 42 frames on the VPS `rf-detr-small-512` and
  78 on the laptop `rf-detr-large-704`), so sightings inside one clip were not measured on one standard.
* One camera produced the same parked car 76 times across 70 clips, split into 12 portfolios: stationary
  coalescing worked only inside a clip.
* 71 sightings came from a single frame; 98 animals had no species.
* `classification_truncated` was true for 319 of 364 planned results (120-frame cap); 21 of those sampled as
  few as 80 frames because the per-segment budget left unused frames behind.
* Code defects: only the first vehicle per frame reached tracking (`vehicles[0]`); greedy nearest-track
  assignment with no one-to-one rule (two people walking together merged); a spatial gate that grew to about
  23 box sizes over a 15 s gap; track confidence was the single maximum; make/model came from moondream
  with free-form JSON; confidence percentages had no calibration and no box was drawn on the still.

### 9.2 What engine v2 does (expected once released)

* **Tracker** (`services/vision/entity_tracker.js`, `ENGINE_VERSION = 'cctv-engine-v2'`): every detection in a
  frame is tracked; one-to-one assignment per frame; bounded gate (max 4 box sizes, 2 with a constant-velocity
  prediction); a detection below 0.4 can extend a track but never start one; weak colour-layout embeddings can
  veto a match but never rescue one; a track is confirmed at 2 hits, or 1 frame at ≥ 0.85; track confidence is
  evidence-weighted with the best frame kept separately. Tracks are review candidates, never identities.
* **One detector per job** (`vision_job_watcher.js`): under `gpu_consistent` an answer counts only when it
  came from the pinned model; other answers leave the frame unanswered and the job is deferred with a label
  naming the model it waits for. Each result records `classification_plan.model_manifest` (engine version,
  policy, pinned model, frames per detector model, rejected answers per model) and `coverage` (frames
  sampled, examined and unanswered, by machine).
* **Frame budget**: `selectFramesForClassification` now spends the whole budget in chronological order; budget
  a short motion segment cannot use passes to longer segments, and with more segments than budget it samples
  segments across the whole clip, never only the first ones.
* **Vision-language hints** (`services/vision/vision_hints.js`): Qwen3-VL (`qwen3-vl:4b`) on the laptop Ollama
  answers against a JSON schema at temperature 0; when it cannot answer the hint is recorded as unavailable,
  never answered by a weaker model. Ollama Cloud (`gemma4:31b` default) is used for vehicle make/model only
  when the local model failed, the organisation opted in, the plate reader examined the frame and every
  located plate is blacked out, the person detector found no person intersecting the crop, and a receipt for
  that crop's SHA-256 was written first — no receipt, no egress. Person, weapon and scene prompts never leave
  the local tier. Every make/model hint keeps the governed label `vision_llm_hint_unverified` (the label
  `review_cctv_entity_observation` relies on to keep a machine guess off the canonical vehicle when a plate is
  accepted); which tier answered is recorded separately as `make_model_tier` (`local_vlm` or `ollama_cloud`)
  with `make_model_model` and, for the cloud, `make_model_receipt_id`.
* **Hint model acceptance (2026-11-01, laptop Ollama 0.40.13, `qwen3-vl:4b`)**: probing with the exact worker
  request found two defects that would have made every hint "unavailable" in production, both fixed before
  release. (1) Without a bounded context Ollama sized the KV cache for Qwen3-VL's full window and failed to load
  the model (36.5 GB allocation); requests now send `num_ctx` 8192 (`VISION_HINT_NUM_CTX`), and the model loads
  fully on the GPU at 4.3 GB. (2) The model reasons before answering (`think: false` did not stop it), and the
  old 256-token output budget would have truncated five of six answers; the budget is now 1536
  (`VISION_HINT_MAX_TOKENS`; the largest answer measured used 738). The prompt also defines the NZ body types,
  because without them a Hilux pickup was filed as a campervan. On three openly licensed Wikimedia Commons
  photographs (Toyota HiLux front, Mazda Demio front and rear), each sent clear at crop size and degraded to
  160 px CCTV quality, make, model, body type and colour were right in 6 of 6; a synthetic drawn car was
  answered "unknown" at low confidence; the weapon prompt answered no weapon and the scene synopsis read
  "white ute parked on the street". Warm latency was 3.5–16 s per hint. This is a smoke test of the request
  contract, not an accuracy measurement — precision comes only from reviewer decisions (§9.3).
* **Configuration names**: the watcher reads `CCTV_VLM_URL`, `CCTV_VLM_MODEL` and `CCTV_CLOUD_VLM_MODEL` from
  `/opt/fcm/.env` (compose maps them to the watcher's `OLLAMA_VISION_*`); do not set `OLLAMA_VISION_*` there,
  because Bob Vibe reads those names for its own images. `VISION_PINNED_DETECTOR_MODEL` defaults to
  `rf-detr-large-704-coco`.
* **Database** (migration `20261102150000_cctv_enterprise_inference.sql`):
  `reconcile_cctv_reviewed_observations` supersedes a reprocessed unreviewed sighting that duplicates an
  accepted or rejected one (same footage and kind, overlapping time, and the same plate, box IoU ≥ 0.3 or a
  stationary position) and records `carried_review_state`; reviewed rows are never changed.
  `cctv_resident_objects` + `link_cctv_resident_vehicle_observations` give a parked vehicle that recurs in the
  same place on the same camera one provisional portfolio across clips. `cctv_inference_policies` +
  `set_cctv_inference_policy` hold the cloud opt-in (administrator only, reason required to enable, audited);
  `cctv_cloud_inference_receipts` holds the crop hash and privacy checks, never the image.
  `cctv_missed_detection_reports` with `report_cctv_missed_detection` / `resolve_cctv_missed_detection` measure
  recall (only a confirmed miss counts; a wrong report is kept as `not_missed`). `cctv_accuracy_summary`
  reports precision per entity kind, engine, detector, review basis and confidence band from human decisions
  only, with the Wilson 95 % lower bound; a group is called calibrated at 30 decisions.
* **Reviewer workspace**: the triage queue draws the detector box on the full frame (only when the sighting
  carries its frame size — a guessed box is never drawn), lists provenance (engine, detector, basis, track
  confirmation, motion, resident object, carried decision), and supports J/K to move, A/R to accept or reject,
  optional move-to-next after deciding, and a receipt with "Back to it". There is deliberately no bulk accept:
  one attributable decision per sighting is the accountability standard. The console can report a missed
  sighting at the playhead. The new Detection quality page (`?area=cctv-quality`) shows precision with its
  lower bound and calibration state per kind, a legacy-engine comparison, the breakdown table, missed reports
  with administrator resolution, and the cloud vehicle-hint policy with its receipt count. The job review
  panel shows detector coverage: frames examined against motion frames, unanswered frames as gaps, which
  machines read them, and a warning when different detector models read one clip.
* **Reprocessing**: `node scripts/rerun-prefix-cctv-jobs.mjs --scope engine-v2 --limit 25` lists completed
  video jobs whose latest result was not produced by engine v2; `--apply` re-queues one batch (audited
  `cctv_inference_rerun`). The migration must be live before the watcher is redeployed, and before any batch.
  Photos are out of scope: engine v2 changed the video path only, and a photo result has no classification
  plan, so the first live canary (2026-11-01, two photos) would otherwise have been re-selected every batch.

### 9.3 Present state and honest gaps

* Present in the repository on merge; live only after the release lane applies the migration and the watcher
  is redeployed with Qwen3-VL pulled on the laptop. Nothing in §9.2 is "exercised" until a reprocessed batch
  writes engine v2 results and reviewers decide them; until 30 decisions exist per group the quality page
  says so instead of showing a calibrated figure.
* Recall is only as good as reviewers' missed reports; there is no labelled ground-truth corpus (no CCTV video
  in the classified sample corpus).
* 107 "Unknown Person" profiles exist live, 32 of them orphaned. Engine v2 does not create or merge them; this
  is recorded as a data gap, not fixed here.
* Sampling is still capped at `VISION_MAX_CLASSIFICATION_FRAMES` (120); motion between samples is not
  examined, and the review panel says so.

### 9.4 Recognition evaluation

`node scripts/cctv-recognition-eval.mjs --fixture` checks the metric calculations against synthetic
review decisions, labeled plates and identity clusters. It is a harness test, not evidence that a model
is accurate on real CCTV footage.

For a live, single-organisation aggregate, run
`node scripts/cctv-recognition-eval.mjs --live --organization-id <uuid> [--since <ISO timestamp>]`
with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in the server-side environment. This calls the
read-only `cctv_accuracy_summary` RPC and emits only reviewer counts, precision and confidence bounds;
it does not fetch or export observations, names, images, plate strings or embeddings. A service-role
read must remain organization- and time-scoped.

The current RPC does not return adjudicated plate strings or ground-truth identity links. Live plate
exact-match and person-fragmentation metrics therefore report `not_available`; synthetic fixture values
must never be presented as production accuracy. A governed, human-labeled evaluation set is required
before those live metrics can be claimed. Existing diagnostic profile totals and the CCTV engine-v2
profile counts have different scopes and no shared denominator; reconcile them by organisation and
time window before using either as a fragmentation rate.

The current quality gate only runs face detection inside detected person head regions. Face matching requires
a clear source frame, sufficient original face size, detector confidence, sharpness and approximate frontal
landmarks; upscaling does not make an originally tiny face eligible. A face outside every detected person box
is not searched. Video person and vehicle appearance templates are quality-weighted and require at least two
eligible detector crops; a still photo emits a single-frame template only when that crop passes the same gate.
Deterministic fallback descriptors may help local track continuity but are not persisted as cross-clip
identity templates. These thresholds are conservative engineering gates, not calibrated accuracy claims, and
must be revisited against a governed labeled set. Plate reads are constrained to NZ formats, voted per
character position with OCR character confidence where it still aligns with the normalised plate, and retain
conflicting strings for human review.

`record_cctv_entity_observations` (migration `20261102190000`) enforces the same gates in the database:
person and vehicle templates are neither stored nor matched unless the observation is `clear` and carries
its explicit usability flag. Only a stored, clear, usable face may create a new provisional Unknown Person
profile. A usable body template may join a portfolio that already has a profile but never creates one, and
low-quality sightings stay unlinked. The legacy workload-token motion ingest (`complete_motion_inference`)
therefore keeps its face rows in manual review without minting profiles. Laptop GPU workers must run
`deploy/laptop-worker/update-watcher.ps1` after release; until they do, their faces and appearance templates
lack the usability flags and are dropped from matching (fail safe, lower recall).

The Python inference-tier tests (`services/fcm-inference/test_inference_tier.py`) are not run by CI; run them
locally with the service requirements and `pytest` before changing the inference service.
