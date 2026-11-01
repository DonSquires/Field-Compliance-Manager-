'use strict';
// CCTV enterprise inference (owner ruling 2026-11-01): reprocessing keeps every human decision, a parked car on
// one camera becomes one resident object, cloud vehicle hints need an organisation opt-in and a receipt written
// before any crop leaves, reviewers can report misses, and precision is reported with an honest interval.
// The live helper cctv_bbox_is_stationary is loaded from the schema snapshot. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261102140000_cctv_enterprise_inference.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const watcher = fs.readFileSync(path.join(__dirname, '../services/vision/vision_job_watcher.js'), 'utf8');

const SERVICE_ONLY = [
  'public.record_cctv_cloud_inference_receipt(uuid, jsonb)',
  'public.reconcile_cctv_reviewed_observations(uuid)',
  'public.link_cctv_resident_vehicle_observations(uuid)',
  'public.cctv_bbox_iou(jsonb, jsonb)',
];
const SIGNED_IN = [
  'public.set_cctv_inference_policy(uuid, boolean, text, text)',
  'public.report_cctv_missed_detection(uuid, text, numeric, timestamptz, jsonb, text)',
  'public.resolve_cctv_missed_detection(uuid, text, text)',
  'public.cctv_accuracy_summary(uuid, timestamptz)',
];
const TABLES = ['cctv_inference_policies', 'cctv_cloud_inference_receipts', 'cctv_resident_objects', 'cctv_missed_detection_reports'];
const escape = (text) => text.replace(/[()[\].*+?^$|{}]/g, '\\$&');

function liveFunction(name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `${name} is in the schema snapshot`);
  const end = schema.indexOf('$function$;', start);
  return schema.slice(start, end + '$function$;'.length);
}

test('every new function is revoked from PUBLIC and granted only to the intended callers', () => {
  for (const signature of [...SERVICE_ONLY, ...SIGNED_IN]) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${escape(signature)} FROM PUBLIC, anon, authenticated, service_role;`), signature);
  }
  for (const signature of SERVICE_ONLY) {
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${escape(signature)} TO postgres, service_role;`), signature);
  }
  for (const signature of SIGNED_IN) {
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${escape(signature)} TO postgres, authenticated, service_role;`), signature);
  }
  for (const table of TABLES) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`), table);
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated, service_role;`), table);
    assert.match(migration, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO authenticated, service_role;`), table);
    assert.match(migration, new RegExp(`USING \\(public\\.org_access_allowed\\(organization_id\\)\\)`), table);
  }
});

test('service guards fail closed when the request role is missing', () => {
  const guards = migration.match(/IF coalesce\(auth\.role\(\), ''\) <> 'service_role' AND session_user NOT IN \('postgres', 'supabase_admin'\) THEN/g) || [];
  assert.equal(guards.length, 3, 'receipt, reconcile and resident linking are service-only');
  assert.doesNotMatch(migration, /IF auth\.role\(\) <> 'service_role'/);
  assert.doesNotMatch(migration, /\bDROP (TABLE|FUNCTION|COLUMN|INDEX)\b/);
  assert.doesNotMatch(migration, /\bTRUNCATE\b|\bDELETE FROM\b/);
});

test('reviewed sightings are never the target of an engine write', () => {
  for (const name of ['reconcile_cctv_reviewed_observations', 'link_cctv_resident_vehicle_observations']) {
    const start = migration.indexOf(`FUNCTION public.${name}(`);
    const body = migration.slice(start, migration.indexOf('$function$;', start));
    const updates = body.match(/UPDATE public\.cctv_entity_observations\n[\s\S]*?\n\s+WHERE [^\n]*/g) || [];
    assert.ok(updates.length > 0, `${name} updates sightings`);
    for (const update of updates) assert.match(update, /\n\s+WHERE id = v_\w+\.id AND review_state = 'unreviewed';$/, `${name} only updates unreviewed rows`);
  }
});

