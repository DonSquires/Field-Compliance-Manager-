const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261117000100_zone_briefing_parity.sql');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n') : '';

test('zones carry the same briefing fields as sites', () => {
  for (const column of ['risk_level', 'site_brief', 'access_instructions', 'hs_notes']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} text`));
  }
  assert.match(migration, /CHECK \(risk_level IN \('low', 'medium', 'high', 'critical'\)\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.manage_crm_zone_briefing\(/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.manage_crm_zone_briefing\(uuid, integer, text, text, text, text\) FROM PUBLIC, anon;/);
  for (const fn of ['get_crm_operational_place_editor', 'get_officer_patrol_stops', 'get_officer_static_post']) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
  }
  assert.doesNotMatch(migration, /\bDROP\b/i);
});

const migrationsDir = path.join(__dirname, '../supabase/migrations');
const lastEditorFile = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  .filter((f) => /CREATE OR REPLACE FUNCTION public\.get_crm_operational_place_editor\(/.test(fs.readFileSync(path.join(migrationsDir, f), 'utf8'))).pop();
const lastEditor = lastEditorFile ? fs.readFileSync(path.join(migrationsDir, lastEditorFile), 'utf8').replace(/\r\n/g, '\n') : '';

// 000100 (briefing) and 010000 (reporting parent) each replace the editor; whichever runs last wins, and live applies them
// in the opposite order to the branch. The final definition must carry both so neither order drops a field.
test('the final place editor carries both the zone briefing and the reporting parent', () => {
  const zones = lastEditor.match(/'zones',\(select[\s\S]*?\)\s*,\s*\n\s*'modules'/)?.[0] ?? '';
  for (const field of ['parent_zone_id', 'risk_level', 'site_brief', 'access_instructions', 'hs_notes']) {
    assert.match(zones, new RegExp(`'${field}',z\\.${field}`), `${lastEditorFile} zones must include ${field}`);
  }
  assert.doesNotMatch(lastEditor, /\bDROP\b/i);
});

describe('zone briefing against disposable PostgreSQL', { skip: process.env.BOB_TEST_POSTGRES !== '1' }, () => {
  const container = `fcm-zone-briefing-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = (sql) => docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres'], sql);
  let created = false;
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const admin = id(1); const clerk = id(2); const officer = id(3); const provider = id(9);
  const location = id(10); const zone = id(20); const patrolShift = id(30); const staticShift = id(31);
  const as = (user) => `SELECT set_config('request.jwt.claim.sub','${user}',false);`;
  const brief = (version, risk) => `public.manage_crm_zone_briefing('${zone}',${version},'${risk}','Gate at north end','Code 1234 from office','Tidal flats')`;

  before(async () => {
    docker(['run', '--detach', '--name', container, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    psql(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE SCHEMA fixture;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, role text, deactivated_at timestamptz);
      CREATE TABLE public.locations(id uuid PRIMARY KEY, organization_id uuid, name text);
      CREATE TABLE public.location_zones(id uuid PRIMARY KEY, organization_id uuid, location_id uuid, name text, zone_type text, module_key text, rule_type text, is_active boolean DEFAULT true, nightly_limit_consecutive integer, nightly_limit_monthly integer, scv_required boolean DEFAULT false, enforcement_workflow_override text, boundary_status text, boundary_verification text, configuration_version integer NOT NULL DEFAULT 1, is_verification_point boolean NOT NULL DEFAULT false);
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY, location_id uuid, name text, address text, risk_level text, site_brief text, access_instructions text, hs_notes text, active boolean, boundary_status text, boundary_verification text, configuration_version integer);
      CREATE TABLE public.module_catalog(module_key text PRIMARY KEY, active boolean);
      CREATE TABLE public.zone_closures(id uuid PRIMARY KEY, zone_id uuid, closure_type text, status text, effective_from date, effective_to date, reason text, resolution_notes text, created_at timestamptz);
      CREATE TABLE public.audit_log(organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb);
      CREATE TABLE public.patrol_routes(id uuid PRIMARY KEY, name text);
      CREATE TABLE public.shifts(id uuid PRIMARY KEY, organization_id uuid, officer_user_id uuid, service_type text, status text, scheduled_start timestamptz, scheduled_end timestamptz, patrol_route_id uuid, notes text);
      CREATE TABLE public.shift_stops(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shift_id uuid, site_id uuid, zone_id uuid, module_key text, stop_order integer, visit_number integer, is_adhoc boolean, patrol_config_id uuid, status text, sla_status text, sla_window_open timestamptz, sla_arrive_by timestamptz, sla_depart_by timestamptz, required_dwell_minutes integer, officer_instructions text, actual_arrived_at timestamptz, actual_departed_at timestamptz, actual_travel_distance_km numeric, travel_from_stop_id uuid, travel_distance_method text, travel_distance_version integer, arrival_verification text, arrival_distance_m numeric, officer_notes text);
      CREATE TABLE public.shift_stop_modules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shift_stop_id uuid, module_key text, is_required boolean, status text, started_at timestamptz, completed_at timestamptz, created_at timestamptz DEFAULT now(), service_agreement_module_id uuid, service_agreement_location_id uuid);
      CREATE TABLE public.service_agreement_locations(id uuid PRIMARY KEY, service_agreement_id uuid, status text);
      CREATE TABLE public.service_agreement_modules(id uuid PRIMARY KEY, service_agreement_id uuid, module_key text, enabled boolean);
      CREATE TABLE public.shift_stop_actions(shift_stop_id uuid, action_type text, receipt jsonb, performed_at timestamptz);
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=$1 AND role='admin' AND deactivated_at IS NULL) $fn$;
      CREATE FUNCTION public.crm_actor_can_manage_location(uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT EXISTS(SELECT 1 FROM public.locations l JOIN public.user_profiles p ON p.id=auth.uid() WHERE l.id=$1 AND l.organization_id=p.organization_id) $fn$;
      CREATE FUNCTION fixture.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $fn$;
      CREATE FUNCTION fixture.raises(command text, expected text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected THEN RETURN; END IF; RAISE; END;
        RAISE EXCEPTION 'Expected SQLSTATE %',expected;
      END $fn$;
      INSERT INTO public.user_profiles VALUES('${admin}','${provider}','admin',NULL),('${clerk}','${provider}','officer',NULL),('${officer}','${provider}','officer',NULL);
      INSERT INTO public.locations VALUES('${location}','${provider}','Estuary reserve');
      INSERT INTO public.location_zones(id,organization_id,location_id,name,zone_type,module_key,rule_type) VALUES('${zone}','${provider}','${location}','Mudflat track','patrol_route','patrol','unrestricted');
      INSERT INTO public.shifts VALUES
        ('${patrolShift}','${provider}','${officer}','patrol','in_progress',now(),now()+interval '8 hours',NULL,NULL),
        ('${staticShift}','${provider}','${officer}','static_guarding','accepted',now(),now()+interval '8 hours',NULL,NULL);
      INSERT INTO public.shift_stops(id,shift_id,zone_id,module_key,stop_order,visit_number,is_adhoc,status) VALUES
        ('${id(40)}','${patrolShift}','${zone}','patrol',1,1,false,'pending'),
        ('${id(41)}','${staticShift}','${zone}','static_guarding',1,1,false,'pending');
      INSERT INTO public.service_agreement_locations VALUES('${id(50)}','${id(52)}','active');
      INSERT INTO public.service_agreement_modules VALUES('${id(51)}','${id(52)}','static_guarding',true);
      INSERT INTO public.shift_stop_modules(shift_stop_id,module_key,is_required,status,service_agreement_module_id,service_agreement_location_id) VALUES('${id(41)}','static_guarding',true,'pending','${id(51)}','${id(50)}');
      ALTER TABLE public.location_zones ADD COLUMN parent_zone_id uuid;
      ${migration}
      ${lastEditor}
    `);
  });

  after(() => { if (created) docker(['rm', '--force', container]); });

  test('zone briefing round-trips for an admin', () => {
    psql(`
      ${as(admin)}
      SELECT fixture.check((SELECT ${brief(1, 'high')} = jsonb_build_object('zone_id','${zone}'::uuid,'configuration_version',2)),'admin save returns the next configuration version');
      SELECT fixture.check((SELECT risk_level='high' AND site_brief='Gate at north end' AND access_instructions='Code 1234 from office' AND hs_notes='Tidal flats' AND configuration_version=2 FROM public.location_zones WHERE id='${zone}'),'zone stores the briefing');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE target_id='${zone}' AND action='crm_zone_briefing_updated'),'zone briefing save is audited');
      SELECT fixture.raises($q$ SELECT ${brief(1, 'high')} $q$,'40001');
      SELECT fixture.raises($q$ SELECT ${brief(2, 'extreme')} $q$,'23514');
      SELECT fixture.check((SELECT z->>'hs_notes'='Tidal flats' AND z->>'risk_level'='high' AND (z->>'configuration_version')::int=2 AND z ? 'parent_zone_id' FROM jsonb_array_elements(public.get_crm_operational_place_editor('${location}')->'zones') z),'place editor returns the zone briefing and reporting parent');
      ${as(clerk)}
      SELECT fixture.raises($q$ SELECT ${brief(2, 'low')} $q$,'42501');
      SELECT fixture.check((SELECT risk_level='high' AND configuration_version=2 FROM public.location_zones WHERE id='${zone}'),'refused saves change nothing');
      SELECT fixture.check(NOT has_function_privilege('anon','public.manage_crm_zone_briefing(uuid,integer,text,text,text,text)','EXECUTE'),'anon cannot save briefings');
      SELECT fixture.check(has_function_privilege('authenticated','public.manage_crm_zone_briefing(uuid,integer,text,text,text,text)','EXECUTE'),'administrators can save briefings');
    `);
  });

  test('officer stop read shows zone safety notes', () => {
    psql(`
      UPDATE public.location_zones SET risk_level='high', site_brief='Gate at north end', access_instructions='Code 1234 from office', hs_notes='Tidal flats' WHERE id='${zone}';
      ${as(officer)}
      SELECT fixture.check((SELECT s->'place'->>'hs_notes'='Tidal flats' AND s->'place'->>'kind'='zone' AND s->'place'->>'access_instructions'='Code 1234 from office' FROM jsonb_array_elements(public.get_officer_patrol_stops('${patrolShift}')->'stops') s),'patrol stop shows the zone briefing');
      SELECT fixture.check((SELECT p->>'id'='${zone}' AND p->>'risk_level'='high' AND p->>'site_brief'='Gate at north end' AND p->>'access_instructions'='Code 1234 from office' AND p->>'hs_notes'='Tidal flats' FROM (SELECT public.get_officer_static_post('${staticShift}')->'place' AS p) x),'static post shows the zone briefing');
    `);
  });
});
