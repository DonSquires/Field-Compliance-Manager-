'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261117200248_auto_record_verified_patrol_checkpoints.sql'), 'utf8');
const operatingBranch = fs.readFileSync(path.join(root, 'supabase/migrations/20261117203133_assigned_patrol_operating_branch.sql'), 'utf8');
const readContext = fs.readFileSync(path.join(root, 'supabase/migrations/20261117204043_assigned_officer_patrol_read_context.sql'), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const table = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('\n);', start) + 3);
};
const definition = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
};

test('verified checkpoint auto-capture is scoped, safe and idempotent', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async t => {
  const container = `fcm-auto-checkpoint-${randomUUID()}`;
  const args = ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
  const docker = (a, input) => execFileSync('docker', a, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = query => docker(args, query).trim();
  const asyncSql = query => new Promise((resolve, reject) => {
    const child = execFile('docker', args, { encoding: 'utf8' },
      (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout.trim()));
    child.stdin.end(query);
  });
  const query = (fix = "-41,174,5,clock_timestamp()", shift = 11) =>
    `SELECT public.auto_record_patrol_checkpoints('${id(shift)}',${fix})`;
  const request = (actor, statement) => `BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub='${id(actor)}'; ${statement}; COMMIT;`;
  const as = (actor, statement = query()) => sql(request(actor, statement));
  const capture = () => JSON.parse(as(3));
  const rejects = (fn, regex) => assert.throws(fn, error => regex.test(String(error.stderr ?? error.message)));
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready);
    sql(`CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      ${['user_profiles', 'shifts', 'shift_stops', 'shift_stop_actions', 'client_sites', 'org_geofence_config',
        'patrol_stop_charge_lines', 'patrols', 'patrol_routes', 'patrol_route_checkpoints',
        'patrol_checkpoints', 'patrol_checkpoint_visits', 'audit_log'].map(table).join('\n')}
      CREATE FUNCTION public.resolve_patrol_stop_charge_line_internal(uuid)
        RETURNS public.patrol_stop_charge_lines LANGUAGE sql AS $$ SELECT NULL::public.patrol_stop_charge_lines $$;
      ${definition('record_patrol_checkpoint_visit')}
      ${definition('manage_officer_patrol_stop')}
      ${definition('start_patrol_session')}
      ${definition('complete_patrol_session')}
      REVOKE ALL ON FUNCTION public.start_patrol_session(uuid) FROM PUBLIC, anon, authenticated, service_role;
      REVOKE ALL ON FUNCTION public.complete_patrol_session(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
      REVOKE ALL ON FUNCTION public.record_patrol_checkpoint_visit(uuid,text,uuid,double precision,double precision,double precision,text) FROM PUBLIC, anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.start_patrol_session(uuid) TO authenticated;
      GRANT EXECUTE ON FUNCTION public.complete_patrol_session(uuid,text) TO authenticated;
      GRANT EXECUTE ON FUNCTION public.record_patrol_checkpoint_visit(uuid,text,uuid,double precision,double precision,double precision,text) TO authenticated;
      ${migration}
      ${operatingBranch}
      ${readContext}
      INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES
        ('${id(3)}','${id(2)}','officer','Officer'),
        ('${id(4)}','${id(2)}','officer','Other'),
        ('${id(5)}','${id(8)}','officer','Other org'),
        ('${id(6)}','${id(2)}','client','Client');
      INSERT INTO public.patrol_routes(id,organization_id,name) VALUES ('${id(10)}','${id(2)}','Route');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,actual_start,status,patrol_route_id,zone_id)
        VALUES ('${id(11)}','${id(2)}','${id(3)}','general_patrol',now()-interval '1 hour',now()+interval '1 hour',
          now()-interval '30 minutes','in_progress','${id(10)}','${id(50)}'),
          ('${id(12)}','${id(2)}','${id(3)}','general_patrol',now()-interval '1 hour',now()+interval '1 hour',
          now()-interval '30 minutes','in_progress','${id(10)}',NULL),
          ('${id(13)}','${id(2)}','${id(4)}','general_patrol',now()-interval '1 hour',now()+interval '1 hour',
          now()-interval '30 minutes','in_progress','${id(10)}',NULL);
      INSERT INTO public.patrols(id,organization_id,shift_id,officer_user_id,status,started_at)
        VALUES ('${id(20)}','${id(2)}','${id(11)}','${id(3)}','in_progress',now()-interval '20 minutes');
      INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,module_key,stop_order,sla_arrive_by,status)
        VALUES ('${id(30)}','${id(2)}','${id(11)}','${id(40)}','general_patrol',1,now(),'on_scene'),
          ('${id(31)}','${id(2)}','${id(11)}','${id(41)}','general_patrol',2,now(),'on_scene'),
          ('${id(32)}','${id(2)}','${id(11)}','${id(41)}','general_patrol',3,now(),'pending'),
          ('${id(33)}','${id(2)}','${id(11)}','${id(42)}','general_patrol',4,now(),'pending'),
          ('${id(35)}','${id(2)}','${id(11)}','${id(43)}','general_patrol',5,now(),'missed'),
          ('${id(36)}','${id(2)}','${id(11)}','${id(44)}','general_patrol',6,now(),'en_route');
      INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,zone_id,gps_lat,gps_lng,radius_meters,checkpoint_verification,checkpoint_verified_by,checkpoint_verified_at,description)
      VALUES
        ('${id(100)}','${id(2)}','first','${id(40)}',NULL,-41,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(101)}','${id(2)}','overlap','${id(40)}',NULL,-41,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(102)}','${id(2)}','unverified','${id(40)}',NULL,-41,174,10,'unverified',NULL,NULL,'PRIVATE'),
        ('${id(103)}','${id(2)}','missing','${id(40)}',NULL,NULL,NULL,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(104)}','${id(2)}','outside','${id(40)}',NULL,-41.01,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(105)}','${id(2)}','edge','${id(40)}',NULL,-41.00006,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(106)}','${id(2)}','small','${id(40)}',NULL,-41,174,3,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(107)}','${id(2)}','pending','${id(42)}',NULL,-41,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(108)}','${id(2)}','shift zone',NULL,'${id(50)}',-41,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(109)}','${id(2)}','ambiguous','${id(41)}',NULL,-41,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(110)}','${id(8)}','foreign','${id(40)}',NULL,-41,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(112)}','${id(2)}','future verification','${id(40)}',NULL,-41,174,10,'verified','${id(3)}',now()+interval '1 minute','PRIVATE'),
        ('${id(113)}','${id(2)}','no reviewer','${id(40)}',NULL,-41,174,10,'verified',NULL,NULL,'PRIVATE'),
        ('${id(117)}','${id(2)}','missed stop','${id(43)}',NULL,-41,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE'),
        ('${id(118)}','${id(2)}','en route stop','${id(44)}',NULL,-41,174,10,'verified','${id(3)}',now()-interval '1 hour','PRIVATE');
      INSERT INTO public.patrol_route_checkpoints(id,patrol_route_id,name,is_active,is_mandatory)
        VALUES ('${id(120)}','${id(10)}','route',true,true);
    `);

    await t.test('rejects unauthorized, inactive, stale and invalid fixes', () => {
      for (const actor of [4, 5]) rejects(() => as(actor), /assigned Patrol shift/i);
      rejects(() => as(6), /Active Patrol officer/i);
      rejects(() => sql(`SET ROLE anon; ${query()}`), /permission denied/i);
      for (const fix of [
        "NULL,174,5,now()", "'NaN'::float8,174,5,now()", "-91,174,5,now()",
        "-41,181,5,now()", "-41,174,0,now()", "-41,174,51,now()",
        "-41,174,'NaN'::float8,now()", "-41,174,5,now()-interval '31 seconds'",
        "-41,174,5,now()+interval '6 seconds'", "-41,174,5,NULL", "-41,174,5,'infinity'::timestamptz",
      ]) rejects(() => as(3, query(fix)), /fresh valid location fix/i);
      sql(`UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${id(3)}'`);
      rejects(() => as(3), /Active Patrol officer/i);
      sql(`UPDATE public.user_profiles SET deactivated_at=NULL,organization_id='${id(8)}' WHERE id='${id(3)}'`);
      assert.equal(JSON.parse(as(3, query("-41,174,5,clock_timestamp()", 12))).status, 'no_session');
      sql(`UPDATE public.user_profiles SET organization_id='${id(2)}' WHERE id='${id(3)}'`);
      sql(`UPDATE public.shifts SET scheduled_end=now()-interval '1 second',status='completed' WHERE id='${id(11)}'`);
      rejects(() => as(3), /active assigned Patrol shift/i);
      sql(`UPDATE public.shifts SET scheduled_end=now()+interval '1 hour', status='accepted' WHERE id='${id(11)}'`);
      rejects(() => as(3), /active assigned Patrol shift/i);
      sql(`UPDATE public.shifts SET status='in_progress' WHERE id='${id(11)}';
        UPDATE public.patrols SET status='completed' WHERE id='${id(20)}'`);
      assert.deepEqual(JSON.parse(as(3)), {
        status: 'no_session', shift_id: id(11), patrol_id: null, recorded_checkpoint_ids: [], checkpoints: [],
      });
      sql(`UPDATE public.patrols SET status='in_progress' WHERE id='${id(20)}'`);
      sql(`UPDATE public.patrols SET started_at=now()-interval '3 seconds' WHERE id='${id(20)}'`);
      rejects(() => as(3, query("-41,174,5,clock_timestamp()-interval '4 seconds'")), /fresh valid location fix/i);
      sql(`UPDATE public.patrols SET started_at=now()-interval '20 minutes' WHERE id='${id(20)}'`);
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits`), '0');
    });

    await t.test('no session is explicit and never falls back to another shift', () => {
      const noSession = JSON.parse(as(3, query("-41,174,5,clock_timestamp()", 12)));
      assert.deepEqual(noSession, {
        status: 'no_session', shift_id: id(12), patrol_id: null, recorded_checkpoint_ids: [], checkpoints: [],
      });
      rejects(() => as(3, query("-41,174,5,clock_timestamp()-interval '31 seconds'", 12)), /fresh valid location fix/i);
      rejects(() => as(3, query("-41,174,5,clock_timestamp()", 13)), /active assigned Patrol shift/i);
      rejects(() => as(3, query("-41,174,5,clock_timestamp()", 99)), /active assigned Patrol shift/i);
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.patrols WHERE shift_id='${id(12)}'`), '0');
      sql(`INSERT INTO public.patrols(id,organization_id,shift_id,officer_user_id,status,started_at)
        VALUES ('${id(21)}','${id(2)}','${id(11)}','${id(3)}','in_progress',now()-interval '10 minutes')`);
      rejects(() => as(3), /session configuration requires operations review/i);
      sql(`DELETE FROM public.patrols WHERE id='${id(21)}'`);
    });

    await t.test('records only inside verified geofences and reports every other reason', () => {
      const result = capture();
      const statuses = Object.fromEntries(result.checkpoints.map(c => [c.checkpoint_id, c.status]));
      assert.equal(result.status, 'processed');
      assert.equal(result.shift_id, id(11));
      assert.equal(result.patrol_id, id(20));
      assert.deepEqual(result.recorded_checkpoint_ids, [id(100), id(101), id(107), id(108), id(109), id(117), id(118)]);
      assert.deepEqual(statuses, {
        [id(100)]: 'recorded', [id(101)]: 'recorded', [id(102)]: 'unverified',
        [id(103)]: 'missing_or_invalid_geofence', [id(104)]: 'outside_geofence',
        [id(105)]: 'boundary_uncertain', [id(106)]: 'accuracy_too_low',
        [id(107)]: 'recorded', [id(108)]: 'recorded_unattributed', [id(109)]: 'recorded_unattributed',
        [id(112)]: 'not_verified_at_capture', [id(113)]: 'unverified',
        [id(117)]: 'recorded_unattributed', [id(118)]: 'recorded', [id(120)]: 'route_not_eligible',
      });
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|foreign/);
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE checkpoint_verification_at_visit='verified' AND within_radius`), '7');
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(109)}' AND shift_stop_id IS NULL`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='patrol.checkpoint_auto_recorded'
        AND metadata->>'checkpoint_id'='${id(109)}' AND metadata->>'stop_resolution'='ambiguous'`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='patrol.checkpoint_auto_recorded'
        AND metadata->>'checkpoint_id'='${id(117)}' AND metadata->>'stop_resolution'='missing'`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(117)}' AND shift_stop_id IS NULL`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(108)}' AND shift_stop_id IS NULL`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE (checkpoint_id='${id(107)}' AND shift_stop_id='${id(33)}') OR (checkpoint_id='${id(118)}' AND shift_stop_id='${id(36)}')`), '2');
      assert.equal(sql(`SELECT count(*) FROM public.shift_stops WHERE id IN ('${id(33)}','${id(36)}') AND status IN ('pending','en_route') AND actual_arrived_at IS NULL AND actual_departed_at IS NULL`), '2');
      assert.equal(sql(`SELECT completed_stops FROM public.shifts WHERE id='${id(11)}'`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='patrol.checkpoint_auto_recorded'`), '7');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='patrol.checkpoint_recorded'`), '7');
    });

    await t.test('retry and later repeated visits never manufacture a second stop visit', () => {
      const retry = capture();
      assert.deepEqual(retry.recorded_checkpoint_ids, []);
      assert.equal(retry.checkpoints.find(c => c.checkpoint_id === id(100)).status, 'already_recorded');
      sql(`UPDATE public.shift_stops SET status='completed' WHERE id='${id(30)}';
        INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,module_key,stop_order,sla_arrive_by,status)
        VALUES ('${id(34)}','${id(2)}','${id(11)}','${id(40)}','general_patrol',5,now(),'on_scene')`);
      const later = capture();
      assert.equal(later.checkpoints.find(c => c.checkpoint_id === id(100)).status, 'already_recorded');
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(100)}'`), '1');
      assert.equal(sql(`SELECT shift_stop_id FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(100)}'`), id(30));
    });

    await t.test('the uncertainty circle may touch but not cross the verified radius', () => {
      sql(`INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,gps_lat,gps_lng,radius_meters,checkpoint_verification,checkpoint_verified_by,checkpoint_verified_at)
        VALUES ('${id(115)}','${id(2)}','boundary equality','${id(40)}',-41,174,10,'verified','${id(3)}',now()-interval '1 hour')`);
      const result = JSON.parse(as(3, query("-41,174,10,clock_timestamp()")));
      assert.equal(result.checkpoints.find(c => c.checkpoint_id === id(115)).status, 'recorded');
      assert.equal(result.checkpoints.find(c => c.checkpoint_id === id(105)).status, 'boundary_uncertain');
    });

    await t.test('an older unverified visit is not relabelled by an automatic retry', () => {
      sql(`INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,gps_lat,gps_lng,radius_meters,checkpoint_verification,checkpoint_verified_by,checkpoint_verified_at)
        VALUES ('${id(116)}','${id(2)}','old visit','${id(40)}',-41,174,10,'verified','${id(3)}',now()-interval '1 hour');
        INSERT INTO public.patrol_checkpoint_visits(organization_id,patrol_id,checkpoint_id,checkpoint_verification_at_visit,within_radius)
        VALUES ('${id(2)}','${id(20)}','${id(116)}','unverified',false)`);
      assert.equal(capture().checkpoints.find(c => c.checkpoint_id === id(116)).status, 'already_recorded');
      assert.equal(sql(`SELECT checkpoint_verification_at_visit FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(116)}'`), 'unverified');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='patrol.checkpoint_auto_recorded' AND metadata->>'checkpoint_id'='${id(116)}'`), '0');
    });

    await t.test('concurrent auto captures either serialize or retry without duplicates', async () => {
      sql(`INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,gps_lat,gps_lng,radius_meters,checkpoint_verification,checkpoint_verified_by,checkpoint_verified_at)
        VALUES ('${id(111)}','${id(2)}','race','${id(40)}',-41,174,10,'verified','${id(3)}',now()-interval '1 hour')`);
      const results = await Promise.allSettled([asyncSql(request(3, query())), asyncSql(request(3, query()))]);
      const statuses = results.filter(r => r.status === 'fulfilled')
        .map(r => JSON.parse(r.value).checkpoints.find(c => c.checkpoint_id === id(111)).status);
      assert.equal(statuses.filter(status => status === 'recorded').length, 1);
      for (const result of results.filter(r => r.status === 'rejected')) {
        assert.match(result.reason.message, /shift or stops are changing; retry/i);
        assert.equal(capture().checkpoints.find(c => c.checkpoint_id === id(111)).status, 'already_recorded');
      }
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(111)}'`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='patrol.checkpoint_auto_recorded' AND metadata->>'checkpoint_id'='${id(111)}'`), '1');
    });

    await t.test('a conflicting shift lock makes auto-capture retry without writes', async () => {
      sql(`INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,gps_lat,gps_lng,radius_meters,checkpoint_verification,checkpoint_verified_by,checkpoint_verified_at)
        VALUES ('${id(114)}','${id(2)}','delayed','${id(40)}',-41,174,10,'verified','${id(3)}',now()-interval '1 hour')`);
      const holder = asyncSql(`SET application_name='fcm-auto-checkpoint-lock';
        BEGIN; SELECT id FROM public.shifts WHERE id='${id(11)}' FOR UPDATE;
        SELECT pg_sleep(3); COMMIT;`);
      let held = false;
      for (let i = 0; i < 30; i++) {
        if (sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fcm-auto-checkpoint-lock' AND wait_event='PgSleep')`) === 't') {
          held = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        assert.ok(held);
        await assert.rejects(asyncSql(request(3, query())), /shift or stops are changing; retry/i);
      } finally {
        await holder;
      }
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(114)}'`), '0');
    });

    await t.test('a fix expiring while waiting for the session is rejected even with no eligible checkpoints', async () => {
      sql(`UPDATE public.patrol_checkpoints SET active=false`);
      const holder = asyncSql(`SET application_name='fcm-auto-session-lock';
        BEGIN; SELECT id FROM public.patrols WHERE id='${id(20)}' FOR UPDATE;
        SELECT pg_sleep(3); COMMIT;`);
      let held = false;
      for (let i = 0; i < 30; i++) {
        if (sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fcm-auto-session-lock' AND wait_event='PgSleep')`) === 't') {
          held = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        assert.ok(held);
        await assert.rejects(asyncSql(request(3, query("-41,174,5,clock_timestamp()-interval '29 seconds'"))), /fresh valid location fix/i);
      } finally {
        await holder;
        sql(`UPDATE public.patrol_checkpoints SET active=true`);
      }
    });

    await t.test('actual concurrent departure cannot deadlock auto-capture', async () => {
      sql(`UPDATE public.shift_stops SET status='on_scene',actual_arrived_at=now()-interval '30 minutes',
        sla_arrive_by=now()+interval '1 hour',sla_status='on_track' WHERE id='${id(34)}'`);
      const departure = asyncSql(`SET application_name='fcm-auto-departure-lock';
        BEGIN;
        SELECT id FROM public.shift_stops WHERE id='${id(34)}' FOR UPDATE;
        SELECT pg_sleep(3);
        SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${id(3)}';
        SELECT public.manage_officer_patrol_stop('${id(34)}','on_scene','depart','${id(119)}');
        COMMIT;`);
      let held = false;
      for (let i = 0; i < 30; i++) {
        if (sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fcm-auto-departure-lock' AND wait_event='PgSleep')`) === 't') {
          held = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        assert.ok(held);
        await assert.rejects(asyncSql(request(3, query())), /shift or stops are changing; retry/i);
      } finally {
        const receipt = await departure;
        assert.match(receipt, /"stop_status": "completed"/);
      }
      assert.equal(sql(`SELECT status FROM public.shift_stops WHERE id='${id(34)}'`), 'completed');
      assert.equal(sql(`SELECT completed_stops FROM public.shifts WHERE id='${id(11)}'`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE checkpoint_id='${id(114)}'`), '0');
    });

    await t.test('cross-branch assignment owns the entire session and writes in its operating organisation', async () => {
      sql(`UPDATE public.user_profiles SET organization_id='${id(8)}' WHERE id='${id(3)}';
        INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,module_key,stop_order,sla_arrive_by,status)
        VALUES ('${id(130)}','${id(2)}','${id(12)}','${id(60)}','general_patrol',1,now(),'pending');
        INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,gps_lat,gps_lng,radius_meters,
          checkpoint_verification,checkpoint_verified_by,checkpoint_verified_at)
        VALUES ('${id(140)}','${id(2)}','auto','${id(60)}',-41,174,10,'verified','${id(3)}',now()-interval '1 hour'),
          ('${id(141)}','${id(2)}','manual','${id(60)}',-41,174,10,'unverified',NULL,NULL);
        UPDATE public.patrol_route_checkpoints SET gps_lat=-41,gps_lng=174,geofence_radius_meters=10 WHERE id='${id(120)}'`);
      const start = () => JSON.parse(as(3, `SELECT row_to_json(p) FROM public.start_patrol_session('${id(12)}') p`));
      const empty = JSON.parse(as(3, `SELECT public.get_assigned_patrol_session('${id(12)}')`));
      assert.deepEqual(empty, {shift_id: id(12), session: null, visits: []});
      const patrol = start();
      assert.equal(patrol.organization_id, id(2));
      assert.equal(patrol.officer_user_id, id(3));
      sql(`UPDATE public.patrols SET notes='PRIVATE SESSION' WHERE id='${patrol.id}'`);
      const reused = start();
      assert.equal(reused.id, patrol.id);
      assert.equal(reused.notes, null);
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='patrol.started' AND target_id='${patrol.id}' AND organization_id='${id(2)}'`), '1');
      const readSession = (actor = 3, shift = 12) => {
        const value = as(actor, `SELECT public.get_assigned_patrol_session('${id(shift)}')`);
        return value ? JSON.parse(value) : null;
      };
      const readShifts = actor => JSON.parse(as(actor, 'SELECT public.get_assigned_officer_shift_context()'));
      assert.equal(readSession().session.id, patrol.id);
      assert.deepEqual(readSession().visits, []);
      assert.equal(readSession(4), null);
      assert.ok(readShifts(3).some(s => s.id === id(12) && s.organization_id === id(2)));
      assert.ok(!readShifts(4).some(s => s.id === id(12)));
      sql(`INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status)
        VALUES ('${id(14)}','${id(2)}','${id(3)}','general_patrol',now()+interval '1 hour',now()+interval '2 hours','accepted');
        INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,module_key,stop_order,sla_arrive_by,status,officer_instructions)
        VALUES ('${id(132)}','${id(8)}','${id(14)}','${id(60)}','general_patrol',1,now(),'pending','PRIVATE FUTURE')`);
      const candidates = readShifts(3);
      assert.equal(candidates.find(s => s.id === id(12)).context_status, 'available');
      assert.equal(candidates.find(s => s.id === id(14)).context_status, 'requires_review');
      assert.doesNotMatch(JSON.stringify(candidates.find(s => s.id === id(14))), /PRIVATE|shift_stops|service_type|location_id/);
      sql(`DELETE FROM public.shift_stops WHERE id='${id(132)}'; DELETE FROM public.shifts WHERE id='${id(14)}'`);
      rejects(() => sql(`SET ROLE anon; SELECT public.get_assigned_officer_shift_context()`), /permission denied/i);
      rejects(() => sql(`SET ROLE anon; SELECT public.get_assigned_patrol_session('${id(12)}')`), /permission denied/i);
      const visit = (kind, checkpoint, actor = 3) => JSON.parse(as(actor,
        `SELECT row_to_json(v) FROM public.record_patrol_checkpoint_visit('${patrol.id}','${kind}','${id(checkpoint)}',-41,174,5,'PRIVATE VISIT') v`));
      const complete = () => JSON.parse(as(3, `SELECT row_to_json(p) FROM public.complete_patrol_session('${patrol.id}','PRIVATE COMPLETION') p`));
      for (const status of ['published', 'accepted']) {
        sql(`UPDATE public.shifts SET status='${status}' WHERE id='${id(12)}'`);
        rejects(() => visit('site', 141), /shift is not active/i);
      }
      sql(`UPDATE public.user_profiles SET organization_id='${id(2)}' WHERE id='${id(3)}'`);
      rejects(() => visit('site', 141), /shift is not active/i);
      sql(`UPDATE public.user_profiles SET organization_id='${id(8)}' WHERE id='${id(3)}';
        UPDATE public.shifts SET status='in_progress' WHERE id='${id(12)}'`);
      sql(`INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,module_key,stop_order,sla_arrive_by,status)
        VALUES ('${id(131)}','${id(2)}','${id(12)}','${id(60)}','general_patrol',2,now(),'en_route')`);
      const unresolved = visit('site', 141);
      assert.equal(unresolved.created, true);
      assert.equal(sql(`SELECT (shift_stop_id IS NULL)::text || ':' || checkpoint_verification_at_visit
        FROM public.patrol_checkpoint_visits WHERE id='${unresolved.visit_id}'`), 'true:unverified');
      assert.equal(sql(`SELECT metadata->>'stop_resolution' FROM public.audit_log
        WHERE action='patrol.checkpoint_recorded' AND target_id='${unresolved.visit_id}'`), 'ambiguous');
      sql(`DELETE FROM public.patrol_checkpoint_visits WHERE id='${unresolved.visit_id}'`);
      sql(`DELETE FROM public.shift_stops WHERE id='${id(131)}'`);
      rejects(() => sql(`SET ROLE anon; SELECT public.start_patrol_session('${id(12)}')`), /permission denied/i);
      rejects(() => sql(`SET ROLE anon; SELECT public.complete_patrol_session('${patrol.id}')`), /permission denied/i);
      rejects(() => sql(`SET ROLE anon; SELECT public.record_patrol_checkpoint_visit('${patrol.id}','site','${id(141)}',-41,174,5)`), /permission denied/i);
      rejects(() => visit('site', 141, 4), /assigned Patrol session/i);
      rejects(() => visit('site', 110), /assigned Patrol checkpoint/i);
      sql(`UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${id(3)}'`);
      rejects(start, /Active Patrol officer/i);
      rejects(() => visit('site', 141), /Active Patrol officer/i);
      rejects(complete, /Active Patrol officer/i);
      rejects(readSession, /Active Patrol officer/i);
      rejects(() => readShifts(3), /Active Patrol officer/i);
      sql(`UPDATE public.user_profiles SET deactivated_at=NULL WHERE id='${id(3)}'`);
      rejects(complete, /mandatory checkpoints remain/i);
      rejects(() => as(3, query("-41,174,5,clock_timestamp()-interval '31 seconds'", 12)), /fresh valid location fix/i);
      const captured = JSON.parse(as(3, query("-41,174,5,clock_timestamp()", 12)));
      assert.deepEqual(captured.recorded_checkpoint_ids, [id(140)]);
      assert.equal(captured.checkpoints.find(c => c.checkpoint_id === id(120)).status, 'route_not_eligible');
      assert.equal(captured.checkpoints.find(c => c.checkpoint_id === id(141)).status, 'unverified');
      assert.equal(JSON.parse(as(3, query("-41,174,5,clock_timestamp()", 12))).recorded_checkpoint_ids.length, 0);
      const recorded = visit('site', 141);
      assert.equal(recorded.created, true);
      assert.equal(recorded.notes, null);
      assert.equal(sql(`SELECT checkpoint_verification_at_visit FROM public.patrol_checkpoint_visits
        WHERE id='${recorded.visit_id}'`), 'unverified');
      assert.equal(visit('site', 141).created, false);
      const stopHolder = asyncSql(`SET application_name='fcm-manual-stop-lock';
        BEGIN; SELECT id FROM public.shift_stops WHERE id='${id(130)}' FOR UPDATE;
        SELECT pg_sleep(3); COMMIT;`);
      let stopHeld = false;
      for (let i = 0; i < 30; i++) {
        if (sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fcm-manual-stop-lock' AND wait_event='PgSleep')`) === 't') {
          stopHeld = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        assert.ok(stopHeld);
        await assert.rejects(asyncSql(request(3,
          `SELECT * FROM public.record_patrol_checkpoint_visit('${patrol.id}','site','${id(141)}',-41,174,5)`)),
        /shift or stops are changing; retry/i);
      } finally {
        await stopHolder;
      }
      const receipts = readSession();
      assert.equal(receipts.visits.length, 2);
      assert.ok(receipts.visits.every(item => item.notes === null));
      assert.doesNotMatch(JSON.stringify(receipts), /PRIVATE/);
      sql(`UPDATE public.patrol_checkpoint_visits SET organization_id='${id(8)}' WHERE patrol_id='${patrol.id}' AND checkpoint_id='${id(141)}'`);
      rejects(readSession, /visit configuration/i);
      sql(`UPDATE public.patrol_checkpoint_visits SET organization_id='${id(2)}' WHERE patrol_id='${patrol.id}' AND checkpoint_id='${id(141)}'`);
      assert.equal(sql(`SELECT status||':'||(actual_arrived_at IS NULL)::text FROM public.shift_stops WHERE id='${id(130)}'`), 'pending:true');
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits WHERE patrol_id='${patrol.id}' AND organization_id='${id(2)}'`), '2');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action IN ('patrol.checkpoint_recorded','patrol.checkpoint_auto_recorded') AND organization_id <> '${id(2)}'`), '0');
      sql(`UPDATE public.patrols SET organization_id='${id(8)}' WHERE id='${patrol.id}'`);
      rejects(() => as(3, query("-41,174,5,clock_timestamp()", 12)), /session configuration/i);
      rejects(() => visit('site', 141), /assigned Patrol session/i);
      rejects(complete, /assigned Patrol session/i);
      rejects(start, /session configuration/i);
      rejects(readSession, /session configuration/i);
      sql(`UPDATE public.patrols SET organization_id='${id(2)}' WHERE id='${patrol.id}';
        UPDATE public.shift_stops SET organization_id='${id(8)}' WHERE id='${id(130)}'`);
      rejects(() => visit('site', 141), /configuration/i);
      rejects(complete, /configuration/i);
      rejects(start, /configuration/i);
      rejects(readSession, /configuration/i);
      assert.equal(readShifts(3).find(s => s.id === id(12)).context_status, 'requires_review');
      sql(`UPDATE public.shift_stops SET organization_id='${id(2)}' WHERE id='${id(130)}';
        UPDATE public.patrol_routes SET organization_id='${id(8)}' WHERE id='${id(10)}'`);
      rejects(() => visit('site', 141), /configuration/i);
      rejects(complete, /configuration/i);
      rejects(start, /configuration/i);
      rejects(() => as(3, query("-41,174,5,clock_timestamp()", 12)), /configuration/i);
      sql(`UPDATE public.patrol_routes SET organization_id='${id(2)}' WHERE id='${id(10)}';
        UPDATE public.shifts SET officer_user_id='${id(4)}' WHERE id='${id(12)}'`);
      rejects(() => visit('site', 141), /assigned Patrol session/i);
      rejects(complete, /assigned Patrol session/i);
      rejects(start, /Assigned Patrol shift/i);
      sql(`UPDATE public.shifts SET officer_user_id='${id(3)}',scheduled_end=now()-interval '1 second' WHERE id='${id(12)}'`);
      rejects(() => visit('site', 141), /shift is not active/i);
      rejects(complete, /shift is not active/i);
      rejects(start, /overdue/i);
      assert.equal(readSession(), null);
      const recovery = readShifts(3).find(s => s.id === id(12));
      assert.equal(recovery.context_status, 'recovery_only');
      assert.deepEqual(Object.keys(recovery).sort(), ['context_status', 'id', 'officer_user_id', 'organization_id', 'scheduled_end', 'scheduled_start', 'status'].sort());
      assert.doesNotMatch(JSON.stringify(recovery), /PRIVATE/);
      sql(`INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,gps_lat,gps_lng,radius_meters,
          checkpoint_verification,checkpoint_verified_by,checkpoint_verified_at)
        VALUES ('${id(144)}','${id(2)}','overdue auto','${id(60)}',-41,174,10,'verified','${id(3)}',now()-interval '1 hour')`);
      const overdueCapture = JSON.parse(as(3, query("-41,174,5,clock_timestamp()", 12)));
      assert.deepEqual(overdueCapture.recorded_checkpoint_ids, [id(144)]);
      assert.equal(sql(`SELECT count(*) FROM public.patrol_checkpoint_visits
        WHERE patrol_id='${patrol.id}' AND checkpoint_id='${id(144)}' AND organization_id='${id(2)}'
          AND checkpoint_verification_at_visit='verified' AND within_radius`), '1');
      assert.deepEqual(JSON.parse(as(3, query("-41,174,5,clock_timestamp()", 12))).recorded_checkpoint_ids, []);
      assert.doesNotMatch(JSON.stringify(overdueCapture), /PRIVATE/);
      sql(`UPDATE public.shifts SET scheduled_end=now()+interval '1 hour' WHERE id='${id(12)}'`);
      const reassignment = asyncSql(`SET application_name='fcm-patrol-reassignment';
        BEGIN; UPDATE public.shifts SET officer_user_id='${id(4)}' WHERE id='${id(12)}';
        SELECT pg_sleep(3); COMMIT;`);
      let held = false;
      for (let i = 0; i < 30; i++) {
        if (sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fcm-patrol-reassignment' AND wait_event='PgSleep')`) === 't') {
          held = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        assert.ok(held);
        await assert.rejects(asyncSql(request(3,
          `SELECT * FROM public.record_patrol_checkpoint_visit('${patrol.id}','site','${id(141)}',-41,174,5)`)),
        /assigned Patrol session/i);
      } finally {
        await reassignment;
      }
      sql(`UPDATE public.shifts SET officer_user_id='${id(3)}' WHERE id='${id(12)}'`);
      sql(`UPDATE public.patrol_route_checkpoints SET is_mandatory=false WHERE id='${id(120)}';
        INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,active)
        VALUES ('${id(143)}','${id(8)}','foreign blocker','${id(60)}',true)`);
      rejects(complete, /mandatory checkpoints remain/i);
      sql(`DELETE FROM public.patrol_checkpoints WHERE id='${id(143)}';
        UPDATE public.patrol_route_checkpoints SET is_mandatory=true WHERE id='${id(120)}'`);
      assert.equal(visit('route', 120).created, true);
      const result = complete();
      assert.equal(result.status, 'completed');
      assert.equal(result.notes, null);
      assert.equal(complete().notes, null);
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='patrol.completed' AND target_id='${patrol.id}' AND organization_id='${id(2)}'`), '1');
    });
  } finally {
    if (created) docker(['rm', '-f', container]);
  }
});
