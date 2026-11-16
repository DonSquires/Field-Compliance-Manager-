'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const definition = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
};
const table = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return `${schema.slice(start, schema.indexOf('\n);', start) + 3)}
    ALTER TABLE public.${name} ADD PRIMARY KEY(id);`;
};
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const signature = 'public.record_officer_checkpoint_visit(uuid,uuid,uuid,double precision,double precision,double precision,double precision,boolean)';

test('checkpoint capture follows the assigned operating shift while preserving scope, GPS truth and retries', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async t => {
  const name = `fcm-checkpoint-operating-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sql = query => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();
  const asyncSql = query => new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1',
      '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], { encoding: 'utf8' },
    (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout.trim()));
    child.stdin.end(query);
  });
  const asSql = (actor, query) => `BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub='${id(actor)}'; ${query}; COMMIT;`;
  const as = (actor, query) => sql(asSql(actor, query));
  const call = (request, shift = 10, checkpoint = 20, coords = '-42,174', claim = '0,true') =>
    `SELECT row_to_json(r) FROM public.record_officer_checkpoint_visit(
      '${id(request)}','${id(shift)}','${id(checkpoint)}',${coords},5,${claim}) r`;
  const fail = (actor, query, pattern) => assert.throws(() => as(actor, query),
    error => pattern.test(String(error.stderr ?? error.message)));
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    sql(`CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      ${['user_profiles', 'shifts', 'patrol_checkpoints', 'patrols',
        'patrol_checkpoint_visits', 'shift_stops', 'audit_log'].map(table).join('\n')}
      ALTER TABLE public.patrols ADD FOREIGN KEY(shift_id) REFERENCES public.shifts(id);
      ALTER TABLE public.patrol_checkpoint_visits ADD FOREIGN KEY(patrol_id) REFERENCES public.patrols(id);
      ALTER TABLE public.patrol_checkpoint_visits ADD UNIQUE(organization_id,officer_user_id,client_request_id);
      INSERT INTO public.user_profiles(id,organization_id,role,display_name,deactivated_at) VALUES
        ('${id(3)}','${id(2)}','officer','Away branch officer',NULL),
        ('${id(4)}','${id(1)}','admin_officer','Home branch officer',NULL),
        ('${id(5)}','${id(2)}','officer','Inactive officer',clock_timestamp());
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,actual_start)
        SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${id(1)}',
          CASE n WHEN 11 THEN '${id(4)}'::uuid WHEN 12 THEN '${id(5)}'::uuid ELSE '${id(3)}'::uuid END,
          'general_patrol',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '7 hours',
          CASE WHEN n=13 THEN 'completed' ELSE 'in_progress' END,clock_timestamp()-interval '1 hour'
        FROM generate_series(10,13) n;
      INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,gps_lat,gps_lng,radius_meters,checkpoint_verification) VALUES
        ('${id(20)}','${id(1)}','Assigned place','${id(30)}',-41,174,10,'verified'),
        ('${id(21)}','${id(2)}','Other branch checkpoint','${id(30)}',-41,174,10,'verified'),
        ('${id(22)}','${id(1)}','Unmatched place','${id(31)}',-41,174,10,'unverified');
      INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,module_key,sla_arrive_by)
        VALUES('${id(50)}','${id(1)}','${id(10)}','${id(30)}','general_patrol',clock_timestamp()+interval '1 hour');
      ${definition('record_officer_checkpoint_visit')}
      REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC,anon,authenticated,service_role;
      GRANT EXECUTE ON FUNCTION ${signature} TO authenticated,service_role;
    `);
    const acl = () => sql(`SELECT proacl::text FROM pg_proc WHERE oid='${signature}'::regprocedure`);
    const beforeAcl = acl();
    const migration = fs.readdirSync(path.join(root, 'supabase/migrations'))
      .find(file => /^\d+_patrol_checkpoint_operating_branch\.sql$/.test(file));
    if (migration) sql(fs.readFileSync(path.join(root, 'supabase/migrations', migration), 'utf8'));
    assert.equal(acl(), beforeAcl, 'Capture grants are preserved');

    await t.test('the operating branch owns the visit, patrol and audit; client proximity is not evidence', () => {
      const receipt = JSON.parse(as(3, call(40)));
      assert.equal(receipt.created, true);
      const visit = JSON.parse(sql(`SELECT row_to_json(v) FROM public.patrol_checkpoint_visits v WHERE id='${receipt.visit_id}'`));
      assert.equal(visit.organization_id, id(1));
      assert.equal(visit.shift_stop_id, id(50));
      assert.equal(visit.within_radius, false);
      assert.ok(visit.gps_distance_from_checkpoint > 100000);
      assert.equal(visit.checkpoint_verification_at_visit, 'verified');
      assert.equal(sql(`SELECT organization_id FROM public.patrols WHERE id='${receipt.patrol_id}'`), id(1));
      assert.equal(sql(`SELECT organization_id FROM public.audit_log WHERE target_id='${receipt.visit_id}'`), id(1));
      assert.equal(JSON.parse(as(3, call(40, 10, 20, '-42,174', '999,false'))).created, false);
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE client_request_id='${id(40)}'`), '1');
      fail(3, call(40, 10, 22), /replay|different|conflict/i);
      fail(3, call(40, 10, 20, '-41,174'), /replay|different|conflict/i);
    });

    await t.test('foreign checkpoints, another officer, inactive identity and closed shifts cannot acquire visits', () => {
      fail(3, call(41, 10, 21), /organization|operating|checkpoint/i);
      fail(3, call(41, 11), /your active shift|assigned|own/i);
      fail(5, call(41, 12), /active officer|identity/i);
      fail(3, call(41, 13), /active shift/i);
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE client_request_id='${id(41)}'`), '0');
      assert.throws(() => sql(`SET ROLE anon; ${call(41)}`), /permission denied/i);
    });

    await t.test('missing and repeated candidate visits remain explicitly unresolved, never guessed', () => {
      const missing = JSON.parse(as(3, call(42, 10, 22, 'NULL,NULL')));
      const first = JSON.parse(sql(`SELECT row_to_json(v) FROM public.patrol_checkpoint_visits v WHERE id='${missing.visit_id}'`));
      assert.equal(first.shift_stop_id, null);
      assert.equal(first.within_radius, null);
      assert.equal(sql(`SELECT metadata->>'stop_resolution' FROM public.audit_log WHERE target_id='${missing.visit_id}'`), 'missing');
      sql(`INSERT INTO public.shift_stops(organization_id,shift_id,site_id,module_key,sla_arrive_by,visit_number)
        VALUES('${id(1)}','${id(10)}','${id(30)}','general_patrol',clock_timestamp()+interval '2 hours',2)`);
      const ambiguous = JSON.parse(as(3, call(43)));
      assert.equal(sql(`SELECT shift_stop_id IS NULL FROM public.patrol_checkpoint_visits WHERE id='${ambiguous.visit_id}'`), 't');
      assert.equal(sql(`SELECT metadata->>'stop_resolution' FROM public.audit_log WHERE target_id='${ambiguous.visit_id}'`), 'ambiguous');
    });

    await t.test('concurrent retries serialize on the same shift without an extra patrol or visit', async () => {
      const first = asyncSql(`BEGIN; SET LOCAL application_name='fcm-checkpoint-race';
        SELECT id FROM public.shifts WHERE id='${id(11)}' FOR UPDATE;
        SELECT pg_sleep(2); SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${id(4)}';
        ${call(44, 11)}; COMMIT;`);
      let held = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        held = sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fcm-checkpoint-race' AND wait_event='PgSleep')") === 't';
        if (held) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(held, 'First capture holds the canonical shift row lock');
      const results = await Promise.all([first, asyncSql(asSql(4, call(44, 11)))]);
      const receipts = results.map(output => JSON.parse(output.split('\n').find(line => line.startsWith('{'))));
      assert.deepEqual(receipts.map(receipt => receipt.created).sort(), [false, true]);
      assert.equal(receipts[0].visit_id, receipts[1].visit_id);
      assert.equal(sql(`SELECT count(*) FROM public.patrols WHERE officer_user_id='${id(4)}' AND shift_id='${id(11)}'`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE client_request_id='${id(44)}'`), '1');
    });

    await t.test('QR codes resolve in the owned active shift branch, not the profile branch', () => {
      sql(`UPDATE public.patrol_checkpoints SET qr_code='QR-'||right(id::text,2)`);
      const resolve = (actor, shift, code) => as(actor,
        `SELECT coalesce(string_agg(id::text,','),'none') FROM public.resolve_officer_checkpoint_qr('${id(shift)}','${code}')`);
      assert.equal(resolve(3, 10, 'QR-20'), id(20));
      assert.equal(resolve(3, 10, 'QR-21'), 'none', 'Home-branch checkpoints are not in the operating branch');
      assert.equal(resolve(3, 11, 'QR-20'), 'none', 'Another officer shift resolves nothing');
      assert.equal(resolve(3, 13, 'QR-20'), 'none', 'Closed shifts resolve nothing');
      assert.throws(() => sql(`SET ROLE anon; SELECT * FROM public.resolve_officer_checkpoint_qr('${id(10)}','QR-20')`),
        /permission denied/i);
    });

    await t.test('a committed capture is recovered after its checkpoint or shift closes', () => {
      sql(`UPDATE public.patrol_checkpoints SET active=false WHERE id='${id(20)}'`);
      assert.equal(JSON.parse(as(3, call(40))).created, false);
      sql(`UPDATE public.shifts SET status='completed' WHERE id='${id(10)}'`);
      const replay = JSON.parse(as(3, call(40)));
      assert.equal(replay.created, false);
      fail(3, call(40, 10, 20, '-41,174'), /replay|different|conflict/i);
      fail(3, call(45), /active shift/i);
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE client_request_id='${id(45)}'`), '0');
    });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
