const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const PROVIDER = '10000000-0000-4000-8000-000000000001';
const CLIENT = '10000000-0000-4000-8000-000000000002';
const ACTOR = '10000000-0000-4000-8000-000000000003';
const RECORD = '10000000-0000-4000-8000-000000000004';
const BATCH = '10000000-0000-4000-8000-000000000005';
const ZONE = '10000000-0000-4000-8000-000000000006';
const AGREEMENT = '10000000-0000-4000-8000-000000000007';
const OBSERVATION = '10000000-0000-4000-8000-000000000008';
const HOUSE = '10000000-0000-4000-8000-000000000009';
const FOREIGN_ORG = '10000000-0000-4000-8000-000000000010';
const FOREIGN_HOUSE = '10000000-0000-4000-8000-000000000011';
const FOREIGN_ZONE = '10000000-0000-4000-8000-000000000012';
const FOREIGN_SITE = '10000000-0000-4000-8000-000000000013';
const SITE_A = '10000000-0000-4000-8000-000000000014';
const SITE_B = '10000000-0000-4000-8000-000000000015';
const SECOND_ZONE = '10000000-0000-4000-8000-000000000016';
const HASH = 'a'.repeat(64);
const PREVIOUS = 'b'.repeat(64);
const NEXT = 'c'.repeat(64);
const REF = 'rm_patrol_import:TEST:7';
const provenance = { source_sha256: HASH, derivative_sha256: HASH, source_file: 'source.xlsx',
  source_sheet: 'DATA', source_row: 1, classification_profile: 'rm_patrol_log' };
const root = path.join(__dirname, '..');

function catalogFunction(schema, name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `Missing catalog function ${name}`);
  const end = schema.indexOf('$function$;', start);
  assert.ok(end >= 0, `Unterminated catalog function ${name}`);
  return schema.slice(start, end + '$function$;'.length);
}