test('the worker calls the new database steps in order and reads the policy it governs', () => {
  const start = watcher.indexOf('async function recordEntityObservations(');
  const body = watcher.slice(start, watcher.indexOf('\n}\n', start));
  const reconcile = body.indexOf("rpc('reconcile_cctv_reviewed_observations', { p_job_id: job.id })");
  const coalesce = body.indexOf("rpc('coalesce_cctv_stationary_vehicle_observations', { p_job_id: job.id })");
  const resident = body.indexOf("rpc('link_cctv_resident_vehicle_observations', { p_job_id: job.id })");
  assert.ok(start >= 0 && reconcile > 0, 'reconcile runs after observations are written');
  assert.ok(coalesce > reconcile && resident > coalesce, 'reconcile, then stationary coalescing, then resident linking');
  for (const failure of ['reconcileError', 'coalesceError', 'residentError']) {
    assert.match(body, new RegExp(`if \\(${failure}\\) throw new Error`), `${failure} fails the job instead of being ignored`);
  }
  assert.match(watcher, /from\('cctv_inference_policies'\)\s*\.select\('cloud_vehicle_vlm_enabled, cloud_vehicle_vlm_model'\)/);
  assert.match(watcher, /rpc\('record_cctv_cloud_inference_receipt', \{ p_job_id: job\.id, p_receipt: receipt \}\)/);
});

