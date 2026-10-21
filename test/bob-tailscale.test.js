const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTailscale, ownerRetainsAccess, tailscaleConfig } = require('../bob-tailscale');

const owner = 'owner@example.test';
const policy = { grants: [{ src: [owner], dst: ['*'], ip: ['*'] }] };
const env = {
  TAILSCALE_OAUTH_CLIENT_ID: 'test-client',
  TAILSCALE_OAUTH_CLIENT_SECRET: 'test-secret',
  TAILSCALE_OWNER_LOGIN: owner,
};

function api({ current = {}, failWrite = false, etag = '"version-1"' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/oauth/token')) {
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.endsWith('/devices')) {
      return Response.json({ devices: [{ hostname: 'test-vps', addresses: ['100.64.0.1'], nodeKey: 'not-for-output' }] });
    }
    if (url.endsWith('/acl/validate')) return Response.json({});
    if (options.method === 'POST') {
      return failWrite
        ? new Response('sensitive upstream failure', { status: 412 })
        : new Response(JSON.stringify(policy), { headers: { etag: '"version-2"' } });
    }
    return new Response(JSON.stringify(current), { headers: { etag } });
  };
  return { calls, fetchImpl };
}

test('credentials are optional, server-side and never returned by status', async () => {
  assert.equal(tailscaleConfig({}).configured, false);
  await assert.rejects(createTailscale({ env: {} }).status(), /not configured/);
  const fake = api();
  const client = createTailscale({ env, fetchImpl: fake.fetchImpl });
  const status = await client.status();
  await client.acl({ op: 'get' });
  assert.equal(status.devices.length, 1);
  assert.equal(JSON.stringify(status).includes('not-for-output'), false);
  assert.equal(JSON.stringify(status).includes('test-secret'), false);
  assert.equal(fake.calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
  const form = new URLSearchParams(fake.calls[0].body);
  assert.equal(form.get('grant_type'), 'client_credentials');
});

test('owner guard checks a real unrestricted grant, not text or a restricted rule', () => {
  assert.equal(ownerRetainsAccess(policy, owner), true);
  assert.equal(ownerRetainsAccess({ acls: [{ action: 'accept', src: [owner], dst: ['*:*'] }] }, owner), true);
  for (const invalid of [
    { comment: owner },
    { grants: [{ src: [owner], dst: ['*'], ip: ['tcp:22'] }] },
    { grants: [{ src: [owner], dst: ['*'], ip: ['*'], srcPosture: ['posture:restricted'] }] },
    { acls: [{ action: 'accept', src: ['*'], dst: [`${owner}:22`] }] },
  ]) assert.equal(ownerRetainsAccess(invalid, owner), false);
  assert.equal(ownerRetainsAccess(policy, ''), false);
});

test('ACL writes validate, compare etags, save private backups and conditionally write', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-tailnet-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const fake = api();
  const client = createTailscale({ env, stateDir, fetchImpl: fake.fetchImpl });
  const result = await client.acl({ op: 'set', policy: JSON.stringify(policy), ifMatch: '"version-1"' });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(result.previous_policy_backup, 'utf8'), '{}');
  assert.equal(fs.statSync(result.previous_policy_backup).mode & 0o777, 0o600);
  assert.deepEqual(fake.calls.slice(1).map(call => [call.method, new URL(call.url).pathname.split('/').slice(-2).join('/')]), [
    ['POST', 'acl/validate'], ['GET', '-/acl'], ['POST', '-/acl'],
  ]);
  assert.equal(fake.calls.at(-1).headers['If-Match'], '"version-1"');
});

test('ACL writes reject stale reads, changed SSH rules and missing preconditions', async () => {
  const fake = api({ current: { ssh: [{ action: 'check' }] } });
  const client = createTailscale({ env, fetchImpl: fake.fetchImpl });
  await assert.rejects(client.acl({ op: 'set', policy: '{}' }), /if_match/);
  await assert.rejects(client.acl({ op: 'set', policy: '{invalid}', ifMatch: '"version-1"' }), /valid JSON/);
  await assert.rejects(client.acl({ op: 'set', policy: '{}', ifMatch: '"version-1"' }), /configured owner/);
  await assert.rejects(client.acl({ op: 'set', policy: JSON.stringify(policy), ifMatch: '"stale"' }), /changed since/);
  await assert.rejects(client.acl({ op: 'set', policy: JSON.stringify(policy), ifMatch: '"version-1"' }), /SSH rules/);
  assert.equal(fake.calls.some(call => call.method === 'POST' && call.url.endsWith('/acl')), false);
});

test('upstream failures are explicit without echoing sensitive response bodies', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-tailnet-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const fake = api({ failWrite: true });
  const client = createTailscale({ env, stateDir, fetchImpl: fake.fetchImpl });
  await assert.rejects(
    client.acl({ op: 'set', policy: JSON.stringify(policy), ifMatch: '"version-1"' }),
    error => /HTTP 412/.test(error.message) && !error.message.includes('sensitive'),
  );
});

test('autonomous engineers advertise only configured host controls', () => {
  const { systemPrompt, DEFAULT_LIMITS } = require('../builder-agentic-engineer');
  const prompt = firewall => systemPrompt({ lane: 'backend', limits: DEFAULT_LIMITS, firewall });
  assert.doesNotMatch(prompt(false), /firewall_change/);
  assert.match(prompt({ tailnet: false }), /firewall_change/);
  assert.doesNotMatch(prompt({ tailnet: false }), /tailnet_acl/);
  assert.match(prompt({ tailnet: true }), /tailnet_acl/);
});
