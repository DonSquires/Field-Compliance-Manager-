const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/process-officer-scan/index.ts'), 'utf8')
  .replace(/import \{ serve \} from '[^']+';/, '')
  .replace(/import \{ createClient as _createClient \} from '[^']+';/, '');

function scanFixture({ confidence = 0, role = 'officer', uploadFails = false, registrationFails = false, parkingRule = true, policyFails = false, priorChalk = null, moduleKey = 'parking_enforcement', sessionFails = false } = {}) {
  let handler;
  let receipt = null;
  const uploads = [];
  const writes = [];
  class Query {
    constructor(table) { this.table = table; this.action = 'select'; }
    select() { return this; }
    eq() { return this; }
    is() { return this; }
    order() { return this; }
    limit() { return this; }
    in() { return this; }
    or() { return this; }
    single() { return this; }
    maybeSingle() { return this; }
    insert(value) { this.action = 'insert'; this.value = value; return this; }
    update(value) { this.action = 'update'; this.value = value; return this; }
    delete() { throw new Error('Request receipts must not be deleted to retry a scan'); }
    then(resolve, reject) {
      const result = { data: null, error: null };
      if (this.table === 'user_profiles') result.data = { id: '11111111-1111-4111-8111-111111111111', role, organization_id: '22222222-2222-4222-8222-222222222222' };
      if (this.table === 'location_zones') result.data = { id: '55555555-5555-4555-8555-555555555555', name: 'Synthetic policy Zone', location_id: null, module_key: moduleKey, boundary_verification: 'verified', parking_time_limit_minutes: parkingRule ? 90 : null, parking_signage_photo_url: parkingRule ? 'synthetic-sign.jpg' : null };
      if (this.table === 'canonical_vehicles') result.data = { rego_status: 'current', wof_status: 'current', cof_status: 'current', compliance_checked_at: new Date().toISOString() };
      if (this.table === 'parking_chalk_records') {
        if (this.action === 'select') result.data = priorChalk;
        else { writes.push({ table: this.table, action: this.action, value: this.value }); result.data = { id: '66666666-6666-4666-8666-666666666666' }; }
      }
      if (['observations', 'vehicle_overnight_sessions'].includes(this.table) && this.action !== 'select') {
        writes.push({ table: this.table, action: this.action, value: this.value });
        if (this.table === 'vehicle_overnight_sessions' && sessionFails) result.error = { code: 'XX000', message: 'synthetic session failure' };
        else result.data = { id: this.table === 'observations' ? '77777777-7777-4777-8777-777777777777' : '88888888-8888-4888-8888-888888888888' };
      }
      if (this.table === 'officer_command_requests') {
        if (this.action === 'select') result.data = receipt;
        else if (this.action === 'insert') receipt = { ...this.value, id: 'receipt', created_at: new Date().toISOString() };
        else Object.assign(receipt, this.value);
        if (this.action !== 'select') result.data = receipt;
      }
      return Promise.resolve(result).then(resolve, reject);
    }
  }
  const database = {
    auth: { getUser: async () => ({ data: { user: { id: '11111111-1111-4111-8111-111111111111' } }, error: null }) },
    from: (table) => new Query(table),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }), remove: async () => ({ error: null }), upload: async (storagePath) => {
      uploads.push(storagePath);
      return { data: uploadFails ? null : { path: storagePath }, error: uploadFails ? { message: 'synthetic storage outage' } : null };
    } }) },
    rpc: async (name) => {
      if (name === 'register_edge_court_photo') return { data: registrationFails ? null : '44444444-4444-4444-8444-444444444444', error: registrationFails ? { message: 'synthetic evidence failure' } : null };
      if (name === 'has_location_access') return { data: true, error: null };
      if (name === 'resolve_operational_context_authorized') return { data: [{ resolution_status: 'resolved', matched_zone_id: '55555555-5555-4555-8555-555555555555', site_id: null }], error: null };
      if (name === 'is_zone_closed') return { data: { closed: false }, error: null };
      if (name === 'classify_fc_overnight_window') return { data: [{ overnight_date: '2026-11-10', scan_window: 'evening' }], error: null };
      if (name === 'calculate_vehicle_compliance') {
        writes.push({ table: 'policy_evaluation', action: 'calculate' });
        return { data: { is_compliant: true, reason: 'compliant', nights_this_zone: 0, nights_this_month: 0, limit_consecutive: 2, limit_monthly: 4, scv_required: false }, error: null };
      }
      if (name === 'evaluate_parking_compliance') return { data: policyFails ? null : { verdict: priorChalk ? 'overstay' : 'clear', effective_limit_minutes: 90, grace_period_minutes: 5, is_overstay: Boolean(priorChalk), is_repeat: false, recommended_action: priorChalk ? 'infringement' : 'none' }, error: policyFails ? { message: 'synthetic policy outage' } : null };
      return { data: null, error: { message: 'synthetic stop after plate validation' } };
    },
  };
  const environment = { SUPABASE_URL: 'http://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INFERENCE_SERVICE_URL: 'http://inference.invalid', INFERENCE_API_KEY: 'synthetic-inference', PLATE_RECOGNIZER_API_TOKEN: 'synthetic-fallback' };
  const context = vm.createContext({
    serve: (callback) => { handler = callback; }, _createClient: () => database,
    Deno: { env: { get: (name) => environment[name] } },
    console: { log() {}, warn() {}, error() {} }, Request, Response, Blob, FormData,
    AbortController, AbortSignal, atob, btoa, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout, TextEncoder,
    fetch: async (url) => url.endsWith('/infer/watermark') ? new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } }) : url.includes('platerecognizer')
      ? new Response('{}', { status: 403 })
      : Response.json(url.endsWith('/infer/alpr') ? { success: true, results: confidence ? [{ plate: 'SYN123', score: confidence }] : [] } : { success: false }),
  });
  vm.runInContext(source, context);
  const body = { client_request_id: '33333333-3333-4333-8333-333333333333', module_key: 'freedom_camping', gps_lat: 0, gps_lng: 0, image_base64: 'YQ==', captured_at: '2026-11-10T07:00:00Z' };
  return {
    receipt: () => receipt,
    uploads,
    writes,
    request: async (changes = {}) => {
      const response = await handler(new Request('http://fixture.invalid', { method: 'POST', headers: { Authorization: 'Bearer synthetic-user', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...changes }) }));
      return { status: response.status, body: await response.json() };
    },
  };
}