test('CCTV enterprise inference behaves as ruled, against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-cctv-enterprise-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psqlAs = (user) => (sql) => execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = psqlAs('postgres');
  const api = psqlAs('api_gateway');
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const orgA = '0a000000-0000-4000-8000-00000000000a';
    const orgB = '0b000000-0000-4000-8000-00000000000b';
    const admin = 'a0000000-0000-4000-8000-000000000001';
    const member = 'a0000000-0000-4000-8000-000000000002';
    const outsider = 'a0000000-0000-4000-8000-000000000003';

    psql(`
      DO $$ BEGIN
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE stranger NOLOGIN;
        CREATE ROLE api_gateway LOGIN NOINHERIT; GRANT anon, authenticated, service_role TO api_gateway;
      END $$;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $fn$;
      CREATE FUNCTION public.is_admin_for_org(p_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $fn$ SELECT auth.uid() = '${admin}'::uuid AND p_organization_id = '${orgA}'::uuid $fn$;
      CREATE FUNCTION public.org_access_allowed(target_org_id uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $fn$ SELECT auth.uid() IN ('${admin}'::uuid, '${member}'::uuid) AND target_org_id = '${orgA}'::uuid $fn$;
      CREATE TABLE public.organizations (id uuid PRIMARY KEY);
      CREATE TABLE public.evidence_items (id uuid PRIMARY KEY, organization_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb);
      CREATE TABLE public.inference_jobs (id uuid PRIMARY KEY, organization_id uuid NOT NULL, evidence_item_id uuid, domain text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE public.inference_results (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inference_job_id uuid, result jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE public.cctv_imports (id uuid PRIMARY KEY, camera_key text, source_timezone text);
      CREATE TABLE public.audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid, action text NOT NULL,
        target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}'::jsonb);
      CREATE TABLE public.cctv_entity_observations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id),
        evidence_item_id uuid NOT NULL, source_event_id text NOT NULL, entity_kind text NOT NULL CHECK (entity_kind IN ('person', 'vehicle', 'animal')),
        observed_at timestamptz NOT NULL, observed_to timestamptz, candidate_plate text, model_confidence real, frame_sha256 text, thumbnail text,
        review_state text NOT NULL DEFAULT 'unreviewed' CHECK (review_state IN ('unreviewed', 'accepted', 'rejected', 'uncertain', 'needs_more_context', 'superseded')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(), cctv_import_id uuid, attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        portfolio_key uuid, portfolio_state text NOT NULL DEFAULT 'unmatched'
          CHECK (portfolio_state IN ('unmatched', 'candidate', 'linked', 'new_identity', 'rejected')),
        portfolio_candidates jsonb NOT NULL DEFAULT '[]'::jsonb, reviewed_by uuid, reviewed_at timestamptz, review_notes text,
        UNIQUE (inference_job_id, source_event_id, entity_kind));
      ${liveFunction('cctv_bbox_is_stationary')}
      ${migration}
    `);

    // Synthetic footage: E1 is reprocessed with reviewed rows; E2..E5 are clips from one parked-car camera.
    const job = (n) => `f${n}000000-0000-4000-8000-00000000000${n}`;
    psql(`
      INSERT INTO public.organizations VALUES ('${orgA}'), ('${orgB}');
      INSERT INTO public.evidence_items VALUES
        ('e1000000-0000-4000-8000-000000000001', '${orgA}', '{"camera_key":"cam-gate"}'),
        ('e2000000-0000-4000-8000-000000000002', '${orgA}', '{"camera_key":"cam-yard"}'),
        ('e3000000-0000-4000-8000-000000000003', '${orgA}', '{"camera_key":"cam-yard"}'),
        ('e4000000-0000-4000-8000-000000000004', '${orgA}', '{}'),
        ('e5000000-0000-4000-8000-000000000005', '${orgA}', '{"camera_key":"cam-yard"}'),
        ('eb000000-0000-4000-8000-00000000000b', '${orgB}', '{"camera_key":"cam-yard"}');
      INSERT INTO public.cctv_imports VALUES ('c4000000-0000-4000-8000-000000000004', 'cam-yard', 'Pacific/Auckland');
      INSERT INTO public.inference_jobs (id, organization_id, evidence_item_id, domain) VALUES
        ('${job(1)}', '${orgA}', 'e1000000-0000-4000-8000-000000000001', 'video_motion'),
        ('${job(2)}', '${orgA}', 'e2000000-0000-4000-8000-000000000002', 'video_motion'),
        ('${job(3)}', '${orgA}', 'e3000000-0000-4000-8000-000000000003', 'video_motion'),
        ('${job(4)}', '${orgA}', 'e4000000-0000-4000-8000-000000000004', 'video_motion'),
        ('${job(5)}', '${orgA}', 'e5000000-0000-4000-8000-000000000005', 'video_motion'),
        ('fb000000-0000-4000-8000-00000000000b', '${orgB}', 'eb000000-0000-4000-8000-00000000000b', 'video_motion');
      INSERT INTO public.inference_results (inference_job_id, result) VALUES
        ('${job(1)}', '{"classification_plan":{"model_manifest":{"engine_version":"cctv-engine-v2"}}}');
    `);

    const obs = (row) => {
      const columns = Object.keys(row);
      const values = columns.map((key) => {
        const value = row[key];
        if (value === null) return 'NULL';
        if (typeof value === 'object') return `'${JSON.stringify(value)}'::jsonb`;
        if (typeof value === 'number') return String(value);
        return `'${value}'`;
      });
      return `INSERT INTO public.cctv_entity_observations (${columns.join(', ')}) VALUES (${values.join(', ')});`;
    };
    const base = (id, n, extra) => ({ id, organization_id: orgA, inference_job_id: job(n), evidence_item_id: `e${n}000000-0000-4000-8000-00000000000${n}`, ...extra });
    const box = (x, y, width = 100, height = 80) => ({ x, y, width, height });
    const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 0, 0, seconds)).toISOString();

    // --- Reconcile: human decisions survive reprocessing ---
    const reviewedPerson = '10000000-0000-4000-8000-000000000001';
    const reviewedAnimal = '10000000-0000-4000-8000-000000000002';
    const reviewedVehicle = '10000000-0000-4000-8000-000000000003';
    const reviewedUncertain = '10000000-0000-4000-8000-000000000004';
    psql([
      obs(base(reviewedPerson, 1, { source_event_id: 'v1-p', entity_kind: 'person', observed_at: at(10), observed_to: at(15), review_state: 'accepted', reviewed_at: at(100), attributes: { bbox: box(100, 100) } })),
      obs(base(reviewedAnimal, 1, { source_event_id: 'v1-a', entity_kind: 'animal', observed_at: at(20), observed_to: at(22), review_state: 'rejected', reviewed_at: at(100), attributes: { bbox: box(400, 300, 60, 40) } })),
      obs(base(reviewedVehicle, 1, { source_event_id: 'v1-v', entity_kind: 'vehicle', observed_at: at(30), observed_to: at(40), candidate_plate: 'ABC123', review_state: 'accepted', attributes: { bbox: box(10, 10) } })),
      obs(base(reviewedUncertain, 1, { source_event_id: 'v1-u', entity_kind: 'person', observed_at: at(50), observed_to: at(52), review_state: 'uncertain', attributes: { bbox: box(600, 100) } })),
      obs(base('20000000-0000-4000-8000-000000000001', 1, { source_event_id: 'v2-p', entity_kind: 'person', observed_at: at(11), observed_to: at(14), thumbnail: 'data:x', portfolio_candidates: [{ score: 0.9 }], attributes: { bbox: box(105, 104), engine_version: 'cctv-engine-v2' } })),
      obs(base('20000000-0000-4000-8000-000000000002', 1, { source_event_id: 'v2-a', entity_kind: 'animal', observed_at: at(21), observed_to: at(21), attributes: { bbox: box(402, 301, 60, 40) } })),
      obs(base('20000000-0000-4000-8000-000000000003', 1, { source_event_id: 'v2-v', entity_kind: 'vehicle', observed_at: at(35), observed_to: at(45), candidate_plate: 'ABC123', attributes: { bbox: box(700, 500) } })),
      obs(base('20000000-0000-4000-8000-000000000004', 1, { source_event_id: 'v2-p-elsewhere', entity_kind: 'person', observed_at: at(12), observed_to: at(13), attributes: { bbox: box(900, 600) } })),
      obs(base('20000000-0000-4000-8000-000000000005', 1, { source_event_id: 'v2-p-later', entity_kind: 'person', observed_at: at(80), observed_to: at(82), attributes: { bbox: box(100, 100) } })),
      obs(base('20000000-0000-4000-8000-000000000006', 1, { source_event_id: 'v2-u', entity_kind: 'person', observed_at: at(50), observed_to: at(52), attributes: { bbox: box(600, 100) } })),
    ].join('\n'));
    const reviewedBefore = psql(`SELECT string_agg(md5(o::text), ',' ORDER BY id) FROM public.cctv_entity_observations o WHERE review_state <> 'unreviewed';`).trim();
    assert.equal(psql(`SELECT public.reconcile_cctv_reviewed_observations('${job(1)}');`).trim(), '3');
    assert.equal(psql(`SELECT public.reconcile_cctv_reviewed_observations('${job(1)}');`).trim(), '0', 'reconciling twice changes nothing');
    assert.equal(
      psql(`SELECT string_agg(md5(o::text), ',' ORDER BY id) FROM public.cctv_entity_observations o WHERE id IN ('${reviewedPerson}', '${reviewedAnimal}', '${reviewedVehicle}', '${reviewedUncertain}');`).trim(),
      reviewedBefore,
      'reviewed rows are byte-for-byte unchanged',
    );
    const states = Object.fromEntries(psql(`SELECT source_event_id || '=' || review_state || ':' || coalesce(attributes->>'carried_review_state', '-') || ':' || coalesce(attributes->>'human_decision_carried_from', '-')
      FROM public.cctv_entity_observations WHERE source_event_id LIKE 'v2-%' ORDER BY 1;`).trim().split('\n').map((line) => line.split('=')));
    assert.equal(states['v2-p'], `superseded:accepted:${reviewedPerson}`, 'an accepted person carries forward');
    assert.equal(states['v2-a'], `superseded:rejected:${reviewedAnimal}`, 'a rejected false positive does not return');
    assert.equal(states['v2-v'], `superseded:accepted:${reviewedVehicle}`, 'the same plate in the same window carries forward');
    assert.equal(states['v2-p-elsewhere'], 'unreviewed:-:-', 'a different place stays for review');
    assert.equal(states['v2-p-later'], 'unreviewed:-:-', 'a later sighting stays for review');
    assert.equal(states['v2-u'], 'unreviewed:-:-', 'an inconclusive decision is not carried');
    assert.equal(psql(`SELECT thumbnail IS NULL AND portfolio_candidates = '[]'::jsonb FROM public.cctv_entity_observations WHERE source_event_id = 'v2-p';`).trim(), 't');

    // --- Resident objects: one parked car, one portfolio ---
    const portfolio = (n) => `5000000${n}-0000-4000-8000-000000000000`;
    const stationary = (extra = {}) => ({ motion_state: 'stationary', bbox: box(300, 200, 200, 120), ...extra });
    psql([
      obs(base('30000000-0000-4000-8000-000000000001', 2, { source_event_id: 'r1', entity_kind: 'vehicle', observed_at: '2026-10-01T00:00:00Z', portfolio_key: portfolio(1), attributes: stationary({ colour: 'White' }) })),
      obs(base('30000000-0000-4000-8000-000000000002', 3, { source_event_id: 'r2', entity_kind: 'vehicle', observed_at: '2026-10-03T00:00:00Z', portfolio_key: portfolio(2), attributes: stationary({ colour: 'white', bbox: box(305, 204, 196, 118) }) })),
      obs(base('30000000-0000-4000-8000-000000000003', 3, { source_event_id: 'r3-moving', entity_kind: 'vehicle', observed_at: '2026-10-03T00:00:00Z', portfolio_key: portfolio(3), attributes: { motion_state: 'moving', bbox: box(300, 200, 200, 120) } })),
      obs(base('30000000-0000-4000-8000-000000000004', 3, { source_event_id: 'r4-red', entity_kind: 'vehicle', observed_at: '2026-10-03T00:00:00Z', portfolio_key: portfolio(4), attributes: stationary({ colour: 'red' }) })),
      obs(base('30000000-0000-4000-8000-000000000005', 3, { source_event_id: 'r5-reviewed', entity_kind: 'vehicle', observed_at: '2026-10-03T00:00:00Z', portfolio_key: portfolio(5), review_state: 'accepted', attributes: stationary({ colour: 'white' }) })),
      obs(base('30000000-0000-4000-8000-000000000006', 5, { source_event_id: 'r6-late', entity_kind: 'vehicle', observed_at: '2026-10-30T00:00:00Z', portfolio_key: portfolio(6), attributes: stationary({ colour: 'white' }) })),
      obs(base('30000000-0000-4000-8000-000000000007', 4, { source_event_id: 'r7-import-camera', entity_kind: 'vehicle', observed_at: '2026-10-04T00:00:00Z', cctv_import_id: 'c4000000-0000-4000-8000-000000000004', portfolio_key: portfolio(7), attributes: stationary({ colour: 'white' }) })),
      obs({ id: '30000000-0000-4000-8000-00000000000b', organization_id: orgB, inference_job_id: 'fb000000-0000-4000-8000-00000000000b', evidence_item_id: 'eb000000-0000-4000-8000-00000000000b',
        source_event_id: 'rb-other-org', entity_kind: 'vehicle', observed_at: '2026-10-03T00:00:00Z', portfolio_key: portfolio(8), attributes: stationary({ colour: 'white' }) }),
    ].join('\n'));
    const reviewedResidentBefore = psql(`SELECT md5(o::text) FROM public.cctv_entity_observations o WHERE source_event_id = 'r5-reviewed';`).trim();
    assert.equal(psql(`SELECT public.link_cctv_resident_vehicle_observations('${job(2)}');`).trim(), '1');
    assert.equal(psql(`SELECT public.link_cctv_resident_vehicle_observations('${job(3)}');`).trim(), '2', 'the white parked car and the red car; not the moving or reviewed one');
    assert.equal(psql(`SELECT public.link_cctv_resident_vehicle_observations('${job(3)}');`).trim(), '0', 'linking twice changes nothing');
    assert.equal(psql(`SELECT public.link_cctv_resident_vehicle_observations('${job(4)}');`).trim(), '1', 'the import camera key is the fallback');
    assert.equal(psql(`SELECT public.link_cctv_resident_vehicle_observations('${job(5)}');`).trim(), '1');
    assert.equal(psql(`SELECT public.link_cctv_resident_vehicle_observations('fb000000-0000-4000-8000-00000000000b');`).trim(), '1');
    const resident = (eventId) => psql(`SELECT portfolio_key || ':' || portfolio_state || ':' || coalesce(attributes->>'resident_sighting_count', '-') || ':' || coalesce(attributes->>'resident_object_id', '-')
      FROM public.cctv_entity_observations WHERE source_event_id = '${eventId}';`).trim().split(':');
    const [r1Key, r1State, r1Count, r1Resident] = resident('r1');
    assert.deepEqual([r1Key, r1State, r1Count], [portfolio(1), 'unmatched', '1'], 'a first sighting starts a resident object');
    const [r2Key, r2State, r2Count, r2Resident] = resident('r2');
    assert.deepEqual([r2Key, r2State, r2Count, r2Resident], [portfolio(1), 'candidate', '2', r1Resident], 'the same parked car joins its portfolio');
    assert.equal(psql(`SELECT attributes->>'portfolio_key_before_resident_link' FROM public.cctv_entity_observations WHERE source_event_id = 'r2';`).trim(), portfolio(2));
    assert.deepEqual(resident('r7-import-camera').slice(0, 3), [portfolio(1), 'candidate', '3']);
    assert.equal(resident('r3-moving')[3], '-', 'a moving vehicle is not resident');
    assert.notEqual(resident('r4-red')[3], r1Resident, 'a different colour is a different vehicle');
    assert.notEqual(resident('r6-late')[3], r1Resident, 'a sighting beyond 14 days starts again');
    assert.notEqual(resident('rb-other-org')[3], r1Resident, 'another organisation never shares a resident object');
    assert.equal(psql(`SELECT md5(o::text) FROM public.cctv_entity_observations o WHERE source_event_id = 'r5-reviewed';`).trim(), reviewedResidentBefore, 'reviewed rows are untouched');
    // Reprocessing deletes and rewrites the unreviewed sighting; the count is derived, not incremented.
    psql(`DELETE FROM public.cctv_entity_observations WHERE source_event_id = 'r2';
      ${obs(base('30000000-0000-4000-8000-000000000012', 3, { source_event_id: 'r2', entity_kind: 'vehicle', observed_at: '2026-10-03T00:00:00Z', portfolio_key: portfolio(2), attributes: stationary({ colour: 'white' }) }))}`);
    assert.equal(psql(`SELECT public.link_cctv_resident_vehicle_observations('${job(3)}');`).trim(), '1');
    assert.equal(psql(`SELECT sighting_count FROM public.cctv_resident_objects WHERE id = '${r1Resident}';`).trim(), '3', 'reprocessing does not inflate the count');

    // --- Cloud policy and receipts ---
    const receipt = (overrides = {}) => `'${JSON.stringify({
      provider: 'ollama_cloud', purpose: 'vehicle_make_model_hint', model: 'qwen3-vl:235b-cloud', crop_sha256: 'a'.repeat(64),
      crop_bytes: 2048, plate_masked: true, plate_boxes_masked: 1, persons_excluded: true, source_event_id: 'v2-v', ...overrides,
    })}'::jsonb`;
    const raises = (fn, pattern, label) => assert.throws(fn, pattern, label);
    const service = (sql) => api(`SET ROLE service_role; SELECT set_config('request.jwt.claim.role', 'service_role', false); ${sql}`);
    const signedIn = (user, sql) => api(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.role', 'authenticated', false); SELECT set_config('request.jwt.claim.sub', '${user}', false); ${sql}`);
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt()});`), /not enabled for this organisation/, 'off by default');
    raises(() => signedIn(member, `SELECT public.set_cctv_inference_policy('${orgA}', true, NULL, 'members cannot');`), /Only an administrator/, 'members cannot opt in');
    raises(() => signedIn(admin, `SELECT public.set_cctv_inference_policy('${orgA}', true, NULL, '  ');`), /A reason is required/, 'opting in needs a reason');
    raises(() => signedIn(admin, `SELECT public.set_cctv_inference_policy('${orgB}', true, NULL, 'wrong org');`), /Only an administrator/, 'another organisation is refused');
    raises(() => api(`SET ROLE authenticated; SELECT public.set_cctv_inference_policy('${orgA}', true, NULL, 'anonymous');`), /Authentication required/);
    raises(() => signedIn(admin, `SELECT public.set_cctv_inference_policy('${orgA}', true, 'bad model; drop', 'reason');`), /model name is not valid/);
    signedIn(admin, `SELECT public.set_cctv_inference_policy('${orgA}', true, 'qwen3-vl:235b-cloud', 'Vehicle make and model hints for the yard cameras');`);
    assert.equal(psql(`SELECT action || ':' || (metadata->>'cloud_vehicle_vlm_enabled') FROM public.audit_log WHERE action = 'cctv_inference_policy_set';`).trim(), 'cctv_inference_policy_set:true');
    assert.equal(signedIn(member, `SELECT count(*) FROM public.cctv_inference_policies;`).trim().split('\n').pop(), '1', 'members can read their policy');
    assert.equal(signedIn(outsider, `SELECT count(*) FROM public.cctv_inference_policies;`).trim().split('\n').pop(), '0', 'outsiders cannot');
    raises(() => signedIn(admin, `INSERT INTO public.cctv_inference_policies (organization_id, cloud_vehicle_vlm_enabled) VALUES ('${orgB}', false);`), /permission denied/);

    raises(() => api(`SET ROLE service_role; SELECT set_config('request.jwt.claim.role', 'authenticated', false); SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt()});`),
      /Service identity required/, 'the service guard checks the request role');
    raises(() => api(`SET ROLE service_role; SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt()});`),
      /Service identity required/, 'a missing request role fails closed');
    raises(() => signedIn(admin, `SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt()});`), /permission denied/, 'signed-in users cannot write receipts');
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt({ plate_masked: false })});`), /Plates must be masked/);
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt({ plate_masked: 'true' })});`), /Plates must be masked/, 'a string is not a boolean');
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt({ persons_excluded: null })});`), /People must be excluded/);
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt({ crop_sha256: 'abc' })});`), /SHA-256 crop hash/);
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt({ model: 'other-model:cloud' })});`), /not the one this organisation allowed/);
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt({ provider: 'openai' })});`), /Unsupported cloud inference provider/);
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('fb000000-0000-4000-8000-00000000000b', ${receipt()});`), /not enabled for this organisation/, 'opt-in is per organisation');
    const receiptId = service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt()});`).trim().split('\n').pop();
    assert.match(receiptId, /^[0-9a-f-]{36}$/);
    assert.equal(psql(`SELECT organization_id || ':' || evidence_item_id || ':' || plate_masked || ':' || persons_excluded || ':' || crop_bytes FROM public.cctv_cloud_inference_receipts WHERE id = '${receiptId}';`).trim(),
      `${orgA}:e1000000-0000-4000-8000-000000000001:true:true:2048`);
    signedIn(admin, `SELECT public.set_cctv_inference_policy('${orgA}', false);`);
    raises(() => service(`SELECT public.record_cctv_cloud_inference_receipt('${job(1)}', ${receipt()});`), /not enabled for this organisation/, 'turning it off stops the next crop');

    // --- Missed detections ---
    raises(() => signedIn(outsider, `SELECT public.report_cctv_missed_detection('e1000000-0000-4000-8000-000000000001', 'person', 12.5);`), /CCTV review access denied/);
    raises(() => signedIn(member, `SELECT public.report_cctv_missed_detection('e1000000-0000-4000-8000-000000000001', 'bicycle', 12.5);`), /Choose person, vehicle, or animal/);
    raises(() => signedIn(member, `SELECT public.report_cctv_missed_detection('e1000000-0000-4000-8000-000000000001', 'person');`), /Say when in the clip/);
    raises(() => signedIn(member, `SELECT public.report_cctv_missed_detection('e1000000-0000-4000-8000-000000000001', 'person', 3, NULL, '[1,2]'::jsonb);`), /must be a box/);
    signedIn(member, `SELECT public.report_cctv_missed_detection('e1000000-0000-4000-8000-000000000001', 'animal', 12.5, NULL, '{"x":1,"y":2,"width":30,"height":20}'::jsonb, 'Possum at the fence line');`);
    assert.equal(psql(`SELECT inference_job_id || ':' || engine_version || ':' || state || ':' || reported_by FROM public.cctv_missed_detection_reports;`).trim(), `${job(1)}:cctv-engine-v2:open:${member}`);
    assert.equal(psql(`SELECT count(*) FROM public.audit_log WHERE action = 'cctv_missed_detection_reported' AND actor_user_id = '${member}';`).trim(), '1');
    const reportId = psql(`SELECT id FROM public.cctv_missed_detection_reports;`).trim();
    raises(() => signedIn(member, `SELECT public.resolve_cctv_missed_detection('${reportId}', 'confirmed_missed');`), /Only an organisation administrator/);
    raises(() => signedIn(admin, `SELECT public.resolve_cctv_missed_detection('${reportId}', 'open');`), /Resolve as confirmed_missed or not_missed/);
    raises(() => signedIn(admin, `SELECT public.resolve_cctv_missed_detection('${randomUUID()}', 'not_missed');`), /Only an organisation administrator/, 'an unknown report reveals nothing');
    signedIn(admin, `SELECT public.resolve_cctv_missed_detection('${reportId}', 'confirmed_missed', 'Possum visible at 12 s');`);
    assert.equal(psql(`SELECT state || ':' || resolved_by || ':' || resolution_notes FROM public.cctv_missed_detection_reports;`).trim(), `confirmed_missed:${admin}:Possum visible at 12 s`);
    raises(() => signedIn(admin, `SELECT public.resolve_cctv_missed_detection('${reportId}', 'not_missed');`), /already resolved as confirmed_missed/, 'a resolution is final');
    raises(() => psql(`UPDATE public.cctv_missed_detection_reports SET resolved_at = NULL;`), /check constraint/, 'a resolved state always names when');
    assert.equal(psql(`SELECT count(*) FROM public.audit_log WHERE action = 'cctv_missed_detection_resolved' AND actor_user_id = '${admin}';`).trim(), '1');

    // --- Accuracy summary ---
    const decided = [];
    for (let index = 0; index < 40; index += 1) {
      decided.push(obs(base(randomUUID(), 2, { source_event_id: `acc-${index}`, entity_kind: 'person', observed_at: at(index), model_confidence: 0.9,
        review_state: index < 30 ? 'accepted' : 'rejected', attributes: { engine_version: 'cctv-engine-v2', detector_model: 'rf-detr-large-704-coco', review_candidate_basis: 'temporal_consensus' } })));
    }
    decided.push(obs(base(randomUUID(), 2, { source_event_id: 'acc-dup', entity_kind: 'person', observed_at: at(1), model_confidence: 0.9, review_state: 'superseded',
      attributes: { engine_version: 'cctv-engine-v2', detector_model: 'rf-detr-large-704-coco', review_candidate_basis: 'temporal_consensus' } })));
    psql(decided.join('\n'));
    raises(() => signedIn(outsider, `SELECT public.cctv_accuracy_summary('${orgA}');`), /CCTV review access denied/);
    raises(() => api(`SET ROLE authenticated; SELECT public.cctv_accuracy_summary('${orgA}');`), /CCTV review access denied/, 'no identity fails closed');
    const summary = JSON.parse(signedIn(member, `SELECT public.cctv_accuracy_summary('${orgA}', '2000-01-01');`).trim().split('\n').pop());
    const group = summary.groups.find((row) => row.engine_version === 'cctv-engine-v2' && row.confidence_band === '0.85-1.00');
    assert.deepEqual(
      { decided: group.decided, accepted: group.accepted, rejected: group.rejected, precision: group.precision, calibrated: group.calibrated, total: group.total },
      { decided: 40, accepted: 30, rejected: 10, precision: 0.75, calibrated: true, total: 40 },
      'superseded duplicates are not counted',
    );
    assert.ok(Math.abs(group.precision_lower_bound - 0.5981) < 0.0005, `Wilson lower bound ${group.precision_lower_bound}`);
    const legacy = summary.groups.find((row) => row.engine_version === 'legacy' && row.entity_kind === 'person' && row.accepted === 1);
    assert.equal(legacy.calibrated, false, 'one decision is not calibrated');
    assert.deepEqual(summary.missed_detections, [{ entity_kind: 'animal', engine_version: 'cctv-engine-v2', open: 0, confirmed_missed: 1, not_missed: 0 }]);
    assert.equal(summary.calibration_minimum_decisions, 30);

    // --- Grants seen from the database ---
    for (const signature of SERVICE_ONLY) {
      assert.equal(psql(`SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')::text || has_function_privilege('authenticated', '${signature}', 'EXECUTE')::text
        || has_function_privilege('anon', '${signature}', 'EXECUTE')::text || has_function_privilege('stranger', '${signature}', 'EXECUTE')::text;`).trim(), 'truefalsefalsefalse', signature);
    }
    for (const signature of SIGNED_IN) {
      assert.equal(psql(`SELECT has_function_privilege('authenticated', '${signature}', 'EXECUTE')::text || has_function_privilege('anon', '${signature}', 'EXECUTE')::text
        || has_function_privilege('stranger', '${signature}', 'EXECUTE')::text;`).trim(), 'truefalsefalse', signature);
    }
    for (const table of TABLES) {
      assert.equal(psql(`SELECT has_table_privilege('authenticated', 'public.${table}', 'SELECT')::text || has_table_privilege('authenticated', 'public.${table}', 'INSERT')::text
        || has_table_privilege('anon', 'public.${table}', 'SELECT')::text;`).trim(), 'truefalsefalse', table);
    }
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
