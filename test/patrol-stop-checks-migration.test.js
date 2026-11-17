'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
const table = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return `${schema.slice(start, schema.indexOf('\n);', start) + 3)}
    ALTER TABLE public.${name} ADD PRIMARY KEY(id);`;
};
const definition = (source, name) => {
  const start = source.search(new RegExp(`CREATE OR REPLACE FUNCTION (?:"public"\\."${name}"|public\\.${name})\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('$function$;', start) + '$function$;'.length);
};
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('required patrol checks protect completion and preserve officer receipts', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async t => {
  const container = `fcm-stop-checks-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sql = query => docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();
  const asyncSql = query => new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', container, 'psql', '-h', '127.0.0.1',
      '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], { encoding: 'utf8' },
    (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout.trim()));
    child.stdin.end(query);
  });
  const as = (actor, query) => sql(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub='${id(actor)}'; ${query}; COMMIT;`);
  const check = (request, stop, key, outcome = 'done', notes = 'NULL', photo = 'NULL', gps = '-41,174,5') =>
    `SELECT public.record_patrol_stop_check('${id(request)}','${id(stop)}','${key}','${outcome}',${notes},${photo},${gps})`;
  const photoHash = 'a'.repeat(64);
  const photoPath = `org/${id(2)}/officer-photos/patrol_stop/${id(31)}/${photoHash}`;
  const depart = (request, stop) =>
    `SELECT public.manage_officer_patrol_stop('${id(stop)}','on_scene','depart','${id(request)}',NULL,NULL,NULL,NULL,NULL)`;
  const fails = (actor, query, pattern) => assert.throws(() => as(actor, query),
    error => pattern.test(String(error.stderr ?? error.message)));
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    const task1 = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261117000100_zone_briefing_parity.sql'), 'utf8');
    const billing = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261009110000_patrol_stop_billing.sql'), 'utf8');
    const patrolStart = billing.indexOf('CREATE OR REPLACE FUNCTION public.manage_officer_patrol_stop(');
    const patrolEnd = billing.indexOf('\n$$;', patrolStart);
    assert.ok(patrolStart >= 0 && patrolEnd > patrolStart, 'The pre-check patrol function exists');
    const patrolFunction = billing.slice(patrolStart, patrolEnd + '\n$$;'.length);
    sql(`CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      ${['shifts', 'shift_stops', 'shift_stop_actions', 'shift_stop_modules', 'client_sites',
        'location_zones', 'patrol_routes', 'org_geofence_config', 'patrol_stop_charge_lines',
        'audit_log', 'client_site_patrol_config', 'service_agreement_delivery_schedules',
        'service_agreements', 'user_profiles', 'organizations', 'evidence_items'].map(table).join('\n')}
      CREATE TABLE public.officer_field_reports(id uuid PRIMARY KEY,organization_id uuid,officer_id uuid,shift_id uuid);
      CREATE TABLE public.incidents(id uuid PRIMARY KEY,organization_id uuid,officer_user_id uuid,dispatch_job_id uuid);
      CREATE TABLE public.dispatch_jobs(id uuid PRIMARY KEY,organization_id uuid,shift_id uuid);
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,owner_id text,metadata jsonb,UNIQUE(bucket_id,name));
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.evidence_items ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
      CREATE POLICY baseline_storage ON storage.objects TO authenticated USING(true) WITH CHECK(true);
      CREATE FUNCTION public.org_access_allowed(p_org uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=p_org AND deactivated_at IS NULL) $$;
      ALTER TABLE public.shift_stops ADD COLUMN IF NOT EXISTS required_checks text[] NOT NULL DEFAULT '{}';
      ALTER TABLE public.location_zones ADD COLUMN IF NOT EXISTS access_instructions text, ADD COLUMN IF NOT EXISTS hs_notes text;
      CREATE UNIQUE INDEX shift_stop_actions_org_request_uidx
        ON public.shift_stop_actions(organization_id,client_request_id) WHERE client_request_id IS NOT NULL;
      CREATE TABLE public.patrol_check_types(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, check_key text NOT NULL,
        label text NOT NULL, needs_photo boolean NOT NULL DEFAULT false, needs_note boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true);
      CREATE FUNCTION public.resolve_patrol_stop_charge_line_internal(uuid)
        RETURNS public.patrol_stop_charge_lines LANGUAGE sql AS $$ SELECT NULL::public.patrol_stop_charge_lines $$;
      ${definition(schema, 'complete_shift_stop')}
      ${patrolFunction}
      ${definition(task1, 'get_officer_patrol_stops')}
      REVOKE ALL ON FUNCTION public.complete_shift_stop(uuid,text,double precision,double precision) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION public.complete_shift_stop(uuid,text,double precision,double precision) TO service_role;
      INSERT INTO public.organizations(id,name,organization_type) VALUES
        ('${id(1)}','Provider','service_provider'),('${id(2)}','Branch','branch');
      INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES
        ('${id(3)}','${id(2)}','officer','Officer'),
        ('${id(4)}','${id(2)}','officer','Other officer');
      INSERT INTO public.officer_field_reports(id,organization_id,officer_id,shift_id)
        VALUES ('${id(9)}','${id(2)}','${id(3)}','${id(20)}');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name)
        VALUES ('${id(10)}','${id(1)}','${id(8)}','Agreement');
      INSERT INTO public.service_agreement_delivery_schedules(id,service_agreement_id,module_key,capability_key,
        work_model,active_days,visits_per_shift,min_gap_between_visits_minutes,pricing_basis)
        VALUES ('${id(11)}','${id(10)}','patrol','patrol','patrol','{1,2,3,4,5,6,7}',1,0,'per_visit');
      INSERT INTO public.client_site_patrol_config(id,organization_id,module_key,delivery_schedule_id)
        VALUES ('${id(12)}','${id(2)}','general_patrol','${id(11)}');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,actual_start)
        VALUES ('${id(20)}','${id(2)}','${id(3)}','general_patrol',now()-interval '2 hours',now()+interval '6 hours','in_progress',now()-interval '2 hours');
      INSERT INTO public.shift_stops(id,organization_id,shift_id,patrol_config_id,module_key,sla_arrive_by,
        status,actual_arrived_at,required_dwell_minutes,required_checks)
        VALUES
        ('${id(30)}','${id(2)}','${id(20)}','${id(12)}','general_patrol',now()+interval '1 hour','pending',NULL,0,'{gate_check}'),
        ('${id(31)}','${id(2)}','${id(20)}','${id(12)}','general_patrol',now()+interval '1 hour','on_scene',now()-interval '10 minutes',0,'{gate_check,photo_check}'),
        ('${id(32)}','${id(2)}','${id(20)}','${id(12)}','general_patrol',now()+interval '1 hour','on_scene',now()-interval '10 minutes',0,'{}'),
        ('${id(33)}','${id(2)}','${id(20)}','${id(12)}','general_patrol',now()+interval '1 hour','on_scene',now()-interval '10 minutes',0,'{gate_check}');
      INSERT INTO public.patrol_check_types(organization_id,check_key,label,needs_photo,needs_note,active) VALUES
        (NULL,'gate_check','Gate check',false,false,true),
        ('${id(1)}','photo_check','Photo check',true,true,false),
        ('${id(2)}','photo_check','Wrong branch check',false,false,true);
    `);
    sql(fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261106120200_officer_record_photo_attachments.sql'), 'utf8'));
    const migration = fs.readdirSync(path.join(root, 'supabase', 'migrations'))
      .find(file => /^\d+_patrol_stop_checks\.sql$/.test(file));
    if (migration) sql(fs.readFileSync(path.join(root, 'supabase', 'migrations', migration), 'utf8'));

    await t.test('only the assigned officer can record required checks after arrival', () => {
      fails(3, check(40, 30, 'gate_check'), /on.scene|arrival/i);
      fails(4, check(40, 31, 'gate_check'), /assigned|your shift/i);
      fails(3, check(40, 31, 'not_required'), /required check/i);
      assert.throws(() => sql(`SET ROLE anon; ${check(40, 31, 'gate_check')}`), /permission denied/i);
      assert.equal(sql(`SELECT count(*) FROM public.shift_stop_actions`), '0');
    });

    await t.test('photos require a private uploaded original registered to this stop and officer', () => {
      fails(3, check(49, 31, 'photo_check', 'done', "'A note'", "'proof/photo.jpg'"), /photo.*(confirm|register|attach)/i);
      assert.equal(as(3, `SELECT public.officer_photo_path_allowed('${photoPath}')`), 't');
      assert.equal(as(4, `SELECT public.officer_photo_path_allowed('${photoPath}')`), 'f');
      fails(3, `SELECT public.attach_officer_record_photo('patrol_stop','${id(31)}','${photoHash}','check.png',now())`, /upload was not confirmed/i);
      as(3, `INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES(
        'officer-record-photos','${photoPath}','${id(3)}','{"size":24,"mimetype":"image/png"}')`);
      const photo = JSON.parse(as(3, `SELECT public.attach_officer_record_photo('patrol_stop','${id(31)}','${photoHash}','check.png',now())`));
      assert.equal(photo.storage_path, photoPath);
      assert.equal(photo.shift_id, id(20));
      assert.equal(sql(`SELECT metadata->>'privacy_review_status' FROM public.evidence_items WHERE id='${photo.evidence_id}'`), 'pending');
      assert.equal(as(4, `SELECT count(*) FROM storage.objects WHERE name='${photoPath}'`), '0');
      const reportPath = `org/${id(2)}/officer-photos/field_report/${id(9)}/${photoHash}`;
      as(3, `INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES(
        'officer-record-photos','${reportPath}','${id(3)}','{"size":24,"mimetype":"image/png"}')`);
      const report = JSON.parse(as(3, `SELECT public.attach_officer_record_photo('field_report','${id(9)}','${photoHash}','report.png',now())`));
      assert.equal(report.storage_path, reportPath);
      fails(3, check(49, 31, 'photo_check', 'done', "'A note'", `'${reportPath}'`), /photo.*(confirm|register|attach)/i);
    });

    await t.test('check outcomes, evidence, replay and provider catalogue are enforced', () => {
      fails(3, check(41, 31, 'gate_check', 'could_not_complete'), /say why/i);
      fails(3, check(42, 31, 'photo_check'), /note/i);
      fails(3, check(42, 31, 'photo_check', 'done', "'A note'"), /photo/i);
      const first = JSON.parse(as(3, check(40, 31, 'gate_check')));
      assert.ok(first.action_id);
      assert.equal(first.check_key, 'gate_check');
      assert.equal(first.outcome, 'done');
      assert.deepEqual(JSON.parse(as(3, check(40, 31, 'gate_check'))), first);
      fails(3, check(40, 31, 'gate_check', 'done', 'NULL', 'NULL', '-42,174,5'), /replay conflicts/i);
      assert.throws(() => sql(`\\set VERBOSITY verbose
        BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${id(3)}';
        ${check(40, 31, 'gate_check', 'done', 'NULL', 'NULL', '-42,174,5')}; COMMIT;`), /42501/);
      fails(3, check(40, 33, 'gate_check'), /replay conflicts/i);
      fails(4, check(40, 31, 'gate_check'), /assigned|your shift/i);
      fails(3, depart(40, 31), /request.*conflict/i);
      fails(3, depart(50, 31), /Photo check/);
      const receipt = JSON.parse(as(3, check(42, 31, 'photo_check', 'done', "'A note'", `'${photoPath}'`)));
      assert.ok(receipt.action_id);
      const read = JSON.parse(as(3, `SELECT public.get_officer_patrol_stops('${id(20)}')`));
      const stop = read.stops.find(item => item.id === id(31));
      assert.deepEqual(stop.checks.map(item => [item.check_key, item.label, item.outcome]), [
        ['gate_check', 'Gate check', 'done'], ['photo_check', 'Photo check', 'done'],
      ]);
      assert.equal(stop.checks[1].notes, 'A note');
      assert.ok(stop.checks[1].needs_photo);
      assert.ok(stop.checks[1].needs_note);
      assert.equal(sql(`SELECT evidence_metadata->>'photo_path' FROM public.shift_stop_actions WHERE id='${receipt.action_id}'`), photoPath);
      assert.equal(JSON.parse(as(3, depart(50, 31))).stop_status, 'completed');
      assert.equal(as(3, `SELECT public.officer_photo_path_allowed('${photoPath}')`), 't');
      assert.deepEqual(JSON.parse(as(3, check(40, 31, 'gate_check'))), first);
    });

    await t.test('the service-only completion path is gated, while legacy stops remain completable', () => {
      assert.throws(() => sql(`SET ROLE service_role; SELECT public.complete_shift_stop('${id(33)}')`), /Gate check/);
      assert.throws(() => sql(`UPDATE public.shift_stops SET status='completed', required_checks='{}' WHERE id='${id(33)}'`), /Gate check/);
      assert.throws(() => as(3, `SELECT public.complete_shift_stop('${id(33)}')`), /permission denied/i);
      as(3, check(44, 33, 'gate_check', 'done'));
      as(3, check(43, 33, 'gate_check', 'could_not_complete', "'Gate damaged'"));
      const read = JSON.parse(as(3, `SELECT public.get_officer_patrol_stops('${id(20)}')`));
      const latest = read.stops.find(item => item.id === id(33)).checks[0];
      assert.equal(latest.outcome, 'could_not_complete');
      assert.equal(latest.notes, 'Gate damaged');
      sql(`SET ROLE service_role; SELECT public.complete_shift_stop('${id(33)}')`);
      assert.equal(sql(`SELECT status FROM public.shift_stops WHERE id='${id(33)}'`), 'completed');
      assert.equal(JSON.parse(as(3, depart(51, 32))).stop_status, 'completed');
    });

    await t.test('a concurrent shift change makes check recording retry instead of using stale authority', async () => {
      sql(`UPDATE public.shift_stops SET status='on_scene',actual_arrived_at=now() WHERE id='${id(30)}'`);
      const holder = asyncSql(`SET application_name='fcm-check-lock-holder';
        BEGIN; SELECT id FROM public.shifts WHERE id='${id(20)}' FOR UPDATE;
        SELECT pg_sleep(4); COMMIT;`);
      let held = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep'
          AND application_name='fcm-check-lock-holder')`) === 't') { held = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        assert.ok(held, 'The other transaction locked the shift');
        fails(3, check(45, 30, 'gate_check'), /shift.*chang|retry/i);
      } finally {
        await holder;
      }
    });

    await t.test('concurrent retries return one receipt and one action', async () => {
      const request = `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${id(3)}';
        ${check(45, 30, 'gate_check')}; COMMIT;`;
      const [first, second] = await Promise.all([asyncSql(request), asyncSql(request)]);
      assert.deepEqual(JSON.parse(first), JSON.parse(second));
      assert.equal(sql(`SELECT count(*) FROM public.shift_stop_actions WHERE client_request_id='${id(45)}'`), '1');
    });
  } finally {
    if (created) docker(['rm', '-f', container]);
  }
});
