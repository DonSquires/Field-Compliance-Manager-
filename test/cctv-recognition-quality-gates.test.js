'use strict';
// CCTV recognition v2 (2026-11-02): low-quality person and vehicle templates must not enter storage or matching,
// a usable body match may join an existing provisional profile, and only a stored, clear, usable face may create a
// new Unknown Person profile. Synthetic data only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261102190000_cctv_recognition_quality_gates.sql'),
  'utf8',
);
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');

function liveFunction(name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `${name} is in the live schema snapshot`);
  return schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
}

function functionBody(name) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} is defined in the migration`);
  const end = migration.indexOf('$$;', start);
  assert.ok(end > start, `${name} has a complete body`);
  return migration.slice(start, end);
}

test('person and vehicle embeddings are removed before storage and matching unless source quality flags pass', () => {
  const writer = functionBody('record_cctv_entity_observations');
  assert.match(writer, /face_usable_for_matching}' = 'true'/);
  assert.match(writer, /appearance_embedding_usable}' = 'true'/);
  assert.match(writer, /v_app_usable := v_kind NOT IN \('person', 'vehicle'\)/);
  assert.match(writer, /COALESCE\(observation->>'quality_state', 'clear'\) = 'clear'/);
  assert.match(writer, /IF NOT v_face_usable THEN v_face_input := NULL;/);
  assert.match(writer, /IF NOT v_app_usable THEN v_app_input := NULL;/);
  assert.match(writer, /IF v_app IS NULL THEN v_app_input := NULL;/);
  assert.match(writer, /CASE WHEN jsonb_typeof\(v_face_input\) = 'array' THEN v_face_input END/);
  assert.match(writer, /v_face_input, v_app_input/);
  assert.doesNotMatch(writer, /observation->'candidate_embedding',\s+observation->'appearance_embedding'/);
});

test('usable faces may create profiles while usable body matches only join existing profiles', () => {
  const writer = functionBody('record_cctv_entity_observations');
  assert.match(writer, /IF v_kind = 'person' AND \(v_face IS NOT NULL OR v_best_key IS NOT NULL\) THEN/);
  assert.match(writer, /IF v_person_id IS NOT NULL THEN\s+UPDATE public\.cctv_entity_observations/);
  assert.doesNotMatch(writer, /IF v_kind = 'person' THEN\s+SELECT profile/);
  const profile = functionBody('ensure_cctv_person_profile');
  assert.match(profile, /p_observation_id IS NULL OR NOT EXISTS/);
  assert.match(profile, /observation\.face_vec IS NOT NULL/);
  assert.match(profile, /observation\.attributes->>'face_usable_for_matching' = 'true'/);
  assert.match(profile, /observation\.quality_state = 'clear'/);
  assert.match(profile, /pg_advisory_xact_lock\(hashtextextended\('cctv_unknown_person:'/);
});

test('both recognition writers are service-only, fail closed and keep the live grants', () => {
  assert.equal((migration.match(/IF coalesce\(auth\.role\(\), ''\) <> 'service_role' AND session_user NOT IN \('postgres', 'supabase_admin'\) THEN/g) || []).length, 2);
  assert.doesNotMatch(migration, /IF auth\.role\(\) <> 'service_role'/);
  for (const signature of ['ensure_cctv_person_profile\\(uuid, uuid, uuid, uuid, timestamptz\\)', 'record_cctv_entity_observations\\(uuid, uuid, uuid, jsonb\\)']) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM PUBLIC, anon, authenticated, service_role;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO postgres, service_role;`));
  }
});

