const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const read = (name) => {
  const file = path.join(__dirname, '../supabase/migrations', name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
};
const priorMigrations = [
  '20261117000200_organization_operating_settings.sql',
  '20261117000300_patrol_catalogues.sql',
  '20261117000400_solar_events.sql',
].map(read);
const migration = read('20261117000500_place_service_terms.sql');
const generatorMigration = read('20261117013747_generator_reads_terms.sql');
const responsibilityMigration = read('20261116045308_location_patrol_responsibility.sql');
const staticMigration = read('20261117022230_place_static_posts.sql');
const lockStart = responsibilityMigration.indexOf('CREATE FUNCTION public.patrol_shift_plan_locked_reason(');
const lockEnd = responsibilityMigration.indexOf('$function$;', lockStart);
assert.ok(lockStart >= 0 && lockEnd > lockStart, 'the patrol evidence lock definition exists');
const patrolEvidenceLock = responsibilityMigration.slice(lockStart, lockEnd + '$function$;'.length)
  .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');

test('place service terms migration declares its surface', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.place_service_term_versions\(/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.patrol_schedule_draw_seeds\(/);
  assert.match(migration, /ALTER TABLE public\.place_service_term_versions ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /ALTER TABLE public\.patrol_schedule_draw_seeds ENABLE ROW LEVEL SECURITY;/);
  for (const fn of ['normalise_place_service_terms', 'place_service_terms_at', 'place_service_drawn_days', 'place_service_window_at',
    'apply_place_service_version', 'roll_place_service_terms', 'get_place_services', 'preview_place_service_change',
    'save_place_service_change', 'decide_place_service_change']) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
  }
  assert.match(migration, /public\.apply_place_static_post_version\(p_version_id\)/);
  assert.match(migration, /cron\.schedule\('place-service-terms-roll', '7 \* \* \* \*', 'SELECT public\.roll_place_service_terms\(\)'\)/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
});

describe('place service terms against disposable PostgreSQL', { skip: process.env.BOB_TEST_POSTGRES !== '1' }, () => {
  const container = `fcm-place-service-terms-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = (sql) => docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres'], sql);
  const scalar = (sql) => docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-qAt', '-U', 'postgres'], sql).trim();
  let created = false;
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const provider = id(1); const client = id(2); const other = id(3);
  const adminA = id(11); const adminB = id(12); const otherAdmin = id(13); const clientAdmin = id(14);
  const harbour = id(24); const harbourZone = id(25); const agreement2 = id(33);
  const location = id(21); const boundedZone = id(22); const bareZone = id(23);
  const agreement = id(31); const route = id(41); const unit = id(42);
  const as = (user) => `SELECT set_config('request.jwt.claim.sub','${user}',false); SET ROLE authenticated;`;
  const reset = 'RESET ROLE;';
  const today = 'fixture.nz_today()';
  const lit = (value) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  const terms = (overrides = {}) => ({
    anchor: { site_id: null, zone_id: boundedZone },
    module_key: 'freedom_camping',
    days: { mode: 'fixed', weekdays: [1, 2, 3, 4, 5, 6, 7] },
    window: { mode: 'solar', start: { anchor: 'sunset', offset_hours: -0.5 }, end: { anchor: 'sunrise', offset_hours: 0.5 } },
    months: [],
    visits_per_shift: 1,
    min_gap_minutes: 60,
    dwell_minutes: 10,
    checks: ['gate_check', 'lock_up'],
    officer_instructions: 'Check the toilets',
    ...overrides,
  });
  const scheduleArg = (schedule) => (schedule ? `'${schedule}'` : 'NULL::uuid');
  const preview = (schedule, kind, value, from = today) =>
    `public.preview_place_service_change('${location}','${agreement}',${scheduleArg(schedule)},'${kind}',${lit(value)},${from})`;
  // Previews and saves in one statement so the fingerprint is fresh.
  const save = (request, schedule, kind, value, from = today, reason = 'Contract variation') =>
    `public.save_place_service_change('${request}','${location}','${agreement}',${scheduleArg(schedule)},'${kind}',${lit(value)},${from},'${reason}',(${preview(schedule, kind, value, from)})->>'preview_fingerprint')`;

  before(async () => {
    docker(['run', '--detach', '--name', container, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { psql('SELECT 1;'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    psql(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE SCHEMA extensions;
      CREATE EXTENSION pgcrypto SCHEMA extensions;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE SCHEMA fixture;
      GRANT USAGE ON SCHEMA fixture TO authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY, parent_organization_id uuid, name text);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, employer_organization_id uuid, role text, display_name text, deactivated_at timestamptz);
      CREATE TABLE public.audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid, action text NOT NULL, target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.locations(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL);
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_organization_id uuid, name text, active boolean NOT NULL DEFAULT true, boundary geometry(Polygon,4326), center_point geometry(Point,4326), location_id uuid);
      CREATE TABLE public.location_zones(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, site_id uuid, name text, boundary geometry(MultiPolygon,4326), center_point geometry(Point,4326), is_active boolean NOT NULL DEFAULT true, is_verification_point boolean NOT NULL DEFAULT false, location_id uuid);
      CREATE TABLE public.module_catalog(module_key text PRIMARY KEY, active boolean NOT NULL DEFAULT true);
      CREATE TABLE public.service_agreements(id uuid PRIMARY KEY, provider_organization_id uuid, client_organization_id uuid, name text, agreement_type text, starts_on date, ends_on date, enabled_modules text[] NOT NULL DEFAULT '{}');
      CREATE TABLE public.service_agreement_locations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_agreement_id uuid, site_id uuid, zone_id uuid, status text, created_by uuid);
      CREATE TABLE public.service_agreement_modules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_agreement_id uuid, module_key text, enabled boolean, UNIQUE(service_agreement_id, module_key));
      CREATE TABLE public.patrol_routes(id uuid PRIMARY KEY, organization_id uuid, is_active boolean);
      CREATE TABLE public.roster_work_units(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, name text NOT NULL, work_unit_type text NOT NULL, service_type text NOT NULL, active boolean NOT NULL DEFAULT true, patrol_route_id uuid, service_agreement_location_id uuid, service_agreement_module_id uuid, workplace_id uuid, team_id uuid, cost_centre_id uuid, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.service_agreement_delivery_schedules(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id), proposal_scope_schedule_id uuid,
        site_id uuid, zone_id uuid, module_key text NOT NULL, capability_key text NOT NULL, work_model text NOT NULL, active_days integer[] NOT NULL,
        visits_per_shift integer NOT NULL, min_gap_between_visits_minutes integer NOT NULL, window_start time, window_end time, response_sla_minutes integer,
        pricing_basis text NOT NULL, rate_rule_id uuid, notes text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
        active_months integer[] NOT NULL DEFAULT '{}', dwell_minutes integer NOT NULL DEFAULT 15, depart_sla_minutes integer, preferred_stop_order integer NOT NULL DEFAULT 0, officer_instructions text,
        CHECK ((site_id IS NOT NULL) <> (zone_id IS NOT NULL)));
      CREATE TABLE public.client_site_patrol_config(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, site_id uuid, patrol_route_id uuid,
        module_key text NOT NULL CHECK (module_key IN ('freedom_camping','parking_enforcement','noise_control','biosecurity','smoke_complaints','static_guarding','access_control','ems','alarm_response','welfare_check','general_patrol')),
        active_days integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}', visits_per_shift integer NOT NULL DEFAULT 1, min_gap_between_visits_minutes integer NOT NULL DEFAULT 60,
        time_window_type text NOT NULL DEFAULT 'fixed' CHECK (time_window_type IN ('fixed','sunrise_sunset','seasonal','as_attended')), window_start time, window_end time,
        sunrise_offset_minutes integer NOT NULL DEFAULT 0, sunset_offset_minutes integer NOT NULL DEFAULT 0, active_months integer[] NOT NULL DEFAULT '{}', dwell_minutes integer NOT NULL DEFAULT 15,
        sla_arrive_within_minutes integer DEFAULT 30, sla_depart_within_minutes integer DEFAULT 45, preferred_stop_order integer NOT NULL DEFAULT 0, officer_instructions text,
        required_actions jsonb NOT NULL DEFAULT '[]', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        zone_id uuid, proposal_scope_schedule_id uuid, delivery_schedule_id uuid UNIQUE REFERENCES public.service_agreement_delivery_schedules(id),
        CHECK (time_window_type = 'as_attended' AND visits_per_shift = 0 AND dwell_minutes = 0 OR time_window_type <> 'as_attended' AND visits_per_shift >= 1 AND dwell_minutes >= 1));
      CREATE TABLE public.patrol_route_stop_modules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, patrol_config_id uuid NOT NULL, module_key text NOT NULL,
        module_config jsonb NOT NULL DEFAULT '{}', is_required boolean NOT NULL DEFAULT true, display_order integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), service_agreement_module_id uuid, service_agreement_location_id uuid, UNIQUE(patrol_config_id, module_key));
      CREATE TABLE public.patrol_config_responsibilities(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, patrol_config_id uuid NOT NULL, patrol_route_id uuid NOT NULL,
        work_unit_id uuid NOT NULL, service_agreement_location_id uuid, service_agreement_module_id uuid, rate_selection_id uuid, effective_from date NOT NULL, effective_to date, superseded_at timestamptz, created_by uuid);
      CREATE TABLE public.shifts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, officer_user_id uuid, service_type text, scheduled_start timestamptz NOT NULL,
        scheduled_end timestamptz NOT NULL, actual_start timestamptz, actual_end timestamptz, status text NOT NULL, patrol_route_id uuid, work_unit_id uuid,
        shift_origin text NOT NULL DEFAULT 'rostered', total_stops integer NOT NULL DEFAULT 0, generated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.shift_stops(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, shift_id uuid NOT NULL, patrol_config_id uuid,
        site_id uuid, zone_id uuid, module_key text NOT NULL, stop_order integer NOT NULL DEFAULT 0, visit_number integer NOT NULL DEFAULT 1,
        is_adhoc boolean NOT NULL DEFAULT false, sla_window_open timestamptz, sla_arrive_by timestamptz NOT NULL, sla_depart_by timestamptz,
        required_dwell_minutes integer NOT NULL DEFAULT 15, officer_instructions text, status text NOT NULL DEFAULT 'pending', sla_status text NOT NULL DEFAULT 'on_track');
      CREATE TABLE public.shift_stop_modules(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, shift_stop_id uuid NOT NULL, module_key text NOT NULL,
        is_required boolean NOT NULL DEFAULT true, service_agreement_module_id uuid, service_agreement_location_id uuid,
        status text NOT NULL DEFAULT 'pending', started_at timestamptz, completed_at timestamptz, result_record_id uuid, outcome text,
        UNIQUE(shift_stop_id,module_key));
      CREATE TABLE public.bob_agentic_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, user_id uuid NOT NULL, action_type text NOT NULL,
        context_page text, context_record_id uuid, context_table text, proposed_payload jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','applied','failed')),
        approved_by uuid, approved_at timestamptz, rejection_reason text, result_record_id uuid, result_table text, error_message text,
        created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz, context_summary text, idempotency_key text, triggered_by uuid);
      -- Live grants authenticated insert/update with org-scoped RLS; the fixture keeps the worst case (no RLS).
      GRANT SELECT, INSERT, UPDATE ON public.bob_agentic_actions TO authenticated;
      CREATE TABLE fixture.generated(shift_id uuid, shift_date date, config_id uuid, at timestamptz DEFAULT clock_timestamp());
      CREATE FUNCTION fixture.nz_today() RETURNS date LANGUAGE sql STABLE AS $fn$ SELECT (now() AT TIME ZONE 'Pacific/Auckland')::date $fn$;
      CREATE FUNCTION public.get_descendant_organizations(org_id uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
        WITH RECURSIVE org_tree AS (SELECT id FROM public.organizations WHERE id = org_id UNION ALL SELECT o.id FROM public.organizations o JOIN org_tree t ON o.parent_organization_id = t.id)
        SELECT coalesce(array_agg(id), array[]::uuid[]) FROM org_tree $fn$;
      CREATE FUNCTION public.can_approve_action(p_user_id uuid, p_action_org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id = p_user_id AND up.deactivated_at IS NULL AND up.role = 'admin' AND p_action_org_id = ANY(public.get_descendant_organizations(up.organization_id))) $fn$;
      CREATE FUNCTION public.is_admin_for_org(target_org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$ SELECT public.can_approve_action(auth.uid(), target_org_id) $fn$;
      CREATE FUNCTION public.user_can_operate_organization(p_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.deactivated_at IS NULL AND p_organization_id = ANY(public.get_descendant_organizations(up.organization_id))) $fn$;
      -- Same logic as the live patrol_window_bounds.
      CREATE FUNCTION public.patrol_window_bounds(p_shift_date date, p_window_start time, p_window_end time, p_shift_start timestamptz, p_shift_end timestamptz)
      RETURNS TABLE(window_open timestamptz, window_close timestamptz) LANGUAGE plpgsql IMMUTABLE AS $fn$
      DECLARE v_open timestamptz; v_close timestamptz;
      BEGIN
        IF p_window_start IS NULL THEN RETURN QUERY SELECT NULL::timestamptz, NULL::timestamptz; RETURN; END IF;
        v_open := (p_shift_date + p_window_start) AT TIME ZONE 'Pacific/Auckland';
        v_close := CASE WHEN p_window_end IS NOT NULL THEN (p_shift_date + p_window_end) AT TIME ZONE 'Pacific/Auckland' END;
        IF v_close IS NOT NULL AND v_close <= v_open THEN v_close := v_close + interval '1 day'; END IF;
        IF p_shift_start IS NOT NULL AND p_shift_end IS NOT NULL AND v_close IS NOT NULL AND NOT (v_open < p_shift_end AND p_shift_start < v_close)
           AND (v_open - interval '1 day') < p_shift_end AND p_shift_start < (v_close - interval '1 day') THEN
          v_open := v_open - interval '1 day'; v_close := v_close - interval '1 day';
        END IF;
        RETURN QUERY SELECT v_open, v_close;
      END $fn$;
      CREATE FUNCTION public.patrol_shift_work_unit_id(p_shift_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT work_unit_id FROM public.shifts WHERE id = p_shift_id $fn$;
      CREATE FUNCTION public.patrol_config_serves(p_config_id uuid, p_date date, p_route_id uuid, p_work_unit_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$
        SELECT coalesce(CASE WHEN r.id IS NULL THEN c.patrol_route_id = p_route_id ELSE r.patrol_route_id = p_route_id AND (p_work_unit_id IS NULL OR r.work_unit_id = p_work_unit_id) END, false)
        FROM public.client_site_patrol_config c
        LEFT JOIN LATERAL (SELECT x.* FROM public.patrol_config_responsibilities x WHERE x.patrol_config_id = c.id AND x.superseded_at IS NULL
          AND x.effective_from <= p_date AND (x.effective_to IS NULL OR x.effective_to >= p_date) ORDER BY x.effective_from DESC LIMIT 1) r ON true
        WHERE c.id = p_config_id $fn$;
      CREATE FUNCTION public.patrol_shift_plan_locked_reason(p_shift_id uuid) RETURNS text LANGUAGE sql STABLE AS $fn$
        SELECT CASE WHEN s.status NOT IN ('scheduled','published','accepted') OR s.actual_start IS NOT NULL THEN 'Shift already started or is no longer an unstarted plan'
          WHEN s.scheduled_start <= statement_timestamp() THEN 'Scheduled start has passed' END FROM public.shifts s WHERE s.id = p_shift_id $fn$;
      CREATE FUNCTION public.generate_shift_stops_internal(p_shift_id uuid, p_shift_date date, p_config_id uuid) RETURNS integer LANGUAGE plpgsql AS $fn$
      BEGIN INSERT INTO fixture.generated(shift_id, shift_date, config_id) VALUES (p_shift_id, p_shift_date, p_config_id); RETURN 1; END $fn$;
      CREATE FUNCTION fixture.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $fn$;
      CREATE FUNCTION fixture.raises(command text, expected text, expected_message text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE = expected AND (expected_message IS NULL OR SQLERRM = expected_message) THEN RETURN; END IF;
          RAISE;
        END;
        RAISE EXCEPTION 'Expected SQLSTATE %',expected;
      END $fn$;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA fixture TO authenticated;
      INSERT INTO public.organizations VALUES('${provider}',NULL,'Provider'),('${client}',NULL,'Council'),('${other}',NULL,'Other provider');
      INSERT INTO public.user_profiles VALUES
        ('${adminA}','${provider}','${provider}','admin','Alex Admin',NULL),
        ('${adminB}','${provider}','${provider}','admin','Bea Admin',NULL),
        ('${otherAdmin}','${other}','${other}','admin','Olly Other',NULL),
        ('${clientAdmin}','${client}','${client}','admin','Cara Council',NULL);
      INSERT INTO public.locations VALUES('${location}','${client}','Lake reserve');
      INSERT INTO public.location_zones(id, organization_id, name, boundary, location_id) VALUES
        ('${boundedZone}','${client}','Campground',ST_GeomFromText('MULTIPOLYGON(((174.7 -41.2,174.8 -41.2,174.8 -41.3,174.7 -41.3,174.7 -41.2)))',4326),'${location}'),
        ('${bareZone}','${client}','Boat ramp',NULL,'${location}');
      INSERT INTO public.module_catalog VALUES('freedom_camping',true),('patrol',true),('static_guarding',true),('parking_enforcement',true);
      INSERT INTO public.service_agreements VALUES('${agreement}','${provider}','${client}','Council patrols','operational',NULL,NULL,'{}');
      INSERT INTO public.patrol_routes VALUES('${route}','${provider}',true);
      INSERT INTO public.roster_work_units(id, organization_id, name, work_unit_type, service_type, patrol_route_id) VALUES('${unit}','${provider}','Night run','patrol','patrol','${route}');
      ${priorMigrations.join('\n')}
      ${migration}
    `);
  });

  after(() => { if (created) docker(['rm', '--force', container]); });

  let solarSchedule;

  test('save without approval applies a dated version', () => {
    const request = randomUUID();
    psql(`
      ${as(adminA)}
      CREATE TEMP TABLE saved AS SELECT ${save(request, null, 'create', terms())} AS r;
      SELECT fixture.check((SELECT r->>'status'='approved' AND (r->>'applied_effective_from')::date=${today} AND r->>'delivery_schedule_id' IS NOT NULL FROM saved),'the change is approved and dated today');
      ${reset}
      SELECT fixture.check((SELECT s.active AND s.zone_id='${boundedZone}' AND s.module_key='freedom_camping' AND s.capability_key='freedom_camping' AND s.active_days='{1,2,3,4,5,6,7}' AND s.window_start IS NULL AND s.dwell_minutes=10
        FROM public.service_agreement_delivery_schedules s WHERE s.id=(SELECT (r->>'delivery_schedule_id')::uuid FROM saved)),'the schedule is live');
      SELECT fixture.check((SELECT c.active AND c.time_window_type='sunrise_sunset' AND c.sunset_offset_minutes=-30 AND c.sunrise_offset_minutes=30 AND c.required_actions='["gate_check","lock_up"]'::jsonb AND c.organization_id='${provider}'
        FROM public.client_site_patrol_config c WHERE c.delivery_schedule_id=(SELECT (r->>'delivery_schedule_id')::uuid FROM saved)),'the config carries a sunrise/sunset window and the checks');
      SELECT fixture.check(EXISTS(SELECT 1 FROM public.service_agreement_modules WHERE service_agreement_id='${agreement}' AND module_key='freedom_camping' AND enabled),'the module is on the agreement');
      SELECT fixture.check(EXISTS(SELECT 1 FROM public.service_agreement_locations WHERE service_agreement_id='${agreement}' AND zone_id='${boundedZone}' AND status='active'),'the place is on the agreement');
      SELECT fixture.check(EXISTS(SELECT 1 FROM public.patrol_schedule_draw_seeds WHERE delivery_schedule_id=(SELECT (r->>'delivery_schedule_id')::uuid FROM saved)),'a draw seed exists');
      SELECT fixture.check(EXISTS(SELECT 1 FROM public.patrol_route_stop_modules m JOIN public.client_site_patrol_config c ON c.id=m.patrol_config_id WHERE c.delivery_schedule_id=(SELECT (r->>'delivery_schedule_id')::uuid FROM saved) AND m.module_key='freedom_camping'),'the stop module exists');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='place_service_change_approved' AND metadata->>'client_request_id'='${request}'),'the change is audited');
      SELECT fixture.check((SELECT public.place_service_terms_at((r->>'delivery_schedule_id')::uuid, ${today})->'window'->>'mode'='solar' FROM saved),'the terms are effective today');
    `);
    solarSchedule = scalar(`SELECT delivery_schedule_id FROM public.place_service_term_versions WHERE client_request_id='${request}';`);
    // A responsible run and a future shift so the update has a shift to regenerate.
    psql(`
      INSERT INTO public.patrol_config_responsibilities(organization_id, patrol_config_id, patrol_route_id, work_unit_id, effective_from)
        SELECT '${provider}', c.id, '${route}', '${unit}', ${today} FROM public.client_site_patrol_config c WHERE c.delivery_schedule_id='${solarSchedule}';
      INSERT INTO public.shifts(organization_id, scheduled_start, scheduled_end, status, patrol_route_id, work_unit_id)
        VALUES('${provider}', ((${today} + 1) + time '20:00') AT TIME ZONE 'Pacific/Auckland', ((${today} + 2) + time '04:00') AT TIME ZONE 'Pacific/Auckland', 'scheduled', '${route}', '${unit}');
      CREATE TABLE fixture.first_version AS SELECT * FROM public.place_service_term_versions WHERE client_request_id='${request}';
    `);
    const update = randomUUID();
    psql(`
      ${as(adminA)}
      SELECT fixture.check((SELECT jsonb_array_length(r->'affected')=1 AND r->'affected'->0->>'work_unit_name'='Night run' AND jsonb_array_length(r->'next_days')=28 AND NOT (r->>'needs_approval')::boolean
        FROM (SELECT ${preview(solarSchedule, 'update', terms({ window: { mode: 'fixed', start: '22:00', end: '06:00' } }))} AS r) p),'the preview lists the future shift and 28 days');
      SELECT ${save(update, solarSchedule, 'update', terms({ window: { mode: 'fixed', start: '22:00', end: '06:00' } }))};
      ${reset}
      SELECT fixture.check((SELECT count(*)=2 FROM public.place_service_term_versions WHERE delivery_schedule_id='${solarSchedule}'),'the update writes a second version');
      SELECT fixture.check((SELECT to_jsonb(v)=to_jsonb(f) FROM public.place_service_term_versions v, fixture.first_version f WHERE v.id=f.id),'the first version is unchanged');
      SELECT fixture.check((SELECT c.time_window_type='fixed' AND c.window_start='22:00' AND c.window_end='06:00' FROM public.client_site_patrol_config c WHERE c.delivery_schedule_id='${solarSchedule}'),'the update is projected');
      SELECT fixture.check((SELECT count(*)>=1 FROM fixture.generated g JOIN public.client_site_patrol_config c ON c.id=g.config_id WHERE c.delivery_schedule_id='${solarSchedule}'),'pending stops are regenerated');
      SELECT fixture.check(public.roll_place_service_terms()=0,'the roll changes nothing already projected');
    `);
  });

  test('versions are immutable', () => {
    psql(`
      SELECT fixture.raises($q$ UPDATE public.place_service_term_versions SET terms='{}' WHERE delivery_schedule_id='${solarSchedule}' $q$,'P0001');
      SELECT fixture.raises($q$ DELETE FROM public.place_service_term_versions WHERE delivery_schedule_id='${solarSchedule}' $q$,'P0001');
    `);
  });

  test('sunrise schedule on an anchor with no point is refused', () => {
    const request = randomUUID();
    psql(`
      ${as(adminA)}
      SELECT fixture.raises($q$ SELECT ${save(request, null, 'create', terms({ anchor: { site_id: null, zone_id: bareZone } }))} $q$,'P0001','Draw the boundary for this place before using sunrise or sunset times');
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms({ anchor: { site_id: boundedZone, zone_id: boundedZone } }))} $q$,'P0001','Choose one place: a site or an area');
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms({ window: { mode: 'solar', start: { anchor: 'sunset', offset_hours: 0.1 }, end: { anchor: 'sunrise', offset_hours: 0 } } }))} $q$,'P0001','Offsets must be in quarter hours between -12 and 12');
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms({ checks: ['gate_check', 'made_up'] }))} $q$,'P0001','Unknown or inactive check: made_up');
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms({ months: [13] }))} $q$,'P0001','Months must be between 1 and 12');
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms({ days: { mode: 'fixed', weekdays: [] } }))} $q$,'P0001','Choose at least one day of the week (Monday = 1)');
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms({ module_key: 'static_guarding' }))} $q$,'P0001','Static guarding terms are not available yet');
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms(), `${today} - 1`)} $q$,'P0001','Effective from cannot be in the past');
      ${reset}
      SELECT fixture.check(NOT EXISTS(SELECT 1 FROM public.place_service_term_versions WHERE client_request_id='${request}'),'no version row is written');
    `);
  });

  test('random draw is deterministic and within allowed days', () => {
    const request = randomUUID();
    const random = terms({ module_key: 'patrol', days: { mode: 'random', per_week: 3, allowed: [1, 2, 3, 4, 5, 6, 7] }, window: { mode: 'any' } });
    psql(`
      ${as(adminA)}
      SELECT ${save(request, null, 'create', random)};
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms({ days: { mode: 'random', per_week: 8, allowed: [1, 2, 3, 4, 5, 6, 7] } }))} $q$,'P0001','Random days per week must be between 1 and the number of allowed days');
      ${reset}
      CREATE TABLE fixture.draws AS
        SELECT w, public.place_service_drawn_days(v.delivery_schedule_id, DATE '2026-01-05' + w * 7, '{1,2,3,4,5,6,7}', 3) AS days,
               public.place_service_drawn_days(v.delivery_schedule_id, DATE '2026-01-09' + w * 7, '{1,2,3,4,5,6,7}', 3) AS again
        FROM public.place_service_term_versions v, generate_series(0, 9) w WHERE v.client_request_id='${request}';
      SELECT fixture.check((SELECT bool_and(days=again AND cardinality(days)=3 AND days <@ '{1,2,3,4,5,6,7}'::int[]) FROM fixture.draws),'the same week draws the same three allowed days');
      SELECT fixture.check((SELECT count(DISTINCT days)>=2 FROM fixture.draws),'weeks draw differently');
      SELECT fixture.check((SELECT s.module_key='general_patrol' AND s.capability_key='patrol' AND c.module_key='general_patrol' FROM public.service_agreement_delivery_schedules s JOIN public.client_site_patrol_config c ON c.delivery_schedule_id=s.id
        JOIN public.place_service_term_versions v ON v.delivery_schedule_id=s.id WHERE v.client_request_id='${request}'),'patrol maps to the general patrol toolset');
      SELECT fixture.check((SELECT NOT delivered_as_visits AND toolset_key='unprofiled_module' FROM public.place_service_module_mapping('unprofiled_module')),'a module without a profile is not a place-visit service');
    `);
  });

  test('seed is not readable by authenticated', () => {
    psql(`
      ${as(adminA)}
      SELECT fixture.raises($q$ SELECT * FROM public.patrol_schedule_draw_seeds $q$,'42501');
      SELECT fixture.raises($q$ SELECT public.place_service_drawn_days('${solarSchedule}', ${today}, '{1,2,3}', 1) $q$,'42501');
      SELECT fixture.raises($q$ SELECT public.apply_place_service_version(gen_random_uuid()) $q$,'42501');
      SELECT fixture.raises($q$ SELECT public.roll_place_service_terms() $q$,'42501');
      ${reset}
      SELECT fixture.check(NOT has_function_privilege('anon','public.get_place_services(uuid)','EXECUTE'),'anon cannot read place services');
      SELECT fixture.check(NOT has_table_privilege('authenticated','public.place_service_term_versions','UPDATE'),'versions are not written through the Data API');
    `);
  });

  test('second approval: pending until another admin approves', () => {
    const request = randomUUID(); const decideA = randomUUID(); const decideB = randomUUID();
    psql(`
      INSERT INTO public.organization_operating_settings(organization_id, place_changes_need_second_approver) VALUES('${provider}', true);
      CREATE TABLE fixture.schedule_count AS SELECT count(*) AS n FROM public.service_agreement_delivery_schedules;
      ${as(adminA)}
      CREATE TEMP TABLE pending AS SELECT ${save(request, null, 'create', terms({ module_key: 'parking_enforcement', window: { mode: 'fixed', start: '08:00', end: '17:00' } }))} AS r;
      SELECT fixture.check((SELECT r->>'status'='pending' AND r->>'delivery_schedule_id' IS NULL FROM pending),'the change waits');
      ${reset}
      SELECT fixture.check((SELECT count(*)=1 FROM public.bob_agentic_actions a JOIN public.place_service_term_versions v ON v.approval_action_id=a.id
        WHERE v.client_request_id='${request}' AND a.status='pending' AND a.action_type='place_service_change' AND a.organization_id='${provider}' AND a.user_id='${adminA}' AND a.triggered_by='${adminA}'
          AND a.context_table='place_service_term_versions' AND a.proposed_payload->>'version_id'=v.id::text),'a pending approval action exists');
      SELECT fixture.check((SELECT n FROM fixture.schedule_count)=(SELECT count(*) FROM public.service_agreement_delivery_schedules),'no schedule is written yet');
      ${as(adminA)}
      SELECT fixture.check((SELECT jsonb_array_length(public.get_place_services('${location}')->'services') >= 1),'the requester sees services');
      SELECT fixture.raises($q$ UPDATE public.bob_agentic_actions SET proposed_payload = proposed_payload || '{"terms":{}}' WHERE action_type='place_service_change' $q$,'42501','Place service approvals can only change through their own functions');
      SELECT fixture.raises($q$ UPDATE public.bob_agentic_actions SET status='rejected' WHERE action_type='place_service_change' $q$,'42501');
      SELECT fixture.raises($q$ INSERT INTO public.bob_agentic_actions(organization_id,user_id,triggered_by,action_type,status,proposed_payload) VALUES('${provider}','${adminA}','${adminA}','place_service_change','pending','{}') $q$,'42501');
      SELECT fixture.raises($q$ SELECT public.decide_place_service_change('${decideA}',(SELECT (r->>'version_id')::uuid FROM pending),'approve',NULL) $q$,'P0001','You cannot approve your own change');
      ${as(adminB)}
      SELECT fixture.check((SELECT public.decide_place_service_change('${decideB}',(SELECT id FROM public.place_service_term_versions WHERE client_request_id='${request}'),'approve','Checked')->>'status'='approved'),'B approves');
      ${reset}
      SELECT fixture.check((SELECT v.status='approved' AND v.decided_by='${adminB}' AND v.applied_effective_from=${today} AND v.delivery_schedule_id IS NOT NULL FROM public.place_service_term_versions v WHERE v.client_request_id='${request}'),'the version is approved and applied');
      SELECT fixture.check((SELECT a.status='applied' AND a.approved_by='${adminB}' AND a.approved_at IS NOT NULL FROM public.bob_agentic_actions a JOIN public.place_service_term_versions v ON v.approval_action_id=a.id WHERE v.client_request_id='${request}'),'the approval action is applied');
      SELECT fixture.check((SELECT s.active AND s.window_start='08:00' FROM public.service_agreement_delivery_schedules s JOIN public.place_service_term_versions v ON v.delivery_schedule_id=s.id WHERE v.client_request_id='${request}'),'the schedule is live after approval');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='place_service_change_pending' AND metadata->>'client_request_id'='${request}'),'the pending change is audited');
    `);
  });

  test('late approval applies from the approval date', () => {
    const decide = randomUUID();
    const version = randomUUID();
    psql(`
      INSERT INTO public.place_service_term_versions(id, organization_id, service_agreement_id, location_id, delivery_schedule_id, service_kind, change_kind, effective_from, terms, status, requested_by, client_request_id, request_fingerprint)
        SELECT '${version}', '${provider}', '${agreement}', '${location}', '${solarSchedule}', 'patrol', 'update', ${today} - 1, terms || '{"dwell_minutes":20}', 'pending', '${adminA}', gen_random_uuid(), 'fixture'
        FROM public.place_service_term_versions WHERE delivery_schedule_id='${solarSchedule}' ORDER BY requested_at DESC LIMIT 1;
      ${as(adminB)}
      SELECT fixture.raises($q$ SELECT public.decide_place_service_change('${randomUUID()}','${version}','reject',NULL) $q$,'P0001');
      SELECT public.decide_place_service_change('${decide}','${version}','approve',NULL);
      SELECT fixture.check((SELECT (public.decide_place_service_change('${decide}','${version}','approve',NULL)->>'replayed')::boolean),'a decision replay returns the stored result');
      ${reset}
      SELECT fixture.check((SELECT applied_effective_from=${today} AND effective_from=${today} - 1 FROM public.place_service_term_versions WHERE id='${version}'),'a late approval applies from today');
      SELECT fixture.check((SELECT dwell_minutes=20 FROM public.client_site_patrol_config WHERE delivery_schedule_id='${solarSchedule}'),'the approved terms are live');
    `);
  });

  test('stale preview is rejected', () => {
    const request = randomUUID();
    const value = terms({ window: { mode: 'fixed', start: '21:00', end: '05:00' } });
    psql(`
      DELETE FROM public.organization_operating_settings WHERE organization_id='${provider}';
      ${as(adminA)}
      CREATE TEMP TABLE stale AS SELECT ${preview(solarSchedule, 'update', value)} AS r;
      ${reset}
      UPDATE public.patrol_route_stop_modules SET display_order = display_order + 1 WHERE patrol_config_id=(SELECT id FROM public.client_site_patrol_config WHERE delivery_schedule_id='${solarSchedule}');
      ${as(adminA)}
      SELECT fixture.raises($q$ SELECT public.save_place_service_change('${request}','${location}','${agreement}','${solarSchedule}','update',${lit(value)},${today},'Variation',(SELECT r->>'preview_fingerprint' FROM stale)) $q$,'40001','Place services changed; reload and confirm a fresh preview');
    `);
  });

  test('replay', () => {
    const request = randomUUID();
    const value = terms({ window: { mode: 'fixed', start: '23:00', end: '05:00' } });
    psql(`
      ${as(adminA)}
      CREATE TEMP TABLE first_save AS SELECT ${save(request, solarSchedule, 'update', value)} AS r;
      SELECT fixture.check((SELECT (r2->>'replayed')::boolean AND r2->>'version_id'=r->>'version_id' FROM first_save, (SELECT ${save(request, solarSchedule, 'update', value)} AS r2) x),'a replay returns the stored result');
      SELECT fixture.raises($q$ SELECT ${save(request, solarSchedule, 'update', terms({ dwell_minutes: 30 }))} $q$,'42501');
      ${reset}
      SELECT fixture.check((SELECT count(*)=1 FROM public.place_service_term_versions WHERE client_request_id='${request}'),'a replay writes nothing');
    `);
  });

  test('get_place_services hides agreements of other providers', () => {
    psql(`
      ${as(otherAdmin)}
      SELECT fixture.check((SELECT NOT (r->>'can_manage')::boolean AND jsonb_array_length(r->'agreements')=0 AND jsonb_array_length(r->'services')=0 FROM (SELECT public.get_place_services('${location}') AS r) x),'an unrelated admin sees nothing');
      SELECT fixture.check((SELECT count(*)=0 FROM public.place_service_term_versions),'an unrelated admin reads no versions');
      ${as(adminA)}
      SELECT fixture.check((SELECT (r->>'can_manage')::boolean AND jsonb_array_length(r->'agreements')=1 AND jsonb_array_length(r->'anchors')=2
        AND (SELECT bool_or((a->>'has_point')::boolean) AND NOT bool_and((a->>'has_point')::boolean) FROM jsonb_array_elements(r->'anchors') a)
        AND jsonb_array_length(r->'check_types')=8 AND jsonb_array_length(r->'seasons')=4
        FROM (SELECT public.get_place_services('${location}') AS r) x),'the provider admin sees the location');
      SELECT fixture.check((SELECT s->'responsibility'->>'work_unit_name'='Night run' FROM jsonb_array_elements(public.get_place_services('${location}')->'services') s WHERE s->>'delivery_schedule_id'='${solarSchedule}'),'the responsible run is listed');
    `);
  });

  test('workspace check types expose the IDs needed to manage the provider catalogue', () => {
    psql(`
      ${as(adminA)}
      CREATE TEMP TABLE check_receipt AS
        SELECT public.manage_patrol_check_type('${randomUUID()}','create','${provider}',NULL,
          'Fixture gate check',false,false) AS r;
      SELECT fixture.check(EXISTS(
        SELECT 1 FROM jsonb_array_elements(public.get_place_services('${location}')->'check_types') item
        WHERE item->>'id'=(SELECT r->>'check_type_id' FROM check_receipt)
          AND item->>'label'='Fixture gate check' AND (item->>'is_global')::boolean=false
      ),'provider check exposes its real ID');
      SELECT fixture.check(EXISTS(
        SELECT 1 FROM jsonb_array_elements(public.get_place_services('${location}')->'check_types') item
        JOIN public.patrol_check_types t ON t.id=(item->>'id')::uuid
        WHERE item->>'check_key'='gate_check' AND t.organization_id IS NULL AND (item->>'is_global')::boolean
      ),'global check exposes its real ID');
      SELECT public.manage_patrol_check_type('${randomUUID()}','deactivate','${provider}',(SELECT (r->>'check_type_id')::uuid FROM check_receipt),NULL,NULL,NULL);
      SELECT fixture.check(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_place_services('${location}')->'check_types') item
        WHERE item->>'id'=(SELECT r->>'check_type_id' FROM check_receipt)),'an inactive check is not offered');
      SELECT fixture.check(EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_place_services('${location}')->'inactive_check_types') item
        WHERE item->>'id'=(SELECT r->>'check_type_id' FROM check_receipt) AND item->>'label'='Fixture gate check'),'an inactive own check is listed for reactivation');
      SELECT public.manage_patrol_check_type('${randomUUID()}','reactivate','${provider}',(SELECT (r->>'check_type_id')::uuid FROM check_receipt),NULL,NULL,NULL);
      ${reset}
    `);
  });

  const insertSchedule = (scheduleId, agreementId, zoneId) =>
    `INSERT INTO public.service_agreement_delivery_schedules(id, service_agreement_id, zone_id, module_key, capability_key, work_model, active_days, visits_per_shift, min_gap_between_visits_minutes, pricing_basis)
       VALUES('${scheduleId}','${agreementId}','${zoneId}','freedom_camping','freedom_camping','scheduled_patrol','{1,2,3}',1,60,'standard_rate_rule');`;

  test('schedules of another agreement or location and client admins are refused', () => {
    const foreignAgreement = randomUUID(); const foreignLocation = randomUUID();
    psql(`
      INSERT INTO public.service_agreements VALUES('${agreement2}','${provider}','${client}','Second contract','operational',NULL,NULL,'{}');
      INSERT INTO public.locations VALUES('${harbour}','${client}','Harbour');
      INSERT INTO public.location_zones(id, organization_id, name, location_id) VALUES('${harbourZone}','${client}','Wharf','${harbour}');
      ${insertSchedule(foreignAgreement, agreement2, boundedZone)}
      ${insertSchedule(foreignLocation, agreement, harbourZone)}
      ${as(adminA)}
      SELECT fixture.raises($q$ SELECT ${preview(foreignAgreement, 'update', terms())} $q$,'P0002','Service not found at this location');
      SELECT fixture.raises($q$ SELECT ${preview(foreignLocation, 'update', terms())} $q$,'P0002','Service not found at this location');
      SELECT fixture.raises($q$ SELECT public.save_place_service_change('${randomUUID()}','${location}','${agreement}','${foreignLocation}','update',${lit(terms())},${today},'x','x') $q$,'P0002','Service not found at this location');
      ${as(clientAdmin)}
      SELECT fixture.raises($q$ SELECT ${preview(null, 'create', terms())} $q$,'42501','Provider administrator required');
      SELECT fixture.raises($q$ SELECT public.save_place_service_change('${randomUUID()}','${location}','${agreement}',NULL,'create',${lit(terms())},${today},'x','x') $q$,'42501','Provider administrator required');
    `);
  });

  let pendingCreate;
  test('a place cannot get the same service twice', () => {
    const value = terms({ anchor: { site_id: null, zone_id: bareZone }, module_key: 'parking_enforcement', window: { mode: 'fixed', start: '08:00', end: '17:00' } });
    const request = randomUUID();
    psql(`
      ${as(adminA)}
      SELECT fixture.raises($q$ SELECT ${save(randomUUID(), null, 'create', terms())} $q$,'P0001','This place already has that service; edit it instead');
      ${reset}
      INSERT INTO public.organization_operating_settings(organization_id, place_changes_need_second_approver) VALUES('${provider}', true)
        ON CONFLICT (organization_id) DO UPDATE SET place_changes_need_second_approver = true;
      ${as(adminA)}
      SELECT fixture.check((SELECT ${save(request, null, 'create', value)}->>'status'='pending'),'the first create waits');
      SELECT fixture.raises($q$ SELECT ${save(randomUUID(), null, 'create', value)} $q$,'P0001','This place already has that service; edit it instead');
    `);
    pendingCreate = scalar(`SELECT id FROM public.place_service_term_versions WHERE client_request_id='${request}';`);
  });

  test('reject path', () => {
    psql(`
      ${as(clientAdmin)}
      SELECT fixture.raises($q$ SELECT public.decide_place_service_change('${randomUUID()}','${pendingCreate}','reject','No') $q$,'42501');
      ${as(adminB)}
      SELECT fixture.raises($q$ SELECT public.decide_place_service_change('${randomUUID()}','${pendingCreate}','reject',' ') $q$,'P0001','Give a reason for rejecting this change');
      SELECT fixture.check((SELECT public.decide_place_service_change('${randomUUID()}','${pendingCreate}','reject','Not in the contract')->>'status'='rejected'),'B rejects');
      ${reset}
      SELECT fixture.check((SELECT v.status='rejected' AND v.decided_by='${adminB}' AND v.decision_reason='Not in the contract' AND v.applied_effective_from IS NULL AND v.delivery_schedule_id IS NULL
        FROM public.place_service_term_versions v WHERE v.id='${pendingCreate}'),'the version is rejected');
      SELECT fixture.check((SELECT a.status='rejected' AND a.rejection_reason='Not in the contract' FROM public.bob_agentic_actions a JOIN public.place_service_term_versions v ON v.approval_action_id=a.id WHERE v.id='${pendingCreate}'),'the approval action is rejected with the reason');
      SELECT fixture.check(NOT EXISTS(SELECT 1 FROM public.service_agreement_delivery_schedules WHERE zone_id='${bareZone}' AND module_key='parking_enforcement'),'no schedule is written');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='place_service_change_rejected' AND metadata->>'version_id'='${pendingCreate}'),'the rejection is audited');
    `);
  });

  test('withdraw path', () => {
    const request = randomUUID(); const withdraw = randomUUID();
    const value = terms({ anchor: { site_id: null, zone_id: bareZone }, module_key: 'parking_enforcement', window: { mode: 'fixed', start: '08:00', end: '17:00' } });
    psql(`
      ${as(adminA)}
      CREATE TEMP TABLE to_withdraw AS SELECT ${save(request, null, 'create', value)} AS r;
      SELECT fixture.check((SELECT r->>'status'='pending' FROM to_withdraw),'the change waits');
      ${as(adminB)}
      SELECT fixture.raises($q$ SELECT public.decide_place_service_change('${randomUUID()}',(SELECT (r->>'version_id')::uuid FROM to_withdraw),'withdraw',NULL) $q$,'42501','Only the person who asked for this change can withdraw it');
      ${as(adminA)}
      SELECT fixture.check((SELECT public.decide_place_service_change('${withdraw}',(SELECT (r->>'version_id')::uuid FROM to_withdraw),'withdraw',NULL)->>'status'='withdrawn'),'the requester withdraws');
      SELECT fixture.check((SELECT (public.decide_place_service_change('${withdraw}',(SELECT (r->>'version_id')::uuid FROM to_withdraw),'withdraw',NULL)->>'replayed')::boolean),'a withdrawal replay returns the stored result');
      ${as(adminB)}
      SELECT fixture.raises($q$ SELECT public.decide_place_service_change('${randomUUID()}',(SELECT (r->>'version_id')::uuid FROM to_withdraw),'approve',NULL) $q$,'P0001','This change has already been decided');
      ${reset}
      SELECT fixture.check((SELECT v.status='withdrawn' AND v.decided_by='${adminA}' AND v.applied_effective_from IS NULL AND v.delivery_schedule_id IS NULL
        FROM public.place_service_term_versions v WHERE v.client_request_id='${request}'),'the version is withdrawn');
      SELECT fixture.check((SELECT a.status='rejected' AND a.rejection_reason='Withdrawn by the person who asked for it' FROM public.bob_agentic_actions a JOIN public.place_service_term_versions v ON v.approval_action_id=a.id WHERE v.client_request_id='${request}'),'the approval action leaves the queue');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='place_service_change_withdrawn' AND metadata->>'client_request_id'='${withdraw}'),'the withdrawal is audited');
      SELECT fixture.check(NOT EXISTS(SELECT 1 FROM public.service_agreement_delivery_schedules WHERE zone_id='${bareZone}' AND module_key='parking_enforcement'),'no schedule is written');
    `);
  });

  test('second approval on an update leaves the live terms until approved', () => {
    const request = randomUUID();
    psql(`
      CREATE TABLE fixture.before_update AS SELECT dwell_minutes, time_window_type, window_start FROM public.client_site_patrol_config WHERE delivery_schedule_id='${solarSchedule}';
      ${as(adminA)}
      SELECT fixture.check((SELECT ${save(request, solarSchedule, 'update', terms({ dwell_minutes: 25 }))}->>'status'='pending'),'the update waits');
      ${reset}
      SELECT fixture.check((SELECT c.dwell_minutes=b.dwell_minutes AND c.dwell_minutes<>25 AND c.time_window_type=b.time_window_type AND c.window_start IS NOT DISTINCT FROM b.window_start
        FROM public.client_site_patrol_config c, fixture.before_update b WHERE c.delivery_schedule_id='${solarSchedule}'),'the live config is unchanged while pending');
      UPDATE public.patrol_check_types SET active = false WHERE organization_id IS NULL AND check_key = 'lock_up';
      ${as(adminB)}
      SELECT fixture.raises($q$ SELECT public.decide_place_service_change('${randomUUID()}',(SELECT id FROM public.place_service_term_versions WHERE client_request_id='${request}'),'approve',NULL) $q$,'P0001','Unknown or inactive check: lock_up');
      ${reset}
      UPDATE public.patrol_check_types SET active = true WHERE organization_id IS NULL AND check_key = 'lock_up';
      SELECT fixture.check((SELECT status='pending' FROM public.place_service_term_versions WHERE client_request_id='${request}'),'a refused approval leaves the change pending');
      ${as(adminB)}
      SELECT public.decide_place_service_change('${randomUUID()}',(SELECT id FROM public.place_service_term_versions WHERE client_request_id='${request}'),'approve',NULL);
      ${reset}
      SELECT fixture.check((SELECT dwell_minutes=25 AND time_window_type='sunrise_sunset' FROM public.client_site_patrol_config WHERE delivery_schedule_id='${solarSchedule}'),'the approved update is live');
      DELETE FROM public.organization_operating_settings WHERE organization_id='${provider}';
    `);
  });

  test('a dated module change waits for its date', () => {
    const create = randomUUID(); const update = randomUUID();
    const fixed = { mode: 'fixed', start: '08:00', end: '17:00' };
    psql(`
      ${as(adminA)}
      SELECT ${save(create, null, 'create', terms({ anchor: { site_id: null, zone_id: bareZone }, window: fixed }))};
      ${reset}
    `);
    const bareSchedule = scalar(`SELECT delivery_schedule_id FROM public.place_service_term_versions WHERE client_request_id='${create}';`);
    const activeModules = `(SELECT coalesce(array_agg(m.module_key ORDER BY m.module_key), '{}') FROM public.patrol_route_stop_modules m JOIN public.client_site_patrol_config c ON c.id=m.patrol_config_id WHERE c.delivery_schedule_id='${bareSchedule}' AND m.active)`;
    psql(`
      SELECT fixture.check(${activeModules}='{freedom_camping}','the new service has one stop module');
      ${as(adminA)}
      SELECT ${save(update, bareSchedule, 'update', terms({ anchor: { site_id: null, zone_id: bareZone }, module_key: 'parking_enforcement', window: fixed }), `${today} + 3`)};
      ${reset}
      SELECT fixture.check(${activeModules}='{freedom_camping}','stop modules are unchanged before the date');
      SELECT fixture.check(NOT EXISTS(SELECT 1 FROM public.patrol_route_stop_modules m JOIN public.client_site_patrol_config c ON c.id=m.patrol_config_id WHERE c.delivery_schedule_id='${bareSchedule}' AND m.module_key='parking_enforcement'),'the new toolset is not on the stop yet');
      SELECT fixture.check((SELECT module_key='freedom_camping' FROM public.service_agreement_delivery_schedules WHERE id='${bareSchedule}'),'the schedule keeps its module before the date');
      CREATE OR REPLACE FUNCTION public.place_service_today() RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp
        AS $fn$ select (clock_timestamp() at time zone 'Pacific/Auckland')::date + 3 $fn$;
      SELECT fixture.check(public.roll_place_service_terms() >= 1,'the roll projects the dated change');
      CREATE OR REPLACE FUNCTION public.place_service_today() RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp
        AS $fn$ select (clock_timestamp() at time zone 'Pacific/Auckland')::date $fn$;
      SELECT fixture.check(${activeModules}='{parking_enforcement}','exactly one active stop module after the date');
      SELECT fixture.check((SELECT m.service_agreement_location_id=l.id AND m.service_agreement_module_id=sam.id
        FROM public.patrol_route_stop_modules m JOIN public.client_site_patrol_config c ON c.id=m.patrol_config_id
        JOIN public.service_agreement_locations l ON l.service_agreement_id='${agreement}' AND l.zone_id='${bareZone}' AND l.status='active'
        JOIN public.service_agreement_modules sam ON sam.service_agreement_id='${agreement}' AND sam.module_key='parking_enforcement'
        WHERE c.delivery_schedule_id='${bareSchedule}' AND m.active),'the active stop module names the place and module on the agreement');
    `);
  });

  test('solar windows: polar night has no window and last night is local', () => {
    const solar = { window: { mode: 'solar', start: { anchor: 'sunset', offset_hours: 0 }, end: { anchor: 'sunrise', offset_hours: 0 } } };
    const clock = { window: { mode: 'solar', start: { anchor: 'clock', time: '22:00', offset_hours: 0 }, end: { anchor: 'clock', time: '06:00', offset_hours: 0 } } };
    psql(`
      SELECT fixture.check(NOT EXISTS(SELECT 1 FROM public.place_service_window_at(${lit(solar)}, DATE '2026-12-21', ST_SetSRID(ST_MakePoint(15.63, 78.22), 4326), NULL, NULL)),'polar night has no window');
      SELECT fixture.check((SELECT count(*)=1 AND bool_and(window_open IS NULL AND window_close IS NULL) FROM public.place_service_window_at('{"window":{"mode":"any"}}', DATE '2026-12-21', NULL, NULL, NULL)),'any time is one open row');
      SELECT fixture.check((SELECT window_open=(TIMESTAMP '2026-09-26 22:00' AT TIME ZONE 'Pacific/Auckland') AND window_close=(TIMESTAMP '2026-09-27 06:00' AT TIME ZONE 'Pacific/Auckland')
        FROM public.place_service_window_at(${lit(clock)}, DATE '2026-09-27', NULL,
          TIMESTAMP '2026-09-27 01:00' AT TIME ZONE 'Pacific/Auckland', TIMESTAMP '2026-09-27 05:00' AT TIME ZONE 'Pacific/Auckland')),'last night''s window across the DST change is 22:00 to 06:00 local');
    `);
  });

  test('the generator reads approved terms and preserves legacy stop planning', () => {
    psql(generatorMigration);
    const config = scalar(`SELECT id FROM public.client_site_patrol_config WHERE delivery_schedule_id='${solarSchedule}';`);
    const insertVersion = (effective, value, kind = 'update') => `
      INSERT INTO public.place_service_term_versions(
        organization_id, service_agreement_id, location_id, delivery_schedule_id, service_kind, change_kind,
        effective_from, applied_effective_from, terms, status, reason, requested_by, client_request_id,
        request_fingerprint, decided_by, decided_at)
      VALUES('${provider}','${agreement}','${location}','${solarSchedule}','patrol','${kind}',
        '${effective}','${effective}',${lit(value)},'approved','Generator fixture','${adminA}',gen_random_uuid(),
        'generator-fixture','${adminA}',clock_timestamp());`;
    const addShift = (shiftId, start, end, status = 'published', actual = 'NULL') => `
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,
        patrol_route_id,work_unit_id,actual_start,shift_origin)
      VALUES('${shiftId}','${provider}','${adminA}','patrol',
        (TIMESTAMP '${start}' AT TIME ZONE 'Pacific/Auckland'),
        (TIMESTAMP '${end}' AT TIME ZONE 'Pacific/Auckland'),'${status}','${route}','${unit}',${actual},'rostered');`;
    const solar = terms();
    psql(`
      UPDATE public.location_zones SET center_point=ST_SetSRID(ST_MakePoint(174.7762,-41.2865),4326) WHERE id='${boundedZone}';
      ${insertVersion('2026-12-21', solar, 'create')}
      ${insertVersion('2026-12-28', terms({
        days: { mode: 'random', per_week: 1, allowed: [1,2,3,4,5,6,7] },
        window: { mode: 'any' },
      }))}
      ${insertVersion('2027-02-01', terms({ months: [6,7,8], window: { mode: 'any' } }))}
      ${insertVersion('2027-02-02', terms({
        days: { mode: 'fixed', weekdays: [1,2,3,4,5,6,7] },
        window: { mode: 'any' }, visits_per_shift: 2, min_gap_minutes: 90,
      }))}
      ${addShift(id(201), '2026-12-21 20:00', '2026-12-22 08:00')}
    `);
    psql(`SELECT public.generate_shift_stops_internal('${id(201)}','2026-12-21','${config}');`);
    const solarStop = JSON.parse(scalar(`SELECT jsonb_build_object(
      'open',(sla_window_open AT TIME ZONE 'Pacific/Auckland')::text,
      'arrive_by',(sla_arrive_by AT TIME ZONE 'Pacific/Auckland')::text,
      'required_checks',required_checks,'required_dwell_minutes',required_dwell_minutes,
      'officer_instructions',officer_instructions)::text FROM public.shift_stops
      WHERE shift_id='${id(201)}' AND patrol_config_id='${config}';`));
    const nearLocalTime = (actual, expected) => Math.abs(Date.parse(actual + 'Z') - Date.parse(expected + 'Z')) <= 4 * 60 * 1000;
    assert.ok(nearLocalTime(solarStop.open, '2026-12-21T20:27:00'), 'the dusk window opens at sunset minus 30 minutes');
    assert.ok(nearLocalTime(solarStop.arrive_by, '2026-12-22T06:14:00'), 'the overnight window closes at sunrise plus 30 minutes');
    assert.deepEqual(solarStop.required_checks, ['gate_check', 'lock_up']);
    assert.equal(solarStop.required_dwell_minutes, 10);
    assert.equal(solarStop.officer_instructions, 'Check the toilets');

    psql(addShift(id(202), '2026-12-22 01:00', '2026-12-22 07:00'));
    psql(`SELECT public.generate_shift_stops_internal('${id(202)}','2026-12-22','${config}');`);
    const afterMidnightOpen = scalar(`SELECT (sla_window_open AT TIME ZONE 'Pacific/Auckland')::text FROM public.shift_stops WHERE shift_id='${id(202)}' AND patrol_config_id='${config}';`);
    assert.ok(nearLocalTime(afterMidnightOpen, '2026-12-21T20:27:00'), 'the stop retains last night’s opening time');

    const drawDay = Number(scalar(`SELECT unnest(public.place_service_drawn_days('${solarSchedule}','2026-12-28',ARRAY[1,2,3,4,5,6,7],1));`));
    const undrawnDay = drawDay === 7 ? 1 : drawDay + 1;
    const dateForDay = day => new Date(Date.UTC(2026, 11, 28 + day - 1)).toISOString().slice(0, 10);
    psql(`${addShift(id(203), `${dateForDay(drawDay)} 08:00`, `${dateForDay(drawDay)} 12:00`)}${addShift(id(204), `${dateForDay(undrawnDay)} 08:00`, `${dateForDay(undrawnDay)} 12:00`)}`);
    psql(`SELECT public.generate_shift_stops_internal('${id(203)}','${dateForDay(drawDay)}','${config}');
      SELECT public.generate_shift_stops_internal('${id(204)}','${dateForDay(undrawnDay)}','${config}');`);
    assert.equal(scalar(`SELECT count(*) FROM public.shift_stops WHERE shift_id='${id(203)}' AND patrol_config_id='${config}';`), '1');
    assert.equal(scalar(`SELECT count(*) FROM public.shift_stops WHERE shift_id='${id(204)}' AND patrol_config_id='${config}';`), '0');

    psql(addShift(id(205), '2027-02-01 08:00', '2027-02-01 12:00'));
    assert.equal(scalar(`SELECT public.generate_shift_stops_internal('${id(205)}','2027-02-01','${config}');`), '0');
    assert.equal(scalar(`SELECT count(*) FROM public.shift_stops WHERE shift_id='${id(205)}' AND patrol_config_id='${config}';`), '0');

    psql(addShift(id(206), '2027-02-02 00:00', '2027-02-02 02:00'));
    psql(`SELECT public.generate_shift_stops_internal('${id(206)}','2027-02-02','${config}');`);
    assert.equal(scalar(`SELECT count(*) FROM public.shift_stops WHERE shift_id='${id(206)}' AND patrol_config_id='${config}';`), '2');
    assert.equal(scalar(`SELECT extract(epoch FROM max(sla_window_open)-min(sla_window_open))::int FROM public.shift_stops
      WHERE shift_id='${id(206)}' AND patrol_config_id='${config}';`), '5400');

    psql(`${insertVersion('2027-02-04', terms(), 'end')}
      ${addShift(id(212), '2027-02-03 08:00', '2027-02-03 12:00')}
      ${addShift(id(213), '2027-02-04 08:00', '2027-02-04 12:00')}`);
    psql(`SELECT public.generate_shift_stops_internal('${id(212)}','2027-02-03','${config}');
      SELECT public.generate_shift_stops_internal('${id(213)}','2027-02-04','${config}');`);
    assert.equal(scalar(`SELECT count(*) FROM public.shift_stops WHERE shift_id='${id(212)}' AND patrol_config_id='${config}';`), '2');
    assert.equal(scalar(`SELECT count(*) FROM public.shift_stops WHERE shift_id='${id(213)}' AND patrol_config_id='${config}';`), '0');

    const legacy = randomUUID();
    psql(`INSERT INTO public.client_site_patrol_config(
      id,organization_id,zone_id,patrol_route_id,module_key,time_window_type,window_start,window_end,
      active_days,visits_per_shift,dwell_minutes,sla_arrive_within_minutes,sla_depart_within_minutes,officer_instructions,active)
      VALUES('${legacy}','${provider}','${boundedZone}','${route}','freedom_camping','fixed','08:00','17:00',
        '{1,2,3,4,5,6,7}',1,15,30,45,'Legacy instruction',true);
      ${addShift(id(207), '2026-12-21 08:00', '2026-12-21 16:00')}`);
    psql(`SELECT public.generate_shift_stops_internal('${id(207)}','2026-12-21','${legacy}');`);
    const legacyStop = JSON.parse(scalar(`SELECT jsonb_build_object(
      'open',(sla_window_open AT TIME ZONE 'Pacific/Auckland')::text,
      'arrive_by',(sla_arrive_by AT TIME ZONE 'Pacific/Auckland')::text,
      'required_checks',required_checks,'required_dwell_minutes',required_dwell_minutes)::text
      FROM public.shift_stops WHERE shift_id='${id(207)}' AND patrol_config_id='${legacy}';`));
    assert.equal(legacyStop.open, '2026-12-21 08:00:00');
    assert.equal(legacyStop.arrive_by, '2026-12-21 08:30:00');
    assert.equal(legacyStop.required_dwell_minutes, 15);
    assert.deepEqual(legacyStop.required_checks, []);
  });

  test('changing terms preserves an on-scene stop and reports its shift as blocked', () => {
    const request = randomUUID();
    const updated = terms({ window: { mode: 'any' }, dwell_minutes: 30, officer_instructions: 'Updated briefing' });
    psql(`
      ALTER TABLE public.shift_stops
        ADD COLUMN actual_arrived_at timestamptz, ADD COLUMN actual_departed_at timestamptz,
        ADD COLUMN officer_notes text, ADD COLUMN arrived_gps_lat double precision,
        ADD COLUMN departed_gps_lat double precision, ADD COLUMN bwc_reference text,
        ADD COLUMN actual_travel_distance_km numeric;
      CREATE TABLE public.shift_stop_actions(shift_id uuid);
      CREATE TABLE public.patrols(shift_id uuid);
      CREATE TABLE public.officer_gps_log(shift_id uuid);
      CREATE TABLE public.patrol_checkpoint_visits(shift_stop_id uuid);
      CREATE TABLE public.safety_briefing_acknowledgements(shift_id uuid);
      CREATE TABLE public.patrol_stop_charge_lines(shift_id uuid);
      ${patrolEvidenceLock}
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,patrol_route_id,work_unit_id)
        SELECT shift_id,'${provider}','${adminA}','patrol',
          ((${today}+1)+time '08:00') AT TIME ZONE 'Pacific/Auckland',
          ((${today}+1)+time '16:00') AT TIME ZONE 'Pacific/Auckland',
          'published','${route}','${unit}'
        FROM (VALUES ('${id(208)}'::uuid),('${id(209)}'::uuid)) shifts(shift_id);
      INSERT INTO public.shift_stops(id,organization_id,shift_id,patrol_config_id,zone_id,module_key,sla_arrive_by,status,officer_instructions)
        SELECT stop_id,'${provider}',shift_id,c.id,'${boundedZone}','freedom_camping',
          ((${today}+1)+time '16:00') AT TIME ZONE 'Pacific/Auckland',stop_status,'Original briefing'
        FROM (VALUES ('${id(210)}'::uuid,'${id(208)}'::uuid,'on_scene'),
                     ('${id(211)}'::uuid,'${id(209)}'::uuid,'pending')) stops(stop_id,shift_id,stop_status)
        CROSS JOIN public.client_site_patrol_config c WHERE c.delivery_schedule_id='${solarSchedule}';
      CREATE TABLE fixture.protected_stop AS SELECT * FROM public.shift_stops WHERE id='${id(210)}';
      ${as(adminA)}
      CREATE TEMP TABLE protected_preview AS SELECT ${preview(solarSchedule, 'update', updated)} AS r;
      SELECT fixture.check(EXISTS(SELECT 1 FROM protected_preview, jsonb_array_elements(r->'blocked') b
        WHERE b->>'shift_id'='${id(208)}' AND b->>'reason' IS NOT NULL),'the on-scene shift is blocked');
      SELECT fixture.check(EXISTS(SELECT 1 FROM protected_preview, jsonb_array_elements(r->'affected') a
        WHERE a->>'shift_id'='${id(209)}'),'the pending shift is affected');
      SELECT public.save_place_service_change('${request}','${location}','${agreement}','${solarSchedule}','update',
        ${lit(updated)},${today},'Updated briefing',(SELECT r->>'preview_fingerprint' FROM protected_preview));
      ${reset}
      SELECT fixture.check((SELECT to_jsonb(s)=to_jsonb(p) FROM public.shift_stops s, fixture.protected_stop p
        WHERE s.id='${id(210)}'),'the on-scene stop is unchanged');
      SELECT fixture.check((SELECT count(*)=1 AND bool_and(id<>'${id(211)}' AND officer_instructions='Updated briefing'
        AND required_dwell_minutes=30) FROM public.shift_stops WHERE shift_id='${id(209)}'),'the pending stop is regenerated');
    `);
  });

  test('static posts respect branch authority, approval, skills, replay and existing slots', () => {
    const branch = id(4); const branchAdmin = id(15); const pendingZone = id(26);
    const providerSkill = id(250); const branchSkill = id(251); const foreignSkill = id(252);
    const addRequest = randomUUID(); const pendingRequest = randomUUID(); const endRequest = randomUUID();
    const invalidStaticReferences = [
      `NULL,'${id(254)}'::uuid,NULL,NULL`,
      `NULL,NULL,'${id(254)}'::uuid,NULL`,
      `NULL,NULL,NULL,'${id(254)}'::uuid`,
    ].map((refs) => `SELECT fixture.raises($q$SELECT public.create_operating_roster_work_unit('${provider}','Invalid static',
      'static','static_guarding',${refs.split(',')[0]},
      (SELECT u.service_agreement_location_id FROM public.roster_work_units u WHERE u.id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved)),
      (SELECT u.service_agreement_module_id FROM public.roster_work_units u WHERE u.id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved)),
      ${refs.split(',').slice(1).join(',')})$q$,'23514');`).join('\n');
    const rosterMigration = read('20261018210000_complete_open_roster_shift_flow.sql');
    const rosterEnd = rosterMigration.indexOf('create or replace function public.materialize_roster_slot_core(');
    assert.ok(rosterEnd > 0, 'real roster-slot function is available');
    psql(`
      CREATE TABLE public.roster_skill_catalog(id uuid PRIMARY KEY, organization_id uuid NOT NULL, skill_name text NOT NULL,
        skill_key text NOT NULL, active boolean NOT NULL DEFAULT true);
      ALTER TABLE public.roster_work_units ADD COLUMN required_skill_ids uuid[] NOT NULL DEFAULT '{}',
        ADD COLUMN required_skill_names text[] NOT NULL DEFAULT '{}';
      GRANT SELECT ON public.roster_work_units TO authenticated;
      CREATE TABLE public.staff_profiles(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, work_ready boolean);
      CREATE TABLE public.roster_slots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        work_unit_id uuid NOT NULL, staff_id uuid, scheduled_start timestamptz NOT NULL, scheduled_end timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'draft', client_request_id uuid NOT NULL, notes text, created_by uuid);
      INSERT INTO public.organizations VALUES ('${branch}','${provider}','Branch');
      INSERT INTO public.user_profiles VALUES ('${branchAdmin}','${branch}','${branch}','admin','Branch admin',NULL);
      INSERT INTO public.location_zones(id,organization_id,name,location_id) VALUES ('${pendingZone}','${client}','Pending area','${location}');
      INSERT INTO public.roster_skill_catalog VALUES
        ('${providerSkill}','${provider}','First aid','first_aid',true),
        ('${branchSkill}','${branch}','Site safety','site_safety',true),
        ('${foreignSkill}','${other}','Other skill','other',true);
      INSERT INTO public.organization_operating_settings(organization_id,place_changes_need_second_approver,branches_may_set_up_static_posts)
        VALUES('${provider}',false,false) ON CONFLICT(organization_id)
        DO UPDATE SET place_changes_need_second_approver=false,branches_may_set_up_static_posts=false;
      ${rosterMigration.slice(0, rosterEnd)}
      ${staticMigration}
      SELECT fixture.check(NOT has_function_privilege('authenticated','public.apply_place_static_post_version(uuid)','EXECUTE')
        AND NOT has_function_privilege('anon','public.add_place_static_post(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid[],text)','EXECUTE'),
        'internal application and anonymous creation are not exposed');
      ${as(otherAdmin)}
      SELECT fixture.raises($q$SELECT public.add_place_static_post('${randomUUID()}','${location}','${agreement}',NULL,'${pendingZone}',
        'Other post','${other}',ARRAY[]::uuid[],'Create post')$q$,'42501');
      ${reset}
      ${as(branchAdmin)}
      SELECT fixture.raises($q$SELECT public.add_place_static_post('${randomUUID()}','${location}','${agreement}',NULL,'${pendingZone}',
        'Branch post','${branch}',ARRAY['${branchSkill}'::uuid],'Create post')$q$,'42501');
      ${reset}
      ${as(adminA)}
      SELECT fixture.raises($q$SELECT public.add_place_static_post('${randomUUID()}','${location}','${agreement}',NULL,'${boundedZone}',
        'Wrong skill','${provider}',ARRAY['${foreignSkill}'::uuid],'Create post')$q$,'P0001');
      ${reset}
      UPDATE public.service_agreements SET ends_on=${today}-1 WHERE id='${agreement}';
      ${as(adminA)}
      SELECT fixture.raises($q$SELECT public.add_place_static_post('${randomUUID()}','${location}','${agreement}',NULL,'${boundedZone}',
        'Expired agreement','${provider}',ARRAY[]::uuid[],'Create post')$q$,'P0001');
      ${reset}
      UPDATE public.service_agreements SET ends_on=NULL WHERE id='${agreement}';
      ${as(adminA)}
      CREATE TEMP TABLE static_saved AS SELECT public.add_place_static_post('${addRequest}','${location}','${agreement}',NULL,
        '${boundedZone}','Gate post','${provider}',ARRAY['${providerSkill}'::uuid],'Create post') r;
      SELECT fixture.check((SELECT r->>'status'='approved' AND r->>'work_unit_id' IS NOT NULL FROM static_saved),'provider creates a post');
      SELECT fixture.check((SELECT (public.add_place_static_post('${addRequest}','${location}','${agreement}',NULL,
        '${boundedZone}','Gate post','${provider}',ARRAY['${providerSkill}'::uuid],'Create post')->>'work_unit_id')=r->>'work_unit_id'
        FROM static_saved),'replay returns the original unit');
      SELECT fixture.check(EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_place_services('${location}')->'services') service
        WHERE service->>'service_kind'='static_guarding' AND service->'anchor'->>'zone_id'='${boundedZone}'
          AND service->'work_unit'->>'id'=(SELECT r->>'work_unit_id' FROM static_saved)),
        'approved static post is visible in the place services workspace');
      SELECT fixture.raises(format('SELECT public.create_operating_roster_work_unit(%L,%L,%L,%L,%L,%L,%L,NULL,NULL,NULL)',
        '${provider}','Invalid static','static','static_guarding','${route}',
        (SELECT u.service_agreement_location_id FROM public.roster_work_units u WHERE u.id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved)),
        (SELECT u.service_agreement_module_id FROM public.roster_work_units u WHERE u.id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved))),'23514');
      ${invalidStaticReferences}
      SELECT fixture.raises($q$SELECT public.add_place_static_post('${addRequest}','${location}','${agreement}',NULL,
        '${boundedZone}','Different post','${provider}',ARRAY['${providerSkill}'::uuid],'Create post')$q$,'42501');
      ${reset}
      SELECT fixture.check((SELECT u.active AND u.work_unit_type='static' AND u.required_skill_ids=ARRAY['${providerSkill}'::uuid]
        AND u.required_skill_names=ARRAY['First aid'] AND sal.zone_id='${boundedZone}' AND sal.site_id IS NULL
        AND sam.module_key='static_guarding' AND sam.enabled
        FROM public.roster_work_units u JOIN public.service_agreement_locations sal ON sal.id=u.service_agreement_location_id
        JOIN public.service_agreement_modules sam ON sam.id=u.service_agreement_module_id
        WHERE u.id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved)),'zone, contract and skills are linked');
      UPDATE public.organization_operating_settings SET branches_may_set_up_static_posts=true, place_changes_need_second_approver=true
        WHERE organization_id='${provider}';
      ${as(branchAdmin)}
      CREATE TEMP TABLE static_pending AS SELECT public.add_place_static_post('${pendingRequest}','${location}','${agreement}',NULL,
        '${pendingZone}','Branch post','${branch}',ARRAY['${branchSkill}'::uuid],'Create post') r;
      SELECT fixture.check((SELECT r->>'status'='pending' AND r->>'work_unit_id' IS NULL FROM static_pending),'branch post waits for approval');
      SELECT fixture.raises(format('SELECT public.decide_place_service_change(%L,%L,%L,NULL)',
        '${randomUUID()}',(SELECT r->>'version_id' FROM static_pending),'approve'),'42501');
      ${reset}
      SELECT fixture.check(NOT EXISTS(SELECT 1 FROM public.service_agreement_locations WHERE service_agreement_id='${agreement}'
        AND zone_id='${pendingZone}') AND NOT EXISTS(SELECT 1 FROM public.roster_work_units WHERE name='Branch post'),
        'pending request does not create an agreement place or a work unit');
      SELECT fixture.check(EXISTS(SELECT 1 FROM public.place_service_term_versions v JOIN public.bob_agentic_actions a ON a.id=v.approval_action_id
        WHERE v.id=(SELECT (r->>'version_id')::uuid FROM static_pending) AND a.proposed_payload->>'effective_from'=${today}::text
          AND a.proposed_payload->'terms'->>'post_name'='Branch post'),'approval request includes its effective date and terms');
      ${as(adminB)}
      SELECT fixture.check(EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_place_services('${location}')->'services') service
        WHERE service->>'service_kind'='static_guarding' AND service->'anchor'->>'zone_id'='${pendingZone}'
          AND service->'pending'->>'version_id'=(SELECT r->>'version_id' FROM static_pending)),
        'pending static post is visible with its anchor to a provider approver');
      ${reset}
      UPDATE public.organization_operating_settings SET branches_may_set_up_static_posts=false WHERE organization_id='${provider}';
      ${as(adminB)}
      SELECT fixture.raises(format('SELECT public.decide_place_service_change(%L,%L,%L,NULL)',
        '${randomUUID()}',(SELECT r->>'version_id' FROM static_pending),'approve'),'42501');
      ${reset}
      SELECT fixture.check((SELECT status='pending' FROM public.place_service_term_versions
        WHERE id=(SELECT (r->>'version_id')::uuid FROM static_pending))
        AND NOT EXISTS(SELECT 1 FROM public.roster_work_units WHERE name='Branch post'),'revoked branch authority prevents approval');
      UPDATE public.organization_operating_settings SET branches_may_set_up_static_posts=true WHERE organization_id='${provider}';
      UPDATE public.service_agreements SET ends_on=${today}-1 WHERE id='${agreement}';
      ${as(adminB)}
      SELECT fixture.raises(format('SELECT public.decide_place_service_change(%L,%L,%L,NULL)',
        '${randomUUID()}',(SELECT r->>'version_id' FROM static_pending),'approve'),'P0001');
      ${reset}
      UPDATE public.service_agreements SET ends_on=NULL WHERE id='${agreement}';
      ${as(adminB)}
      SELECT public.decide_place_service_change('${randomUUID()}',(SELECT (r->>'version_id')::uuid FROM static_pending),'approve',NULL);
      ${reset}
      SELECT fixture.check(EXISTS(SELECT 1 FROM public.place_service_term_versions v JOIN public.roster_work_units u ON u.id=v.work_unit_id
        JOIN public.service_agreement_locations sal ON sal.id=u.service_agreement_location_id
        WHERE v.id=(SELECT (r->>'version_id')::uuid FROM static_pending) AND v.status='approved'
        AND u.organization_id='${branch}' AND u.required_skill_names=ARRAY['Site safety'] AND sal.zone_id='${pendingZone}'),
        'second provider administrator creates the branch post on approval');
      ${as(adminA)}
      CREATE TEMP TABLE static_slot AS SELECT (public.create_roster_slot('${randomUUID()}',
        (SELECT (r->>'work_unit_id')::uuid FROM static_saved),NULL,now()+interval '1 day',now()+interval '1 day 8 hours',false,NULL)).id id;
      CREATE TEMP TABLE static_ended AS SELECT public.end_place_static_post('${endRequest}',
        (SELECT (r->>'work_unit_id')::uuid FROM static_saved),'Post ended') r;
      SELECT fixture.check((SELECT r->>'status'='pending' FROM static_ended),'end waits for approval');
      SELECT fixture.raises(format('SELECT public.decide_place_service_change(%L,%L,%L,NULL)',
        '${randomUUID()}',(SELECT r->>'version_id' FROM static_ended),'approve'),'P0001');
      SELECT fixture.raises(format('SELECT public.end_place_static_post(%L,%L,%L)',
        '${randomUUID()}',(SELECT r->>'work_unit_id' FROM static_saved),'Again'),'P0001');
      ${reset}
      SELECT fixture.check((SELECT active FROM public.roster_work_units WHERE id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved)),
        'pending end leaves the unit active');
      CREATE TEMP TABLE old_static_link AS SELECT u.service_agreement_location_id FROM public.roster_work_units u
        WHERE u.id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved);
      UPDATE public.roster_work_units SET service_agreement_location_id=(
        SELECT l.id FROM public.service_agreement_locations l WHERE l.service_agreement_id='${agreement}' AND l.zone_id='${pendingZone}' LIMIT 1)
        WHERE id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved);
      ${as(adminB)}
      SELECT fixture.raises(format('SELECT public.decide_place_service_change(%L,%L,%L,NULL)',
        '${randomUUID()}',(SELECT r->>'version_id' FROM static_ended),'approve'),'40001');
      ${reset}
      UPDATE public.roster_work_units SET service_agreement_location_id=(SELECT service_agreement_location_id FROM old_static_link)
        WHERE id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved);
      ${as(adminB)}
      SELECT public.decide_place_service_change('${randomUUID()}',(SELECT (r->>'version_id')::uuid FROM static_ended),'approve',NULL);
      ${reset}
      ${as(adminA)}
      SELECT fixture.check((SELECT public.end_place_static_post('${endRequest}',(SELECT (r->>'work_unit_id')::uuid FROM static_saved),
        'Post ended')->>'version_id'=r->>'version_id' FROM static_ended),'end replay returns the same version');
      SELECT fixture.raises(format('SELECT public.create_roster_slot(%L,%L,NULL,now()+interval %L,now()+interval %L,false,NULL)',
        '${randomUUID()}',(SELECT r->>'work_unit_id' FROM static_saved),'2 days','2 days 8 hours'),'P0001','Active authorized work unit required');
      ${reset}
      SELECT fixture.check((SELECT NOT active FROM public.roster_work_units WHERE id=(SELECT (r->>'work_unit_id')::uuid FROM static_saved))
        AND EXISTS(SELECT 1 FROM public.roster_slots WHERE id=(SELECT id FROM static_slot)),'ending retains the existing roster slot');
      UPDATE public.organization_operating_settings SET place_changes_need_second_approver=false WHERE organization_id='${provider}';
      ${as(adminA)}
      SELECT fixture.check(public.end_place_static_post('${randomUUID()}',
        (SELECT work_unit_id FROM public.place_service_term_versions WHERE id=(SELECT (r->>'version_id')::uuid FROM static_pending)),
        'Branch post ended')->>'status'='approved','a post ends immediately when approval is disabled');
      ${reset}
    `);
  });

  const withChangedProvider = async (changingAgreement, check) => {
    const sql = `BEGIN; UPDATE public.service_agreements SET provider_organization_id='${other}' WHERE id='${changingAgreement}'; SELECT pg_sleep(8); COMMIT;`;
    const writer = spawn('docker', ['exec', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] });
    let writerError = '';
    writer.stdout.resume();
    writer.stderr.on('data', (data) => { writerError += data.toString(); });
    const completed = new Promise((resolve, reject) => {
      writer.once('error', reject);
      writer.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`concurrent writer failed (${code}): ${writerError}`)));
    });
    let locked = false;
    try {
      for (let i = 0; i < 50; i += 1) {
        if (scalar(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active'
          AND query LIKE '%SELECT pg_sleep(8)%' AND query LIKE '%${changingAgreement}%');`) === 't') { locked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(locked, 'the agreement update holds its row lock');
      check();
    } finally {
      await completed;
    }
  };

  test('a change of agreement provider during static-post creation cannot authorise the old provider', async () => {
    const changingAgreement = id(36);
    const request = randomUUID();
    psql(`
      INSERT INTO public.service_agreements VALUES('${changingAgreement}','${provider}','${client}','Changing provider','operational',NULL,NULL,'{}');
      INSERT INTO public.organization_operating_settings(organization_id,place_changes_need_second_approver)
        VALUES('${other}',true) ON CONFLICT(organization_id) DO UPDATE SET place_changes_need_second_approver=true;
    `);
    await withChangedProvider(changingAgreement, () => {
      psql(`
        ${as(adminA)}
        SELECT fixture.raises($q$SELECT public.add_place_static_post('${request}','${location}','${changingAgreement}',NULL,'${boundedZone}',
          'Concurrent post','${provider}',ARRAY[]::uuid[],'Create post')$q$,'42501');
        ${reset}
        SELECT fixture.check(NOT EXISTS(SELECT 1 FROM public.place_service_term_versions WHERE client_request_id='${request}'),
          'no pending request is written under a new provider');
      `);
    });
  });

  test('a change of agreement provider during static-post ending cannot authorise the old provider', async () => {
    const changingAgreement = id(37);
    const request = randomUUID();
    psql(`
      INSERT INTO public.service_agreements VALUES('${changingAgreement}','${provider}','${client}','Changing provider','operational',NULL,NULL,'{}');
      UPDATE public.organization_operating_settings SET place_changes_need_second_approver=false WHERE organization_id='${provider}';
    `);
    const workUnit = scalar(`
      ${as(adminA)}
      SELECT public.add_place_static_post('${randomUUID()}','${location}','${changingAgreement}',NULL,'${boundedZone}',
        'Race post','${provider}',ARRAY[]::uuid[],'Create post')->>'work_unit_id';
    `).split('\n').pop();
    psql(`UPDATE public.organization_operating_settings SET place_changes_need_second_approver=true WHERE organization_id='${provider}';`);
    await withChangedProvider(changingAgreement, () => {
      psql(`
        ${as(adminA)}
        SELECT fixture.raises($q$SELECT public.end_place_static_post('${request}','${workUnit}','End post')$q$,'42501');
        ${reset}
        SELECT fixture.check(NOT EXISTS(SELECT 1 FROM public.place_service_term_versions WHERE client_request_id='${request}'),
          'no pending end is written under the former provider');
      `);
    });
  });
});
