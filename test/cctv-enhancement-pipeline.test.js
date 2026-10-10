const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const watcher = read('services/vision/vision_job_watcher.js');
const derivativeHelpers = read('services/vision/observation_derivatives.js');
const inference = read('services/fcm-inference/app.py');
const runpodHandler = read('services/fcm-inference/runpod_handler.py');
const superResolution = read('services/fcm-inference/super_resolution.py');
const models = read('services/fcm-inference/download_models.py');
const migration = read('supabase/migrations/20260925140000_cctv_observation_derivatives.sql');
const photoMigration = read('supabase/migrations/20260926012000_cctv_photo_inference.sql');
const reviewer = read('apps/web/src/components/CCTVStillComparison.tsx');
const vpsCompose = read('docker-compose.full.yml');
const laptopCompose = read('docker-compose.laptop-worker.yml');
const laptopUpdater = read('deploy/laptop-worker/update-watcher.ps1');

test('laptop GPU is primary, VPS CPU is resilient, and RunPod is final fallback', () => {
  assert.match(vpsCompose, /VISION_INFERENCE_POLICY: \$\{VISION_INFERENCE_POLICY:-local_gpu_first\}/);
  assert.match(watcher, /if \(policy === 'local_gpu_first'\) return \['local_gpu', 'vps', 'gpu'\]/);
  assert.match(watcher, /callLaptopEnhancement\(fusedBytes[\s\S]*?callRunpodEnhancement\(fusedBytes[\s\S]*?'worker_deterministic'/);
  assert.match(laptopCompose, /VISION_INFERENCE_POLICY: vps_first/);
  assert.match(laptopCompose, /LOCAL_GPU_INFERENCE_URL: http:\/\/fcm-inference:3000/);
  assert.match(laptopCompose, /LOCAL_GPU_INFERENCE_API_KEY: \$\{LAPTOP_INFERENCE_API_KEY:\?LAPTOP_INFERENCE_API_KEY is required\}/);
  assert.match(laptopCompose, /RUNPOD_API_URL:/);
  assert.match(laptopCompose, /LAPTOP_INFERENCE_API_KEY:\?LAPTOP_INFERENCE_API_KEY is required/);
  assert.match(laptopUpdater, /laptopKey\.Length -lt 32/);
  assert.match(laptopUpdater, /git worktree add --detach \$temporaryWorktree origin\/main/);
  assert.match(laptopUpdater, /Tracked local changes preserved/);
  assert.match(laptopUpdater, /LAPTOP_WORKER_ENV_FILE/);
  assert.match(laptopUpdater, /inspectJson \| ConvertFrom-Json/);
  assert.match(laptopUpdater, /Get-DockerContainerInspect/);
  assert.match(laptopUpdater, /Labels\.'com\.docker\.compose\.project'/);
  assert.doesNotMatch(laptopUpdater, /docker inspect --format/);
  assert.match(laptopUpdater, /New-LaptopDeploymentEnv/);
  assert.match(laptopUpdater, /\^\(\[A-Za-z_\]\[A-Za-z0-9_\]\*\)=\(\.\*\)\$/);
  assert.match(laptopUpdater, /System\.Text\.UTF8Encoding\(\$false\)/);
  assert.match(laptopUpdater, /Remove-Item \$deploymentEnvFile -Force/);
  assert.match(laptopUpdater, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(laptopUpdater, /Docker GPU startup failed after the build/);
  assert.match(laptopUpdater, /did not restart cleanly after three attempts/);
  assert.doesNotMatch(laptopUpdater, /throw 'The checkout has tracked local changes/);
  assert.match(laptopCompose, /LAPTOP_WORKER_ENV_FILE:-\.\/deploy\/laptop-worker\/laptop-worker\.env/);
  assert.match(laptopUpdater, /health\.cuda -ne \$true/);
  assert.match(laptopUpdater, /health\.super_resolution\.state -ne 'ready'/);
});

test('the enhancement model is pinned, checksummed, GPU-aware and explicitly generative', () => {
  assert.match(models, /realesrgan_x4plus\.onnx/);
  assert.match(models, /0a06c68f463a14bf5563b78d77d61ba4394024e148383c4308d6d3783eac2dc5/);
  assert.match(superResolution, /"CUDAExecutionProvider", "CPUExecutionProvider"/);
  assert.match(superResolution, /"generative": True/);
  assert.match(inference, /@app\.post\("\/infer\/enhance"\)/);
  assert.match(inference, /"source": _infer_frame\(image, tasks\)/);
  assert.match(inference, /"enhanced": _infer_frame\(enhanced, tasks\)/);
});

test('face candidates carry model and crop provenance on both inference paths', () => {
  assert.match(inference, /"detector_confidence": round\(float\(detection\[-1\]\), 6\)/);
  assert.match(inference, /"face_crop_width_px": box_width/);
  assert.match(inference, /"alignment_basis": alignment_basis/);
  assert.match(inference, /"face_detector_model": YUNET_MODEL_PATH\.name/);
  assert.match(inference, /"face_embedding_model": SFACE_MODEL_PATH\.name/);
  assert.match(runpodHandler, /_face_sync/);
  assert.doesNotMatch(runpodHandler, /detector, recognizer = _face_models\(\)/);
});

test('derivatives are bounded, private, evidence-scoped and persisted only through the service writer', () => {
  assert.match(watcher, /VISION_MAX_OBSERVATION_DERIVATIVES \|\| 8/);
  assert.match(derivativeHelpers, /cctv-derivatives/);
  assert.match(watcher, /supabase\.storage\.from\(paths\.bucket\)\.upload\(paths\.original/);
  assert.match(watcher, /supabase\.storage\.from\(paths\.bucket\)\.upload\(paths\.enhanced/);
  assert.match(watcher, /record_cctv_observation_derivatives/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cctv_observation_derivatives/);
  assert.match(migration, /CREATE POLICY cctv_observation_derivatives_select/);
  assert.match(migration, /Service identity required/);
  assert.match(migration, /Derivative storage path or enhancement profile is invalid/);
});

test('the reviewer sees source and enhanced results without surrendering source authority', () => {
  assert.match(reviewer, /Original remains authoritative/);
  assert.match(reviewer, /AI-enhanced derivative/);
  assert.match(reviewer, /Source and enhanced recognition comparison/);
  assert.match(reviewer, /human comparison required/);
  assert.doesNotMatch(reviewer, /review_cctv_entity_observation|canonical_vehicles.*update/);
});

test('photos use immutable evidence, the laptop-first worker, and a service-only completion boundary', () => {
  assert.match(photoMigration, /evidence_kind, storage_path[\s\S]*'photo'/);
  assert.match(photoMigration, /'video_motion', 'queued'/);
  assert.match(photoMigration, /Photo queued for face and plate review/);
  assert.match(photoMigration, /REVOKE ALL ON FUNCTION public\.complete_cctv_still_inference[\s\S]*authenticated/);
  assert.match(photoMigration, /GRANT EXECUTE ON FUNCTION public\.complete_cctv_still_inference[\s\S]*TO service_role/);
  assert.match(watcher, /evidence\.evidence_kind === 'photo'/);
  assert.match(watcher, /callLaptopEnhancement\(originalBytes[\s\S]*recogniseDeterministicFallback\(originalBytes, originalBytes\)[\s\S]*callRunpodEnhancement\(originalBytes/);
  assert.match(watcher, /complete_cctv_still_inference/);
  assert.match(watcher, /playback_transcode_profile: 'photo-normalised-jpeg-v1'/);
});
