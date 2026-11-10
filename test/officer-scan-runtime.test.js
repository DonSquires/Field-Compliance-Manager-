const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/process-officer-scan/index.ts'), 'utf8')
  .replace(/import \{ serve \} from '[^']+';/, '')
  .replace(/import \{ createClient as _createClient \} from '[^']+';/, '');

function scanFixture({ confidence = 0, role = 'officer', uploadFails = false, registrationFails = false, parkingRule = true, policyFails = false, priorChalk = null, moduleKey = 'parking_enforcement', sessionFails = false, branchModules = ['freedom_camping', 'parking_enforcement'], includeHomeContext = true, recoveryAuditFailsOnce = false } = {}) {
  let handler;
  let receipt = null;
  let registeredEvidence = null;
  let recoveryAudits = 0;
  const uploads = [];
  const writes = [];
  const rpcCalls = [];
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
      if (this.table === 'audit_log' && this.value?.action === 'officer_scan_capture_recovered') {
        recoveryAudits += 1;
        if (recoveryAuditFailsOnce && recoveryAudits === 1) result.error = { message: 'synthetic audit outage' };
      }
      if (this.table === 'user_profiles') result.data = { id: '11111111-1111-4111-8111-111111111111', role, organization_id: '22222222-2222-4222-8222-222222222222' };
      if (this.table === 'evidence_items') {
        if (this.action === 'select') result.data = registeredEvidence;
        else if (this.action === 'update') {
          registeredEvidence = { ...registeredEvidence, metadata: this.value.metadata };
          writes.push({ table: this.table, action: this.action, value: this.value });
          result.data = { id: registeredEvidence.id };
        }
      }
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
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === 'get_operating_organization_contexts') return { data: [
        ...(includeHomeContext ? [{ organization_id: '22222222-2222-4222-8222-222222222222', authority_basis: 'organisation_home', module_access: [] }] : []),
        { organization_id: '33333333-3333-4333-8333-333333333333', authority_basis: 'branch_authorisation', module_access: branchModules, is_default: !includeHomeContext },
      ], error: null };
      if (name === 'register_edge_court_photo') {
        if (registrationFails) return { data: null, error: { message: 'synthetic evidence failure' } };
        registeredEvidence = { id: '44444444-4444-4444-8444-444444444444', organization_id: args.p_organization_id, module_key: args.p_module_key, metadata: args.p_metadata };
        return { data: registeredEvidence.id, error: null };
      }
      if (name === 'has_location_access') return { data: true, error: null };
      if (name === 'resolve_operational_context_authorized') return { data: [{ resolution_status: 'resolved', matched_zone_id: '55555555-5555-4555-8555-555555555555', site_id: null }], error: null };
      if (name === '_geofence_active_at') return { data: true, error: null };
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
  const body = { client_request_id: '33333333-3333-4333-8333-333333333333', module_key: 'freedom_camping', gps_lat: 0, gps_lng: 0, location_source: 'device_gps', image_base64: 'YQ==', captured_at: '2026-11-10T07:00:00Z' };
  return {
    receipt: () => receipt,
    legacyRecoveryContext: () => {
      const { image_base64: imageBase64, ...original } = body;
      receipt.response.request_fingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify({
        image_base64: imageBase64, plate_number: '', gps_lat: body.gps_lat, gps_lng: body.gps_lng,
        zone_id: null, module_key: body.module_key, captured_at: body.captured_at,
      })).digest('hex');
      return original;
    },
    uploads,
    writes,
    rpcCalls,
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
  assert.equal(fixture.uploads.length, 2);
  const registration = fixture.rpcCalls.find((call) => call.name === 'register_edge_court_photo');
  assert.equal(registration.args.p_metadata.watermark_service, 'inference');
  assert.match(registration.args.p_metadata.raw_sha256, /^[0-9a-f]{64}$/);
  assert.match(registration.args.p_metadata.watermarked_sha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.receipt().command_status, 'failed');
  assert.equal((await fixture.request()).status, 400);
  assert.equal(fixture.uploads.length, 2);
});

test('a saved ALPR-failed capture can be retried with a manual plate without reuploading', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping' });
  const first = await fixture.request();
  assert.equal(first.status, 400);
  assert.equal(first.body.code, 'plate_confirmation_required');
  const retry = await fixture.request({ plate_number: 'SYN123' });
  assert.equal(retry.status, 200);
  assert.equal(fixture.uploads.length, 2);
  assert.equal(fixture.rpcCalls.filter((call) => call.name === 'register_edge_court_photo').length, 1);
});

test('a proven legacy pre-write failure resumes the same saved photo with a manual plate', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping' });
  await fixture.request();
  const original = { ...fixture.legacyRecoveryContext(), plate_number: 'SYN123' };
  const priorFingerprint = fixture.receipt().response.request_fingerprint;
  const result = await fixture.request({ plate_number: 'SYN123', zone_id: '55555555-5555-4555-8555-555555555555', location_source: 'manual_zone', recovery_original_context: original });
  assert.equal(result.status, 200);
  assert.equal(fixture.receipt().response.recovery_from_fingerprint, priorFingerprint);
  assert.equal(fixture.uploads.length, 2);
});