test('ALPR rejection finalizes a retryable failure and the same request is not poisoned', async () => {
  const fixture = scanFixture();
  const first = await fixture.request();
  assert.equal(first.status, 400);
  assert.equal(first.body.code, 'plate_confirmation_required');
  assert.equal(first.body.capture_saved, true);
  assert.equal(fixture.uploads.length, 1);
  assert.equal(fixture.receipt().command_status, 'failed');
  assert.equal((await fixture.request()).status, 400);
  assert.equal(fixture.uploads.length, 1);
});

test('a failed photo upload cannot claim a saved capture', async () => {
  const result = await scanFixture({ uploadFails: true }).request();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'capture_storage_failed');
  assert.equal(result.body.capture_saved, false);
});

test('a failed evidence registration is never reported as a confirmed capture', async () => {
  const result = await scanFixture({ registrationFails: true }).request();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'capture_registration_failed');
  assert.equal(result.body.capture_saved, false);
});

test('a request ID cannot silently change its plate or capture evidence', async () => {
  const fixture = scanFixture();
  await fixture.request();
  const changed = await fixture.request({ plate_number: 'SYN123' });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'scan_request_mismatch');
  assert.equal(fixture.uploads.length, 1);
});

test('failed external fallback never confirms a low-confidence local plate', async () => {
  const result = await scanFixture({ confidence: 0.1 }).request();
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'plate_confirmation_required');
});

test('non-operational roles cannot use the service-role scan pipeline', async () => {
  const result = await scanFixture({ role: 'client_user' }).request();
  assert.equal(result.status, 403);
});

test('Parking without a source-backed rule keeps the photo but never invents a chalk time', async () => {
  const fixture = scanFixture({ parkingRule: false });
  const result = await fixture.request({ module_key: 'parking_enforcement', plate_number: 'SYN123' });
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'parking_rule_review_required');
  assert.equal(result.body.capture_saved, true);
  assert.equal(fixture.writes.length, 0);
});

