// Self-hosted vision-language hints for CCTV review (owner ruling 2026-11-01, docs/CCTV_INFERENCE_TIER.md).
//
// Every value produced here is an UNVERIFIED HINT for a human reviewer, never a detection or an identity.
//   - Primary: Qwen3-VL on the technician's own GPU through Ollama, answering against a JSON schema at
//     temperature 0. There is no silent fallback to a weaker model: when the configured model cannot answer,
//     the hint is recorded as unavailable so "not checked" never looks like "checked, nothing found".
//   - Optional: Ollama Cloud, for vehicle make/model only, only for an organisation that opted in, only for a
//     crop with no detected person in it, only after the plate reader examined the frame, with every located
//     plate blacked out, and only after a receipt for that exact crop (SHA-256) was written. No receipt, no
//     egress. Person, weapon and scene prompts never leave the local tier.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { normaliseBbox, bboxesIntersect } = require('./entity_tracker');

const execFileAsync = promisify(execFile);

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

const LOCAL_VLM_URL = (process.env.OLLAMA_VISION_URL || '').replace(/\/+$/, '');
const LOCAL_VLM_MODEL = process.env.OLLAMA_VISION_MODEL || 'qwen3-vl:4b';
const VISION_HINT_TIMEOUT_MS = Number(process.env.VISION_HINT_TIMEOUT_MS) || 45_000;
// Ollama otherwise sizes the KV cache for the model's full context window, which for Qwen3-VL needs ~36 GB and
// fails to load on the laptop GPU. A 768px crop plus the prompt is under 2k tokens.
const VISION_HINT_NUM_CTX = Number(process.env.VISION_HINT_NUM_CTX) || 8192;
// Qwen3-VL reasons before it answers, so the budget has to cover the reasoning and the JSON.
const VISION_HINT_MAX_TOKENS = Number(process.env.VISION_HINT_MAX_TOKENS) || 1536;
const CLOUD_VLM_URL = (process.env.OLLAMA_CLOUD_URL || 'https://ollama.com').replace(/\/+$/, '');
const CLOUD_VLM_TOKEN = process.env.OLLAMA_API_TOKEN || process.env.OLLAMA_API_KEY || '';
const CLOUD_VLM_DEFAULT_MODEL = process.env.OLLAMA_CLOUD_VISION_MODEL || 'gemma4:31b';
const CROP_MAX_EDGE = 768;

const BODY_TYPES = ['sedan', 'hatchback', 'station_wagon', 'suv', 'ute', 'van', 'truck', 'bus', 'motorcycle', 'campervan', 'trailer', 'other', 'unknown'];
const COLOURS = ['white', 'silver', 'grey', 'black', 'red', 'blue', 'green', 'yellow', 'orange', 'brown', 'beige', 'gold', 'purple', 'other', 'unknown'];

const VEHICLE_HINT_SCHEMA = {
  type: 'object',
  properties: {
    make: { type: 'string' },
    model: { type: 'string' },
    body_type: { type: 'string', enum: BODY_TYPES },
    colour: { type: 'string', enum: COLOURS },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidence: { type: 'string' },
  },
  required: ['make', 'model', 'body_type', 'colour', 'confidence', 'evidence'],
};

const VEHICLE_HINT_PROMPT = [
  'This is a cropped CCTV image of one vehicle. Identify the manufacturer (make) and model only from visible evidence:',
  'badges, grille, headlight and tail-light shape, body lines. Use "unknown" for make or model when the evidence is not',
  'visible; a wrong guess is worse than "unknown". Never read or invent a registration plate. Set confidence to "high"',
  'only when a badge or a distinctive design feature is clearly visible. In "evidence" name the feature you relied on.',
  'Body types: "ute" is a pickup with an open or canopied rear tray (e.g. Ranger, Navara, Triton); "hatchback" is a',
  'small or medium car with a short rear and a lift-up tailgate (e.g. Swift, Yaris, Golf); "station_wagon" is',
  'an estate car whose roof runs flat to a long rear load area; "campervan" is a motorhome or a van fitted out for',
  'sleeping; "van" is a panel or passenger van.',
].join(' ');

const WEAPON_HINT_SCHEMA = {
  type: 'object',
  properties: { possible_weapon: { type: 'boolean' }, description: { type: 'string' } },
  required: ['possible_weapon', 'description'],
};