test('legacy recovery never accepts different photo bytes or capture time', async () => {
  for (const changes of [{ image_base64: 'Yg==' }, { captured_at: '2026-11-10T07:01:00Z' }]) {
    const fixture = scanFixture({ moduleKey: 'freedom_camping' });
    await fixture.request();
    const original = fixture.legacyRecoveryContext();
    const result = await fixture.request({ ...changes, zone_id: '55555555-5555-4555-8555-555555555555', location_source: 'manual_zone', recovery_original_context: original });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'scan_request_mismatch');
    assert.equal(fixture.writes.length, 0);
  }
});

test('a failed recovery audit is required again on the next retry', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping', recoveryAuditFailsOnce: true });
  await fixture.request();
  const changes = { plate_number: 'SYN123', zone_id: '55555555-5555-4555-8555-555555555555', location_source: 'manual_zone', recovery_original_context: fixture.legacyRecoveryContext() };
  const first = await fixture.request(changes);
  assert.equal(first.status, 503);
  assert.equal(first.body.code, 'scan_recovery_audit_failed');
  assert.equal(fixture.writes.length, 0);
  assert.equal((await fixture.request(changes)).status, 200);
  assert.ok(fixture.receipt().response.recovery_from_fingerprint);
});

test('legacy recovery cannot claim device GPS provenance from its old fingerprint', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping' });
  await fixture.request();
  const result = await fixture.request({ plate_number: 'SYN123', recovery_original_context: fixture.legacyRecoveryContext() });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'scan_recovery_location_required');
  assert.equal(fixture.writes.length, 0);
});

test('legacy recovery refuses receipts that may have partial primary writes', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping' });
  await fixture.request();
  const original = fixture.legacyRecoveryContext();
  fixture.receipt().response.retryable = false;
  const result = await fixture.request({ plate_number: 'SYN123', recovery_original_context: original });
  assert.equal(result.status, 409);
  assert.equal(fixture.writes.length, 0);
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

test('a request ID cannot silently change its capture evidence', async () => {
  const fixture = scanFixture();
  await fixture.request();
  const changed = await fixture.request({ image_base64: 'Yg==' });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'scan_request_mismatch');
  assert.equal(fixture.uploads.length, 2);
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

test('a branch cannot use a scan module absent from its operating authorization', async () => {
  const result = await scanFixture({ branchModules: ['freedom_camping'] }).request({
    operating_organization_id: '33333333-3333-4333-8333-333333333333',
    module_key: 'parking_enforcement',
  });
  assert.equal(result.status, 403);
});

test('a caller without an explicit organization uses its authorized default operating branch', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping', includeHomeContext: false });
  const result = await fixture.request({ plate_number: 'SYN123' });
  assert.equal(result.status, 200);
  assert.equal(fixture.rpcCalls.find((call) => call.name === 'resolve_operational_context_authorized').args.p_org_id, '33333333-3333-4333-8333-333333333333');
});

test('coordinates without a declared source are not treated as device GPS', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping' });
  const result = await fixture.request({ location_source: null });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'location_confirmation_required');
  assert.equal(result.body.capture_saved, true);
  assert.equal(fixture.rpcCalls.some((call) => call.name === 'resolve_operational_context_authorized'), false);
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
  const chalkUpdate = fixture.writes.find((write) => write.table === 'parking_chalk_records' && write.action === 'update');
  assert.equal(chalkUpdate.value.photo_url, 'first-photo.jpg');
  assert.equal(chalkUpdate.value.photo_urls.length, 1);
  assert.equal(fixture.rpcCalls.filter((call) => call.name === 'register_edge_court_photo').length, 1);
  assert.equal(fixture.writes.find((write) => write.table === 'evidence_items').value.metadata.parking_chalk_record_id, '66666666-6666-4666-8666-666666666666');
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

test('device GPS resolves the module Working Zone within the selected operating organization', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping' });
  const result = await fixture.request({
    plate_number: 'SYN123',
    operating_organization_id: '33333333-3333-4333-8333-333333333333',
    zone_id: '55555555-5555-4555-8555-555555555555',
    location_source: 'device_gps',
  });
  assert.equal(result.status, 200);
  const resolution = fixture.rpcCalls.find((call) => call.name === 'resolve_operational_context_authorized');
  assert.equal(resolution.args.p_org_id, '33333333-3333-4333-8333-333333333333');
  const observation = fixture.writes.find((write) => write.table === 'observations' && write.action === 'insert');
  assert.equal(observation.value.organization_id, '33333333-3333-4333-8333-333333333333');
});

