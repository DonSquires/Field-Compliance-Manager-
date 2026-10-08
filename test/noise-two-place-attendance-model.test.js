const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const readSource = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
const migration = readSource('supabase/migrations/20260914110000_noise_two_place_attendance_model.sql');
const oracle = readSource('supabase/tests/20260914110000_noise_two_place_rls.sql');
const schema = readSource('supabase/schema.sql');
const canon = readSource('docs/canon/NOISE_CONTROL_TWO_PLACE_MODEL.md');

const functionBody = (name) => {
  const start = migration.indexOf(`FUNCTION public.${name}(`) >= 0 ? migration.indexOf(`FUNCTION public.${name}(`) : migration.indexOf(`FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `${name} must be defined`);
  const end = migration.indexOf('\n$$;', start) >= 0 ? migration.indexOf('\n$$;', start) : migration.indexOf('$function$;', start);
  return migration.slice(start, end);
};

test('the migration is additive: no drops of tables, columns or custody policies', () => {
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|ALTER COLUMN [a-z_]+ TYPE|TRUNCATE/i);
  for (const custody of ['na_select', 'noise_assessments_select', 'na_insert', 'na_update', 'dispatch_jobs_select', 'shift_stops_select']) {
    assert.doesNotMatch(migration, new RegExp(`DROP POLICY IF EXISTS ${custody}\\b`));
  }
  assert.match(migration, /ADD COLUMN IF NOT EXISTS harmed_party_site_id uuid REFERENCES public\.client_sites\(id\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS place_role text NOT NULL DEFAULT 'work_place'/);
  assert.match(migration, /CHECK \(place_role IN \('work_place', 'harmed_party_place'\)\)/);
  assert.match(migration, /arrival_verification IN \('verified_on_site', 'near_site', 'off_site', 'unverified_boundary', 'no_geofence', 'no_gps'\)/);
});

test('the submit RPC writes shift_id, which the migration created (it was missing live until 2026-09-14), with the same signature', () => {
  const live = schema.slice(schema.indexOf('CREATE OR REPLACE FUNCTION "public"."submit_officer_noise_assessment"('));
  const liveHeader = live.slice(0, live.indexOf('\n'));
  assert.match(live.slice(0, live.indexOf('$function$;')), /incident_report_text, follow_up_required, shift_id, dispatch_job_id/);
  const liveTable = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS "public"."noise_assessments" ('));
  assert.match(liveTable.slice(0, liveTable.indexOf('\n);')), /"shift_id" "uuid"/, 'live schema must carry noise_assessments.shift_id after 20260914110000');
  assert.match(migration, /ALTER TABLE public\.noise_assessments\s+ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES public\.shifts\(id\)/);
  const reissued = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "public"."submit_officer_noise_assessment"('));
  assert.equal(reissued.slice(0, reissued.indexOf('\n')), liveHeader, 'signature must be identical so no overload is created');
});

test('END period is a dated council rule capped at the statute (RMA s327(3), 8 days since 21 Aug 2025)', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS end_validity_hours smallint NOT NULL DEFAULT 192/);
  assert.match(migration, /CHECK \(end_validity_hours BETWEEN 1 AND 192\)/);
  const submit = functionBody('submit_officer_noise_assessment');
  assert.match(submit, /make_interval\(hours => v_end_validity_hours\)/);
  assert.doesNotMatch(submit, /72 ?hours|interval '72/);
  assert.match(canon, /8 days/);
  assert.match(canon, /21 August 2025|21 Aug 2025/);
});

test('statutory preconditions are enforced in the write path', () => {
  const submit = functionBody('submit_officer_noise_assessment');
  assert.match(submit, /p_action_taken = 'direction_notice' AND p_dispatch_job_id IS NULL[\s\S]*?RAISE EXCEPTION 'An excessive noise direction requires a linked complaint/);
  assert.match(submit, /p_action_taken = 'equipment_seized' AND NOT coalesce\(p_police_present, false\)[\s\S]*?RAISE EXCEPTION 'Equipment seizure requires Police present \(RMA s328\(3\)\)'/);
});

test('both places derive from the job and the assessment stays anchored on the source (rule #157)', () => {
  const submit = functionBody('submit_officer_noise_assessment');
  assert.match(submit, /v_site_id := v_job\.client_site_id;/);
  assert.match(submit, /v_complainant_site_id := COALESCE\(v_complainant_site_id, v_job\.harmed_party_site_id\)/);
  assert.match(submit, /v_complaint_address := COALESCE\(v_complaint_address, v_job\.harmed_party_address\)/);
  assert.match(submit, /place_role = 'work_place' AND st\.actual_arrived_at IS NOT NULL/);
  assert.match(submit, /place_role = 'harmed_party_place' AND st\.actual_arrived_at IS NOT NULL/);
  assert.match(submit, /site_id, complainant_protected, source_stop_id, complainant_stop_id,[\s\S]*?v_site_id, true, v_source_stop_id, v_complainant_stop_id/);
  assert.match(submit, /ST_Distance\(COALESCE\(cs\.boundary, cs\.center_point\)::geography, v_point::geography\)/);
});

test('complainant identity is unreadable except through the guarded, audited RPC', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.dispatch_job_protected_parties/);
  const table = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS public.dispatch_job_protected_parties'), migration.indexOf('-- ── 6.'));
  assert.match(table, /ENABLE ROW LEVEL SECURITY/);
  assert.match(table, /REVOKE ALL ON TABLE public\.dispatch_job_protected_parties FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(table, /CREATE POLICY/);
  const read = functionBody('get_dispatch_job_protected_party');
  assert.match(read, /v_org <> v_job\.organization_id[\s\S]*?RETURN jsonb_build_object\('available', false, 'reason', 'no_basis'\)/);
  assert.match(read, /'protected_party_read'/);
  assert.match(read, /v_job\.status NOT IN \('completed', 'cancelled'\)/, 'attending officer basis ends with the job');
  const set = functionBody('set_dispatch_job_harmed_party');
  assert.match(set, /'identity_recorded', v_has_identity/);
  assert.doesNotMatch(set, /'display_name', p_display_name|'phone', p_phone/, 'audit metadata must never carry identity values');
});

test('arrival is a loud, non-blocking geofence verification with an idempotent receipt', () => {
  const arrive = functionBody('arrive_at_dispatch_place');
  for (const outcome of ["'no_gps'", "'no_geofence'", "'unverified_boundary'", "'verified_on_site'", "'near_site'", "'off_site'"]) assert.match(arrive, new RegExp(`v_verification := ${outcome}`));
  assert.doesNotMatch(arrive, /RAISE EXCEPTION '[^']*(off site|geofence)[^']*'/i, 'a failed geofence check must never block attendance');
  assert.match(arrive, /r\.request_id = p_client_request_id::text/);
  assert.match(arrive, /v_receipt\.actor_user_id IS DISTINCT FROM v_user[\s\S]*?RAISE EXCEPTION 'client_request_id belongs to another actor'/);
  assert.match(arrive, /INSERT INTO public\.shift_stops \([\s\S]*?is_adhoc, dispatch_job_id/);
  assert.match(arrive, /SET on_scene_at = COALESCE\(dispatch_jobs\.on_scene_at, v_stop\.actual_arrived_at\)/);
  const depart = functionBody('depart_dispatch_place');
  assert.match(depart, /RAISE EXCEPTION 'Arrival breached the response SLA; a delay reason is required before departure'/);
});

test('the client report discloses by basis and never carries identity', () => {
  const report = functionBody('get_noise_attendance_report');
  assert.match(report, /v_custodian := COALESCE\(/);
  assert.match(report, /v_harmed_party_reader := COALESCE\(/);
  assert.match(report, /'harmed_party_address', CASE WHEN v_custodian OR v_harmed_party_reader THEN v_job\.harmed_party_address ELSE NULL END/);
  assert.match(report, /'complaint_address', CASE WHEN v_custodian OR v_harmed_party_reader THEN na\.complaint_address ELSE NULL END/);
  assert.match(report, /'summary', CASE WHEN v_custodian THEN i\.summary ELSE NULL END/);
  assert.doesNotMatch(report, /dispatch_job_protected_parties/, 'the report must not join the protected table');
  assert.match(report, /'noise_attendance_report_read'/);
});

test('every RPC is SECURITY DEFINER with a pinned search_path and revoked from PUBLIC and anon', () => {
  const names = ['set_dispatch_job_harmed_party', 'get_dispatch_job_protected_party', 'arrive_at_dispatch_place', 'depart_dispatch_place', 'record_job_party_interaction', 'get_noise_attendance_report'];
  for (const name of names) {
    const body = functionBody(name);
    assert.match(body, /SECURITY DEFINER SET search_path = public/, `${name} must pin search_path`);
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon;`), `${name} must be revoked from PUBLIC/anon`);
  }
});

test('the disposable-database truth table covers both directions of every rule', () => {
  for (const label of [
    'protected parties table is not directly readable',
    'source-side owner gets no basis for complainant identity',
    'every protected read is audited (IPP 6)',
    'source arrival verified_on_site',
    'assessment derives source site from the job (rule #157)',
    'complainant_protected forced true',
    'END expires 8 days after assessment (RMA s327(3), 2025 amendment)',
    'END without a complaint is refused',
    'seizure without Police present is refused (s328(3))',
    'SLA-breached departure requires a delay reason',
    'report never carries complainant identity',
    'source-side owner sees the report with complainant redacted',
    'W1: source-side owner cannot read the assessment row',
    'custody: recording officer org still reads its row',
  ]) assert.ok(oracle.includes(label), `oracle must assert: ${label}`);
  assert.match(oracle, /^rollback;/m);
  assert.match(fs.readFileSync(path.join(root, 'scripts/run-rls-oracle.sh'), 'utf8'), /--network=none/);
});