const WEAPON_HINT_PROMPT = [
  'This is a cropped CCTV image of a person. Look at anything they hold, carry or wear.',
  'Could any object plausibly be a firearm, knife or other weapon? If unsure, flag it so a human checks:',
  'a false alarm is cheaper than a missed weapon. Describe only what is visible; do not describe the person.',
].join(' ');

const SCENE_SYNOPSIS_SCHEMA = {
  type: 'object',
  properties: { synopsis: { type: 'string' } },
  required: ['synopsis'],
};

const SCENE_SYNOPSIS_PROMPT = [
  'This is one representative frame from a CCTV clip. In one short plain-English sentence describe what is visible',
  '(for example "person walking near the gate", "white ute parked in the yard"). Do not guess identity or intent.',
].join(' ');

function localVlmConfigured() {
  return Boolean(LOCAL_VLM_URL);
}

function vlmManifest() {
  return {
    local_model: LOCAL_VLM_URL ? LOCAL_VLM_MODEL : null,
    local_configured: Boolean(LOCAL_VLM_URL),
    cloud_model_default: CLOUD_VLM_TOKEN ? CLOUD_VLM_DEFAULT_MODEL : null,
    cloud_available: Boolean(CLOUD_VLM_TOKEN),
  };
}

function expandBbox(bbox, padding) {
  const pad = Math.round(Math.max(bbox.width, bbox.height) * padding);
  return { x: Math.max(0, Math.round(bbox.x) - pad), y: Math.max(0, Math.round(bbox.y) - pad), width: Math.round(bbox.width) + pad * 2, height: Math.round(bbox.height) + pad * 2 };
}

// Crop (optionally after blacking out boxes in source-frame coordinates) and return the exact JPEG bytes.
async function cropFrame(filePath, bbox, { maskBoxes = [], padding = 0 } = {}) {
  const box = normaliseBbox(bbox);
  if (!filePath || !box) return null;
  const crop = padding > 0 ? expandBbox(box, padding) : { x: Math.max(0, Math.round(box.x)), y: Math.max(0, Math.round(box.y)), width: Math.round(box.width), height: Math.round(box.height) };
  if (crop.width <= 1 || crop.height <= 1) return null;
  const filters = maskBoxes.map((mask) => `drawbox=x=${Math.round(mask.x)}:y=${Math.round(mask.y)}:w=${Math.max(1, Math.round(mask.width))}:h=${Math.max(1, Math.round(mask.height))}:color=black:t=fill`);
  // ffmpeg clamps an out-of-frame crop to the frame with the min() expressions.
  filters.push(`crop=min(${crop.width}\\,iw-${crop.x}):min(${crop.height}\\,ih-${crop.y}):${crop.x}:${crop.y}`);
  filters.push(`scale='min(${CROP_MAX_EDGE},iw)':-2`);
  const cropPath = path.join(os.tmpdir(), `vision-hint-${crypto.randomUUID()}.jpg`);
  try {
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', filePath, '-vf', filters.join(','), '-q:v', '3', cropPath], { timeout: 15_000 });
    return { bytes: await fs.readFile(cropPath), crop };
  } catch (error) {
    log('vision_hint_crop_failed', { file_path: filePath, error: error.message });
    return null;
  } finally {
    await fs.rm(cropPath, { force: true }).catch(() => {});
  }
}

// Seams for tests: the crop needs ffmpeg and the query needs a model server.
const deps = { cropFrame, fetch: (...args) => fetch(...args) };

async function queryOllama({ baseUrl, model, token, prompt, image, schema }) {
  if (!baseUrl || !image) return { ok: false, error: 'not_configured' };
  try {
    const response = await deps.fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images: [image] }],
        stream: false,
        format: schema,
        options: { temperature: 0, num_predict: VISION_HINT_MAX_TOKENS, num_ctx: VISION_HINT_NUM_CTX },
        keep_alive: '5m',
      }),
      signal: AbortSignal.timeout(VISION_HINT_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const body = await response.json();
    const content = body?.message?.content ?? body?.response;
    try {
      return { ok: true, value: JSON.parse(content) };
    } catch {
      return { ok: false, error: 'unparseable_response' };
    }
  } catch (error) {
    return { ok: false, error: error.name === 'TimeoutError' ? 'timeout' : 'unreachable', detail: error.message };
  }
}

