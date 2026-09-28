const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createClient } = require('@supabase/supabase-js');
const { verifyAndConsumeToken } = require('./src/security/job_token_consumer');
const { verifyJobToken } = require('./src/security/job_token_verifier');
const { createModelGateway } = require('./src/bob/modelGateway');
const { planTurn } = require('./src/bob/plan');
const { subagentStep } = require('./src/bob/subagent');
const { classifyIdentityDocument, extractIdentityFields, identityDocumentDefinition } = require('./src/bob/identityDocument');
const { createDocumentReader, docxXmlToText } = require('./src/bob/documents');

const execFileAsync = promisify(execFile);

const port = Number(process.env.PORT || 3000);
const apiToken = process.env.FCM_API_TOKEN || '';
const voiceUrl = (process.env.VOICE_URL || '').replace(/\/+$/, '');
const voiceApiKey = process.env.VOICE_API_KEY || '';
const osrmUrl = (process.env.OSRM_URL || '').replace(/\/+$/, '');
const workloadSigningSecret = process.env.WORKLOAD_SIGNING_SECRET || '';
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const inferenceServiceUrl = (process.env.INFERENCE_SERVICE_URL || '').replace(/\/+$/, '');
const inferenceApiKey = process.env.INFERENCE_API_KEY || '';
const identityInferenceSecret = process.env.IDENTITY_INFERENCE_SECRET || '';
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 256 * 1024 * 1024);
const maxIdentityBytes = Number(process.env.IDENTITY_DOCUMENT_MAX_BYTES || 25 * 1024 * 1024);
const modelGateway = createModelGateway();
const supabase = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  const token = (request.headers.authorization || '').replace(/^Bearer /, '');
  return apiToken && token.length === apiToken.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(apiToken));
}

function verifiedIdentityContext(request, attachmentId) {
  const value = String(request.headers['x-identity-context'] || '');
  const [encodedPayload, suppliedSignature] = value.split('.');
  if (!identityInferenceSecret || !encodedPayload || !suppliedSignature) throw new Error('identity_inference_context_required');
  const expectedSignature = crypto.createHmac('sha256', identityInferenceSecret).update(encodedPayload).digest('hex');
  if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature))) {
    throw new Error('identity_inference_context_invalid');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('identity_inference_context_invalid');
  }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.attachment_id !== attachmentId || !isUuid(payload.organization_id) || !isUuid(payload.actor_id)
      || !Number.isFinite(payload.expires_at) || payload.expires_at < nowSeconds || payload.expires_at > nowSeconds + 120) {
    throw new Error('identity_inference_context_invalid');
  }
  return payload;
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid_json');
  }
}

async function proxyVoiceTranscription(request, response) {
  if (!voiceUrl || !voiceApiKey) return json(response, 503, { error: 'capability_unavailable', capability: 'voice_transcription' });
  const body = await readJson(request);
  const upstream = await fetch(`${voiceUrl}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voiceApiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });
  const payload = await upstream.json().catch(() => ({ error: 'voice_service_invalid_response' }));
  return json(response, upstream.status, payload);
}

async function proxyVoiceSpeech(request, response) {
  if (!voiceUrl || !voiceApiKey) return json(response, 503, { error: 'capability_unavailable', capability: 'voice_synthesis' });
  const body = await readJson(request);
  const upstream = await fetch(`${voiceUrl}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voiceApiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  });
  const payload = await upstream.json().catch(() => ({ error: 'voice_service_invalid_response' }));
  return json(response, upstream.status, payload);
}

// Bob's brain: canonical planner (src/bob/planPrompt.js) → verifying subagent
// (src/bob/verify.js, different model identity) → one self-heal repair pass.
async function planBobTurn(request, response) {
  const body = await readJson(request);
  const result = await planTurn(body, { gateway: modelGateway });
  return json(response, result.status, result.body);
}

// One bounded step of a read-only subagent Bob delegated to; the conductor loops it.
async function runBobSubagentStep(request, response) {
  const body = await readJson(request);
  const result = await subagentStep(body, { gateway: modelGateway });
  return json(response, result.status, result.body);
}

