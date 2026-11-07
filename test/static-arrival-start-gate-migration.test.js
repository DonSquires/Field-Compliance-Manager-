const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261107213000_static_arrival_requires_started_shift.sql'), 'utf8').replace(/\r\n/g, '\n');
const guard = "  if v_shift.status<>'in_progress' or v_shift.actual_start is null then raise exception 'Start this shift from My schedule and complete its safety briefing before recording attendance';end if;\n";
const autoStart = "    update public.shifts set status='in_progress',actual_start=coalesce(actual_start,v_at) where id=v_shift.id and status='accepted';\n";
const preFix = migration.replace(guard, '').replace('  else\n', `${autoStart}  else\n`);

test('static arrival keeps the existing task, boundary and retry logic but cannot start shifts', () => {
  assert.ok(migration.includes(guard));
  assert.doesNotMatch(migration, /update public\.shifts set status=/);
  assert.match(migration, /boundary_verification='verified'/);
  assert.ok(migration.indexOf('if found then return v_receipt') < migration.indexOf(guard));
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.match(migration, /revoke all on function public\.manage_officer_static_post\([^)]*\) from public, anon;/);
  assert.match(migration, /revoke all on function public\.get_officer_static_post\(uuid\) from public, anon;/);
});

test('accepted shifts cannot bypass canonical start, against disposable PostgreSQL', { skip: process.env.BOB_TEST_POSTGRES !== '1' }, async () => {
  const container = `fcm-static-start-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const call = (action, status, request, notes = 'Synthetic handover') => `public.manage_officer_static_post('${id(3)}','${status}','${action}','${id(request)}','${notes}',0,0,5)`;
    const sql = `
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE shifts(id uuid PRIMARY KEY, officer_user_id uuid, organization_id uuid, service_type text, status text, actual_start timestamptz, completed_stops integer, scheduled_start timestamptz, scheduled_end timestamptz, notes text);
      CREATE TABLE shift_stops(id uuid PRIMARY KEY, shift_id uuid, module_key text, site_id uuid, status text, sla_arrive_by timestamptz, actual_arrived_at timestamptz, actual_departed_at timestamptz, arrived_gps_lat double precision, arrived_gps_lng double precision, sla_status text, updated_at timestamptz, officer_notes text, stop_order integer DEFAULT 1, zone_id uuid);
      CREATE TABLE shift_stop_modules(id uuid PRIMARY KEY, shift_stop_id uuid, module_key text, is_required boolean, service_agreement_module_id uuid, service_agreement_location_id uuid, status text, started_at timestamptz, completed_at timestamptz, updated_at timestamptz, outcome text, created_at timestamptz DEFAULT now());
      CREATE TABLE service_agreement_modules(id uuid, service_agreement_id uuid, module_key text, enabled boolean);
      CREATE TABLE service_agreement_locations(id uuid, service_agreement_id uuid, status text);
      CREATE TABLE client_sites(id uuid, active boolean, boundary geometry, boundary_verification text, center_point geometry, onsite_radius_meters double precision, name text DEFAULT 'Synthetic site', address text, risk_level text, site_brief text, access_instructions text, hs_notes text);
      CREATE TABLE location_zones(id uuid, name text);
      CREATE TABLE shift_stop_actions(id uuid, organization_id uuid, shift_stop_id uuid, shift_id uuid, shift_stop_module_id uuid, action_type text, outcome text, notes text, gps_lat double precision, gps_lng double precision, performed_at timestamptz, client_request_id uuid, gps_accuracy_metres double precision, evidence_metadata jsonb, receipt jsonb);
      CREATE TABLE audit_log(organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb);
      CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $fn$;
      CREATE FUNCTION pg_temp.denied(command text, expected text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN IF position(expected in SQLERRM)>0 THEN RETURN; END IF; RAISE; END;
        RAISE EXCEPTION 'Expected refusal: %',expected;
      END $fn$;
      INSERT INTO shifts(id,officer_user_id,organization_id,service_type,status,actual_start,completed_stops,scheduled_start,scheduled_end) VALUES('${id(2)}','${id(1)}','${id(9)}','static_guarding','accepted',NULL,0,now(),now()+interval '8 hours');
      INSERT INTO shift_stops(id,shift_id,module_key,site_id,status,sla_arrive_by) VALUES('${id(3)}','${id(2)}','static_guarding','${id(4)}','pending',now()+interval '1 hour');
      INSERT INTO shift_stop_modules(id,shift_stop_id,module_key,is_required,service_agreement_module_id,service_agreement_location_id,status) VALUES('${id(5)}','${id(3)}','static_guarding',true,'${id(6)}','${id(7)}','pending');
      INSERT INTO service_agreement_modules VALUES('${id(6)}','${id(8)}','static_guarding',true);
      INSERT INTO service_agreement_locations VALUES('${id(7)}','${id(8)}','active');
      INSERT INTO client_sites(id,active,boundary,boundary_verification,center_point,onsite_radius_meters) VALUES('${id(4)}',true,st_makeenvelope(-0.001,-0.001,0.001,0.001,4326),'verified',st_setsrid(st_point(0,0),4326),10);
      SELECT set_config('request.jwt.claim.sub','${id(1)}',false);
      ${preFix}
      SELECT ${call('arrive', 'pending', 10)};
      SELECT pg_temp.check((SELECT status='in_progress' AND actual_start IS NOT NULL FROM shifts),'before: arrival auto-started accepted shift');
      UPDATE shifts SET status='accepted',actual_start=NULL;
      UPDATE shift_stops SET status='pending',actual_arrived_at=NULL;
      UPDATE shift_stop_modules SET status='pending',started_at=NULL;
      TRUNCATE shift_stop_actions,audit_log;
      ${migration}
      UPDATE shifts SET status='scheduled';
      SELECT pg_temp.check(public.get_officer_static_post('${id(2)}')->'shift'->>'id'='${id(2)}','own unscheduled work can load private pre-start briefing');
      UPDATE shifts SET status='published';
      SELECT pg_temp.check(public.get_officer_static_post('${id(2)}')->'shift'->>'status'='published','own published assignment can be read before acceptance');
      UPDATE shifts SET status='accepted';
      SELECT pg_temp.denied($sql$ SELECT ${call('arrive', 'pending', 11)} $sql$,'Start this shift from My schedule');
      SELECT pg_temp.check((SELECT status='pending' FROM shift_stops),'refused attendance leaves the stop unchanged');
      SELECT pg_temp.check((SELECT count(*)=0 FROM shift_stop_actions),'refused attendance creates no receipt');
      UPDATE shifts SET status='in_progress',actual_start=NULL;
      SELECT pg_temp.denied($sql$ SELECT ${call('arrive', 'pending', 12)} $sql$,'Start this shift from My schedule');
      UPDATE shifts SET actual_start=now();
      SELECT set_config('request.jwt.claim.sub','${id(99)}',false);
      SELECT pg_temp.check(public.get_officer_static_post('${id(2)}') IS NULL,'another officer cannot read this assignment');
      SELECT pg_temp.denied($sql$ SELECT ${call('arrive', 'pending', 13)} $sql$,'not assigned to this officer');
      SELECT set_config('request.jwt.claim.sub','${id(1)}',false);
      UPDATE client_sites SET boundary_verification='unverified';
      SELECT pg_temp.denied($sql$ SELECT ${call('arrive', 'pending', 14)} $sql$,'verified site boundary');
      UPDATE client_sites SET boundary_verification='verified';
      SELECT ${call('arrive', 'pending', 15)};
      SELECT pg_temp.check((SELECT status='on_scene' FROM shift_stops),'started shift records arrival');
      SELECT ${call('arrive', 'pending', 15)};
      SELECT pg_temp.check((SELECT count(*)=1 FROM shift_stop_actions),'retry reuses arrival receipt');
      SELECT ${call('depart', 'on_scene', 16)};
      SELECT pg_temp.check((SELECT status='completed' AND officer_notes='Synthetic handover' FROM shift_stops),'departure stores handover');
      SELECT pg_temp.check((SELECT status='in_progress' AND completed_stops=1 FROM shifts),'post completion does not bypass shift debrief/end');
      UPDATE shifts SET status='completed';
      SELECT ${call('depart', 'on_scene', 16)};
      SELECT pg_temp.check((SELECT count(*)=2 FROM shift_stop_actions),'receipt replay survives completed shift');
    `;
    docker(['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], sql);
  } finally { if (created) docker(['rm', '--force', container]); }
});
