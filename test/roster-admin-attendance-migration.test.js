'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261109170000_roster_admin_attendance_events.sql'), 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');

test('admin attendance events are append-only and do not write officer attendance or payable fields', () => {
  const sql = squash(migration);
  assert.match(sql, /UNIQUE \(shift_id, event_type\)/);
  assert.match(sql, /public\.is_admin_for_org\(v_shift\.organization_id\)/);
  assert.match(sql, /actual_start_before/);
  assert.match(sql, /actual_end_before/);
  assert.match(sql, /admin_recorded_not_officer_attendance/);
  assert.doesNotMatch(sql, /UPDATE public\.shifts SET[\s\S]*?actual_(start|end)\s*=/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.shift_admin_attendance_events FROM PUBLIC, anon, authenticated, service_role/);
});

test('admin attendance event authorization, replay and non-mutation run in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-roster-admin-attendance-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const org = '00000000-0000-4000-8000-000000000001';
  const admin = '00000000-0000-4000-8000-000000000002';
  const outsider = '00000000-0000-4000-8000-000000000003';
  const shift = '00000000-0000-4000-8000-000000000004';
  const startRequest = '00000000-0000-4000-8000-000000000005';
  const finishRequest = '00000000-0000-4000-8000-000000000006';
  const as = (user) => `SET LOCAL request.jwt.claim.sub='${user}';`;
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    sql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, display_name text);
      CREATE TABLE public.shifts(id uuid PRIMARY KEY, organization_id uuid, status text, actual_start timestamptz,
        actual_end timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.audit_log(id bigserial, organization_id uuid, actor_user_id uuid, action text,
        target_table text, target_id uuid, metadata jsonb);
      CREATE FUNCTION public.is_admin_for_org(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT auth.uid()='${admin}' AND p_org='${org}'
      $$;
      INSERT INTO public.organizations VALUES ('${org}');
      INSERT INTO public.user_profiles VALUES ('${admin}','Roster Admin'),('${outsider}','Outsider');
      INSERT INTO public.shifts(id,organization_id,status) VALUES ('${shift}','${org}','accepted');
    `);
    sql(migration);

    fails(`BEGIN; ${as(outsider)} SELECT public.record_admin_shift_attendance('${startRequest}','${shift}',(SELECT updated_at FROM public.shifts WHERE id='${shift}'),'admin_start','2026-01-01T18:00:00Z','Officer called in'); COMMIT;`, /Roster administrator access required/);
    fails(`BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${startRequest}','${shift}',(SELECT updated_at FROM public.shifts WHERE id='${shift}'),'admin_start','2026-01-01T18:00:00Z','No'); COMMIT;`, /reason of 5 to 1000 characters/);
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${startRequest}','${shift}',(SELECT updated_at FROM public.shifts WHERE id='${shift}'),'admin_start','2026-01-01T18:00:00Z','Officer reported starting at this time')->>'source'; COMMIT;`).trim(), 'admin_recorded_not_officer_attendance');
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT (public.record_admin_shift_attendance('${startRequest}','${shift}',(SELECT updated_at FROM public.shifts WHERE id='${shift}'),'admin_start','2026-01-01T18:00:00Z','Officer reported starting at this time')->>'replayed'); COMMIT;`).trim(), 'true');
    fails(`BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${finishRequest}','${shift}',(SELECT updated_at FROM public.shifts WHERE id='${shift}'),'admin_finish','2026-01-01T17:59:00Z','Officer reported finishing'); COMMIT;`, /finish time must follow/);
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${finishRequest}','${shift}',(SELECT updated_at FROM public.shifts WHERE id='${shift}'),'admin_finish','2026-01-01T22:00:00Z','Officer reported finishing at this time')->>'event_type'; COMMIT;`).trim(), 'admin_finish');
    assert.equal(sql(`SELECT status||'|'||(actual_start IS NULL)::text||'|'||(actual_end IS NULL)::text FROM public.shifts WHERE id='${shift}'`).trim(), 'accepted|true|true');
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT admin_start::text||'|'||admin_finish::text FROM public.get_roster_admin_attendance('${org}',ARRAY['${shift}'::uuid]); COMMIT;`).trim(), '2026-01-01 18:00:00+00|2026-01-01 22:00:00+00');
    assert.equal(sql("SELECT count(*) FROM public.audit_log WHERE action='shift_admin_attendance_recorded'").trim(), '2');
    fails(`BEGIN; ${as(outsider)} SELECT * FROM public.get_roster_admin_attendance('${org}',ARRAY['${shift}'::uuid]); COMMIT;`, /Roster administrator access required/);
    assert.equal(sql("SELECT has_function_privilege('authenticated','public.record_admin_shift_attendance(uuid,uuid,timestamptz,text,timestamptz,text)','EXECUTE')").trim(), 't');
    assert.equal(sql("SELECT has_function_privilege('anon','public.record_admin_shift_attendance(uuid,uuid,timestamptz,text,timestamptz,text)','EXECUTE')").trim(), 'f');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});