function cleanLabel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^(unknown|n\/?a|none|null|unsure|not visible)$/i.test(trimmed)) return null;
  return trimmed.slice(0, 60);
}

// The one label every consumer treats as an unverified machine guess: review_cctv_entity_observation will not seed
// the canonical vehicle with it, and the console offers it only for attribute review. Which tier answered is kept
// separately in vehicle_make_model_tier so the label never has to change.
const VLM_HINT_SOURCE = 'vision_llm_hint_unverified';

function vehicleHintFrom(parsed, tier, model) {
  if (!parsed || typeof parsed !== 'object') return null;
  const confidence = ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'low';
  // A low-confidence make/model is withheld: reviewers would read it as an answer.
  const make = confidence === 'low' ? null : cleanLabel(parsed.make);
  const vehicleModel = make && confidence !== 'low' ? cleanLabel(parsed.model) : null;
  return {
    vehicle_make: make,
    vehicle_model: vehicleModel,
    vehicle_make_model_source: make || vehicleModel ? VLM_HINT_SOURCE : null,
    vehicle_make_model_tier: tier,
    vehicle_make_model_status: make || vehicleModel ? 'hint' : 'no_confident_guess',
    vehicle_make_model_confidence: confidence,
    vehicle_make_model_evidence: typeof parsed.evidence === 'string' ? parsed.evidence.trim().slice(0, 160) || null : null,
    vehicle_make_model_model: model,
    vlm_body_type: BODY_TYPES.includes(parsed.body_type) && parsed.body_type !== 'unknown' ? parsed.body_type : null,
    vlm_colour: COLOURS.includes(parsed.colour) && parsed.colour !== 'unknown' ? parsed.colour : null,
  };
}

function unavailableVehicleHint(status) {
  return { vehicle_make: null, vehicle_model: null, vehicle_make_model_source: null, vehicle_make_model_status: status };
}

// context.cloud: { enabled, model, plateScanned, plateBoxesComplete, plateBoxes, personScanned, personBoxes,
//                  sourceEventId, recordReceipt(receipt) -> Promise<{ id }> }
async function getVehicleVisionHint(filePath, bbox, context = {}) {
  if (!normaliseBbox(bbox) || !filePath) return unavailableVehicleHint('no_crop');
  if (localVlmConfigured()) {
    const crop = await deps.cropFrame(filePath, bbox, { padding: 0.08 });
    if (!crop) return unavailableVehicleHint('no_crop');
    const answer = await queryOllama({ baseUrl: LOCAL_VLM_URL, model: LOCAL_VLM_MODEL, prompt: VEHICLE_HINT_PROMPT, image: crop.bytes.toString('base64'), schema: VEHICLE_HINT_SCHEMA });
    if (answer.ok) {
      const hint = vehicleHintFrom(answer.value, 'local_vlm', LOCAL_VLM_MODEL);
      if (hint) return hint;
    }
    log('vision_hint_local_unavailable', { error: answer.error, detail: answer.detail });
  }
  if (context.cloud?.enabled) return getCloudVehicleHint(filePath, bbox, context.cloud);
  return unavailableVehicleHint('vlm_unavailable');
}

