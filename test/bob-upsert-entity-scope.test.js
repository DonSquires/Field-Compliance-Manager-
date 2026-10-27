const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/bob-upsert-entity/index.ts'), 'utf8')
  .replace(/import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"];?/g, '');

function harness({ inactive = false, targetOrg = 'other-org', staffOrg = 'own-org', authorityError = false } = {}) {
  let handler;
  const writes = [];
  const checks = [];
  function client(service) {
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'actor' } }, error: null }) },
      rpc: async (name, args) => {
        assert.equal(service, false, 'authority must use the human JWT');
        assert.equal(name, 'is_admin_for_org');
        assert.deepEqual(Object.keys(args), ['target_org_id']);
        checks.push(args.target_org_id);
        return { data: args.target_org_id === 'own-org', error: authorityError ? { message: 'unavailable' } : null };
      },
      from(table) {
        let id;
        let activeOnly = false;
        const row = () => table === 'user_profiles' && id === 'actor'
          ? activeOnly && inactive ? null : { id, role: 'admin_officer', organization_id: 'own-org' }
          : table === 'staff_profiles'
            ? { id, organization_id: staffOrg }
            : { id: targetOrg, organization_id: targetOrg, client_organization_id: targetOrg, provider_organization_id: targetOrg, staff_id: 'staff' };
        const builder = {
          select() { return builder; },
          eq(column, value) { if (column === 'id') id = value; return builder; },
          is(column, value) { if (column === 'deactivated_at' && value === null) activeOnly = true; return builder; },
          limit() { return builder; },
          single: async () => ({ data: row(), error: null }),
          maybeSingle: async () => ({ data: row(), error: null }),
          then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
          insert(value) { writes.push({ table, value }); return builder; },
          update(value) { writes.push({ table, value }); return builder; },
        };
        return builder;
      },
    };
  }
  const environment = { SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', SUPABASE_ANON_KEY: 'test-anon-key' };
  vm.runInNewContext(source, {
    serve: fn => { handler = fn; },
    createClient: (_url, key) => client(key === environment.SUPABASE_SERVICE_ROLE_KEY),
    Deno: { env: { get: name => environment[name] } },
    Response, console,
  });
  return {
    writes, checks,
    invoke: (body, service = false) => handler(new Request('https://example.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${service ? 'test-service-key' : 'test-human-token'}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ human_invoked: true, dry_run: false, provenance: { source: 'fixture' }, ...body }),
    })),
  };
}

for (const entity of ['client_org', 'client_site', 'contact', 'service_agreement', 'staff_profile', 'invoice', 'credential', 'shift_template']) {
  test(`${entity} updates cannot target another tenant`, async () => {
    const h = harness({ staffOrg: 'other-org' });
    const response = await h.invoke({ entity, mode: 'update', target_id: 'target', data: { name: 'Fixture' } });
    assert.equal(response.status, 403);
    assert.equal(h.writes.length, 0);
  });
}

for (const [entity, data] of [
  ['invoice', { organization_id: 'other-org' }],
  ['contact', { organization_id: 'other-org' }],
  ['shift_template', { organization_id: 'other-org' }],
  ['client_org', { parent_organization_id: 'other-org' }],
  ['client_site', { client_organization_id: 'other-org' }],
  ['service_agreement', { provider_organization_id: 'own-org', client_organization_id: 'other-org' }],
  ['user', { organization_id: 'other-org' }],
  ['credential', { organization_id: 'own-org', staff_id: 'other-staff' }],
]) {
  test(`${entity} creation requires authority over the parent`, async () => {
    const h = harness({ staffOrg: 'other-org' });
    const response = await h.invoke({ entity, mode: 'create', data });
    assert.equal(response.status, 403);
    assert.equal(h.writes.length, 0);
  });
}

test('a proposed parent change requires authority over both sides', async () => {
  const h = harness({ targetOrg: 'own-org' });
  const response = await h.invoke({ entity: 'client_org', mode: 'update', target_id: 'own-org', data: { parent_organization_id: 'other-org' } });
  assert.equal(response.status, 403);
  assert.deepEqual(h.checks, ['own-org', 'other-org']);
  assert.equal(h.writes.length, 0);
});

test('active authorised humans and the separate service path can still update', async () => {
  for (const service of [false, true]) {
    const h = harness({ targetOrg: 'own-org' });
    const response = await h.invoke({ entity: 'credential', mode: 'update', target_id: 'target', data: { issuing_authority: 'Fixture' } }, service);
    assert.equal(response.status, 200);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.checks, service ? [] : ['own-org']);
  }
});

test('inactive callers and failed authority checks stop before any mutation', async () => {
  for (const options of [{ inactive: true }, { authorityError: true }]) {
    const h = harness(options);
    const response = await h.invoke({ entity: 'invoice', mode: 'create', data: { organization_id: 'own-org' } });
    assert.equal(response.status, options.inactive ? 403 : 500);
    assert.equal(h.writes.length, 0);
  }
});
