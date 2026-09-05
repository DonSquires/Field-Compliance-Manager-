const crypto = require('node:crypto');
const http = require('node:http');

const port = Number(process.env.PORT || 3000);
const apiToken = process.env.FCM_API_TOKEN || '';
const voiceUrl = (process.env.VOICE_URL || '').replace(/\/+$/, '');
const voiceApiKey = process.env.VOICE_API_KEY || '';
const maxBodyBytes = 2 * 1024 * 1024;

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

http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', service: 'fcm-api' });
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