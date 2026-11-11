'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '../supabase/migrations', file), 'utf8');
const original = read('20261109170000_roster_admin_attendance_events.sql');
const migration = read('20261112090000_admin_remote_shift_start.sql');
const squash = (text) => text.replace(/\s+/g, ' ');

test('admin start drives the real shift after a phone briefing and admin finish uses the supervisor close path', () => {
  const sql = squash(migration);
  assert.match(sql, /Owner direction 2026-11-12/);
  assert.match(sql, /SET status = 'in_progress', actual_start = p_recorded_at/);
  assert.match(sql, /IF NOT v_briefed THEN RAISE EXCEPTION 'Confirm you briefed the officer/);
  assert.match(sql, /'admin_phone', v_actor/);
  assert.match(sql, /PERFORM public\.close_unfinished_officer_shift\(p_client_request_id, v_shift\.id/);
  assert.match(sql, /PERFORM public\.enqueue_notification\(/);
  assert.match(sql, /WHERE applied_to_shift/);
  assert.match(sql, /'acknowledged_via', CASE WHEN/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.record_admin_shift_attendance\(uuid, uuid, timestamptz, text, timestamptz, text, boolean\) FROM PUBLIC, anon, service_role/);
  assert.doesNotMatch(sql, /admin_recorded_not_officer_attendance/);
});

test('admin remote start and finish run against the real shift in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-roster-admin-remote-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const org = '00000000-0000-4000-8000-000000000001';
  const admin = '00000000-0000-4000-8000-000000000002';
  const officer = '00000000-0000-4000-8000-000000000003';
  const shift = '00000000-0000-4000-8000-000000000004';
  const legacy = '00000000-0000-4000-8000-000000000005';
  const startRequest = '00000000-0000-4000-8000-000000000006';
  const finishRequest = '00000000-0000-4000-8000-000000000007';
  const as = (user) => `SET LOCAL request.jwt.claim.sub='${user}';`;
  const updatedAt = `(SELECT updated_at FROM public.shifts WHERE id='${shift}')`;
  const start = (request, briefed, reason = 'Officer phoned in from the site gate') => `BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${request}','${shift}',${updatedAt},'admin_start',now() - interval '10 minutes','${reason}',${briefed}); COMMIT;`;
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
      CREATE TABLE public.officer_gps_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), officer_id uuid,
        shift_id uuid, recorded_at timestamptz, physical_address text);
      CREATE TABLE public.notification_calls(recipient uuid, category text, link_page text, dedup_key text);
      CREATE FUNCTION public.is_admin_for_org(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT auth.uid()='${admin}' AND p_org='${org}'
      $$;
      CREATE FUNCTION public.build_shift_safety_briefing(p_shift uuid, p_stop uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT jsonb_build_object('briefing_hash','hash-1','item_count',2,'items','[]'::jsonb)
      $$;
      CREATE FUNCTION public.enqueue_notification(p_organization_id uuid, p_category text, p_title text, p_body text,
        p_severity text, p_recipient_user_id uuid, p_recipient_role text DEFAULT NULL, p_link_page text DEFAULT NULL,
        p_link_payload jsonb DEFAULT NULL, p_dedup_key text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
        INSERT INTO public.notification_calls VALUES (p_recipient_user_id, p_category, p_link_page, p_dedup_key);
        SELECT gen_random_uuid();
      $$;
      CREATE FUNCTION public.close_unfinished_officer_shift(p_client_request_id uuid, p_shift_id uuid, p_expected_status text,
        p_expected_updated_at timestamptz, p_actual_end timestamptz, p_reason text) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT public.is_admin_for_org((SELECT organization_id FROM public.shifts WHERE id = p_shift_id)) THEN
          RAISE EXCEPTION 'Shift not found or access denied';
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
      INSERT INTO public.shifts(id,organization_id,officer_user_id,status,scheduled_start)
        VALUES ('${shift}','${org}','${officer}','accepted',now() - interval '30 minutes');
      CREATE FUNCTION public.require_shift_safety_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_briefing jsonb;
      BEGIN
        IF NEW.status = 'in_progress' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'in_progress') THEN
          v_briefing := public.build_shift_safety_briefing(NEW.id, NULL);
          IF (v_briefing->>'item_count')::integer > 0 AND NOT EXISTS (
            SELECT 1 FROM public.safety_briefing_acknowledgements a
            WHERE a.shift_id = NEW.id AND a.officer_user_id = NEW.officer_user_id
              AND a.shift_stop_id IS NULL AND a.briefing_hash = v_briefing->>'briefing_hash'
          ) THEN
            RAISE EXCEPTION 'The assigned officer must read and acknowledge the current site risks before starting this shift.';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER shifts_require_safety_briefing AFTER INSERT OR UPDATE OF status ON public.shifts
        FOR EACH ROW EXECUTE FUNCTION public.require_shift_safety_acknowledgement();
      CREATE FUNCTION public.tg_notify_shift_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF coalesce(current_setting('fcm.silent_shift_notice', true), 'off') = 'on' THEN RETURN NEW; END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          INSERT INTO public.notification_calls VALUES (NEW.officer_user_id, 'roster', 'schedule', 'shift_change:' || NEW.id);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_notify_shift_change AFTER UPDATE ON public.shifts FOR EACH ROW EXECUTE FUNCTION public.tg_notify_shift_change();
    `);
    sql(original);
    sql(`BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${legacy}','${shift}',${updatedAt},'admin_start',now() - interval '20 minutes','Legacy reported start time'); COMMIT;`);
    sql(migration);

    fails(start(startRequest, false), /briefed the officer on the site and its risks by phone/);
    fails(`BEGIN; ${as(officer)} SELECT public.record_admin_shift_attendance('${startRequest}','${shift}',${updatedAt},'admin_start',now() - interval '10 minutes','Officer phoned in',true); COMMIT;`, /Roster administrator access required/);

    const otherShift = '00000000-0000-4000-8000-000000000008';
    sql(`SET session_replication_role = replica; INSERT INTO public.shifts(id,organization_id,officer_user_id,status,scheduled_start,actual_start) VALUES ('${otherShift}','${org}','${officer}','in_progress',now() - interval '9 hours',now() - interval '9 hours'); RESET session_replication_role;`);
    fails(start(randomUUID(), true), /still on another shift/);
    sql(`UPDATE public.shifts SET status='completed', actual_end=now() - interval '1 hour' WHERE id='${otherShift}'`);
    sql('DELETE FROM public.notification_calls');

    const openedAt = sql(`SELECT updated_at FROM public.shifts WHERE id='${shift}'`).trim();
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const startCall = `BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${startRequest}','${shift}','${openedAt}','admin_start','${startedAt}','Officer phoned in from the site gate',true)::text; COMMIT;`;
    const started = JSON.parse(sql(startCall).trim());
    assert.equal(started.source, 'admin_started_officer_shift');
    assert.equal(started.replayed, false);
    assert.equal(sql(`SELECT status||'|'||(actual_start IS NOT NULL)::text||'|'||(actual_end IS NULL)::text FROM public.shifts WHERE id='${shift}'`).trim(), 'in_progress|true|true');
    assert.equal(sql(`SELECT acknowledged_via||'|'||recorded_by||'|'||officer_user_id||'|'||briefing_hash FROM public.safety_briefing_acknowledgements`).trim(), `admin_phone|${admin}|${officer}|hash-1`);
    assert.equal(sql(`SELECT metadata->>'started_by'||'|'||(metadata->'start_position'->>'status') FROM public.audit_log WHERE action='officer_shift_started'`).trim(), 'administrator|admin_confirmed_by_phone');
    assert.equal(sql(`SELECT recipient||'|'||category||'|'||link_page||'|'||dedup_key FROM public.notification_calls`).trim(), `${officer}|roster|schedule|admin_shift_start:${shift}`);

    const replay = JSON.parse(sql(startCall).trim());
    assert.equal(replay.replayed, true);
    assert.equal(replay.source, 'admin_started_officer_shift');
    assert.equal(sql('SELECT count(*) FROM public.safety_briefing_acknowledgements').trim(), '1');
    fails(start(randomUUID(), true), /already started/);

    assert.equal(sql(`BEGIN; ${as(admin)} SELECT location_captured_at IS NULL FROM public.get_roster_admin_attendance('${org}',ARRAY['${shift}'::uuid]); COMMIT;`).trim(), 't');
    sql(`INSERT INTO public.officer_gps_log(officer_id, shift_id, recorded_at, physical_address) VALUES ('${officer}','${shift}',now(),'12 Gate Road')`);
    const attendance = sql(`BEGIN; ${as(admin)} SELECT (admin_start IS NOT NULL)::text||'|'||admin_start_by||'|'||location_address FROM public.get_roster_admin_attendance('${org}',ARRAY['${shift}'::uuid]); COMMIT;`).trim();
    assert.equal(attendance, 'true|Roster Admin|12 Gate Road');

    const finish = JSON.parse(sql(`BEGIN; ${as(admin)} SELECT public.record_admin_shift_attendance('${finishRequest}','${shift}',${updatedAt},'admin_finish',now() - interval '1 minute','Officer phoned to say they had left site')::text; COMMIT;`).trim());
    assert.equal(finish.source, 'admin_finished_officer_shift');
    assert.equal(finish.shift_status, 'completed');
    assert.equal(sql(`SELECT string_agg(dedup_key, ',' ORDER BY dedup_key) FROM public.notification_calls`).trim(), `admin_shift_finish:${shift},admin_shift_start:${shift}`);
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='shift_supervisor_close'`).trim(), '1');
    assert.equal(sql(`SELECT count(*) FROM public.shift_admin_attendance_events WHERE applied_to_shift`).trim(), '2');
    assert.equal(sql(`SELECT count(*) FROM public.shift_admin_attendance_events WHERE NOT applied_to_shift`).trim(), '1');

    assert.equal(sql("SELECT has_function_privilege('authenticated','public.record_admin_shift_attendance(uuid,uuid,timestamptz,text,timestamptz,text,boolean)','EXECUTE')").trim(), 't');
    assert.equal(sql("SELECT has_function_privilege('anon','public.record_admin_shift_attendance(uuid,uuid,timestamptz,text,timestamptz,text,boolean)','EXECUTE')").trim(), 'f');
    assert.equal(sql("SELECT has_function_privilege('service_role','public.record_admin_shift_attendance(uuid,uuid,timestamptz,text,timestamptz,text,boolean)','EXECUTE')").trim(), 'f');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
