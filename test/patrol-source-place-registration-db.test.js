const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..');
const PROVIDER = '20000000-0000-4000-8000-000000000001';
const ACTOR = '20000000-0000-4000-8000-000000000002';
const CLIENT_A = '20000000-0000-4000-8000-000000000003';
const CLIENT_B = '20000000-0000-4000-8000-000000000004';
const AGREEMENT_A = '20000000-0000-4000-8000-000000000005';
const AGREEMENT_B = '20000000-0000-4000-8000-000000000006';

function catalogFunction(schema, name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `Missing catalog function ${name}`);
  const end = schema.indexOf('$function$;', start);
  assert.ok(end >= 0, `Unterminated catalog function ${name}`);
  return schema.slice(start, end + '$function$;'.length);
}

function tableDDL(schema, name) {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, `Missing catalog table ${name}`);
  return schema.slice(start, schema.indexOf('\n);', start) + 3);
}

describe('patrol import place registration', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, () => {
  const container = `fcm-place-import-${randomUUID()}`;
  let created = false;
  let placeRegistrationSql;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
  });
  const psql = ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-F', '|'];
  const sql = query => docker(psql, query).trim();
  const sqlAsync = query => {
    const process = spawn('docker', psql, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const result = new Promise((resolve, reject) => {
      process.stdout.on('data', chunk => { stdout += chunk; });
      process.stderr.on('data', chunk => { stderr += chunk; });
      process.on('error', reject);
      process.on('close', code => {
        settled = true;
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`PostgreSQL command failed (${code}): ${stderr}`));
      });
    });
    process.stdin.end(query);
    return { result, isSettled: () => settled };
  };
  const registrations = (clientId, names, suffix) => placeRegistrationSql({
    actorId: ACTOR,
    providerId: PROVIDER,
    clientId,
    source: { file: 'fixture.xlsx', sheet: 'Patrol', sha256: 'a'.repeat(64) },
    places: names.map(sourceName => ({
      name: `${sourceName} (${suffix})`, source_name: sourceName, source_rows: [2],
    })),
    commit: true,
  });
  const registration = (clientId, sourceName, suffix) => registrations(clientId, [sourceName], suffix);
  const status = receipt => receipt.split('|')[1];

  before(async () => {
    ({ placeRegistrationSql } = await import('../services/document-source-worker/source-places.mjs'));
    docker(['run', '--detach', '--name', container, '--network', 'none', '--pull', 'never',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
    const tables = ['audit_log', 'canonical_place_links', 'canonical_places', 'import_source_profiles',
      'locations', 'location_zones', 'module_catalog', 'service_agreements', 'service_agreement_locations',
      'user_profiles'];
    const functions = ['address_match_key', 'ensure_canonical_place', 'canonical_place_for_house',
      'tg_locations_place_identity', 'manage_crm_location', 'manage_crm_zone'];
    sql(`CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      ${tables.map(name => tableDDL(schema, name)).join('\n')}
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY, location_id uuid);
      CREATE UNIQUE INDEX canonical_places_key ON public.canonical_places(canonical_key);
      CREATE UNIQUE INDEX canonical_place_links_source ON public.canonical_place_links(source_table,source_id);
      CREATE UNIQUE INDEX agreement_place ON public.service_agreement_locations(service_agreement_id,zone_id);
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.crm_actor_can_manage_account(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.crm_actor_can_manage_location(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      ${functions.map(name => catalogFunction(schema, name)).join('\n')}
      CREATE TRIGGER zz_place_identity BEFORE INSERT OR UPDATE ON public.locations
        FOR EACH ROW EXECUTE FUNCTION public.tg_locations_place_identity();
      INSERT INTO public.user_profiles(id,organization_id,role) VALUES ('${ACTOR}','${PROVIDER}','admin');
      INSERT INTO public.import_source_profiles(organization_id,profile_code,name,parser,import_actor_id)
        VALUES ('${PROVIDER}','rm_patrol_log','Fixture','xlsx','${ACTOR}');
      INSERT INTO public.module_catalog(module_key) VALUES ('patrol');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,invitation_status)
        VALUES ('${AGREEMENT_A}','${PROVIDER}','${CLIENT_A}','A','accepted'),
          ('${AGREEMENT_B}','${PROVIDER}','${CLIENT_B}','B','accepted');
      CREATE TABLE public.test_place_gate(released boolean NOT NULL);
      INSERT INTO public.test_place_gate VALUES (false);
      CREATE FUNCTION public.test_wait_before_first_place() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE deadline timestamptz := clock_timestamp() + interval '30 seconds';
      BEGIN
        IF current_setting('application_name') = 'fcm_place_first' THEN
          LOOP
            EXIT WHEN (SELECT released FROM public.test_place_gate);
            IF clock_timestamp() > deadline THEN RAISE EXCEPTION 'Place race gate timed out'; END IF;
            PERFORM pg_sleep(0.05);
          END LOOP;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER aa_test_wait BEFORE INSERT ON public.locations
        FOR EACH ROW EXECUTE FUNCTION public.test_wait_before_first_place();`);
  });

  after(() => {
    if (created) docker(['rm', '-f', container]);
  });

  test('a differently suffixed place already in the registry is held for review', () => {
    assert.equal(status(sql(registration(CLIENT_A, 'Shared Crossing', 'First'))), 'created');
    assert.equal(status(sql(registration(CLIENT_B, 'Shared Crossing', 'Second'))), 'registry_match_review');
    assert.equal(sql(`SELECT count(*) FROM public.canonical_places
      WHERE display_name LIKE 'Shared Crossing%';`), '1');
    assert.equal(sql(`SELECT count(*) FROM public.locations
      WHERE organization_id='${CLIENT_B}' AND name LIKE 'Shared Crossing%';`), '0');
  });

  test('concurrent client imports do not create two canonical places for the same source name', async () => {
    const first = sqlAsync(`SET application_name='fcm_place_first';\n${registration(CLIENT_A, 'Race Crossing', 'First')}`);
    first.result.catch(() => {});
    let second;
    try {
      let firstWaiting = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        firstWaiting = sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE application_name='fcm_place_first' AND wait_event='PgSleep');`) === 't';
        if (firstWaiting || first.isSettled()) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(firstWaiting, 'First import reached the place-creation gate');
      second = sqlAsync(`SET application_name='fcm_place_second';\n${registration(CLIENT_B, 'Race Crossing', 'Second')}`);
      second.result.catch(() => {});
      let secondReachedDecision = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        secondReachedDecision = second.isSettled() || sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE application_name='fcm_place_second' AND wait_event_type='Lock');`) === 't';
        if (secondReachedDecision) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(secondReachedDecision, 'Second import completed or waited for the first import');
    } finally {
      sql('UPDATE public.test_place_gate SET released=true;');
    }
    const [firstReceipt, secondReceipt] = await Promise.all([first.result, second.result]);
    assert.equal(status(firstReceipt), 'created');
    assert.equal(status(secondReceipt), 'registry_match_review');
    assert.equal(sql(`SELECT count(*) FROM public.canonical_places
      WHERE display_name LIKE 'Race Crossing%';`), '1');
  });

  test('different places still register and an exact same-client retry is reused', () => {
    const initial = sql(registration(CLIENT_A, 'East Trail', 'First'));
    const retry = sql(registration(CLIENT_A, 'East Trail', 'First'));
    const other = sql(registration(CLIENT_B, 'West Trail', 'Second'));
    assert.equal(status(initial), 'created');
    assert.equal(status(retry), 'existing');
    assert.equal(retry.split('|')[2], initial.split('|')[2]);
    assert.equal(status(other), 'created');
  });

  test('concurrent imports of multiple places in opposite order complete without deadlock', async () => {
    sql('UPDATE public.test_place_gate SET released=false;');
    const first = sqlAsync(`SET application_name='fcm_place_first';\n${
      registrations(CLIENT_A, ['Alpha Trail', 'Beta Trail'], 'First')}`);
    first.result.catch(() => {});
    let second;
    try {
      let firstWaiting = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        firstWaiting = sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE application_name='fcm_place_first' AND wait_event='PgSleep');`) === 't';
        if (firstWaiting || first.isSettled()) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(firstWaiting, 'First import reached the place-creation gate');
      second = sqlAsync(`SET application_name='fcm_place_second';\n${
        registrations(CLIENT_A, ['Beta Trail', 'Alpha Trail'], 'First')}`);
      second.result.catch(() => {});
      let secondWaiting = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        secondWaiting = sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE application_name='fcm_place_second' AND wait_event_type='Lock');`) === 't';
        if (secondWaiting || second.isSettled()) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(secondWaiting, 'Second import reached a contended lock');
    } finally {
      sql('UPDATE public.test_place_gate SET released=true;');
    }
    const [firstReceipt, secondReceipt] = await Promise.all([first.result, second.result]);
    assert.deepEqual(firstReceipt.split(/\r?\n/).map(status), ['created', 'created']);
    assert.deepEqual(secondReceipt.split(/\r?\n/).map(status), ['existing', 'existing']);
  });
});
