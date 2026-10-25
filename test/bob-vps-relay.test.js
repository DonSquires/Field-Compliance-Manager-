'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../supabase/functions/_shared/vps-relay.mjs');

test('relay falls through missing legacy routes to the control plane using its own credential', async () => {
  const { relayVpsRead } = await load();
  const calls = [];
  const result = await relayVpsRead({
    path: '/assessment', stackBase: 'https://legacy.invalid/api', stackToken: 'legacy-only',
    controlBase: 'https://control.invalid/api/bob/builder/', controlToken: 'control-only',
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      calls.push([url, options.headers.authorization, options.signal]);
      return url.startsWith('https://legacy.invalid') ? new Response('', { status: 404 })
        : Response.json({ fileCount: 42 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.fileCount, 42);
  assert.equal(calls.length, 4);
  assert.ok(calls.slice(0, 3).every(([, auth]) => auth === 'Bearer legacy-only'));
  assert.deepEqual(calls[3].slice(0, 2), ['https://control.invalid/assessment', 'Bearer control-only']);
  assert.ok(calls.every(([, , signal]) => signal instanceof AbortSignal));
});

test('relay never combines incomplete credential pairs or retries permission failures elsewhere', async () => {
  const { relayVpsRead } = await load();
  const absent = await relayVpsRead({ path: '/assessment', stackBase: 'https://legacy.invalid', controlToken: 'other', fetchImpl: () => assert.fail('no complete pair') });
  assert.equal(absent.status, 503);
  let calls = 0;
  const denied = await relayVpsRead({ path: '/assessment', stackBase: 'https://legacy.invalid', stackToken: 'legacy',
    controlBase: 'https://control.invalid', controlToken: 'control', fetchImpl: async () => { calls++; return Response.json({ code: 'FORBIDDEN' }, { status: 403 }); } });
  assert.equal(denied.status, 403);
  assert.equal(calls, 1);
});

test('missing routes, network and invalid responses remain explicit failures', async () => {
  const { relayVpsRead } = await load();
  for (const [fetchImpl, status, code] of [
    [async () => new Response('', { status: 404 }), 404, 'RELAY_ROUTE_NOT_FOUND'],
    [async () => { throw new Error('credential-bearing message'); }, 502, 'RELAY_UNREACHABLE'],
    [async () => new Response('not JSON'), 502, 'RELAY_INVALID_RESPONSE'],
  ]) {
    const result = await relayVpsRead({ path: '/docker/services', controlBase: 'https://control.invalid', controlToken: 'private', fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
    assert.doesNotMatch(JSON.stringify(result), /credential-bearing|private/);
  }
});