test('recognition gates hold against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-cctv-recognition-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psqlAs = (user) => (sql) => execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = psqlAs('postgres');
  const api = psqlAs('api_gateway');
  const raises = (fn, pattern, message) => assert.throws(fn, (error) => pattern.test(String(error.stderr || error.message)), message);
  const one = (sql) => psql(sql).trim().split('\n').at(-1);
  const org = '0a000000-0000-4000-8000-00000000000a';
  const evidence = '0e000000-0000-4000-8000-00000000000e';
  const job = '0b000000-0000-4000-8000-00000000000b';
  const vec = (dims) => Array.from({ length: dims }, (_, index) => ((index % 7) + 1) / 10);
  const person = (id, { face = true, faceUsable = false, body = true, bodyUsable = false, quality = 'clear' } = {}) => ({
    source_event_id: id, entity_kind: 'person', observed_at: '2026-11-02T01:00:00Z', quality_state: quality,
    candidate_embedding: face ? vec(128) : null, appearance_embedding: body ? vec(256) : null,
    attributes: { face_usable_for_matching: faceUsable, appearance_embedding_usable: bodyUsable },
  });
  const record = (observations, prefix = "SET ROLE service_role; SELECT set_config('request.jwt.claim.role', 'service_role', false);") =>
    api(`${prefix} SELECT public.record_cctv_entity_observations('${job}', '${evidence}', '${org}', $json$${JSON.stringify(observations)}$json$::jsonb);`)
      .trim().split('\n').at(-1);
  const row = (id, columns) => one(`SELECT ${columns} FROM public.cctv_entity_observations WHERE source_event_id = '${id}';`);
  const hits = (values) => psql(`DELETE FROM public.test_match_hits; ${values.length ? `INSERT INTO public.test_match_hits VALUES ${values.join(', ')};` : ''}`);
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
    psql(`
      DO $$ BEGIN
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
        CREATE ROLE api_gateway LOGIN NOINHERIT; GRANT anon, authenticated, service_role TO api_gateway;
      END $$;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $fn$;
      -- pgvector stand-in: these functions only store vectors; similarity search is stubbed below.
      CREATE DOMAIN public.vector AS real[];
      CREATE FUNCTION public.cctv_jsonb_to_vector(p_value jsonb, p_dimensions integer) RETURNS public.vector LANGUAGE sql IMMUTABLE AS
        $fn$ SELECT CASE WHEN jsonb_typeof(p_value) = 'array' AND jsonb_array_length(p_value) = p_dimensions
          THEN ARRAY(SELECT value::real FROM jsonb_array_elements_text(p_value))::public.vector END $fn$;
      CREATE TABLE public.organizations (id uuid PRIMARY KEY);
      CREATE TABLE public.cctv_imports (id uuid PRIMARY KEY, location_id uuid, canonical_place_id uuid, site_id uuid, zone_id uuid);
      CREATE TABLE public.evidence_items (id uuid PRIMARY KEY, cctv_import_id uuid);
      CREATE TABLE public.inference_jobs (id uuid PRIMARY KEY, organization_id uuid NOT NULL, evidence_item_id uuid, domain text NOT NULL);
      CREATE TABLE public.person_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, display_name text,
        review_state text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE public.canonical_people (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_key text NOT NULL UNIQUE, display_name text,
        normalized_name text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', review_state text NOT NULL DEFAULT 'draft',
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE public.canonical_person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_person_id uuid NOT NULL,
        source_table text NOT NULL, source_id uuid NOT NULL, organization_id uuid, link_kind text NOT NULL DEFAULT 'projection',
        metadata jsonb NOT NULL DEFAULT '{}', UNIQUE (source_table, source_id));
      CREATE TABLE public.audit_log (id bigserial PRIMARY KEY, organization_id uuid, actor_user_id uuid, action text, target_table text,
        target_id uuid, metadata jsonb);
      CREATE TABLE public.cctv_entity_observations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, inference_job_id uuid NOT NULL,
        evidence_item_id uuid NOT NULL, source_event_id text NOT NULL, entity_kind text NOT NULL, observed_at timestamptz NOT NULL,
        observed_to timestamptz, site_id uuid, zone_id uuid, canonical_person_id uuid, canonical_vehicle_id uuid, candidate_label text,
        candidate_plate text, animal_type text, candidate_embedding jsonb, model_confidence real, frame_sha256 text, thumbnail text,
        review_state text NOT NULL DEFAULT 'unreviewed', person_record_id uuid, cctv_import_id uuid, location_id uuid,
        canonical_place_id uuid, quality_state text NOT NULL DEFAULT 'clear', species_confidence real, is_pest boolean,
        attributes jsonb NOT NULL DEFAULT '{}', appearance_embedding jsonb, face_vec public.vector, appearance_vec public.vector,
        portfolio_key uuid, portfolio_state text NOT NULL DEFAULT 'unmatched', portfolio_candidates jsonb NOT NULL DEFAULT '[]',
        reviewed_by uuid, reviewed_at timestamptz, review_notes text,
        UNIQUE (inference_job_id, source_event_id, entity_kind));
      CREATE TABLE public.test_match_calls (entity_kind text, face jsonb, appearance jsonb);
      CREATE TABLE public.test_match_hits (entity_kind text, portfolio_key uuid, score real, basis text);
      CREATE FUNCTION public.find_cctv_portfolio_matches(p_organization_id uuid, p_entity_kind text, p_face_embedding jsonb DEFAULT NULL,
        p_appearance_embedding jsonb DEFAULT NULL, p_plate text DEFAULT NULL, p_exclude_observation_id uuid DEFAULT NULL, p_limit integer DEFAULT 10)
      RETURNS TABLE(match_kind text, match_id uuid, observation_id uuid, portfolio_key uuid, display_name text, score real, basis text,
        last_seen_at timestamptz, canonical_place_id uuid, plate_number text, person_record_id uuid, canonical_vehicle_id uuid,
        thumbnail text, evidence_item_id uuid, cctv_import_id uuid)
      LANGUAGE plpgsql AS $fn$
      #variable_conflict use_column
      BEGIN
        INSERT INTO public.test_match_calls VALUES (p_entity_kind, p_face_embedding, p_appearance_embedding);
        RETURN QUERY SELECT 'observation'::text, gen_random_uuid(), NULL::uuid, h.portfolio_key, NULL::text, h.score, h.basis,
          NULL::timestamptz, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid
          FROM public.test_match_hits h
         WHERE h.entity_kind = p_entity_kind
           AND ((h.basis = 'face' AND p_face_embedding IS NOT NULL) OR (h.basis = 'appearance' AND p_appearance_embedding IS NOT NULL));
      END $fn$;
      ${liveFunction('normalize_plate_number')}
      ${liveFunction('ensure_canonical_person_for_record')}
      ${migration}
      INSERT INTO public.organizations VALUES ('${org}');
      INSERT INTO public.evidence_items VALUES ('${evidence}', NULL);
      INSERT INTO public.inference_jobs VALUES ('${job}', '${org}', '${evidence}', 'video_motion');
    `);

    raises(() => record([person('denied')], 'SET ROLE service_role;'), /Service identity required/, 'a missing request role fails closed');
    raises(() => api(`SET ROLE service_role; SELECT * FROM public.ensure_cctv_person_profile('${org}', gen_random_uuid());`),
      /Service identity required/, 'the profile helper also fails closed');
    for (const role of ['anon', 'authenticated']) {
      raises(() => record([person('denied')], `SET ROLE ${role}; SELECT set_config('request.jwt.claim.role', 'service_role', false);`),
        /permission denied for function record_cctv_entity_observations/, `${role} cannot record observations`);
      raises(() => api(`SET ROLE ${role}; SELECT * FROM public.ensure_cctv_person_profile('${org}', gen_random_uuid());`),
        /permission denied for function ensure_cctv_person_profile/, `${role} cannot mint profiles`);
    }

    assert.equal(record([person('face-1', { faceUsable: true, bodyUsable: true })]), '1');
    const firstKey = row('face-1', 'portfolio_key');
    const firstPerson = row('face-1', 'person_record_id');
    assert.equal(one(`SELECT display_name FROM public.person_records WHERE id = '${firstPerson}';`), 'Unknown Person #1');
    assert.equal(row('face-1', 'face_vec IS NOT NULL AND appearance_vec IS NOT NULL AND canonical_person_id IS NOT NULL'), 't');
    assert.equal(one("SELECT count(*) FROM public.audit_log WHERE action = 'cctv_unknown_person_profile_created';"), '1');

    hits([`('person', '${firstKey}', 0.95, 'face')`, `('person', '${firstKey}', 0.95, 'appearance')`]);
    psql('DELETE FROM public.test_match_calls;');
    assert.equal(record([person('low-flags'), person('degraded', { faceUsable: true, bodyUsable: true, quality: 'degraded' })]), '2');
    assert.equal(one('SELECT count(*) FROM public.test_match_calls WHERE face IS NOT NULL OR appearance IS NOT NULL;'), '0',
      'unusable or degraded person templates never reach matching');
    for (const id of ['low-flags', 'degraded']) {
      assert.equal(row(id, `candidate_embedding IS NULL AND appearance_embedding IS NULL AND face_vec IS NULL AND appearance_vec IS NULL
        AND person_record_id IS NULL AND portfolio_key <> '${firstKey}'`), 't', `${id} is stored without templates or a profile`);
    }

    hits([`('person', '${firstKey}', 0.9, 'appearance')`]);
    assert.equal(record([person('body-joins', { face: false, bodyUsable: true })]), '1');
    assert.equal(row('body-joins', `portfolio_key = '${firstKey}' AND person_record_id = '${firstPerson}'`), 't',
      'a usable body match joins the existing provisional profile');

    hits([]);
    assert.equal(record([person('body-alone', { face: false, bodyUsable: true })]), '1');
    assert.equal(row('body-alone', 'person_record_id IS NULL AND appearance_vec IS NOT NULL'), 't', 'an unmatched body template mints no profile');
    hits([`('person', '${row('body-alone', 'portfolio_key')}', 0.9, 'appearance')`]);
    assert.equal(record([person('body-chain', { face: false, bodyUsable: true })]), '1');
    assert.equal(row('body-chain', 'person_record_id IS NULL'), 't', 'a body match to a faceless portfolio mints no profile');
    assert.equal(one('SELECT count(*) FROM public.person_records;'), '1');

    const vehicleKey = randomUUID();
    hits([`('vehicle', '${vehicleKey}', 0.9, 'appearance')`]);
    const vehicle = (id, usable) => ({ source_event_id: id, entity_kind: 'vehicle', observed_at: '2026-11-02T01:00:00Z',
      appearance_embedding: vec(256), attributes: { appearance_embedding_usable: usable } });
    const animal = { source_event_id: 'animal', entity_kind: 'animal', observed_at: '2026-11-02T01:00:00Z', appearance_embedding: vec(256) };
    assert.equal(record([vehicle('vehicle-blurred', false), vehicle('vehicle-clear', true), animal]), '3');
    assert.equal(row('vehicle-blurred', `appearance_embedding IS NULL AND appearance_vec IS NULL AND portfolio_key <> '${vehicleKey}'`), 't');
    assert.equal(row('vehicle-clear', `appearance_vec IS NOT NULL AND portfolio_key = '${vehicleKey}'`), 't');
    assert.equal(row('animal', 'appearance_vec IS NOT NULL'), 't', 'animal templates keep their existing path');

    psql("UPDATE public.cctv_entity_observations SET review_state = 'accepted' WHERE source_event_id = 'face-1';");
    assert.equal(record([person('face-1', { face: false, body: false })]), '0');
    assert.equal(row('face-1', `face_vec IS NOT NULL AND candidate_embedding IS NOT NULL AND person_record_id = '${firstPerson}'`), 't',
      'a reviewed observation keeps its templates and profile');

    const service = "SET ROLE service_role; SELECT set_config('request.jwt.claim.role', 'service_role', false);";
    assert.equal(api(`${service} SELECT count(*) FROM public.ensure_cctv_person_profile('${org}', gen_random_uuid(), NULL, '${evidence}', now());`)
      .trim().split('\n').at(-1), '0', 'a face event without a stored usable observation mints no profile');
    assert.equal(api(`${service} SELECT person_record_id FROM public.ensure_cctv_person_profile('${org}', '${firstKey}');`)
      .trim().split('\n').at(-1), firstPerson, 'an existing portfolio profile still resolves');
    assert.equal(one('SELECT count(*) FROM public.person_records;'), '1');
  } finally {
    if (created) {
      try { docker(['rm', '--force', name]); } catch { /* best-effort cleanup */ }
    }
  }
});
