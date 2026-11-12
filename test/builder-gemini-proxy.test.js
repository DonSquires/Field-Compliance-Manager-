'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const handler = () => import('../supabase/functions/_shared/builder-gemini-proxy.mjs');
const env = { SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', GOOGLE_API_TOKEN: 'synthetic-google' };
const request = (body, overrides = {}) => new Request('https://fixture.supabase.co/functions/v1/bob-gemini-gateway/chat/completions', {
  method: 'POST', headers: { Authorization: 'Bearer synthetic-service' },
  body: JSON.stringify(body), ...overrides,
});
const body = { model: 'gemini-approved', messages: [{ role: 'user', content: 'Synthetic probe' }], max_tokens: 32 };

test('Gemini proxy denies non-service callers before contacting Google', async () => {
  const { handleGeminiProxy } = await handler();
  for (const authorization of ['', 'Bearer anon', 'Bearer user-session']) {
    const result = await handleGeminiProxy(request(body, { headers: { Authorization: authorization } }), {
      env, fetchImpl: () => assert.fail('denied callers must not reach Google'),
    });
    assert.equal(result.status, 401);
  }
});

test('Gemini proxy uses its Supabase secret only against the fixed Google endpoint', async () => {
  const { handleGeminiProxy } = await handler();
  const result = await handleGeminiProxy(request(body), {
    env,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer synthetic-google');
      assert.equal(init.headers.Authorization.includes('synthetic-service'), false);
      assert.deepEqual(JSON.parse(init.body), body);
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    },
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).choices[0].message.content, '{"ok":true}');
});

test('Gemini proxy validates bounded text-only requests without accepting caller endpoints', async () => {
  const { handleGeminiProxy } = await handler();
  for (const invalid of [
    { ...body, model: 'not-gemini' }, { ...body, stream: true }, { ...body, url: 'http://private' },
    { ...body, max_tokens: 1000000 }, { ...body, messages: [{ role: 'user', content: [{ image_url: 'private' }] }] },
  ]) {
    const result = await handleGeminiProxy(request(invalid), { env, fetchImpl: () => assert.fail('invalid request') });
    assert.equal(result.status, 400);
  }
  const oversized = await handleGeminiProxy(request({ ...body, messages: [{ role: 'user', content: 'x'.repeat(1_200_001) }] }), { env });
  assert.equal(oversized.status, 413);
});

test('Gemini proxy rejects gateway-name lookalikes and unrelated route prefixes', async () => {
  const { handleGeminiProxy } = await handler();
  for (const pathname of ['/unrelated/chat/completions', '/bob-gemini-gateway-extra/chat/completions', '/other/bob-gemini-gateway/chat/completions']) {
    const result = await handleGeminiProxy(new Request(`https://fixture${pathname}`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }, body: JSON.stringify(body),
    }), { env, fetchImpl: () => assert.fail('invalid route must not reach Google') });
    assert.equal(result.status, 404);
  }
});

test('Gemini proxy accepts byte-bounded continuations longer than 200 messages', async () => {
  const { handleGeminiProxy } = await handler();
  const messages = Array.from({ length: 202 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Synthetic step' }));
  const result = await handleGeminiProxy(request({ ...body, messages }), {
    env, fetchImpl: async (url, init) => {
      assert.equal(JSON.parse(init.body).messages.length, messages.length);
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    },
  });
  assert.equal(result.status, 200);
});

test('Gemini proxy returns redacted errors when either JSON stream disconnects', async () => {
  const { handleGeminiProxy } = await handler();
  const broken = () => new ReadableStream({ start(controller) { controller.error(new TypeError('synthetic private stream')); } });
  const failedRequest = new Request('https://fixture/bob-gemini-gateway/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }, body: broken(), duplex: 'half',
  });
  const inputError = await handleGeminiProxy(failedRequest, { env, fetchImpl: () => assert.fail('invalid stream') });
  assert.equal(inputError.status, 400);
  const upstreamError = await handleGeminiProxy(request(body), { env, fetchImpl: async () => new Response(broken()) });
  assert.equal(upstreamError.status, 502);
  assert.doesNotMatch(await upstreamError.text(), /private stream/);
});

test('Gemini proxy preserves failures without echoing upstream details or credentials', async () => {
  const { handleGeminiProxy } = await handler();
  const unavailable = await handleGeminiProxy(request(body), { env: { SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY } });
  assert.equal(unavailable.status, 503);
  const denied = await handleGeminiProxy(request(body), {
    env, fetchImpl: async () => Response.json({ error: { message: 'synthetic-google raw private request' } }, { status: 403 }),
  });
  assert.equal(denied.status, 403);
  assert.doesNotMatch(await denied.text(), /synthetic-google|raw private/);
  const models = await handleGeminiProxy(new Request('https://fixture/bob-gemini-gateway/models', { headers: { Authorization: 'Bearer synthetic-service' } }), {
    env, fetchImpl: async () => Response.json({ data: [{ id: 'gemini-approved' }] }),
  });
  assert.equal((await models.json()).data[0].id, 'gemini-approved');
});
