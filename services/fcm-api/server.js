const crypto = require('node:crypto');
const http = require('node:http');
const { createClient } = require('@supabase/supabase-js');
const { verifyAndConsumeToken } = require('./src/security/job_token_consumer');
const { verifyJobToken } = require('./src/security/job_token_verifier');

const port = Number(process.env.PORT || 3000);
const apiToken = process.env.FCM_API_TOKEN || '';
const voiceUrl = (process.env.VOICE_URL || '').replace(/\/+$/, '');
const voiceApiKey = process.env.VOICE_API_KEY || '';
const workloadSigningSecret = process.env.WORKLOAD_SIGNING_SECRET || '';
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const maxBodyBytes = 2 * 1024 * 1024;
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

http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', service: 'fcm-api' });
  if (request.method === 'POST' && request.url === '/api/v1/compliance/motion-ingestion') {
    try {
      return await ingestMotion(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'motion ingestion failed';
      const status = /token|credential|signature|expired|claim|invalid/.test(message) ? 401 : 502;
      return json(response, status, { ok: false, error: message });
    }
  }
  if (!apiToken) return json(response, 503, { error: 'api_authentication_not_configured' });
  if (!authorized(request)) return json(response, 401, { error: 'unauthorized' });
  try {
    if (request.method === 'POST' && request.url === '/api/bob/voice/transcribe') return await proxyVoiceTranscription(request, response);
    if (request.method === 'POST' && request.url === '/api/bob/voice/speak') return await proxyVoiceSpeech(request, response);
    return json(response, 503, { error: 'capability_unavailable', capability: 'unrecovered_fcm_api_route' });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : 'request_failed' });
  }
}).listen(port, '0.0.0.0', () => console.log(`[fcm-api] listening on ${port}`));