describe('direct patrol source RPC concurrency', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, () => {
  const name = `fcm-patrol-direct-${randomUUID()}`;
  let created = false;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
  });
  const sql = query => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();

  before(async () => {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--pull', 'never',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    sql(`CREATE EXTENSION dblink;
      CREATE SCHEMA auth;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${ACTOR}'::uuid $$;
      CREATE FUNCTION public.is_tenant_import_admin(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE TABLE public.file_import_batches(
        id uuid PRIMARY KEY, organization_id uuid, status text, source_sha256 text, manifest_json jsonb, created_by uuid,
        source_file text NOT NULL
      );
      CREATE TABLE public.import_source_profiles(
        organization_id uuid, profile_code text, active boolean, import_actor_id uuid
      );
      CREATE TABLE public.service_agreements(
        id uuid PRIMARY KEY, provider_organization_id uuid, client_organization_id uuid,
        agreement_type text, starts_on date, ends_on date
      );
      CREATE TABLE public.service_agreement_modules(service_agreement_id uuid, module_key text, enabled boolean);
      CREATE TABLE public.service_agreement_locations(service_agreement_id uuid, zone_id uuid, site_id uuid, status text);
      CREATE TABLE public.locations(id uuid PRIMARY KEY, organization_id uuid);
      CREATE TABLE public.location_zones(id uuid PRIMARY KEY, organization_id uuid, location_id uuid);
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY, organization_id uuid, client_organization_id uuid, location_id uuid);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, employer_organization_id uuid, deactivated_at timestamptz);
      CREATE TABLE public.canonical_vehicles(id uuid DEFAULT gen_random_uuid(), plate_number text, compliance_source text);
      CREATE TABLE public.location_events(
        id uuid PRIMARY KEY, organization_id uuid, external_ref text, source text, occurred_at timestamptz,
        zone_id uuid, client_site_id uuid, observed_entity_id uuid, observed_entity_type text,
        event_type text, status text, distance_km numeric, payload jsonb
      );
      CREATE TABLE public.observations(
        id uuid PRIMARY KEY, organization_id uuid, officer_id uuid, plate_number text, zone_id uuid,
        site_id uuid, observed_at timestamptz, module_key text, canonical_vehicle_id uuid, officer_notes text,
        plate_source text, external_refs jsonb, distance_km numeric, locked_at timestamptz,
        gps_lat double precision, gps_lng double precision, is_compliant boolean, compliance_reason text
      );
      CREATE TABLE public.file_import_row_proposals(
        organization_id uuid, batch_id uuid, source_record_key text, source_row_number integer,
        target_type text, proposed_payload jsonb, source_values jsonb, confidence numeric, status text, created_by uuid,
        UNIQUE(batch_id,source_record_key,target_type)
      );
      CREATE TABLE public.patrol_import_record_versions(
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY, provider_organization_id uuid, client_organization_id uuid,
        record_kind text, record_id uuid, external_ref text, source_profile text, source_file text, source_sheet text,
        source_row integer, source_sha256 text, derivative_sha256 text, source_fingerprint text, batch_id uuid,
        version_no integer, is_current boolean DEFAULT true, change_kind text, changed_fields text[],
        state_before jsonb, state_after jsonb, applied_by uuid
      );
      CREATE TABLE public.audit_log(
        organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb
      );
      CREATE FUNCTION public.patrol_source_sync_batch(uuid,uuid,uuid) RETURNS public.file_import_batches
      LANGUAGE sql AS $$ SELECT batch FROM public.file_import_batches batch WHERE batch.id=$1 $$;
      CREATE FUNCTION public.patrol_source_assert_row_provenance(public.file_import_batches,jsonb) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT $2->'desired'->'payload' $$;
      CREATE FUNCTION public.patrol_source_state_diff(jsonb,jsonb) RETURNS text[]
      LANGUAGE sql AS $$ SELECT ARRAY['status']::text[] $$;
      CREATE FUNCTION public.patrol_source_record_state(p_kind text,p_record_id uuid) RETURNS jsonb
      LANGUAGE plpgsql AS $$
      DECLARE state jsonb; attempt integer; edit_sql text;
      BEGIN
        IF p_kind='event' THEN
          SELECT jsonb_build_object('status',event.status) INTO state
          FROM public.location_events event WHERE event.id=p_record_id;
          edit_sql:=format('UPDATE public.location_events SET status=%L WHERE id=%L','manual edit',p_record_id);
        ELSE
          SELECT jsonb_build_object('officer_notes',observation.officer_notes) INTO state
          FROM public.observations observation WHERE observation.id=p_record_id;
          edit_sql:=format('UPDATE public.observations SET officer_notes=%L WHERE id=%L','manual edit',p_record_id);
        END IF;
        IF current_setting('test.concurrent_edit',true)='yes' THEN
          PERFORM set_config('test.concurrent_edit','no',true);
          PERFORM public.dblink_connect('manual_editor',
            'host=127.0.0.1 user=postgres dbname=postgres application_name=fcm_patrol_manual_editor');
          PERFORM public.dblink_send_query('manual_editor',edit_sql);
          FOR attempt IN 1..100 LOOP
            EXIT WHEN public.dblink_is_busy('manual_editor')=0;
            PERFORM pg_stat_clear_snapshot();
            EXIT WHEN EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE application_name='fcm_patrol_manual_editor' AND wait_event_type='Lock');
            IF attempt=100 THEN RAISE EXCEPTION 'Concurrent editor did not reach a deterministic state'; END IF;
            PERFORM pg_sleep(0.02);
          END LOOP;
        END IF;
        RETURN state;
      END $$;
      INSERT INTO public.file_import_batches VALUES (
        '${BATCH}','${PROVIDER}','staging','${HASH}',
        jsonb_build_object('target_client_organization_id','${CLIENT}','source_profile','rm_patrol_log',
          'derivative_sha256','${HASH}'),'${ACTOR}','source.xlsx');
      INSERT INTO public.import_source_profiles VALUES ('${PROVIDER}','rm_patrol_log',true,'${ACTOR}');
      INSERT INTO public.service_agreements VALUES ('${AGREEMENT}','${PROVIDER}','${CLIENT}','operational',NULL,NULL);
      INSERT INTO public.service_agreement_modules VALUES ('${AGREEMENT}','patrol',true);
      INSERT INTO public.service_agreement_locations VALUES ('${AGREEMENT}','${ZONE}',NULL,'active');
      INSERT INTO public.locations VALUES ('${HOUSE}','${CLIENT}');
      INSERT INTO public.location_zones VALUES ('${ZONE}','${CLIENT}','${HOUSE}');
      INSERT INTO public.user_profiles VALUES ('${ACTOR}','${PROVIDER}',NULL,NULL);
      INSERT INTO public.location_events VALUES (
        '${RECORD}','${CLIENT}','${REF}','rm_patrol_log_import','2026-10-19T00:00:00Z',
        '${ZONE}',NULL,NULL,NULL,'patrol_visit','original',4,
        jsonb_build_object('source_sha256','${HASH}','comments','manual note','extra',NULL::text));
      INSERT INTO public.observations(id,organization_id,officer_id,plate_number,zone_id,observed_at,officer_notes,external_refs)
      VALUES ('${OBSERVATION}','${CLIENT}','${ACTOR}','ABC123','${ZONE}','2026-10-19T00:00:00Z','original',
        jsonb_build_object('external_ref','${REF}:obs','import',jsonb_build_object(
          'source','rm_patrol_log_import','source_sha256','${HASH}','comments','manual note','extra',NULL::text)));
      INSERT INTO public.patrol_import_record_versions(provider_organization_id,client_organization_id,record_kind,
        record_id,external_ref,source_profile,source_file,source_sheet,source_fingerprint,batch_id,version_no,state_after)
      VALUES ('${PROVIDER}','${CLIENT}','event','${RECORD}','${REF}','rm_patrol_log','source.xlsx','DATA',
        '${PREVIOUS}','${BATCH}',1,'{"status":"original"}'),
        ('${PROVIDER}','${CLIENT}','observation','${OBSERVATION}','${REF}:obs','rm_patrol_log','source.xlsx','DATA',
        '${PREVIOUS}','${BATCH}',1,'{"officer_notes":"original"}');`);

    const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
    sql(catalogFunction(schema, 'stage_patrol_import_chunk_unlocked'));
    sql(catalogFunction(schema, 'stage_patrol_import_chunk_contract_scoped'));
    sql(catalogFunction(schema, 'stage_patrol_import_chunk'));
    sql(catalogFunction(schema, 'adopt_patrol_source_baseline'));
    sql(catalogFunction(schema, 'apply_patrol_source_updates'));
    sql(catalogFunction(schema, 'tg_observations_enforce_lock'));
    sql(`CREATE TRIGGER test_observations_enforce_lock BEFORE UPDATE ON public.observations
      FOR EACH ROW EXECUTE FUNCTION public.tg_observations_enforce_lock();`);
    sql(`REVOKE ALL ON FUNCTION public.stage_patrol_import_chunk_unlocked(uuid,uuid,uuid,jsonb,jsonb,jsonb)
        FROM PUBLIC,anon,authenticated,service_role;
      GRANT EXECUTE ON FUNCTION public.stage_patrol_import_chunk_unlocked(uuid,uuid,uuid,jsonb,jsonb,jsonb) TO postgres;
      REVOKE ALL ON FUNCTION public.apply_patrol_source_updates(uuid,uuid,uuid,jsonb)
        FROM PUBLIC,anon,authenticated,service_role;
      GRANT EXECUTE ON FUNCTION public.apply_patrol_source_updates(uuid,uuid,uuid,jsonb) TO authenticated;
      REVOKE ALL ON FUNCTION public.adopt_patrol_source_baseline(uuid,uuid,uuid,jsonb)
        FROM PUBLIC,anon,authenticated,service_role;
      GRANT EXECUTE ON FUNCTION public.adopt_patrol_source_baseline(uuid,uuid,uuid,jsonb) TO authenticated;`);
    const migrations = fs.readdirSync(path.join(root, 'supabase', 'migrations'))
      .filter(file => file.endsWith('_patrol_source_safe_concurrency.sql'));
    assert.ok(migrations.length <= 1, 'Only one patrol concurrency migration is expected');
    if (migrations.length) {
      const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', migrations[0]), 'utf8');
      if (migration.trim()) sql(migration);
    }
  });

  after(() => {
    if (created) docker(['rm', '-f', name]);
  });

  function probeLockOrder(operation, updates, firstKey, secondKey, application) {
    const remote = `SELECT outcome FROM public.${operation}(
      '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify(updates)}$json$::jsonb)`;
    return sql(`BEGIN;
      DO $gate$
      DECLARE attempt integer;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('${firstKey}',0));
        PERFORM public.dblink_connect('order_probe',
          'host=127.0.0.1 user=postgres dbname=postgres application_name=${application}');
        PERFORM public.dblink_send_query('order_probe',$query$${remote}$query$);
        FOR attempt IN 1..100 LOOP
          PERFORM pg_stat_clear_snapshot();
          EXIT WHEN EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE application_name='${application}' AND wait_event_type='Lock');
          IF attempt=100 THEN RAISE EXCEPTION 'Update did not reach the contested lock'; END IF;
          PERFORM pg_sleep(0.02);
        END LOOP;
        IF NOT pg_try_advisory_xact_lock(hashtextextended('${secondKey}',0)) THEN
          RAISE EXCEPTION 'Update acquired the later lock before the earlier lock';
        END IF;
      END $gate$;
      COMMIT;
      SELECT outcome FROM public.dblink_get_result('order_probe') AS result(outcome text);
      DO $close$ BEGIN PERFORM public.dblink_disconnect('order_probe'); END $close$;`).split('\n');
  }

  test('source updates take mixed evidence keys in the same order as staging', () => {
    const earlier = `${REF}:order-a`;
    const later = `${REF}:order-z`;
    const items = [
      { kind: 'event', external_ref: later, record_id: randomUUID(), prior_source_fingerprint: PREVIOUS,
        desired: { payload: { ...provenance } } },
      { kind: 'observation', external_ref: earlier, record_id: randomUUID(), prior_source_fingerprint: PREVIOUS,
        desired: { payload: { ...provenance } } },
    ];
    assert.deepEqual(probeLockOrder('apply_patrol_source_updates', items, `${CLIENT}:evidence:${earlier}`,
      `${CLIENT}:evidence:${later}`, 'fcm_patrol_evidence_order'), ['held', 'held']);
  });

  test('baseline adoption takes mixed evidence keys in the same order as staging', () => {
    const earlier = `${REF}:baseline-order-a`;
    const later = `${REF}:baseline-order-z`;
    const items = [
      { kind: 'event', external_ref: later, record_id: randomUUID(), source_fingerprint: PREVIOUS,
        desired: { external_ref: later, payload: { ...provenance } } },
      { kind: 'observation', external_ref: earlier, record_id: randomUUID(), source_fingerprint: PREVIOUS,
        desired: { external_ref: earlier, payload: { ...provenance } } },
    ];
    assert.deepEqual(probeLockOrder('adopt_patrol_source_baseline', items, `${CLIENT}:evidence:${earlier}`,
      `${CLIENT}:evidence:${later}`, 'fcm_patrol_baseline_order'), ['held', 'held']);
  });

  test('baseline adoption holds a source key shared by different evidence kinds', () => {
    const items = [
      { kind: 'event', external_ref: REF, record_id: RECORD, source_fingerprint: PREVIOUS,
        desired: { external_ref: REF, payload: { ...provenance } } },
      { kind: 'observation', external_ref: `${REF}:obs`, record_id: OBSERVATION, source_fingerprint: PREVIOUS,
        desired: { external_ref: `${REF}:obs`, payload: { ...provenance } } },
    ];
    const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
    const result = sql(`BEGIN;
      ${catalogFunction(schema, 'patrol_source_assert_row_provenance')}
      INSERT INTO public.observations(id,organization_id,external_refs)
        VALUES (gen_random_uuid(),'${CLIENT}',jsonb_build_object('external_ref','${REF}'));
      INSERT INTO public.location_events(id,organization_id,external_ref,source)
        VALUES (gen_random_uuid(),'${CLIENT}','${REF}:obs','manual_entry');
      SELECT outcome || '|' || coalesce(detail,'') FROM public.adopt_patrol_source_baseline(
        '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify(items)}$json$::jsonb);
      ROLLBACK;`).split('\n');
    assert.deepEqual(result, ['held|ambiguous_record_key', 'held|ambiguous_record_key']);
  });

  test('baseline adoption checks for another evidence kind after waiting for its source lock', () => {
    const item = { kind: 'event', external_ref: REF, record_id: RECORD, source_fingerprint: PREVIOUS,
      desired: { external_ref: REF, payload: { ...provenance } } };
    const remote = `SELECT outcome || '|' || coalesce(detail,'') FROM public.adopt_patrol_source_baseline(
      '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([item])}$json$::jsonb)`;
    try {
      const result = sql(`BEGIN;
        DO $start$
        DECLARE attempt integer;
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended('${CLIENT}:evidence:${REF}',0));
          PERFORM public.dblink_connect('baseline_importer',
            'host=127.0.0.1 user=postgres dbname=postgres application_name=fcm_baseline_cross_kind_race');
          PERFORM public.dblink_send_query('baseline_importer',$query$${remote}$query$);
          FOR attempt IN 1..100 LOOP
            PERFORM pg_stat_clear_snapshot();
            EXIT WHEN EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE application_name='fcm_baseline_cross_kind_race' AND wait_event_type='Lock');
            IF attempt=100 THEN RAISE EXCEPTION 'Baseline importer did not wait for the source-key lock'; END IF;
            PERFORM pg_sleep(0.02);
          END LOOP;
        END $start$;
        UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{external_ref}','"${REF}"')
          WHERE id='${OBSERVATION}';
        COMMIT;
        SELECT result FROM public.dblink_get_result('baseline_importer') AS receipt(result text);
        DO $close$ BEGIN PERFORM public.dblink_disconnect('baseline_importer'); END $close$;`);
      assert.equal(result, 'held|ambiguous_record_key');
    } finally {
      sql(`UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{external_ref}','"${REF}:obs"')
        WHERE id='${OBSERVATION}';`);
    }
  });

  test('an unambiguous baseline replay remains current', () => {
    const item = { kind: 'event', external_ref: REF, record_id: RECORD, source_fingerprint: PREVIOUS,
      desired: { external_ref: REF, payload: { ...provenance } } };
    assert.equal(sql(`SELECT outcome FROM public.adopt_patrol_source_baseline(
      '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([item])}$json$::jsonb);`), 'already_current');
  });

  test('an unambiguous matching record still receives its first source baseline', () => {
    const id = randomUUID();
    const ref = `${REF}:new-baseline`;
    const item = { kind: 'event', external_ref: ref, record_id: id, source_fingerprint: NEXT,
      desired: { external_ref: ref, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE, distance_km: 4,
        event_type: 'patrol_visit', status: 'original', payload: { ...provenance } } };
    const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
    const result = sql(`BEGIN;
      ${catalogFunction(schema, 'patrol_source_record_state')}
      ${catalogFunction(schema, 'patrol_source_assert_row_provenance')}
      INSERT INTO public.location_events VALUES (
        '${id}','${CLIENT}','${ref}','rm_patrol_log_import','2026-10-19T00:00:00Z',
        '${ZONE}',NULL,NULL,NULL,'patrol_visit','original',4,'{}');
      SELECT outcome FROM public.adopt_patrol_source_baseline(
        '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([item])}$json$::jsonb);
      SELECT payload->>'source_sha256' FROM public.location_events WHERE id='${id}';
      SELECT change_kind || '|' || source_fingerprint FROM public.patrol_import_record_versions WHERE record_id='${id}';
      ROLLBACK;`).split('\n');
    assert.deepEqual(result, ['adopted', HASH, `baseline|${NEXT}`]);
  });

  test('source updates take multiple vehicle keys in the same order as staging', () => {
    const ids = [randomUUID(), randomUUID()];
    const refs = [`${REF}:vehicle-a`, `${REF}:vehicle-z`];
    const oldPlates = ['OLDA001', 'OLDZ001'];
    const newPlates = ['ZZZ000', 'AAA000'];
    for (let index = 0; index < ids.length; index += 1) {
      sql(`INSERT INTO public.observations(id,organization_id,officer_id,plate_number,zone_id,observed_at,officer_notes,external_refs)
        VALUES ('${ids[index]}','${CLIENT}','${ACTOR}','${oldPlates[index]}','${ZONE}',
          '2026-10-19T00:00:00Z','original',jsonb_build_object('external_ref','${refs[index]}','import','{}'::jsonb));
        INSERT INTO public.patrol_import_record_versions(provider_organization_id,client_organization_id,record_kind,
          record_id,external_ref,source_profile,source_file,source_sheet,source_fingerprint,batch_id,version_no,state_after)
        VALUES ('${PROVIDER}','${CLIENT}','observation','${ids[index]}','${refs[index]}','rm_patrol_log',
          'source.xlsx','DATA','${PREVIOUS}','${BATCH}',1,'{"officer_notes":"original"}');`);
    }
    const items = ids.map((id, index) => ({
      kind: 'observation', external_ref: refs[index], record_id: id, source_fingerprint: NEXT,
      prior_source_fingerprint: PREVIOUS, desired: { occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
        officer_id: ACTOR, plate: newPlates[index], officer_notes: 'original', payload: { ...provenance } },
    }));
    assert.deepEqual(probeLockOrder('apply_patrol_source_updates', items, 'vehicle:AAA000', 'vehicle:ZZZ000',
      'fcm_patrol_vehicle_order'), ['held', 'held']);
  });

  test('staging retains matching event values and permits additive provenance', () => {
    const row = { external_ref: REF, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      event_type: 'patrol_visit', status: 'original',
      payload: { ...provenance, comments: 'manual note', extra: 'new detail' } };
    const call = `SELECT evt_matched FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
      '[]'::jsonb,$json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb);`;
    assert.equal(sql(call), '1');
    assert.equal(sql(`SELECT payload->>'source_file' FROM public.location_events WHERE id='${RECORD}';`), 'source.xlsx');
    assert.equal(sql(`SELECT payload->>'extra' FROM public.location_events WHERE id='${RECORD}';`), 'new detail');
  });

  test('staging retains matching observation values and permits additive provenance', () => {
    const row = { external_ref: `${REF}:obs`, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      officer_id: ACTOR, plate: 'ABC123',
      payload: { ...provenance, comments: 'manual note', extra: 'new detail' } };
    const call = `SELECT obs_matched FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
      $json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb,'[]'::jsonb);`;
    assert.equal(sql(call), '1');
    assert.equal(sql(`SELECT external_refs->'import'->>'source_file' FROM public.observations WHERE id='${OBSERVATION}';`),
      'source.xlsx');
    assert.equal(sql(`SELECT external_refs->'import'->>'extra' FROM public.observations WHERE id='${OBSERVATION}';`),
      'new detail');
  });

  test('staging refuses to overwrite an existing event payload value', () => {
    const row = { external_ref: REF, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      event_type: 'patrol_visit', status: 'original', payload: { ...provenance, comments: 'source note' } };
    const call = `SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
      '[]'::jsonb,$json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb);`;
    assert.throws(() => sql(call), error => /payload.*conflict/i.test(String(error.stderr)));
    assert.equal(sql(`SELECT payload->>'comments' FROM public.location_events WHERE id='${RECORD}';`), 'manual note');
  });

  test('staging refuses to overwrite an existing observation payload value', () => {
    const row = { external_ref: `${REF}:obs`, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      officer_id: ACTOR, plate: 'ABC123', payload: { ...provenance, comments: 'source note' } };
    const call = `SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
      $json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb,'[]'::jsonb);`;
    assert.throws(() => sql(call), error => /payload.*conflict/i.test(String(error.stderr)));
    assert.equal(sql(`SELECT external_refs->'import'->>'comments' FROM public.observations WHERE id='${OBSERVATION}';`),
      'manual note');
  });

  test('staging rechecks importer ownership after waiting for a source-key lock', () => {
    const ref = `${REF}:ownership-race`;
    const row = { external_ref: ref, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      event_type: 'patrol_visit', status: 'original', payload: { ...provenance, comments: 'import note' } };
    const remote = `SELECT evt_matched FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
      '[]'::jsonb,$json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb)`;
    try {
      const output = sql(`BEGIN;
        DO $start$
        DECLARE attempt integer;
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended('${CLIENT}:evidence:${ref}',0));
          PERFORM public.dblink_connect('importer',
            'host=127.0.0.1 user=postgres dbname=postgres application_name=fcm_patrol_ownership_race');
          PERFORM public.dblink_send_query('importer',$query$${remote}$query$);
          FOR attempt IN 1..100 LOOP
            PERFORM pg_stat_clear_snapshot();
            EXIT WHEN EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE application_name='fcm_patrol_ownership_race' AND wait_event_type='Lock');
            IF attempt=100 THEN RAISE EXCEPTION 'Importer did not wait for the source-key lock'; END IF;
            PERFORM pg_sleep(0.02);
          END LOOP;
        END $start$;
        INSERT INTO public.location_events VALUES (gen_random_uuid(),'${CLIENT}','${ref}','manual_entry',
          '2026-10-19T00:00:00Z','${ZONE}',NULL,NULL,NULL,'patrol_visit','original',NULL,'{}');
        COMMIT;
        SELECT evt_matched FROM public.dblink_get_result('importer',false) AS result(evt_matched integer);
        SELECT public.dblink_error_message('importer');
        SELECT source || '|' || coalesce(payload->>'comments','') FROM public.location_events WHERE external_ref='${ref}';
        DO $close$ BEGIN PERFORM public.dblink_disconnect('importer'); END $close$;`);
      assert.match(output, /external reference is not owned by this importer/i);
      assert.match(output, /manual_entry\|$/);
    } finally {
      sql(`DELETE FROM public.location_events WHERE organization_id='${CLIENT}' AND external_ref='${ref}';`);
    }
  });

  test('the locked staging body rejects an observation owned by another source', () => {
    const row = { external_ref: `${REF}:obs`, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      officer_id: ACTOR, plate: 'ABC123', payload: { ...provenance } };
    assert.throws(() => sql(`BEGIN;
      UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{import,source}','"manual_entry"')
        WHERE id='${OBSERVATION}';
      SELECT * FROM public.stage_patrol_import_chunk_unlocked('${BATCH}','${PROVIDER}','${CLIENT}',
        $json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb,'[]'::jsonb);
      ROLLBACK;`), error => /external reference is not owned by this importer/i.test(String(error.stderr)));
  });

  test('staging rejects event provenance naming another workbook', () => {
    const row = { external_ref: REF, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      event_type: 'patrol_visit', status: 'original', payload: { ...provenance, source_file: 'other.xlsx' } };
    assert.throws(() => sql(`BEGIN;
      UPDATE public.location_events SET payload=payload-'source_file' WHERE id='${RECORD}';
      SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
        '[]'::jsonb,$json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb);
      ROLLBACK;`), error => /source file does not match its batch/i.test(String(error.stderr)));
  });

  test('staging rejects observation provenance naming another workbook', () => {
    const row = { external_ref: `${REF}:obs`, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      officer_id: ACTOR, plate: 'ABC123', payload: { ...provenance, source_file: 'other.xlsx' } };
    assert.throws(() => sql(`BEGIN;
      UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{import}',
        (external_refs->'import')-'source_file') WHERE id='${OBSERVATION}';
      SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
        $json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb,'[]'::jsonb);
      ROLLBACK;`), error => /source file does not match its batch/i.test(String(error.stderr)));
  });

  test('staging rejects proposal provenance naming another workbook', () => {
    const proposal = { source_record_key: REF, source_row_number: 1, target_type: 'finance_service_cost',
      proposed_payload: { organization_id: PROVIDER, client_organization_id: CLIENT },
      source_values: { ...provenance, source_profile: 'rm_patrol_log', source_file: 'other.xlsx' } };
    assert.throws(() => sql(`BEGIN;
      SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
        '[]'::jsonb,'[]'::jsonb,$json$${JSON.stringify([proposal])}$json$::jsonb);
      ROLLBACK;`), error => /source file does not match its batch/i.test(String(error.stderr)));
  });

  test('staging holds an event whose source key also belongs to an observation', () => {
    const row = { external_ref: REF, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      event_type: 'patrol_visit', status: 'original', payload: { ...provenance } };
    assert.throws(() => sql(`BEGIN;
      UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{external_ref}','"${REF}"')
        WHERE id='${OBSERVATION}';
      SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
        '[]'::jsonb,$json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb);
      ROLLBACK;`), error => /source reference is used by another evidence kind/i.test(String(error.stderr)));
  });

  test('staging holds an observation whose source key also belongs to an event', () => {
    const ref = `${REF}:obs`;
    const row = { external_ref: ref, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      officer_id: ACTOR, plate: 'ABC123', payload: { ...provenance } };
    assert.throws(() => sql(`BEGIN;
      INSERT INTO public.location_events VALUES (gen_random_uuid(),'${CLIENT}','${ref}','rm_patrol_log_import',
        '2026-10-19T00:00:00Z','${ZONE}',NULL,NULL,NULL,'patrol_visit','original',NULL,'{}');
      SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
        $json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb,'[]'::jsonb);
      ROLLBACK;`), error => /source reference is used by another evidence kind/i.test(String(error.stderr)));
  });

  test('staging detects another evidence kind committed while waiting for the source-key lock', () => {
    const row = { external_ref: REF, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      event_type: 'patrol_visit', status: 'original', payload: { ...provenance } };
    const remote = `SELECT evt_matched FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
      '[]'::jsonb,$json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb)`;
    try {
      const output = sql(`BEGIN;
        DO $start$
        DECLARE attempt integer;
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended('${CLIENT}:evidence:${REF}',0));
          PERFORM public.dblink_connect('importer',
            'host=127.0.0.1 user=postgres dbname=postgres application_name=fcm_patrol_cross_kind_race');
          PERFORM public.dblink_send_query('importer',$query$${remote}$query$);
          FOR attempt IN 1..100 LOOP
            PERFORM pg_stat_clear_snapshot();
            EXIT WHEN EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE application_name='fcm_patrol_cross_kind_race' AND wait_event_type='Lock');
            IF attempt=100 THEN RAISE EXCEPTION 'Importer did not wait for the source-key lock'; END IF;
            PERFORM pg_sleep(0.02);
          END LOOP;
        END $start$;
        UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{external_ref}','"${REF}"')
          WHERE id='${OBSERVATION}';
        COMMIT;
        SELECT evt_matched FROM public.dblink_get_result('importer',false) AS result(evt_matched integer);
        SELECT public.dblink_error_message('importer');
        SELECT status FROM public.location_events WHERE id='${RECORD}';
        DO $close$ BEGIN PERFORM public.dblink_disconnect('importer'); END $close$;`);
      assert.match(output, /source reference is used by another evidence kind/i);
      assert.match(output, /original$/);
    } finally {
      sql(`UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{external_ref}','"${REF}:obs"')
        WHERE id='${OBSERVATION}';`);
    }
  });

  test('source updates hold a key shared by different evidence kinds', () => {
    const update = { kind: 'event', external_ref: REF, record_id: RECORD, source_fingerprint: NEXT,
      prior_source_fingerprint: PREVIOUS, desired: { occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
        event_type: 'patrol_visit', status: 'source update', distance_km: 4, payload: { ...provenance } } };
    const result = sql(`BEGIN;
      UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{external_ref}','"${REF}"')
        WHERE id='${OBSERVATION}';
      SELECT outcome || ':' || coalesce(detail,'') FROM public.apply_patrol_source_updates(
        '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([update])}$json$::jsonb);
      SELECT status FROM public.location_events WHERE id='${RECORD}';
      ROLLBACK;`).split('\n');
    assert.deepEqual(result, ['held:ambiguous_record_key', 'original']);
  });

  test('staging refuses contradictory event status', () => {
    const event = { external_ref: REF, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      event_type: 'patrol_visit', status: 'different status', payload: { ...provenance } };
    assert.throws(() => sql(`SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
      '[]'::jsonb,$json$${JSON.stringify([event])}$json$::jsonb,'[]'::jsonb);`),
    error => /core fields conflict/i.test(String(error.stderr)));
  });

  test('staging refuses contradictory observation notes', () => {
    const observation = { external_ref: `${REF}:obs`, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      officer_id: ACTOR, plate: 'ABC123', officer_notes: 'different note', payload: { ...provenance } };
    assert.throws(() => sql(`SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
      $json$${JSON.stringify([observation])}$json$::jsonb,'[]'::jsonb,'[]'::jsonb);`),
    error => /core fields conflict/i.test(String(error.stderr)));
  });

  test('staging refuses an observation with a missing stored officer or plate', () => {
    const row = { external_ref: `${REF}:obs`, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      officer_id: ACTOR, plate: 'ABC123', payload: { ...provenance } };
    for (const column of ['officer_id', 'plate_number']) {
      try {
        sql(`UPDATE public.observations SET ${column}=NULL WHERE id='${OBSERVATION}';`);
        assert.throws(() => sql(`SELECT * FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
          $json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb,'[]'::jsonb);`),
        error => /core fields conflict/i.test(String(error.stderr)), column);
      } finally {
        sql(`UPDATE public.observations SET officer_id='${ACTOR}',plate_number='ABC123' WHERE id='${OBSERVATION}';`);
      }
    }
  });

  test('staging accepts an identical replay when nested source values contain nulls', () => {
    const row = { external_ref: REF, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      event_type: 'patrol_visit', status: 'original',
      payload: { ...provenance, correction: { rule: 'formula', amount: null } } };
    const output = sql(`BEGIN;
      UPDATE public.location_events SET payload = payload ||
        '{"correction":{"rule":"formula","amount":null}}'::jsonb WHERE id='${RECORD}';
      SELECT evt_matched FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
        '[]'::jsonb,$json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb);
      ROLLBACK;`);
    assert.equal(output, '1');
  });

  test('observation staging accepts an identical replay with nested source nulls', () => {
    const row = { external_ref: `${REF}:obs`, occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
      officer_id: ACTOR, plate: 'ABC123',
      payload: { ...provenance, correction: { rule: 'formula', amount: null } } };
    const output = sql(`BEGIN;
      UPDATE public.observations SET external_refs=jsonb_set(external_refs,'{import,correction}',
        '{"rule":"formula","amount":null}'::jsonb,true) WHERE id='${OBSERVATION}';
      SELECT obs_matched FROM public.stage_patrol_import_chunk('${BATCH}','${PROVIDER}','${CLIENT}',
        $json$${JSON.stringify([row])}$json$::jsonb,'[]'::jsonb,'[]'::jsonb);
      ROLLBACK;`);
    assert.equal(output, '1');
  });

  test('migration preserves the existing RPC execution grants', () => {
    assert.equal(sql(`SELECT has_function_privilege('anon',
      'public.stage_patrol_import_chunk_unlocked(uuid,uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated',
      'public.stage_patrol_import_chunk_unlocked(uuid,uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated',
      'public.apply_patrol_source_updates(uuid,uuid,uuid,jsonb)','EXECUTE');`), 't');
    assert.equal(sql(`SELECT has_function_privilege('anon',
      'public.apply_patrol_source_updates(uuid,uuid,uuid,jsonb)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('service_role',
      'public.apply_patrol_source_updates(uuid,uuid,uuid,jsonb)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated',
      'public.adopt_patrol_source_baseline(uuid,uuid,uuid,jsonb)','EXECUTE');`), 't');
    assert.equal(sql(`SELECT has_function_privilege('anon',
      'public.adopt_patrol_source_baseline(uuid,uuid,uuid,jsonb)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('service_role',
      'public.adopt_patrol_source_baseline(uuid,uuid,uuid,jsonb)','EXECUTE');`), 'f');
  });

  test('a mismatched agreement link cannot reanchor evidence to another organisation house', () => {
    for (const [kind, foreignPlace] of [['zone', FOREIGN_ZONE], ['site', FOREIGN_SITE]]) {
      const desired = { occurred_at: '2026-10-19T00:00:00Z', [`${kind}_id`]: foreignPlace,
        event_type: 'patrol_visit', status: 'source update', distance_km: 4, payload: { ...provenance } };
      const update = { kind: 'event', external_ref: REF, record_id: RECORD, source_fingerprint: NEXT,
        prior_source_fingerprint: PREVIOUS, desired };
      const result = sql(`BEGIN;
        INSERT INTO public.locations VALUES ('${FOREIGN_HOUSE}','${FOREIGN_ORG}');
        INSERT INTO public.location_zones VALUES ('${FOREIGN_ZONE}','${FOREIGN_ORG}','${FOREIGN_HOUSE}');
        INSERT INTO public.client_sites VALUES ('${FOREIGN_SITE}',NULL,'${FOREIGN_ORG}','${FOREIGN_HOUSE}');
        INSERT INTO public.service_agreement_locations VALUES ('${AGREEMENT}',
          ${kind === 'zone' ? `'${FOREIGN_ZONE}'` : 'NULL'},${kind === 'site' ? `'${FOREIGN_SITE}'` : 'NULL'},'active');
        SELECT outcome || ':' || coalesce(detail,'') FROM public.apply_patrol_source_updates(
          '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([update])}$json$::jsonb);
        SELECT zone_id FROM public.location_events WHERE id='${RECORD}';
        ROLLBACK;`).split('\n');
      assert.deepEqual(result, ['held:source_place_owner_mismatch', ZONE], kind);
    }
  });

  test('a locked observation cannot be moved between sites by source reconciliation', () => {
    const update = { kind: 'observation', external_ref: `${REF}:obs`, record_id: OBSERVATION, source_fingerprint: NEXT,
      prior_source_fingerprint: PREVIOUS, desired: { occurred_at: '2026-10-19T00:00:00Z', site_id: SITE_B,
        officer_id: ACTOR, plate: 'ABC123', officer_notes: 'original', payload: { ...provenance } } };
    const result = sql(`BEGIN;
      INSERT INTO public.client_sites VALUES
        ('${SITE_A}',NULL,'${CLIENT}','${HOUSE}'),('${SITE_B}',NULL,'${CLIENT}','${HOUSE}');
      INSERT INTO public.service_agreement_locations VALUES ('${AGREEMENT}',NULL,'${SITE_B}','active');
      UPDATE public.observations SET zone_id=NULL, site_id='${SITE_A}' WHERE id='${OBSERVATION}';
      UPDATE public.observations SET locked_at=clock_timestamp() WHERE id='${OBSERVATION}';
      SELECT outcome || ':' || coalesce(detail,'') FROM public.apply_patrol_source_updates(
        '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([update])}$json$::jsonb);
      SELECT site_id FROM public.observations WHERE id='${OBSERVATION}';
      ROLLBACK;`).split('\n');
    assert.deepEqual(result, ['held:locked_evidence_requires_correction_review', SITE_A]);
  });

  test('unlocked observation identity and time corrections hold before changing evidence or history', () => {
    const anotherOfficer = randomUUID();
    for (const changes of [
      { occurred_at: '2026-10-19T01:00:00Z' },
      { plate: 'XYZ789' },
      { officer_id: anotherOfficer },
    ]) {
      const desired = { occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
        officer_id: ACTOR, plate: 'ABC123', officer_notes: 'changed note',
        payload: { ...provenance }, ...changes };
      const update = { kind: 'observation', external_ref: `${REF}:obs`, record_id: OBSERVATION,
        source_fingerprint: NEXT, prior_source_fingerprint: PREVIOUS, desired };
      const result = sql(`BEGIN;
        INSERT INTO public.user_profiles VALUES ('${anotherOfficer}','${PROVIDER}',NULL,NULL);
        SELECT outcome || ':' || coalesce(detail,'') FROM public.apply_patrol_source_updates(
          '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([update])}$json$::jsonb);
        SELECT observed_at::text || '|' || plate_number || '|' || officer_id || '|' || officer_notes
          FROM public.observations WHERE id='${OBSERVATION}';
        SELECT count(*) FROM public.patrol_import_record_versions WHERE record_id='${OBSERVATION}';
        SELECT count(*) FROM public.audit_log WHERE target_id='${OBSERVATION}';
        ROLLBACK;`).split('\n');
      assert.deepEqual(result, ['held:observation_mirror_correction_requires_review',
        `2026-10-19 00:00:00+00|ABC123|${ACTOR}|original`, '1', '0']);
    }
  });

  test('an unlocked observation note can still be updated without changing its identity', () => {
    const update = { kind: 'observation', external_ref: `${REF}:obs`, record_id: OBSERVATION,
      source_fingerprint: NEXT, prior_source_fingerprint: PREVIOUS, desired: {
        occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE, officer_id: ACTOR,
        plate: 'ABC123', officer_notes: 'corrected', payload: { ...provenance },
      } };
    const result = sql(`BEGIN;
      SELECT outcome FROM public.apply_patrol_source_updates(
        '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([update])}$json$::jsonb);
      SELECT officer_notes FROM public.observations WHERE id='${OBSERVATION}';
      ROLLBACK;`).split('\n');
    assert.deepEqual(result, ['updated', 'corrected']);
  });

  test('changing an existing event place requires historical correction review', () => {
    const update = { kind: 'event', external_ref: REF, record_id: RECORD, source_fingerprint: NEXT,
      prior_source_fingerprint: PREVIOUS, desired: { occurred_at: '2026-10-19T00:00:00Z', zone_id: SECOND_ZONE,
        event_type: 'patrol_visit', status: 'source update', distance_km: 4, payload: { ...provenance } } };
    const result = sql(`BEGIN;
      INSERT INTO public.location_zones VALUES ('${SECOND_ZONE}','${CLIENT}','${HOUSE}');
      INSERT INTO public.service_agreement_locations VALUES ('${AGREEMENT}','${SECOND_ZONE}',NULL,'active');
      SELECT outcome || ':' || coalesce(detail,'') FROM public.apply_patrol_source_updates(
        '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([update])}$json$::jsonb);
      SELECT zone_id FROM public.location_events WHERE id='${RECORD}';
      ROLLBACK;`).split('\n');
    assert.deepEqual(result, ['held:source_place_difference_requires_review', ZONE]);
  });

  test('changing an unlocked observation place also requires historical correction review', () => {
    const update = { kind: 'observation', external_ref: `${REF}:obs`, record_id: OBSERVATION, source_fingerprint: NEXT,
      prior_source_fingerprint: PREVIOUS, desired: { occurred_at: '2026-10-19T00:00:00Z', site_id: SITE_B,
        officer_id: ACTOR, plate: 'ABC123', officer_notes: 'original', payload: { ...provenance } } };
    const result = sql(`BEGIN;
      INSERT INTO public.client_sites VALUES
        ('${SITE_A}',NULL,'${CLIENT}','${HOUSE}'),('${SITE_B}',NULL,'${CLIENT}','${HOUSE}');
      INSERT INTO public.service_agreement_locations VALUES ('${AGREEMENT}',NULL,'${SITE_B}','active');
      UPDATE public.observations SET zone_id=NULL,site_id='${SITE_A}' WHERE id='${OBSERVATION}';
      SELECT outcome || ':' || coalesce(detail,'') FROM public.apply_patrol_source_updates(
        '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([update])}$json$::jsonb);
      SELECT site_id FROM public.observations WHERE id='${OBSERVATION}';
      ROLLBACK;`).split('\n');
    assert.deepEqual(result, ['held:source_place_difference_requires_review', SITE_A]);
  });

  test('the observation lock rejects site changes both while locking and after lock', () => {
    sql(`UPDATE public.observations SET zone_id=NULL,site_id='${SITE_A}' WHERE id='${OBSERVATION}';`);
    try {
      assert.throws(() => sql(`UPDATE public.observations SET site_id='${SITE_B}',locked_at=clock_timestamp()
        WHERE id='${OBSERVATION}';`), error => /cannot be locked with mutated frozen fields/i.test(String(error.stderr)));
      sql(`UPDATE public.observations SET locked_at=clock_timestamp() WHERE id='${OBSERVATION}';`);
      assert.throws(() => sql(`UPDATE public.observations SET site_id='${SITE_B}' WHERE id='${OBSERVATION}';`),
        error => /frozen fact fields may not be edited/i.test(String(error.stderr)));
      assert.equal(sql(`SELECT site_id FROM public.observations WHERE id='${OBSERVATION}';`), SITE_A);
    } finally {
      sql(`ALTER TABLE public.observations DISABLE TRIGGER test_observations_enforce_lock;
        UPDATE public.observations SET locked_at=NULL,site_id=NULL,zone_id='${ZONE}' WHERE id='${OBSERVATION}';
        ALTER TABLE public.observations ENABLE TRIGGER test_observations_enforce_lock;`);
    }
  });

  test('a previously edited event is held rather than updated', () => {
    sql(`UPDATE public.location_events SET status='manual edit' WHERE id='${RECORD}';`);
    const update = { kind: 'event', external_ref: REF, record_id: RECORD, source_fingerprint: NEXT,
      prior_source_fingerprint: PREVIOUS, desired: { occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
        event_type: 'patrol_visit', status: 'source update', distance_km: 4, payload: { ...provenance } } };
    const outcome = sql(`SELECT outcome || ':' || detail FROM public.apply_patrol_source_updates(
      '${BATCH}','${PROVIDER}','${CLIENT}',$json$${JSON.stringify([update])}$json$::jsonb);`);
    assert.equal(outcome, 'held:fcm_record_changed_since_last_sync');
    assert.equal(sql(`SELECT status FROM public.location_events WHERE id='${RECORD}';`), 'manual edit');
    sql(`UPDATE public.location_events SET status='original' WHERE id='${RECORD}';`);
  });

  test('an edit arriving after comparison is not overwritten by a direct update RPC', () => {
    const update = { kind: 'event', external_ref: REF, record_id: RECORD, source_fingerprint: NEXT,
      prior_source_fingerprint: PREVIOUS, desired: { occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
        event_type: 'patrol_visit', status: 'source update', distance_km: 4,
        payload: { source_file: 'source.xlsx', source_sheet: 'DATA', classification_profile: 'rm_patrol_log',
          source_row: 1, source_sha256: HASH, derivative_sha256: HASH } } };
    sql(`BEGIN;
      SET LOCAL test.concurrent_edit='yes';
      SELECT * FROM public.apply_patrol_source_updates('${BATCH}','${PROVIDER}','${CLIENT}',
        $json$${JSON.stringify([update])}$json$::jsonb);
      COMMIT;
      SELECT * FROM public.dblink_get_result('manual_editor') AS result(status text);`);
    assert.equal(sql(`SELECT status FROM public.location_events WHERE id='${RECORD}';`), 'manual edit');
  });

  test('an observation edit arriving after comparison is not overwritten by a direct update RPC', () => {
    const update = { kind: 'observation', external_ref: `${REF}:obs`, record_id: OBSERVATION, source_fingerprint: NEXT,
      prior_source_fingerprint: PREVIOUS, desired: { occurred_at: '2026-10-19T00:00:00Z', zone_id: ZONE,
        officer_id: ACTOR, plate: 'ABC123', officer_notes: 'source update',
        payload: { ...provenance } } };
    sql(`BEGIN;
      SET LOCAL test.concurrent_edit='yes';
      SELECT * FROM public.apply_patrol_source_updates('${BATCH}','${PROVIDER}','${CLIENT}',
        $json$${JSON.stringify([update])}$json$::jsonb);
      COMMIT;
      SELECT * FROM public.dblink_get_result('manual_editor') AS result(status text);`);
    assert.equal(sql(`SELECT officer_notes FROM public.observations WHERE id='${OBSERVATION}';`), 'manual edit');
  });
});
