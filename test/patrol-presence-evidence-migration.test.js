'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const table = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return `${schema.slice(start, schema.indexOf('\n);', start) + 3)}
    ALTER TABLE public.${name} ADD PRIMARY KEY(id);`;
};
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;

test('patrol GPS policy and point evidence preserve effective versions and never invent confidence', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async t => {
  const name = `fcm-patrol-presence-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sql = query => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();
  const as = (actor, query) => sql(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub='${id(actor)}'; ${query}; COMMIT;`);
  const policy = (request, org = 1, expected = null, accuracy = '20', gap = '120', from = null) =>
    `public.manage_patrol_billing_evidence_policy('${id(request)}','${id(org)}',
      ${literal(expected)},${accuracy},${gap},${literal(from)})`;
  const json = (actor, query) => JSON.parse(as(actor, `SELECT ${query}`));
  const fails = (actor, query, pattern) => assert.throws(() => as(actor, `SELECT ${query}`),
    error => pattern.test(String(error.stderr ?? error.message)));
  const classify = fix => JSON.parse(sql(`SELECT row_to_json(r)
    FROM public.classify_patrol_presence_fix_internal('${id(fix)}','${id(12)}') r`));
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
      ${['organizations', 'user_profiles', 'service_agreements', 'service_agreement_locations',
        'shifts', 'shift_stops', 'shift_stop_modules',
        'officer_gps_log', 'geofence_boundary_history', 'audit_log'].map(table).join('\n')}
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles p WHERE p.id=auth.uid()
          AND p.role='admin' AND p.deactivated_at IS NULL
          AND (p.organization_id=$1 OR (p.organization_id='${id(1)}' AND $1='${id(20)}'))) $$;
      CREATE FUNCTION public.user_can_operate_organization(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT public.is_admin_for_org($1) $$;
      CREATE FUNCTION public.get_descendant_organizations(uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
        SELECT CASE WHEN $1='${id(1)}' THEN ARRAY['${id(1)}','${id(20)}']::uuid[] ELSE ARRAY[$1] END $$;
      INSERT INTO public.organizations(id,name,organization_type) VALUES
        ('${id(1)}','Provider','service_provider'),('${id(2)}','Client','client'),
        ('${id(3)}','Other','service_provider'),('${id(20)}','Operating branch','service_provider');
      INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES
        ('${id(4)}','${id(1)}','admin','Administrator'),('${id(5)}','${id(2)}','officer','Away officer'),
        ('${id(6)}','${id(3)}','admin','Other administrator'),('${id(7)}','${id(1)}','admin','Second administrator');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name)
        VALUES('${id(10)}','${id(1)}','${id(2)}','Contract');
      INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id)
        VALUES('${id(12)}','${id(10)}','${id(11)}');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,actual_start)
        VALUES('${id(20)}','${id(20)}','${id(5)}','general_patrol',now()-interval '2 hours',
          now()+interval '6 hours','in_progress',now()-interval '2 hours');
    `);
    const migration = fs.readdirSync(path.join(root, 'supabase/migrations'))
      .find(file => /^\d+_patrol_presence_evidence\.sql$/.test(file));
    if (migration) sql(fs.readFileSync(path.join(root, 'supabase/migrations', migration), 'utf8'));

    await t.test('policy appends explicit limits, binds retries and rejects unauthorized/stale/backdated edits', () => {
      const saved = json(4, policy(50));
      fails(5, policy(52), /authority|administrator/i);
      fails(6, policy(52), /authority|administrator/i);
      for (const [accuracy, gap] of [['NULL', '120'], ['0', '120'], ["'NaN'", '120'],
        ["'Infinity'", '120'], ['20', 'NULL'], ['20', '0']]) {
        fails(4, policy(52, 1, saved.policy.id, accuracy, gap), /accuracy|gap|limits/i);
      }
      assert.equal(saved.policy.organization_id, id(1));
      assert.equal(Number(saved.policy.accuracy_meters), 20);
      assert.equal(saved.policy.max_gap_seconds, 120);
      assert.deepEqual(json(4, policy(50)), saved);
      fails(7, policy(50), /replay|conflict/i);
      fails(4, policy(50, 1, null, '25'), /replay|conflict/i);
      fails(4, policy(51), /stale|changed/i);
      fails(4, policy(51, 1, saved.policy.id, '25', '150', '2020-01-01T00:00:00Z'), /past|backdat/i);
      const future = new Date(Date.now() + 3600000).toISOString();
      const next = json(4, policy(51, 1, saved.policy.id, '25', '150', future));
      assert.notEqual(next.policy.id, saved.policy.id);
      assert.equal(sql(`SELECT accuracy_meters FROM public.patrol_billing_evidence_policies WHERE id='${saved.policy.id}'`), '20');
      assert.equal(sql(`SELECT effective_to=(${literal(future)}::timestamptz)
        FROM public.patrol_billing_evidence_policies WHERE id='${saved.policy.id}'`), 't');
      assert.equal(sql('SELECT count(*) FROM public.audit_log'), '2');
      assert.throws(() => as(4, 'SELECT * FROM public.patrol_billing_evidence_policies'), /permission denied/i);
    });

    await t.test('historical fence and policy, not today’s fence, classify the accuracy disk', () => {
      sql(`INSERT INTO public.patrol_billing_evidence_policies(
          id,organization_id,accuracy_meters,max_gap_seconds,effective_from,created_by,version,created_at)
        VALUES('${id(60)}','${id(20)}',20,120,now()-interval '3 hours','${id(4)}',1,now()-interval '3 hours');
        INSERT INTO public.geofence_boundary_history(id,entity_type,entity_id,boundary,
          verification_state,verified_by,verified_at,changed_via,version,created_at)
        VALUES('${id(61)}','client_site','${id(11)}',
          ST_MakeEnvelope(173.999,-41.001,174.001,-40.999,4326),'verified','${id(4)}',
          now()-interval '3 hours','verification',1,now()-interval '3 hours'),
          ('${id(62)}','client_site','${id(11)}',ST_MakeEnvelope(175,-42,175.01,-41.99,4326),
          'verified','${id(4)}',now(),'verification',2,now());
        INSERT INTO public.officer_gps_log(id,organization_id,officer_id,shift_id,gps_point,gps_lat,gps_lng,
          accuracy_meters,recorded_at,client_event_id)
        SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${id(20)}','${id(5)}','${id(20)}',
          ST_SetSRID(ST_Point(CASE n WHEN 71 THEN 174.01 WHEN 72 THEN 174.00099 ELSE 174 END,-41),4326),
          -41,CASE n WHEN 71 THEN 174.01 WHEN 72 THEN 174.00099 ELSE 174 END,
          CASE n WHEN 73 THEN NULL WHEN 74 THEN 'NaN'::double precision WHEN 75 THEN 25 ELSE 5 END,
          now()-interval '1 hour',gen_random_uuid()
        FROM generate_series(70,75) n;`);
      const inside = classify(70);
      assert.equal(inside.classification, 'inside');
      assert.equal(inside.policy_id, id(60));
      assert.equal(inside.boundary_history_id, id(61));
      assert.equal(classify(71).classification, 'outside');
      for (const fix of [72, 73, 74, 75]) assert.equal(classify(fix).classification, 'uncertain');
      assert.throws(() => as(4, `SELECT * FROM public.classify_patrol_presence_fix_internal('${id(70)}','${id(12)}')`), /permission denied/i);
    });

    await t.test('missing provenance and unverified or invalid history remain review evidence', () => {
      sql(`UPDATE public.geofence_boundary_history SET verification_state='unverified' WHERE id='${id(61)}'`);
      assert.equal(classify(70).classification, 'uncertain');
      sql(`UPDATE public.geofence_boundary_history SET verification_state='verified',
        boundary=ST_GeomFromText('POLYGON((174 -41,174.001 -40.999,174 -40.999,174.001 -41,174 -41))',4326)
        WHERE id='${id(61)}'`);
      assert.equal(classify(70).classification, 'uncertain');
      sql(`UPDATE public.geofence_boundary_history SET created_at=now()+interval '1 hour' WHERE id='${id(61)}'`);
      assert.equal(classify(70).reason, 'missing_historical_boundary');
      sql(`UPDATE public.patrol_billing_evidence_policies SET effective_from=now()-interval '30 minutes'
        WHERE id='${id(60)}'`);
      assert.equal(classify(70).reason, 'missing_effective_policy');
    });

    await t.test('paired boundaries qualify only the inside span; gaps, uncertainty and incomplete pairs require review', () => {
      sql(`UPDATE public.patrol_billing_evidence_policies SET effective_from=now()-interval '3 hours' WHERE id='${id(60)}';
        UPDATE public.geofence_boundary_history SET created_at=now()-interval '3 hours',
          boundary=ST_MakeEnvelope(173.999,-41.001,174.001,-40.999,4326) WHERE id='${id(61)}';
        INSERT INTO public.user_profiles(id,organization_id,role,display_name)
          VALUES('${id(8)}','${id(2)}','officer','Second away officer');
        INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,actual_start)
          VALUES('${id(21)}','${id(20)}','${id(8)}','general_patrol',now()-interval '2 hours',
            now()+interval '6 hours','in_progress',now()-interval '2 hours');
        INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,module_key,sla_arrive_by,status)
          VALUES('${id(22)}','${id(20)}','${id(21)}','${id(11)}','patrol',now(),'completed');
        INSERT INTO public.shift_stop_modules(organization_id,shift_stop_id,module_key,service_agreement_location_id)
          VALUES('${id(20)}','${id(22)}','patrol','${id(12)}');
        INSERT INTO public.officer_gps_log(id,organization_id,officer_id,shift_id,gps_point,gps_lat,gps_lng,
          accuracy_meters,recorded_at,client_event_id)
        SELECT ('00000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,'${id(20)}','${id(8)}','${id(21)}',
          ST_SetSRID(ST_Point(CASE WHEN n IN (0,12) THEN 174.01 ELSE 174 END,-41),4326),
          -41,CASE WHEN n IN (0,12) THEN 174.01 ELSE 174 END,5,
          now()-interval '1 hour'+n*interval '1 minute',gen_random_uuid()
        FROM generate_series(0,12) n;`);
      const project = () => JSON.parse(sql(`SELECT jsonb_agg(to_jsonb(r) ORDER BY r.started_at)
        FROM public.project_patrol_presence_intervals_internal('${id(21)}','${id(12)}') r`));
      const paired = project();
      assert.equal(paired.length, 1);
      assert.equal(paired[0].qualification_state, 'qualified');
      assert.equal(Number(paired[0].duration_seconds), 600);
      assert.equal(paired[0].inside_fix_count, 11);
      assert.deepEqual(paired[0].entry_event_ids, [id(100)]);
      assert.deepEqual(paired[0].exit_event_ids, [id(112)]);
      const captures = sql(`SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id DESC)
        FROM public.officer_gps_log g WHERE g.shift_id='${id(21)}'`);
      const restore = () => sql(`DELETE FROM public.officer_gps_log WHERE shift_id='${id(21)}';
        INSERT INTO public.officer_gps_log SELECT * FROM jsonb_populate_recordset(
          NULL::public.officer_gps_log,${literal(captures)}::jsonb)`);
      restore();
      assert.deepEqual(project(), paired, 'Insertion order does not change derived presence');
      sql(`UPDATE public.officer_gps_log SET gps_lng=174.01,gps_point=ST_SetSRID(ST_Point(174.01,-41),4326)
        WHERE id IN ('${id(106)}','${id(107)}')`);
      const reentered = project();
      assert.ok(reentered.every(interval => interval.qualification_state==='qualified'));
      assert.deepEqual(reentered.map(interval => Number(interval.duration_seconds)), [240, 180],
        'Re-entry never bills the off-site gap');
      restore();
      sql(`INSERT INTO public.officer_gps_log SELECT * FROM jsonb_populate_record(
        NULL::public.officer_gps_log,(SELECT to_jsonb(g)||jsonb_build_object('id','${id(999)}',
          'client_event_id','${id(999)}') FROM public.officer_gps_log g WHERE id='${id(101)}'))`);
      assert.equal(project()[0].inside_fix_count, 11, 'Duplicate instants are not additional inside fixes');
      restore();
      sql(`INSERT INTO public.geofence_boundary_history(id,entity_type,entity_id,boundary,
          verification_state,verified_by,verified_at,changed_via,version,created_at)
        SELECT '${id(63)}','client_site','${id(11)}',ST_MakeEnvelope(173.999,-41.001,174.001,-40.999,4326),
          'verified','${id(4)}',g.recorded_at,'verification',3,g.recorded_at
        FROM public.officer_gps_log g WHERE g.id='${id(105)}'`);
      assert.ok(project().every(interval => interval.qualification_state==='review'),
        'Presence is not paired across different boundary versions');
      sql(`DELETE FROM public.geofence_boundary_history WHERE id='${id(63)}';
        UPDATE public.patrol_billing_evidence_policies SET effective_to=(
          SELECT recorded_at FROM public.officer_gps_log WHERE id='${id(105)}') WHERE id='${id(60)}';
        INSERT INTO public.patrol_billing_evidence_policies(id,organization_id,accuracy_meters,max_gap_seconds,
          effective_from,version,created_by,created_at)
        SELECT '${id(64)}','${id(20)}',20,120,g.recorded_at,2,'${id(4)}',g.recorded_at
        FROM public.officer_gps_log g WHERE g.id='${id(105)}'`);
      assert.ok(project().every(interval => interval.qualification_state==='review'),
        'Presence is not paired across different policy versions');
      sql(`DELETE FROM public.patrol_billing_evidence_policies WHERE id='${id(64)}';
        UPDATE public.patrol_billing_evidence_policies SET effective_to=NULL WHERE id='${id(60)}'`);
      sql(`UPDATE public.officer_gps_log SET accuracy_meters=NULL WHERE id='${id(106)}'`);
      const uncertain = project();
      assert.ok(uncertain.every(interval => interval.qualification_state==='review'));
      assert.deepEqual(uncertain[0].exit_event_ids, [], 'An uncertain fix is not a confirmed exit');
      assert.deepEqual(uncertain[1].entry_event_ids, [], 'An uncertain fix is not a confirmed entry');
      sql(`UPDATE public.officer_gps_log SET accuracy_meters=5 WHERE id='${id(106)}';
        UPDATE public.patrol_billing_evidence_policies SET max_gap_seconds=30 WHERE id='${id(60)}'`);
      assert.ok(project().every(interval => interval.qualification_state==='review'));
      sql(`UPDATE public.patrol_billing_evidence_policies SET max_gap_seconds=120 WHERE id='${id(60)}';
        DELETE FROM public.officer_gps_log WHERE id='${id(112)}'`);
      assert.equal(project()[0].reason, 'missing_confirmed_exit');
      sql(`DELETE FROM public.officer_gps_log WHERE id='${id(100)}'`);
      assert.equal(project()[0].qualification_state, 'review');
      restore();
      sql(`UPDATE public.shifts SET actual_end=(SELECT recorded_at FROM public.officer_gps_log
        WHERE id='${id(105)}') WHERE id='${id(21)}'`);
      assert.equal(project()[0].reason, 'missing_confirmed_exit', 'Finishing duty never invents an outside fix');
      sql(`INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name)
        VALUES('${id(15)}','${id(1)}','${id(2)}','Other contract at the same place');
        INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id)
        VALUES('${id(13)}','${id(15)}','${id(11)}')`);
      assert.throws(() => sql(`SELECT * FROM public.project_patrol_presence_intervals_internal(
        '${id(21)}','${id(13)}')`), /explicit contracted stop attribution/i);
      assert.throws(() => as(4, `SELECT * FROM public.project_patrol_presence_intervals_internal(
        '${id(21)}','${id(12)}')`), /permission denied/i);
    });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