async function getCloudVehicleHint(filePath, bbox, cloud) {
  if (!CLOUD_VLM_TOKEN) return unavailableVehicleHint('cloud_not_configured');
  if (typeof cloud.recordReceipt !== 'function') return unavailableVehicleHint('cloud_receipt_unavailable');
  if (cloud.plateScanned !== true) return unavailableVehicleHint('cloud_skipped_plate_scan_missing');
  if (cloud.plateBoxesComplete !== true) return unavailableVehicleHint('cloud_skipped_unmasked_plates');
  if (cloud.personScanned !== true) return unavailableVehicleHint('cloud_skipped_person_scan_missing');
  const box = normaliseBbox(bbox);
  const crop = expandBbox(box, 0.08);
  const people = (cloud.personBoxes || []).map(normaliseBbox).filter(Boolean);
  if (people.some((person) => bboxesIntersect(person, crop))) return unavailableVehicleHint('cloud_skipped_person_in_crop');
  const plates = (cloud.plateBoxes || []).map(normaliseBbox).filter(Boolean).filter((plate) => bboxesIntersect(plate, crop)).map((plate) => expandBbox(plate, 0.2));
  const masked = await deps.cropFrame(filePath, bbox, { maskBoxes: plates, padding: 0.08 });
  if (!masked) return unavailableVehicleHint('no_crop');
  const model = cloud.model || CLOUD_VLM_DEFAULT_MODEL;
  const cropSha256 = crypto.createHash('sha256').update(masked.bytes).digest('hex');
  let receipt;
  try {
    receipt = await cloud.recordReceipt({
      provider: 'ollama_cloud',
      purpose: 'vehicle_make_model_hint',
      model,
      crop_sha256: cropSha256,
      crop_bytes: masked.bytes.length,
      plate_masked: true,
      plate_boxes_masked: plates.length,
      persons_excluded: true,
      source_event_id: cloud.sourceEventId || null,
    });
  } catch (error) {
    log('vision_hint_cloud_receipt_failed', { error: error.message });
    return unavailableVehicleHint('cloud_skipped_receipt_failed');
  }
  if (!receipt?.id) return unavailableVehicleHint('cloud_skipped_receipt_failed');
  const answer = await queryOllama({ baseUrl: CLOUD_VLM_URL, model, token: CLOUD_VLM_TOKEN, prompt: VEHICLE_HINT_PROMPT, image: masked.bytes.toString('base64'), schema: VEHICLE_HINT_SCHEMA });
  const receiptSummary = { id: receipt.id, crop_sha256: cropSha256, plate_boxes_masked: plates.length, persons_excluded: true };
  if (!answer.ok) {
    log('vision_hint_cloud_unavailable', { error: answer.error, detail: answer.detail });
    return { ...unavailableVehicleHint('vlm_unavailable'), vehicle_make_model_receipt: receiptSummary };
  }
  const hint = vehicleHintFrom(answer.value, 'ollama_cloud', model) || unavailableVehicleHint('vlm_unavailable');
  return { ...hint, vehicle_make_model_receipt: receiptSummary };
}

// Local tier only. On any failure this returns null (the key is omitted from the observation) rather than
// {present:false}: "not checked" must never look identical to "checked, nothing found".
async function getWeaponHint(filePath, bbox) {
  if (!localVlmConfigured() || !filePath || !normaliseBbox(bbox)) return null;
  const crop = await deps.cropFrame(filePath, bbox, { padding: 0.05 });
  if (!crop) return null;
  const answer = await queryOllama({ baseUrl: LOCAL_VLM_URL, model: LOCAL_VLM_MODEL, prompt: WEAPON_HINT_PROMPT, image: crop.bytes.toString('base64'), schema: WEAPON_HINT_SCHEMA });
  if (!answer.ok || typeof answer.value?.possible_weapon !== 'boolean') return null;
  return {
    present: answer.value.possible_weapon,
    description: typeof answer.value.description === 'string' && answer.value.description.trim() ? answer.value.description.trim().slice(0, 200) : null,
    source: 'vision_llm_hint_requires_human_review',
    model: LOCAL_VLM_MODEL,
    generated_at: new Date().toISOString(),
  };
}

function stripDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const commaIndex = dataUrl.indexOf(',');
  return dataUrl.startsWith('data:image/') && commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : null;
}

async function getSceneSynopsis(keyframeDataUrl) {
  const image = stripDataUrl(keyframeDataUrl);
  if (!image || !localVlmConfigured()) return null;
  const answer = await queryOllama({ baseUrl: LOCAL_VLM_URL, model: LOCAL_VLM_MODEL, prompt: SCENE_SYNOPSIS_PROMPT, image, schema: SCENE_SYNOPSIS_SCHEMA });
  const text = answer.ok && typeof answer.value?.synopsis === 'string' ? answer.value.synopsis.trim() : '';
  if (!text) return null;
  return { text: text.slice(0, 300), source: VLM_HINT_SOURCE, model: LOCAL_VLM_MODEL, generated_at: new Date().toISOString() };
}

module.exports = {
  getVehicleVisionHint,
  getWeaponHint,
  getSceneSynopsis,
  vlmManifest,
  vehicleHintFrom,
  VEHICLE_HINT_SCHEMA,
  LOCAL_VLM_MODEL,
  __testing: { deps },
};