test('an address candidate selects a Working Zone but is not recorded as officer GPS presence', async () => {
  const fixture = scanFixture({ moduleKey: 'freedom_camping' });
  const result = await fixture.request({
    plate_number: 'SYN123',
    zone_id: '55555555-5555-4555-8555-555555555555',
    location_source: 'address_candidate',
  });
  assert.equal(result.status, 200);
  assert.equal(fixture.rpcCalls.some((call) => call.name === 'resolve_operational_context_authorized'), false);
  const observation = fixture.writes.find((write) => write.table === 'observations' && write.action === 'insert');
  assert.equal(observation.value.gps_lat, null);
  assert.equal(observation.value.gps_lng, null);
  assert.equal(observation.value.geofence_context.on_site, null);
  assert.equal(observation.value.geofence_context.location_source, 'address_candidate');
  assert.equal(observation.value.geofence_context.spatial_resolution_evaluated, false);
  assert.equal(observation.value.geofence_context.in_operating_bounds, null);
  assert.equal(observation.value.geofence_context.candidate_coordinates.lat, 0);
  assert.equal(observation.value.geofence_context.candidate_coordinates.lng, 0);
  assert.equal(fixture.rpcCalls.filter((call) => call.name === 'register_edge_court_photo').length, 1);
  assert.equal(fixture.writes.find((write) => write.table === 'evidence_items').value.metadata.observation_id, '77777777-7777-4777-8777-777777777777');
});

test('Camping session-write failure is an explicit recovery state, not a successful scan', async () => {
  const result = await scanFixture({ moduleKey: 'freedom_camping', sessionFails: true }).request({ plate_number: 'SYN123' });
  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'scan_recovery_required');
  assert.equal(result.body.capture_saved, true);
  assert.equal(result.body.retryable, false);
});

test('live evidence custody and service-only evaluator contracts hold in PostgreSQL', {
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
    const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');
    const evidenceFunctions = ['tg_seal_verified_photo_evidence', 'tg_evidence_items_custody_guard', 'register_edge_court_photo'].map((name) => {
      const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
      const end = schema.indexOf('$function$;', start);
      assert.ok(start >= 0 && end > start, `${name} must exist in the live schema snapshot`);
      return schema.slice(start, end + '$function$;'.length);
    }).join('\n');
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
SELECT public.calculate_vehicle_compliance('SYN123',NULL,NULL),public.evaluate_parking_compliance(NULL,NULL,'SYN123',false,NULL);
RESET ROLE;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
CREATE TABLE public.evidence_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, module_key text, evidence_kind text,
  storage_path text, captured_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}', sha256_hash text,
  is_court_ready boolean DEFAULT false, locked_at timestamptz, cctv_import_id uuid, retention_days integer,
  retention_hold boolean DEFAULT false
);
CREATE TABLE public.audit_log (organization_id uuid, action text, target_table text, target_id uuid, metadata jsonb);
${evidenceFunctions}
CREATE TRIGGER trg_seal_verified_photo_evidence BEFORE INSERT OR UPDATE ON public.evidence_items FOR EACH ROW EXECUTE FUNCTION public.tg_seal_verified_photo_evidence();
CREATE TRIGGER zz_evidence_items_custody_guard BEFORE UPDATE OR DELETE ON public.evidence_items FOR EACH ROW EXECUTE FUNCTION public.tg_evidence_items_custody_guard();
REVOKE ALL ON FUNCTION public.register_edge_court_photo(uuid,text,text,timestamptz,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_edge_court_photo(uuid,text,text,timestamptz,jsonb) TO service_role;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT SELECT,UPDATE ON public.evidence_items TO service_role;
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',false);
DO $$ DECLARE evidence_id uuid; rejected boolean := false; BEGIN
  BEGIN
    PERFORM public.register_edge_court_photo('22222222-2222-4222-8222-222222222222','freedom_camping','synthetic-invalid.jpg',now(),'{}');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%requires inference watermark provenance%' THEN RAISE; END IF;
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Missing watermark provenance was accepted'; END IF;
  evidence_id := public.register_edge_court_photo('22222222-2222-4222-8222-222222222222','freedom_camping','synthetic-watermarked.jpg',now(),jsonb_build_object(
    'original_path','synthetic-original.jpg','raw_sha256',repeat('a',64),'watermarked_sha256',repeat('b',64),
    'watermark_text','Synthetic capture pending plate confirmation','watermark_service','inference'
  ));
  IF NOT EXISTS(SELECT 1 FROM public.evidence_items WHERE id=evidence_id AND is_court_ready AND locked_at IS NOT NULL AND sha256_hash=repeat('b',64)) THEN RAISE EXCEPTION 'Evidence was not sealed with its measured hash'; END IF;
  UPDATE public.evidence_items SET metadata=metadata||jsonb_build_object('observation_id','77777777-7777-4777-8777-777777777777','capture_state','linked') WHERE id=evidence_id;
  IF NOT EXISTS(SELECT 1 FROM public.evidence_items WHERE id=evidence_id AND metadata->>'observation_id'='77777777-7777-4777-8777-777777777777') THEN RAISE EXCEPTION 'Record association was not retained'; END IF;
  rejected := false;
  BEGIN
    UPDATE public.evidence_items SET metadata=jsonb_set(metadata,'{raw_sha256}',to_jsonb(repeat('c',64))) WHERE id=evidence_id;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%provenance metadata%' THEN RAISE; END IF;
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Sealed evidence hash provenance was changed'; END IF;
END $$;`;
    docker(['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], sql);
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }
});