async function bobHealth(_request, response) {
  const status = await modelGateway.status();
  return json(response, 200, { status: 'ok', service: 'fcm-api', bob: status });
}

async function loadAttachment(attachmentId) {
  if (!supabase || !isUuid(attachmentId)) throw new Error('valid_attachment_id_required');
  const { data: attachment, error } = await supabase.from('bob_attachments')
    .select('id,organization_id,file_name,file_type,file_size_bytes,storage_bucket,storage_path')
    .eq('id', attachmentId).maybeSingle();
  if (error || !attachment) throw new Error('attachment_not_found');
  if (Number(attachment.file_size_bytes) > maxIdentityBytes) throw new Error('identity_document_too_large');
  const downloaded = await supabase.storage.from(attachment.storage_bucket).download(attachment.storage_path);
  if (downloaded.error || !downloaded.data) throw new Error('attachment_download_failed');
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  if (!bytes.length || bytes.length > maxIdentityBytes) throw new Error('identity_document_size_invalid');
  return { attachment, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function tesseractText(filePath) {
  const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout', '-l', 'eng', '--psm', '6'], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  return String(stdout || '').trim();
}

async function ocrAttachment(attachmentId, identityContext = null) {
  const loaded = await loadAttachment(attachmentId);
  if (loaded.attachment.storage_bucket === 'identity-evidence'
      && (!identityContext || loaded.attachment.organization_id !== identityContext.organization_id)) {
    throw new Error('identity_attachment_scope_mismatch');
  }
  const bytes = loaded.bytes;
  const isPdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const isBmp = bytes.subarray(0, 2).toString('ascii') === 'BM';
  const isTiff = bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
  if (!isPdf && !isJpeg && !isPng && !isWebp && !isBmp && !isTiff) throw new Error('unsupported_identity_document_type');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fcm-identity-'));
  const extension = isPdf ? '.pdf' : isJpeg ? '.jpg' : isPng ? '.png' : isWebp ? '.webp' : isBmp ? '.bmp' : '.tiff';
  const sourcePath = path.join(work, `source${extension}`);
  try {
    await fs.writeFile(sourcePath, loaded.bytes, { mode: 0o600 });
    let pages = [sourcePath];
    if (isPdf) {
      const prefix = path.join(work, 'page');
      await execFileAsync('pdftoppm', ['-f', '1', '-l', '4', '-jpeg', '-r', '220', sourcePath, prefix], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
      pages = (await fs.readdir(work)).filter((name) => /^page-.*\.jpg$/i.test(name)).sort().map((name) => path.join(work, name));
      if (!pages.length) throw new Error('identity_pdf_render_failed');
    }
    const text = (await Promise.all(pages.map(tesseractText))).filter(Boolean).join('\n\n').slice(0, 40_000);
    return {
      ...loaded,
      text,
      pageCount: pages.length,
      provider: 'tesseract-5',
      detectedMime: isPdf ? 'application/pdf' : isJpeg ? 'image/jpeg' : isPng ? 'image/png' : isWebp ? 'image/webp' : isBmp ? 'image/bmp' : 'image/tiff',
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function inferIdentityImage(loaded) {
  if (!inferenceServiceUrl || !loaded.detectedMime?.startsWith('image/')) return { face_count: 0, face_embedding: null, face_confidence: null };
  const form = new FormData();
  form.append('photo', new Blob([loaded.bytes], { type: loaded.detectedMime }), loaded.attachment.file_name);
  form.append('tasks', JSON.stringify(['face']));
  form.append('source_frame_hash', loaded.sha256);
  const response = await fetch(`${inferenceServiceUrl}/infer/face`, {
    method: 'POST',
    headers: inferenceApiKey ? { Authorization: `Bearer ${inferenceApiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) return { face_count: 0, face_embedding: null, face_confidence: null, face_error: `identity_face_http_${response.status}` };
  const payload = await response.json();
  const faces = Array.isArray(payload?.faces) ? payload.faces : [];
  const face = faces.length === 1 ? faces[0] : null;
  return {
    face_count: faces.length,
    face_embedding: Array.isArray(face?.embedding) ? face.embedding : null,
    face_confidence: Number.isFinite(Number(face?.confidence ?? face?.det_score)) ? Number(face.confidence ?? face.det_score) : null,
    face_model: 'sface',
    face_authority: 'provisional_source_image',
  };
}

async function identityDocument(request, response, ocrOnly = false) {
  const body = await readJson(request);
  const documentKind = String(body.document_kind || 'other_identity');
  const context = ocrOnly ? null : verifiedIdentityContext(request, String(body.attachment_id || ''));
  const loaded = await ocrAttachment(String(body.attachment_id || ''), context);
  if (ocrOnly) return json(response, 200, { ocr: { text: loaded.text, provider: loaded.provider, page_count: loaded.pageCount, sha256: loaded.sha256, review_required: true } });
  const image = await inferIdentityImage(loaded);
  const definitionResult = await supabase.from('identity_document_type_definitions')
    .select('document_kind,display_name,category,canonical_destination,staff_credential_type,default_authorized_activities,extraction_rules')
    .eq('document_kind', documentKind).eq('active', true).maybeSingle();
  const definition = identityDocumentDefinition(documentKind, definitionResult.data);
  return json(response, 200, {
    success: true,
    attachment_id: loaded.attachment.id,
    document_kind: documentKind,
    sha256: loaded.sha256,
    ocr: { text: loaded.text, provider: loaded.provider, page_count: loaded.pageCount, review_required: true },
    proposed_fields: extractIdentityFields(loaded.text, documentKind, definition),
    classification: classifyIdentityDocument(loaded.text, documentKind, definition),
    document_definition: {
      label: definition.label,
      category: definition.category,
      credential_type: definition.credential_type,
      authorized_activities: definition.activity ? [definition.activity] : definition.default_authorized_activities ?? [],
    },
    image,
    authority: 'provisional',
    review_required: true,
  });
}

const maxDocumentBytes = Number(process.env.BOB_DOCUMENT_MAX_BYTES || 40 * 1024 * 1024);

async function extractDocumentText(attachment, kind) {
  if (Number(attachment.file_size_bytes) > maxDocumentBytes) throw new Error('document_too_large');
  const downloaded = await supabase.storage.from(attachment.storage_bucket).download(attachment.storage_path);
  if (downloaded.error || !downloaded.data) throw new Error('attachment_download_failed');
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  if (kind === 'text') return bytes.toString('utf8').slice(0, 60_000);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fcm-doc-'));
  const sourcePath = path.join(work, `source.${kind === 'image' ? 'img' : kind}`);
  try {
    await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
    if (kind === 'pdf') {
      const { stdout } = await execFileAsync('pdftotext', ['-layout', '-l', '30', sourcePath, '-'], { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
      return String(stdout || '').slice(0, 60_000);
    }
    if (kind === 'docx') {
      const { stdout } = await execFileAsync('unzip', ['-p', sourcePath, 'word/document.xml'], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
      return docxXmlToText(stdout).slice(0, 60_000);
    }
    if (kind === 'image') return (await tesseractText(sourcePath)).slice(0, 60_000);
    return '';
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

const documentReader = supabase ? createDocumentReader({ supabase, gateway: modelGateway, extract: extractDocumentText }) : null;

async function understandDocumentsBatch(request, response) {
  if (!documentReader) return json(response, 503, { error: 'capability_unavailable', capability: 'document_understanding' });
  const body = await readJson(request);
  const result = await documentReader.understandBatch(body);
  return json(response, result.status, result.body);
}

function bearerToken(request) {
  const value = request.headers.authorization || '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function ingestMotion(request, response) {
  if (!workloadSigningSecret || !supabase) return json(response, 503, { ok: false, error: 'workload_ingestion_not_configured' });
  const body = await readJson(request);
  const required = ['inference_job_id', 'evidence_item_id', 'motion_summary'];
  if (required.some((key) => body[key] === undefined || body[key] === null)) {
    return json(response, 400, { ok: false, error: 'inference_job_id, evidence_item_id, and motion_summary are required' });
  }
  if (!isUuid(body.inference_job_id) || !isUuid(body.evidence_item_id) || !body.motion_summary || !Array.isArray(body.motion_summary.motion_segments)) {
    return json(response, 422, { ok: false, error: 'invalid motion ingestion payload' });
  }
  const token = bearerToken(request);
  const previewClaims = verifyJobToken(token, workloadSigningSecret);
  if (previewClaims.inference_job_id !== body.inference_job_id || previewClaims.evidence_item_id !== body.evidence_item_id || (body.organization_id && previewClaims.organization_id !== body.organization_id)) {
    return json(response, 403, { ok: false, error: 'workload token claims do not match payload' });
  }
  const claims = await verifyAndConsumeToken(token, workloadSigningSecret, supabase);
  const { data, error } = await supabase.rpc('complete_motion_inference', {
    p_job_id: claims.inference_job_id,
    p_evidence_id: claims.evidence_item_id,
    p_org_id: claims.organization_id,
    p_motion_result: body.motion_summary
  });
  if (error) throw new Error(`motion persistence failed: ${error.message}`);
  return json(response, 200, { ok: true, status: 'success', inference_result_id: data });
}

async function routeGuidance(request, response) {
  if (!osrmUrl) return json(response, 503, { error: 'capability_unavailable', capability: 'route_guidance' });
  const body = await readJson(request);
  const values = ['origin_lat', 'origin_lng', 'destination_lat', 'destination_lng'].map((key) => Number(body[key]));
  if (!Number.isFinite(values[0]) || !Number.isFinite(values[1]) || !Number.isFinite(values[2]) || !Number.isFinite(values[3]) || Math.abs(values[0]) > 90 || Math.abs(values[2]) > 90 || Math.abs(values[1]) > 180 || Math.abs(values[3]) > 180) return json(response, 400, { error: 'valid_origin_and_destination_coordinates_required' });
  const [originLat, originLng, destinationLat, destinationLng] = values;
  const url = `${osrmUrl}/route/v1/driving/${originLng},${originLat};${destinationLng},${destinationLat}?overview=full&geometries=geojson&steps=true`;
  const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const payload = await upstream.json().catch(() => null);
  const route = payload?.routes?.[0];
  if (!upstream.ok || !route) return json(response, 502, { error: 'route_guidance_unavailable' });
  const steps = (route.legs?.[0]?.steps ?? []).slice(0, 30).map((step) => ({
    instruction: [step.maneuver?.type, step.maneuver?.modifier, step.name].filter(Boolean).join(' '),
    distance_meters: Math.round(Number(step.distance) || 0),
    duration_seconds: Math.round(Number(step.duration) || 0),
  }));
  return json(response, 200, { distance_meters: Math.round(route.distance), duration_seconds: Math.round(route.duration), geometry: route.geometry?.coordinates ?? [], steps });
}

async function routePlan(request, response) {
  if (!osrmUrl) return json(response, 503, { error: 'capability_unavailable', capability: 'route_plan' });
  const body = await readJson(request);
  const originLat = Number(body.origin_lat), originLng = Number(body.origin_lng);
  const stops = Array.isArray(body.stops) ? body.stops.slice(0, 24) : [];
  if (!Number.isFinite(originLat) || !Number.isFinite(originLng) || !stops.length || stops.some((stop) => !stop?.id || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng)))) return json(response, 400, { error: 'valid_origin_and_stops_required' });
  const points = [{ lat: originLat, lng: originLng }, ...stops.map((stop) => ({ lat: Number(stop.lat), lng: Number(stop.lng) }))];
  const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(';');
  const upstream = await fetch(`${osrmUrl}/table/v1/driving/${coordinates}?annotations=duration,distance`, { signal: AbortSignal.timeout(12_000) });
  const matrix = await upstream.json().catch(() => null);
  if (!upstream.ok || !Array.isArray(matrix?.durations)) return json(response, 502, { error: 'route_plan_unavailable' });
  const priorityWeight = { urgent: 0, high: 60, normal: 180, low: 360 };
  const pending = stops.map((stop, index) => ({ ...stop, matrixIndex: index + 1 }));
  const ordered = [];
  let currentIndex = 0;
  let elapsedSeconds = 0;
  while (pending.length) {
    const now = Date.now();
    pending.sort((left, right) => {
      const leftTravel = Number(matrix.durations[currentIndex]?.[left.matrixIndex] ?? Infinity);
      const rightTravel = Number(matrix.durations[currentIndex]?.[right.matrixIndex] ?? Infinity);
      const leftDeadline = left.sla_respond_by ? new Date(left.sla_respond_by).getTime() : Infinity;
      const rightDeadline = right.sla_respond_by ? new Date(right.sla_respond_by).getTime() : Infinity;
      const leftLate = Math.max(0, now + (elapsedSeconds + leftTravel) * 1000 - leftDeadline) / 1000;
      const rightLate = Math.max(0, now + (elapsedSeconds + rightTravel) * 1000 - rightDeadline) / 1000;
      const leftScore = leftLate * 1_000_000 + leftTravel + (priorityWeight[left.priority] ?? 720);
      const rightScore = rightLate * 1_000_000 + rightTravel + (priorityWeight[right.priority] ?? 720);
      return leftScore - rightScore;
    });
    const next = pending.shift();
    const travelSeconds = Number(matrix.durations[currentIndex]?.[next.matrixIndex] ?? 0);
    const distanceMeters = Number(matrix.distances?.[currentIndex]?.[next.matrixIndex] ?? 0);
    elapsedSeconds += travelSeconds;
    const deadline = next.sla_respond_by ? new Date(next.sla_respond_by).getTime() : null;
    ordered.push({ id: next.id, kind: next.kind ?? 'dispatch', eta_seconds: Math.round(elapsedSeconds), distance_meters: Math.round(distanceMeters), sla_risk: deadline && Date.now() + elapsedSeconds * 1000 > deadline ? 'at_risk' : 'on_track' });
    elapsedSeconds += Number(next.dwell_seconds ?? 300);
    currentIndex = next.matrixIndex;
  }
  return json(response, 200, { stops: ordered });
}

http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', service: 'fcm-api' });
  if (request.method === 'POST' && request.url === '/api/v1/compliance/motion-ingestion') {
    try {
      return await ingestMotion(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'motion ingestion failed';
      console.error(JSON.stringify({ event: 'motion_ingestion_failed', message }));
      const status = /token|credential|signature|expired|claim|invalid/.test(message)
        ? 401
        : message === 'request_body_too_large' ? 413 : 502;
      return json(response, status, { ok: false, error: message });
    }
  }
  if (request.method === 'POST' && request.url === '/api/bob/plan') {
    if (!apiToken) return json(response, 503, { error: 'api_authentication_not_configured' });
    if (!authorized(request)) return json(response, 401, { error: 'unauthorized' });
    try {
      return await planBobTurn(request, response);
    } catch (error) {
      return json(response, 502, { ok: false, error: error instanceof Error ? error.message : 'planning_failed', route_selected: 'error' });
    }
  }
  if (!apiToken) return json(response, 503, { error: 'api_authentication_not_configured' });
  if (!authorized(request)) return json(response, 401, { error: 'unauthorized' });
  try {
    if (request.method === 'POST' && request.url === '/api/bob/subagent') return await runBobSubagentStep(request, response);
    if (request.method === 'GET' && request.url === '/api/bob/health') return await bobHealth(request, response);
    if (request.method === 'POST' && request.url === '/api/bob/voice/transcribe') return await proxyVoiceTranscription(request, response);
    if (request.method === 'POST' && request.url === '/api/bob/voice/speak') return await proxyVoiceSpeech(request, response);
    if (request.method === 'POST' && request.url === '/api/bob/media/ocr-image') return await identityDocument(request, response, true);
    if (request.method === 'POST' && request.url === '/api/bob/media/identity-document') return await identityDocument(request, response, false);
    if (request.method === 'POST' && request.url === '/api/bob/documents/understand-batch') return await understandDocumentsBatch(request, response);
    if (request.method === 'POST' && request.url === '/api/navigation/route') return await routeGuidance(request, response);
    if (request.method === 'POST' && request.url === '/api/navigation/plan') return await routePlan(request, response);
    return json(response, 503, { error: 'capability_unavailable', capability: 'unrecovered_fcm_api_route' });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : 'request_failed' });
  }
}).listen(port, '0.0.0.0', () => console.log(`[fcm-api] listening on ${port}`));