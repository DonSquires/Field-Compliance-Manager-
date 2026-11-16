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
const literal = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('location patrol responsibility versions confirmed future plans without changing contracts or field evidence', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async t => {
  const name = `fcm-location-patrol-responsibility-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
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
    SET LOCAL request.jwt.claim.sub=${literal(actor)}; ${query}; COMMIT;`;
  const as = (actor, query) => sql(asSql(actor, query));
  const json = (actor, query) => JSON.parse(as(actor, `SELECT ${query}`));
  const fails = (actor, query, pattern) => assert.throws(() => as(actor, `SELECT ${query}`),
    error => pattern.test(String(error.stderr ?? error.message)));
  const get = () => json(id(4), `public.get_location_patrol_setup('${id(7)}')`);
  const preview = changes => json(id(4),
    `public.preview_location_patrol_setup('${id(7)}',${literal(JSON.stringify(changes))}::jsonb)`);
  const save = (changes, version, fingerprint, request = id(90)) =>
    `public.save_location_patrol_setup('${id(7)}','${request}',${literal(version)},
      ${literal(fingerprint)},${literal(JSON.stringify(changes))}::jsonb)`;
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
    sql(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      ${['organizations', 'user_profiles', 'locations', 'client_sites', 'location_zones',
        'service_agreements', 'service_agreement_locations', 'service_agreement_modules',
        'service_agreement_delivery_schedules', 'client_site_patrol_config', 'patrol_routes',
        'patrol_route_stop_modules', 'roster_work_units', 'shifts', 'shift_stops', 'shift_stop_modules',
        'patrol_stop_charge_lines', 'shift_stop_actions', 'patrol_checkpoint_visits', 'patrols',
        'officer_gps_log', 'safety_briefing_acknowledgements', 'rate_rules', 'crm_commercial_settings',
        'audit_log'].map(table).join('\n')}
      ALTER TABLE public.shift_stop_modules ADD UNIQUE(shift_stop_id,module_key);
      ALTER TABLE public.shift_stop_modules ADD FOREIGN KEY(shift_stop_id)
        REFERENCES public.shift_stops(id) ON DELETE CASCADE;
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles p WHERE p.id=auth.uid()
          AND p.role IN('admin','admin_officer') AND p.deactivated_at IS NULL
          AND (p.organization_id=$1 OR (p.organization_id='${id(1)}' AND $1='${id(20)}'))) $$;
      CREATE FUNCTION public.user_can_operate_organization(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT public.is_admin_for_org($1) $$;
      CREATE FUNCTION public.get_descendant_organizations(uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
        SELECT CASE WHEN $1='${id(1)}' THEN ARRAY['${id(1)}','${id(20)}']::uuid[] ELSE ARRAY[$1] END $$;
      CREATE FUNCTION public.evaluate_shift_start_position(uuid,double precision,double precision)
        RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"status":"no_gps"}'::jsonb $$;
      ${definition('manage_operating_branch_rate_rule')}
      ${definition('resolve_rate_rule')}
      ${definition('patrol_window_bounds')}
      ${definition('generate_shift_stops')}
      ${definition('preview_work_unit_coverage')}
      ${definition('start_officer_shift')}
      CREATE TABLE public.reference_codes(id uuid,organization_id uuid,code_type text,code text,is_active boolean);
      INSERT INTO public.organizations(id,name,organization_type) VALUES
        ('${id(1)}','Provider','service_provider'),('${id(2)}','Client','client'),
        ('${id(3)}','Other','service_provider'),('${id(20)}','Operating branch','service_provider');
      INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES
        ('${id(4)}','${id(1)}','admin','Test admin'),('${id(5)}','${id(1)}','officer','Test officer'),
        ('${id(6)}','${id(3)}','admin','Other admin'),('${id(21)}','${id(1)}','admin','Second admin');
      INSERT INTO public.locations(id,organization_id,name,canonical_place_id)
        VALUES('${id(7)}','${id(2)}','Location','${id(70)}');
      INSERT INTO public.client_sites(id,location_id,client_organization_id,organization_id,name)
        VALUES('${id(8)}','${id(7)}','${id(2)}','${id(2)}','Site');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,starts_on,ends_on,invitation_status)
        VALUES('${id(10)}','${id(1)}','${id(2)}','First contract','2020-01-01','2099-12-31','accepted'),
          ('${id(11)}','${id(1)}','${id(2)}','Second contract','2020-01-01','2099-12-31','accepted');
      INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id)
        VALUES('${id(12)}','${id(10)}','${id(8)}'),('${id(13)}','${id(11)}','${id(8)}');
      INSERT INTO public.service_agreement_modules(id,service_agreement_id,module_key)
        VALUES('${id(14)}','${id(10)}','patrol'),('${id(15)}','${id(11)}','patrol');
      INSERT INTO public.crm_commercial_settings(service_agreement_id,base_rate_per_hour)
        VALUES('${id(10)}',39.5),('${id(11)}',65);
      INSERT INTO public.patrol_routes(id,organization_id,name,is_active) VALUES
        ('${id(30)}','${id(20)}','Day patrol',true),('${id(31)}','${id(20)}','Night patrol',true),
        ('${id(32)}','${id(3)}','Foreign patrol',true),('${id(33)}','${id(20)}','Inactive patrol',false),
        ('${id(34)}','${id(20)}','Not rosterable yet',true);
      INSERT INTO public.roster_work_units(id,organization_id,name,work_unit_type,service_type,patrol_route_id)
        VALUES('${id(35)}','${id(20)}','Day patrol','patrol','general_patrol','${id(30)}'),
          ('${id(36)}','${id(20)}','Night patrol','patrol','general_patrol','${id(31)}');
      INSERT INTO public.service_agreement_delivery_schedules(id,service_agreement_id,site_id,module_key,
        capability_key,work_model,active_days,visits_per_shift,min_gap_between_visits_minutes,pricing_basis)
        VALUES('${id(40)}','${id(10)}','${id(8)}','patrol','patrol','scheduled_visits','{1,2,3,4,5,6,7}',1,60,'hourly'),
          ('${id(41)}','${id(11)}','${id(8)}','patrol','patrol','scheduled_visits','{1,2,3,4,5,6,7}',1,60,'hourly');
      INSERT INTO public.client_site_patrol_config(id,organization_id,site_id,patrol_route_id,module_key,delivery_schedule_id,time_window_type)
        VALUES('${id(42)}','${id(20)}','${id(8)}','${id(30)}','general_patrol','${id(40)}','fixed'),
          ('${id(43)}','${id(20)}','${id(8)}','${id(30)}','general_patrol','${id(41)}','fixed');
      INSERT INTO public.patrol_route_stop_modules(organization_id,patrol_config_id,module_key,
        service_agreement_location_id,service_agreement_module_id)
        VALUES('${id(20)}','${id(42)}','general_patrol','${id(12)}','${id(14)}'),
          ('${id(20)}','${id(43)}','general_patrol','${id(13)}','${id(15)}');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,patrol_route_id,scheduled_start,scheduled_end,status)
        SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${id(20)}','${id(5)}','general_patrol',
          CASE WHEN n=52 THEN '${id(31)}'::uuid ELSE '${id(30)}'::uuid END,
          ((clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date + CASE WHEN n=50 THEN 1 ELSE 3 END + time '08:00') AT TIME ZONE 'Pacific/Auckland',
          ((clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date + CASE WHEN n=50 THEN 1 ELSE 3 END + time '16:00') AT TIME ZONE 'Pacific/Auckland','published'
        FROM generate_series(50,57) n;
      DO $$ DECLARE s record; BEGIN FOR s IN SELECT * FROM public.shifts LOOP
        PERFORM public.generate_shift_stops(s.id,(s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date);
      END LOOP; END $$;
      UPDATE public.shifts SET status='in_progress',actual_start=scheduled_start WHERE id='${id(53)}';
      UPDATE public.shifts SET status='cancelled' WHERE id='${id(55)}';
      UPDATE public.shifts SET status='completed',actual_start=scheduled_start,actual_end=scheduled_end WHERE id='${id(56)}';
      UPDATE public.shift_stop_modules SET outcome='Recorded evidence',result_record_id='${id(99)}'
        WHERE shift_stop_id IN(SELECT id FROM public.shift_stops WHERE shift_id='${id(54)}');
    `);
    for (const file of ['20261115230036_location_client_billing_selection.sql',
      '20261116043411_patrol_billing_units.sql']) {
      sql(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
    }
    const responsibilityMigration = fs.readdirSync(path.join(root, 'supabase/migrations'))
      .find(file => /^\d+_location_patrol_responsibility\.sql$/.test(file));
    if (responsibilityMigration) sql(fs.readFileSync(path.join(root, 'supabase/migrations', responsibilityMigration), 'utf8'));
    const effective = sql("SELECT ((clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date+2)::text");
    const changes = {
      patrol_config_id: id(42), service_agreement_location_id: id(12),
      service_agreement_module_id: id(14), patrol_route_id: id(31), work_unit_id: id(36),
      effective_from: effective,
      billing: { source: 'agreement', rate_type: 'hourly', billing_unit_code: 'hourly_officer' },
    };

    await t.test('setup distinguishes contracts and rejects unauthorized or unrosterable responsibility', () => {
      const setup = get();
      assert.equal(new Set(setup.configs.map(row => row.service_agreement_id)).size, 2);
      assert.equal(setup.runs.find(run => run.id === id(34)).work_units.length, 0);
      assert.ok(!setup.runs.some(run => run.id === id(32)), 'Foreign branch options are not disclosed');
      for (const actor of [id(5), id(6)]) {
        fails(actor, `public.get_location_patrol_setup('${id(7)}')`, /administrator|authority|access/i);
      }
      for (const route of [id(32), id(33), id(34)]) {
        assert.throws(() => preview({ ...changes, patrol_route_id: route }),
          /authorized|active|operating|work unit|rosterable/i);
      }
      assert.throws(() => preview({ ...changes, service_agreement_location_id: id(13),
        service_agreement_module_id: id(15) }), /contract|agreement|schedule/i);
      assert.throws(() => preview({ ...changes, visits_per_shift: 5 }), /contract|unsupported|terms/i);
    });

    await t.test('provider operational authority does not depend on client portal acceptance', () => {
      sql(`UPDATE public.service_agreements SET invitation_status='not_invited' WHERE id='${id(10)}'`);
      try {
        assert.ok(get().configs.some(config => config.service_agreement_id === id(10)));
        assert.equal(preview(changes).contractual_terms.service_agreement_id, id(10));
      } finally {
        sql(`UPDATE public.service_agreements SET invitation_status='accepted' WHERE id='${id(10)}'`);
      }
    });

    await t.test('confirmation changes only the chosen contract and safe future plans with replay receipts', () => {
      const contractsBefore = sql('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.service_agreement_delivery_schedules d');
      const protectedIds = [50, 53, 54, 55, 56].map(id);
      const protectedBefore = sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.shift_stops s
        WHERE shift_id=ANY(${literal(`{${protectedIds.join(',')}}`)}::uuid[])`);
      const otherContractBefore = sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.shift_stops s WHERE patrol_config_id='${id(43)}'`);
      const before = get();
      const plan = preview(changes);
      assert.deepEqual(plan.affected.map(row => row.shift_id).sort(), [id(51), id(52), id(57)]);
      assert.deepEqual(plan.blocked.map(row => row.shift_id).sort(), [id(53), id(54), id(55), id(56)]);
      assert.equal(sql(`SELECT count(*) FROM public.shift_stops WHERE shift_id='${id(52)}'`), '0', 'Preview performs no writes');
      const receipt = json(id(4), save(changes, before.version, plan.preview_fingerprint));
      assert.equal(receipt.replayed, false);
      assert.equal(receipt.billing.selection.billing_unit_code, 'hourly_officer');
      assert.equal(sql(`SELECT count(*) FROM public.shift_stops WHERE patrol_config_id='${id(42)}'
        AND shift_id IN('${id(51)}','${id(57)}')`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.shift_stops WHERE patrol_config_id='${id(42)}'
        AND shift_id='${id(52)}'`), '1');
      assert.equal(sql(`SELECT service_agreement_location_id FROM public.shift_stop_modules m
        JOIN public.shift_stops s ON s.id=m.shift_stop_id WHERE s.shift_id='${id(52)}'`), id(12));
      assert.equal(sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.shift_stops s
        WHERE shift_id=ANY(${literal(`{${protectedIds.join(',')}}`)}::uuid[])`), protectedBefore);
      assert.equal(sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.shift_stops s WHERE patrol_config_id='${id(43)}'`), otherContractBefore);
      assert.equal(sql('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.service_agreement_delivery_schedules d'), contractsBefore);
      const stopsAfter = sql('SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.shift_stops s');
      const replay = json(id(4), save(changes, before.version, plan.preview_fingerprint));
      assert.equal(replay.replayed, true);
      assert.equal(replay.responsibility_id, receipt.responsibility_id);
      assert.equal(sql('SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.shift_stops s'), stopsAfter);
      assert.equal(sql("SELECT count(*) FROM public.audit_log WHERE action='location_patrol_setup_saved'"), '1');
      fails(id(21), save(changes, before.version, plan.preview_fingerprint), /request|replay|actor|conflict/i);
      fails(id(4), save({ ...changes, effective_from: '2099-01-01' }, before.version, plan.preview_fingerprint), /request|replay|conflict/i);
    });

    await t.test('roster coverage follows the same effective responsibility as materialized stops', () => {
      const later = sql("SELECT ((clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date+3)::text");
      const earlier = sql("SELECT ((clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date+1)::text");
      const coverage = (unit, date) => json(id(4), `public.preview_work_unit_coverage('${unit}','${date}')`);
      assert.equal(coverage(id(35), earlier).stop_count, 2);
      assert.equal(coverage(id(36), earlier).stop_count, 0);
      assert.equal(coverage(id(35), later).stop_count, 1);
      assert.equal(coverage(id(36), later).stop_count, 1);
    });

    await t.test('source changes and a concurrent canonical shift start invalidate preview without partial writes', async () => {
      const amended = { ...changes, patrol_route_id: id(30), work_unit_id: id(35),
        billing: { ...changes.billing, expected_selection_id: get().billing_workspaces[0].selections[0].id,
          expected_updated_at: get().billing_workspaces[0].selections[0].updated_at } };
      const setup = get();
      const plan = preview(amended);
      sql(`UPDATE public.patrol_routes SET name='Updated run' WHERE id='${id(30)}'`);
      fails(id(4), save(amended, setup.version, plan.preview_fingerprint, id(91)), /changed|reload|stale/i);
      const fresh = get();
      const freshPlan = preview(amended);
      const blocker = asyncSql(`BEGIN; SET LOCAL application_name='fcm-patrol-start-race';
        SELECT id FROM public.shifts WHERE id='${id(52)}' FOR UPDATE;
        SELECT pg_sleep(3); ${asSql(id(4),
          `SELECT shift_id FROM public.start_officer_shift('${id(92)}','${id(52)}','published')`)
          .replace('BEGIN;', '').replace('COMMIT;', '')}; COMMIT;`);
      let held = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        held = sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep' AND application_name='fcm-patrol-start-race')") === 't';
        if (held) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(held, 'Canonical start transaction holds the shared shift row lock');
      const writesBefore = sql("SELECT count(*) FROM public.audit_log WHERE action='location_patrol_setup_saved'");
      fails(id(4), save(amended, fresh.version, freshPlan.preview_fingerprint, id(93)), /changed|reload|stale|concurrent|lock/i);
      await blocker;
      fails(id(4), save(amended, fresh.version, freshPlan.preview_fingerprint, id(93)), /changed|reload|stale/i);
      assert.equal(sql("SELECT count(*) FROM public.audit_log WHERE action='location_patrol_setup_saved'"), writesBefore);
      assert.equal(sql(`SELECT count(*) FROM public.shift_stops WHERE patrol_config_id='${id(42)}' AND shift_id='${id(52)}'`), '1');
    });

    await t.test('public regeneration cannot rewrite evidenced plans or act for a deactivated officer', () => {
      for (const shift of [52, 53, 54, 55, 56]) {
        const day = sql(`SELECT (scheduled_start AT TIME ZONE 'Pacific/Auckland')::date FROM public.shifts WHERE id='${id(shift)}'`);
        fails(id(4), `public.generate_shift_stops('${id(shift)}','${day}')`, /regenerate|evidence|started|unstarted/i);
      }
      sql(`UPDATE public.user_profiles SET deactivated_at=clock_timestamp() WHERE id='${id(5)}'`);
      const day = sql(`SELECT (scheduled_start AT TIME ZONE 'Pacific/Auckland')::date FROM public.shifts WHERE id='${id(50)}'`);
      fails(id(5), `public.generate_shift_stops('${id(50)}','${day}')`, /active|authority|access|officer/i);
      assert.throws(() => sql(`SET ROLE anon; SELECT public.get_location_patrol_setup('${id(7)}')`), /permission denied/i);
    });

    await t.test('initial publication and ad-hoc creation still work without permitting historical regeneration', () => {
      sql(`INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,patrol_route_id,
        scheduled_start,scheduled_end,status,shift_origin,actual_start) VALUES
        ('${id(80)}','${id(20)}','${id(21)}','general_patrol','${id(30)}',
          clock_timestamp()-interval '3 days',clock_timestamp()-interval '2 days','published','rostered',NULL),
        ('${id(81)}','${id(20)}','${id(21)}','general_patrol','${id(30)}',
          clock_timestamp(),clock_timestamp()+interval '8 hours','in_progress','ad_hoc',clock_timestamp())`);
      for (const shift of [80, 81]) {
        const day = sql(`SELECT (scheduled_start AT TIME ZONE 'Pacific/Auckland')::date FROM public.shifts WHERE id='${id(shift)}'`);
        assert.equal(as(id(4), `SELECT public.generate_shift_stops('${id(shift)}','${day}')`), '2');
        fails(id(4), `public.generate_shift_stops('${id(shift)}','${day}')`, /regenerate|started|passed/i);
      }
    });

    await t.test('authorized places with no patrol schedule return an empty setup, including future agreements', () => {
      sql(`INSERT INTO public.locations(id,organization_id,name,canonical_place_id) VALUES
        ('${id(71)}','${id(2)}','Not configured','${id(74)}'),
        ('${id(75)}','${id(2)}','Future location','${id(84)}');
      INSERT INTO public.client_sites(id,location_id,client_organization_id,organization_id,name) VALUES
        ('${id(72)}','${id(71)}','${id(2)}','${id(2)}','Empty site'),
        ('${id(76)}','${id(75)}','${id(2)}','${id(2)}','Future site');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,starts_on,ends_on,invitation_status)
        VALUES('${id(78)}','${id(1)}','${id(2)}','Future contract',
          (clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date+20,'2099-12-31','accepted');
      INSERT INTO public.service_agreement_modules(id,service_agreement_id,module_key)
        VALUES('${id(79)}','${id(78)}','patrol');
      INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id) VALUES
        ('${id(73)}','${id(10)}','${id(72)}'),('${id(77)}','${id(78)}','${id(76)}')`);
      for (const [location, agreementId, covered] of [[71, 10, 73], [75, 78, 77]]) {
        const setup = json(id(4), `public.get_location_patrol_setup('${id(location)}')`);
        assert.deepEqual(setup.configs, []);
        assert.equal(setup.agreements[0].id, id(agreementId));
        assert.equal(setup.billing_workspaces[0].places[0].id, id(covered));
      }
    });

    await t.test('a future-dated charge-rate change invalidates confirmation even when today has no applicable rate', () => {
      sql(`INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,effective_from)
        VALUES('${id(95)}','${id(1)}','billing','Future rate','hourly',45,'${effective}')`);
      const current = get().billing_workspaces[0].selections[0];
      const amendment = { ...changes, patrol_route_id: id(30), work_unit_id: id(35),
        billing: { source: 'rate_rule', rate_type: 'hourly', billing_unit_code: 'hourly_officer',
          rate_rule_id: id(95), expected_selection_id: current.id, expected_updated_at: current.updated_at } };
      const before = get();
      const plan = preview(amendment);
      sql(`UPDATE public.rate_rules SET amount=99 WHERE id='${id(95)}'`);
      assert.equal(get().version, before.version, 'Today-only workspace is not a proxy for the selected future rate');
      fails(id(4), save(amendment, before.version, plan.preview_fingerprint, id(96)), /changed|reload|stale/i);
    });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
