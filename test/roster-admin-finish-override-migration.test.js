'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '../supabase/migrations', file), 'utf8');
const original = read('20261109170000_roster_admin_attendance_events.sql');
const remoteStart = read('20261112090000_admin_remote_shift_start.sql');
const migration = read('20261112120000_admin_finish_override.sql');
const squash = (text) => text.replace(/\s+/g, ' ');
const signature = 'public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean, boolean)';

test('admin finish overrides open work, records the GPS breadcrumb and fails fast on lock waits', () => {
  const sql = squash(migration);
  assert.match(sql, /Owner direction 2026-11-12/);
  assert.match(sql, /SET lock_timeout TO '3s'/);
  assert.match(sql, /DROP FUNCTION public\.record_admin_shift_attendance\(uuid, uuid, timestamptz, text, timestamptz, text, boolean\);/);
  assert.match(sql, /p_officer_safety_confirmed boolean DEFAULT false/);
  assert.match(sql, /AND NOT v_safe THEN RAISE EXCEPTION 'This shift has open welfare alerts\. Confirm you have checked the officer is safe/);
  assert.match(sql, /UPDATE public\.dispatch_jobs j SET status = CASE WHEN j\.status = 'pending_approval' THEN 'pending_approval' ELSE 'pending' END, shift_id = NULL/);
  assert.match(sql, /gps\.recorded_at <= p_recorded_at ORDER BY gps\.recorded_at DESC LIMIT 1/);
  assert.match(sql, /PERFORM public\.close_unfinished_officer_shift\(p_client_request_id, v_shift\.id/);
  assert.match(sql, /IF v_safe THEN v_request := v_request \|\| jsonb_build_object\('officer_safety_confirmed', true\)/);
  assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${signature.replace(/[().]/g, '\\$&')} FROM PUBLIC, anon, service_role`));
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_admin_shift_finish_preview\(uuid\) FROM PUBLIC, anon, service_role/);
});

test('admin finish override runs against the real shift in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-roster-admin-finish-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const org = '00000000-0000-4000-8000-000000000001';
  const admin = '00000000-0000-4000-8000-000000000002';
  const officer = '00000000-0000-4000-8000-000000000003';
  const shift = '00000000-0000-4000-8000-000000000004';
  const job = '00000000-0000-4000-8000-000000000005';
  const approvalJob = '00000000-0000-4000-8000-000000000006';
  const doneJob = '00000000-0000-4000-8000-000000000007';
  const alert = '00000000-0000-4000-8000-000000000008';
  const finishRequest = '00000000-0000-4000-8000-000000000009';
  const as = (user) => `SET LOCAL request.jwt.claim.sub='${user}';`;
  const updatedAt = `(SELECT updated_at FROM public.shifts WHERE id='${shift}')`;
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
      CREATE TABLE public.shifts(id uuid PRIMARY KEY, organization_id uuid, officer_user_id uuid, status text,
        scheduled_start timestamptz, actual_start timestamptz, actual_end timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.shift_stops(id uuid PRIMARY KEY, shift_id uuid);
      CREATE TABLE public.audit_log(id bigserial, organization_id uuid, actor_user_id uuid, action text,
        target_table text, target_id uuid, metadata jsonb);
      CREATE TABLE public.safety_briefing_acknowledgements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL, shift_id uuid NOT NULL, shift_stop_id uuid, officer_user_id uuid NOT NULL,
        briefing_hash text NOT NULL, hazard_snapshot jsonb NOT NULL DEFAULT '[]', item_count integer NOT NULL DEFAULT 0,
        gps_lat double precision, gps_lng double precision, client_request_id uuid NOT NULL,
        acknowledged_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.officer_gps_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        officer_id uuid NOT NULL, shift_id uuid, gps_lat double precision NOT NULL, gps_lng double precision NOT NULL,
        accuracy_meters double precision, recorded_at timestamptz NOT NULL DEFAULT now(), physical_address text);
      CREATE TABLE public.dispatch_jobs(id uuid PRIMARY KEY, organization_id uuid, shift_id uuid, shift_stop_id uuid,
        assigned_officer_id uuid, dispatch_resource_id uuid, status text NOT NULL, outcome_notes text);
      CREATE TABLE public.welfare_alerts(id uuid PRIMARY KEY, organization_id uuid, officer_user_id uuid, shift_id uuid,
        status text NOT NULL DEFAULT 'pending', resolved_at timestamptz, resolved_by uuid, resolution_notes text);
      CREATE TABLE public.notification_calls(recipient uuid, category text, link_page text, dedup_key text);
      CREATE FUNCTION public.is_admin_for_org(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT auth.uid()='${admin}' AND p_org='${org}'
      $$;
      CREATE FUNCTION public.build_shift_safety_briefing(p_shift uuid, p_stop uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT jsonb_build_object('briefing_hash','hash-1','item_count',0,'items','[]'::jsonb)
      $$;
      CREATE FUNCTION public.enqueue_notification(p_organization_id uuid, p_category text, p_title text, p_body text,
        p_severity text, p_recipient_user_id uuid, p_recipient_role text DEFAULT NULL, p_link_page text DEFAULT NULL,
        p_link_payload jsonb DEFAULT NULL, p_dedup_key text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
        INSERT INTO public.notification_calls VALUES (p_recipient_user_id, p_category, p_link_page, p_dedup_key);
        SELECT gen_random_uuid();
      $$;
      -- Mirrors the live guard: the close is refused while jobs or alerts are still open.
      CREATE FUNCTION public.close_unfinished_officer_shift(p_client_request_id uuid, p_shift_id uuid, p_expected_status text,
        p_expected_updated_at timestamptz, p_actual_end timestamptz, p_reason text) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.dispatch_jobs j WHERE j.shift_id = p_shift_id AND j.status NOT IN ('completed', 'cancelled')) THEN
          RAISE EXCEPTION 'Complete or cancel this shift''s dispatch jobs before closing it';
        END IF;
        IF EXISTS (SELECT 1 FROM public.welfare_alerts w WHERE w.shift_id = p_shift_id AND w.status <> 'resolved') THEN
          RAISE EXCEPTION 'Resolve this shift''s welfare alerts before closing it';
        END IF;
        UPDATE public.shifts SET status='completed', actual_end=p_actual_end, updated_at=clock_timestamp()
        WHERE id=p_shift_id AND status=p_expected_status AND updated_at=p_expected_updated_at;
        IF NOT FOUND THEN RAISE EXCEPTION 'Shift changed since it was opened'; END IF;
        INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
        SELECT organization_id, auth.uid(), 'shift_supervisor_close', 'shifts', id,
          jsonb_build_object('client_request_id', p_client_request_id) FROM public.shifts WHERE id=p_shift_id;
        RETURN jsonb_build_object('replayed', false);
      END $$;
      INSERT INTO public.organizations VALUES ('${org}');
      INSERT INTO public.user_profiles VALUES ('${admin}','Roster Admin'),('${officer}','Field Officer');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,status,scheduled_start,actual_start)
        VALUES ('${shift}','${org}','${officer}','in_progress',now() - interval '9 hours',now() - interval '8 hours');
      INSERT INTO public.dispatch_jobs VALUES
        ('${job}','${org}','${shift}',gen_random_uuid(),'${officer}',gen_random_uuid(),'on_scene','Arrived at gate'),
        ('${approvalJob}','${org}','${shift}',NULL,'${officer}',NULL,'pending_approval',NULL),
        ('${doneJob}','${org}','${shift}',NULL,'${officer}',NULL,'completed','Done');
      INSERT INTO public.welfare_alerts(id,organization_id,officer_user_id,shift_id,status)
        VALUES ('${alert}','${org}','${officer}','${shift}','pending');
      INSERT INTO public.officer_gps_log(organization_id,officer_id,shift_id,gps_lat,gps_lng,accuracy_meters,recorded_at,physical_address) VALUES
        ('${org}','${officer}','${shift}',-41.1,173.1,8,now() - interval '3 hours','Last fix before finish'),
        ('${org}','${officer}','${shift}',-41.2,173.2,5,now() - interval '30 minutes','After the finish time'),
        ('${org}','${officer}',NULL,-41.3,173.3,5,now() - interval '20 hours','Before the shift');
    `);
    sql(original);
    sql(remoteStart);
    sql(migration);

    const preview = JSON.parse(sql(`BEGIN; ${as(admin)} SELECT public.get_admin_shift_finish_preview('${shift}')::text; COMMIT;`).trim());
    assert.equal(preview.open_dispatch_jobs, 2);
    assert.equal(preview.open_welfare_alerts, 1);
    assert.equal(preview.last_location.address, 'After the finish time');
    fails(`BEGIN; ${as(officer)} SELECT public.get_admin_shift_finish_preview('${shift}'); COMMIT;`, /Roster administrator access required/);

    const finishAt = `now() - interval '1 hour'`;
    const finish = (request, safe) => `BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${request}','${shift}',${updatedAt},'admin_finish',${finishAt},'Phone went flat, officer called in',false,${safe})::text; COMMIT;`;
    fails(finish(randomUUID(), false), /open welfare alerts\. Confirm you have checked the officer is safe/);
    fails(`BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${randomUUID()}','${shift}',${updatedAt},'admin_finish',now() - interval '12 hours','Phone went flat, officer called in',false,true); COMMIT;`, /finish time must be after the shift started/);
    assert.equal(sql(`SELECT status FROM public.shifts WHERE id='${shift}'`).trim(), 'in_progress');
    assert.equal(sql(`SELECT status FROM public.dispatch_jobs WHERE id='${job}'`).trim(), 'on_scene');

    const openedAt = sql(`SELECT updated_at FROM public.shifts WHERE id='${shift}'`).trim();
    const finishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const finishCall = `BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${finishRequest}','${shift}','${openedAt}','admin_finish','${finishedAt}','Phone went flat, officer called in',false,true)::text; COMMIT;`;
    const finished = JSON.parse(sql(finishCall).trim());
    assert.equal(finished.source, 'admin_finished_officer_shift');
    assert.equal(finished.shift_status, 'completed');
    assert.equal(finished.released_dispatch_jobs, 2);
    assert.equal(finished.resolved_welfare_alerts, 1);
    assert.equal(finished.finish_location.address, 'Last fix before finish');
    assert.equal(finished.finish_location.lat, -41.1);

    assert.equal(sql(`SELECT status||'|'||(shift_id IS NULL)::text||'|'||(shift_stop_id IS NULL)::text||'|'||(assigned_officer_id IS NULL)::text||'|'||(dispatch_resource_id IS NULL)::text FROM public.dispatch_jobs WHERE id='${job}'`).trim(), 'pending|true|true|true|true');
    assert.match(sql(`SELECT outcome_notes FROM public.dispatch_jobs WHERE id='${job}'`), /Arrived at gate\nReturned to the dispatch queue/);
    assert.equal(sql(`SELECT status FROM public.dispatch_jobs WHERE id='${approvalJob}'`).trim(), 'pending_approval');
    assert.equal(sql(`SELECT status||'|'||(shift_id IS NOT NULL)::text FROM public.dispatch_jobs WHERE id='${doneJob}'`).trim(), 'completed|true');
    assert.equal(sql(`SELECT status||'|'||resolved_by FROM public.welfare_alerts WHERE id='${alert}'`).trim(), `resolved|${admin}`);
    assert.equal(sql(`SELECT officer_safety_confirmed::text||'|'||cardinality(released_dispatch_job_ids)||'|'||finish_location_address FROM public.shift_admin_attendance_events WHERE client_request_id='${finishRequest}'`).trim(), 'true|2|Last fix before finish');
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action IN ('shift_supervisor_close','officer_shift_finished_by_admin')`).trim(), '2');
    assert.equal(sql(`SELECT dedup_key FROM public.notification_calls`).trim(), `admin_shift_finish:${shift}`);

    const replay = JSON.parse(sql(finishCall).trim());
    assert.equal(replay.replayed, true);
    assert.equal(replay.released_dispatch_jobs, 2);
    assert.equal(replay.finish_location.address, 'Last fix before finish');

    const attendance = sql(`BEGIN; ${as(admin)} SELECT finish_location_address||'|'||finish_released_dispatch_jobs||'|'||finish_resolved_welfare_alerts||'|'||admin_finish_by FROM public.get_roster_admin_attendance('${org}',ARRAY['${shift}'::uuid]); COMMIT;`).trim();
    assert.equal(attendance, 'Last fix before finish|2|1|Roster Admin');

    for (const fn of [signature.replace(/ /g, ''), 'public.get_admin_shift_finish_preview(uuid)']) {
      assert.equal(sql(`SELECT has_function_privilege('authenticated','${fn}','EXECUTE')`).trim(), 't');
      assert.equal(sql(`SELECT has_function_privilege('anon','${fn}','EXECUTE')`).trim(), 'f');
      assert.equal(sql(`SELECT has_function_privilege('service_role','${fn}','EXECUTE')`).trim(), 'f');
    }
    assert.equal(sql("SELECT count(*) FROM pg_proc WHERE proname='record_admin_shift_attendance'").trim(), '1');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
