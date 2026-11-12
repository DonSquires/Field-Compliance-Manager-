const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MAX_BYTES = 1_200_000;
const FIELDS = new Set(['model', 'messages', 'max_tokens', 'temperature', 'response_format']);
const failure = (status, error) => Response.json({ error }, { status });

async function boundedJson(message) {
  const reader = message.body?.getReader();
  if (!reader) throw new SyntaxError('JSON body required');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BYTES) {
      await reader.cancel();
      throw new RangeError('body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function validRequest(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => FIELDS.has(key))
    && /^gemini-[a-zA-Z0-9._-]{1,100}$/.test(body.model)
    && Array.isArray(body.messages) && body.messages.length > 0
    && body.messages.every(message => message && ['system', 'user', 'assistant'].includes(message.role)
      && typeof message.content === 'string' && Object.keys(message).every(key => ['role', 'content'].includes(key)))
    && (body.max_tokens === undefined || (Number.isInteger(body.max_tokens) && body.max_tokens >= 1 && body.max_tokens <= 16384))
    && (body.temperature === undefined || (Number.isFinite(body.temperature) && body.temperature >= 0 && body.temperature <= 2))
    && (body.response_format === undefined || (body.response_format?.type === 'json_object'
      && Object.keys(body.response_format).length === 1));
}

export async function handleGeminiProxy(request, { env, fetchImpl = globalThis.fetch }) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return failure(503, 'Gemini service authentication is not configured');
  if (request.headers.get('Authorization') !== `Bearer ${serviceKey}`) return failure(401, 'Service authentication required');
  const pathname = new URL(request.url).pathname;
  const route = pathname.match(/^\/(?:functions\/v1\/)?bob-gemini-gateway(\/.*)$/)?.[1];
  const models = request.method === 'GET' && route === '/models';
  const completion = request.method === 'POST' && route === '/chat/completions';
  if (!models && !completion) return failure(404, 'Unsupported Gemini gateway route');
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_TOKEN;
  if (!apiKey) return failure(503, 'Gemini credential is not configured in Supabase');
  let body;
  if (completion) {
    try {
      body = await boundedJson(request);
    } catch (error) {
      if (error instanceof RangeError) return failure(413, 'Gemini request exceeds the byte limit');
      if (error instanceof SyntaxError) return failure(400, 'Gemini request must be JSON');
      if (error instanceof TypeError || error?.name === 'AbortError') return failure(400, 'Gemini request stream was interrupted');
      throw error;
    }
    if (!validRequest(body)) return failure(400, 'Invalid Gemini text completion request');
  }
  let upstream;
  try {
    upstream = await fetchImpl(`${GOOGLE_BASE}${models ? '/models' : '/chat/completions'}`, {
      method: models ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(completion ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]),
    });
  } catch (error) {
    return failure(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502, 'Gemini transport unavailable');
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return failure(upstream.status, `Gemini upstream rejected the request (HTTP ${upstream.status})`);
  }
  try {
    return Response.json(await boundedJson(upstream));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return failure(502, 'Gemini returned an invalid or oversized response');
    if (error instanceof TypeError || error?.name === 'AbortError') return failure(502, 'Gemini response stream was interrupted');
    throw error;
  }
}