test('Parking evaluator errors keep the photo without a false clear verdict', async () => {
  const fixture = scanFixture({ policyFails: true });
  const result = await fixture.request({ module_key: 'parking_enforcement', plate_number: 'SYN123' });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'parking_policy_unavailable');
  assert.equal(fixture.writes.length, 0);
});

test('Parking return evidence reuses the first chalk and withholds an unconfirmed overstay', async () => {
  const fixture = scanFixture({ priorChalk: { id: '66666666-6666-4666-8666-666666666666', photo_url: 'first-photo.jpg', photo_urls: [], chalked_at: '2026-11-10T05:00:00Z' } });
  const result = await fixture.request({ module_key: 'parking_enforcement', plate_number: 'SYN123' });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.verdict, 'unknown');
  assert.equal(result.body.is_overstay, false);
  assert.equal(fixture.writes.some((write) => write.action === 'insert'), false);
  assert.equal(fixture.writes[0].value.photo_url, 'first-photo.jpg');
  assert.equal(fixture.writes[0].value.photo_urls.length, 1);
});

test('Camping persists real observation evidence before one session write and policy evaluation', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping' });
  const result = await fixture.request({ plate_number: 'SYN123' });
  assert.equal(result.status, 200);
  assert.equal(result.body.observation_id, '77777777-7777-4777-8777-777777777777');
  const sessionWrites = fixture.writes.filter((write) => write.table === 'vehicle_overnight_sessions' && write.action === 'insert');
  assert.equal(sessionWrites.length, 1);
  assert.equal(sessionWrites[0].value.evening_observation_id, result.body.observation_id);
  assert.ok(sessionWrites[0].value.evening_photo_url);
  assert.ok(fixture.writes.findIndex((write) => write.table === 'observations' && write.action === 'update') < fixture.writes.indexOf(sessionWrites[0]));
  assert.ok(fixture.writes.indexOf(sessionWrites[0]) < fixture.writes.findIndex((write) => write.table === 'policy_evaluation'));
  const count = fixture.writes.length;
  assert.equal((await fixture.request({ plate_number: 'SYN123' })).status, 200);
  assert.equal(fixture.writes.length, count);
});

test('Camping session-write failure is an explicit recovery state, not a successful scan', async () => {
  const result = await scanFixture({ moduleKey: 'freedom_camping', sessionFails: true }).request({ plate_number: 'SYN123' });
  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'scan_recovery_required');
  assert.equal(result.body.capture_saved, true);
  assert.equal(result.body.retryable, false);
});

test('compliance evaluators are service-only after the forward migration', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, () => {
  const name = `fcm-scan-auth-${process.pid}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    docker(['run', '-d', '--rm', '--network', 'none', '--memory', '512m', '--cpus', '1', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { timeout: 2000, stdio: 'ignore' }).status === 0) { ready = true; break; }
    }
    assert.equal(ready, true);
    const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261110100000_secure_vehicle_compliance_rpc.sql'), 'utf8');
    const sql = `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE FUNCTION public.calculate_vehicle_compliance(text,uuid,uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$SELECT '{}'::jsonb$$;
CREATE FUNCTION public.evaluate_parking_compliance(uuid,uuid,text,boolean,integer) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$SELECT '{}'::jsonb$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated,anon;
${migration}
DO $$ BEGIN
  IF has_function_privilege('authenticated','public.calculate_vehicle_compliance(text,uuid,uuid)','execute')
    OR has_function_privilege('anon','public.evaluate_parking_compliance(uuid,uuid,text,boolean,integer)','execute') THEN RAISE EXCEPTION 'Client evaluator access remains'; END IF;
END $$;
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM public.calculate_vehicle_compliance('SYN123',NULL,NULL); RAISE EXCEPTION 'Unauthorized camping evaluator ran'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.evaluate_parking_compliance(NULL,NULL,'SYN123',false,NULL); RAISE EXCEPTION 'Unauthorized parking evaluator ran'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE; SET ROLE service_role;
SELECT public.calculate_vehicle_compliance('SYN123',NULL,NULL),public.evaluate_parking_compliance(NULL,NULL,'SYN123',false,NULL);`;
    docker(['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], sql);
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }
});