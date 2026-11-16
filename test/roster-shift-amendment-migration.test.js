'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261116001241_roster_shift_amendments.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const liveFunction = (name) => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.notEqual(start, -1, `${name} must exist in the canonical snapshot`);
  const end = schema.indexOf('$function$;', start);
  assert.notEqual(end, -1, `${name} must have a complete body`);
  return schema.slice(start, end + '$function$;'.length);
};
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const liveTable = (name) => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.notEqual(start, -1, `${name} must exist in the canonical snapshot`);
  return schema.slice(start, schema.indexOf('\n);', start) + 4);
};

test('roster edit context and amendments enforce active authority, versions and replay', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 120_000,
}, async () => {
  const container = `fcm-roster-amend-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sql = (input) => docker([
    'exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
  ], input);
  const as = (actor, role = 'authenticated') => `BEGIN; SET LOCAL ROLE ${role};
    SET LOCAL request.jwt.claim.sub='${actor}';`;
  const fails = (input, pattern) => assert.throws(() => sql(input),
    (error) => pattern.test(String(error.stderr ?? error.message)));
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    sql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      CREATE TABLE organizations(id uuid PRIMARY KEY, active boolean);
      CREATE TABLE user_profiles(id uuid PRIMARY KEY, organization_id uuid, role text, deactivated_at timestamptz,
        employer_organization_id uuid);
      CREATE TABLE roster_work_units(id uuid PRIMARY KEY, organization_id uuid, work_unit_type text,
        service_type text, name text DEFAULT 'Synthetic work unit', active boolean, patrol_route_id uuid, service_agreement_location_id uuid,
        service_agreement_module_id uuid, required_skill_names text[] NOT NULL DEFAULT '{}');
      CREATE TABLE staff_profiles(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, work_ready boolean);
      CREATE TABLE audit_log(id bigserial PRIMARY KEY, organization_id uuid, actor_user_id uuid,
        action text, target_table text, target_id uuid, metadata jsonb, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE roster_slots(id uuid PRIMARY KEY, organization_id uuid, work_unit_id uuid,
        staff_id uuid, scheduled_start timestamptz, scheduled_end timestamptz, status text,
        linked_shift_id uuid, notes text, planned_break_minutes integer, break_unpaid boolean,
        external_refs jsonb NOT NULL DEFAULT '{}', updated_at timestamptz DEFAULT clock_timestamp(),
        client_request_id uuid DEFAULT gen_random_uuid(), created_by uuid);
      ALTER TABLE roster_slots ALTER COLUMN id SET DEFAULT gen_random_uuid();
      ALTER TABLE roster_slots ALTER COLUMN status SET DEFAULT 'draft';
      ALTER TABLE roster_slots ALTER COLUMN planned_break_minutes SET DEFAULT 0;
      ALTER TABLE roster_slots ALTER COLUMN break_unpaid SET DEFAULT false;
      ALTER TABLE roster_slots ADD CONSTRAINT roster_slots_planned_break_check CHECK
        (planned_break_minutes >= 0 AND planned_break_minutes <= 240
          AND planned_break_minutes < extract(epoch FROM scheduled_end-scheduled_start)/60);
      CREATE TABLE shifts(id uuid PRIMARY KEY, organization_id uuid, officer_user_id uuid, status text,
        scheduled_start timestamptz, scheduled_end timestamptz, actual_start timestamptz, actual_end timestamptz,
        updated_at timestamptz DEFAULT clock_timestamp(), service_type text, location_id uuid, zone_id uuid,
        patrol_route_id uuid, roster_slot_id uuid, notes text, ended_reason text,
        total_stops integer DEFAULT 0, completed_stops integer DEFAULT 0, generated_at timestamptz,
        service_agreement_location_id uuid,service_agreement_module_id uuid);
      ALTER TABLE shifts ALTER COLUMN id SET DEFAULT gen_random_uuid();
      CREATE TABLE roster_slot_contacts(roster_slot_id uuid PRIMARY KEY, contact_name text, contact_phone text,
        version uuid DEFAULT gen_random_uuid(), updated_at timestamptz DEFAULT clock_timestamp(), updated_by uuid);
      CREATE TABLE dispatch_jobs(id uuid PRIMARY KEY, shift_id uuid, status text, organization_id uuid,
        shift_stop_id uuid, assigned_officer_id uuid, dispatch_resource_id uuid, outcome_notes text);
      CREATE TABLE welfare_alerts(id uuid PRIMARY KEY, shift_id uuid, status text, organization_id uuid,
        resolved_at timestamptz, resolved_by uuid, resolution_notes text);
      CREATE TABLE staff_branch_authorisations(user_id uuid, branch_org_id uuid, status text, can_be_rostered boolean,
        starts_on date, ends_on date);
      CREATE TABLE leave_requests(staff_id uuid, status text, starts_on date, ends_on date);
      CREATE TABLE service_agreement_locations(id uuid, status text, site_id uuid, zone_id uuid, service_agreement_id uuid);
      CREATE TABLE service_agreement_modules(id uuid, service_agreement_id uuid, enabled boolean, module_key text);
      CREATE TABLE client_sites(id uuid, location_id uuid);
      CREATE TABLE patrols(id uuid, shift_id uuid, status text);
      CREATE TABLE shift_stop_actions(id uuid, shift_id uuid);
      CREATE TABLE staff_skills(staff_id uuid, skill_name text, certified boolean, certification_expiry date);
      CREATE TABLE notification_calls(recipient uuid, payload jsonb, dedup_key text);
      CREATE TABLE validation_flags(unavailable boolean, fatigue text, unavailable_staff uuid);
      INSERT INTO validation_flags VALUES(false,NULL,NULL);
      CREATE FUNCTION public.staff_has_roster_availability_conflict(uuid,timestamptz,timestamptz)
        RETURNS boolean LANGUAGE sql AS $$
          SELECT unavailable OR coalesce($1=unavailable_staff,false) FROM public.validation_flags
        $$;
      CREATE FUNCTION public.staff_fatigue_conflict(uuid,timestamptz,timestamptz,uuid)
        RETURNS text LANGUAGE sql AS $$ SELECT fatigue FROM public.validation_flags $$;
      CREATE FUNCTION public.get_descendant_organizations(uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT '{}'::uuid[] $$;
      CREATE FUNCTION public.enqueue_notification(p_organization_id uuid,p_category text,p_title text,p_body text,
        p_severity text,p_recipient_user_id uuid,p_recipient_role text DEFAULT NULL,p_link_page text DEFAULT NULL,
        p_link_payload jsonb DEFAULT NULL,p_dedup_key text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
        INSERT INTO public.notification_calls VALUES(p_recipient_user_id,p_link_payload,p_dedup_key);
        SELECT gen_random_uuid();
      $$;
      ${liveTable('shift_stops')}
      ${liveTable('shift_stop_modules')}
      ${liveTable('shift_breaks')}
      ${liveTable('shift_admin_attendance_events')}
      ${liveTable('organization_fatigue_rules')}
      CREATE TABLE officer_gps_log(id uuid PRIMARY KEY, organization_id uuid, officer_id uuid,
        shift_id uuid, gps_lat double precision, gps_lng double precision, accuracy_meters double precision,
        recorded_at timestamptz, physical_address text);
      CREATE FUNCTION public.is_admin_for_org(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = '' AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles p WHERE p.id=auth.uid()
          AND p.organization_id=target AND p.role IN ('admin','admin_officer') AND p.deactivated_at IS NULL)
      $$;
      CREATE FUNCTION public.user_can_operate_organization(target uuid) RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT public.is_admin_for_org(target) $$;
      INSERT INTO organizations VALUES ('${id(100)}',true),('${id(200)}',true);
      INSERT INTO user_profiles(id,organization_id,role,deactivated_at) VALUES
        ('${id(1)}','${id(100)}','admin',NULL),
        ('${id(2)}','${id(200)}','admin',NULL),
        ('${id(3)}','${id(100)}','admin',now()),
        ('${id(4)}','${id(100)}','officer',NULL),
        ('${id(5)}','${id(100)}','officer',NULL);
      INSERT INTO shifts(id,organization_id,officer_user_id,status,scheduled_start,scheduled_end,actual_start)
        VALUES ('${id(500)}','${id(100)}','${id(4)}','in_progress',
          now()-interval '2 hours',now()+interval '6 hours',now()-interval '2 hours');
      INSERT INTO roster_slots(id,organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,
        status,linked_shift_id,notes,planned_break_minutes,break_unpaid)
        VALUES ('${id(300)}','${id(100)}','${id(10)}','${id(21)}',now()-interval '2 hours',
          now()+interval '6 hours','accepted','${id(500)}','Synthetic briefing',30,true);
      INSERT INTO roster_slot_contacts(roster_slot_id,contact_name,contact_phone,version)
        VALUES ('${id(300)}','Synthetic duty contact','03 555 1234','${id(700)}');
      INSERT INTO roster_work_units(id,organization_id,work_unit_type,service_type,active,patrol_route_id,
        service_agreement_location_id,service_agreement_module_id) VALUES
        ('${id(10)}','${id(100)}','static','static_guarding',true,NULL,NULL,NULL),
        ('${id(11)}','${id(100)}','internal','administration',true,NULL,NULL,NULL);
      INSERT INTO staff_profiles VALUES ('${id(21)}','${id(4)}','${id(100)}',true),
        ('${id(22)}','${id(5)}','${id(100)}',true);
      INSERT INTO service_agreement_locations VALUES('${id(31)}','active','${id(33)}',NULL,'${id(30)}');
      INSERT INTO service_agreement_modules VALUES('${id(32)}','${id(30)}',true,'static_guarding');
      INSERT INTO client_sites VALUES('${id(33)}','${id(34)}');
      UPDATE roster_work_units SET service_agreement_location_id='${id(31)}',service_agreement_module_id='${id(32)}'
        WHERE id='${id(10)}';
      INSERT INTO roster_slots(id,organization_id,work_unit_id,scheduled_start,scheduled_end,
        status,notes,planned_break_minutes,break_unpaid)
        VALUES ('${id(301)}','${id(100)}','${id(11)}','2099-01-01T08:00:00Z',
          '2099-01-01T16:00:00Z','draft','Original synthetic briefing',0,false);
      INSERT INTO dispatch_jobs(id,shift_id,status) VALUES ('${id(800)}','${id(500)}','on_scene');
      INSERT INTO welfare_alerts(id,shift_id,status) VALUES ('${id(900)}','${id(500)}','pending');
      ${['create_roster_slot','set_roster_slot_break','create_roster_slot_with_break',
        'create_roster_shift','materialize_roster_slot_core','materialize_roster_slot','manage_roster_slot',
        'set_roster_slot_contact','close_unfinished_officer_shift','record_admin_shift_attendance',
        'enforce_roster_slot_availability','tg_enforce_roster_slot_skill_requirements',
        'tg_touch_updated_at'].map(liveFunction).join('\n')}
      ${liveFunction('roster_assignment_load')}
      ${liveFunction('staff_fatigue_conflict')}
      CREATE TRIGGER availability BEFORE INSERT OR UPDATE OF staff_id,scheduled_start,scheduled_end,status
        ON roster_slots FOR EACH ROW EXECUTE FUNCTION enforce_roster_slot_availability();
      CREATE TRIGGER skills BEFORE INSERT OR UPDATE OF staff_id,work_unit_id
        ON roster_slots FOR EACH ROW EXECUTE FUNCTION tg_enforce_roster_slot_skill_requirements();
      CREATE TRIGGER touch BEFORE UPDATE ON roster_slots FOR EACH ROW EXECUTE FUNCTION tg_touch_updated_at();
      GRANT SELECT,UPDATE ON roster_slots,shifts TO authenticated;
      ${liveFunction('get_admin_shift_finish_preview')}
      ${migration}
    `);
    const context = JSON.parse(sql(`${as(id(1))}
      SELECT public.get_roster_slot_edit_context('${id(300)}')::text; COMMIT;`).trim());
    assert.equal(context.slot.id, id(300));
    assert.equal(context.slot.planned_break_minutes, 30);
    assert.equal(context.slot.break_unpaid, true);
    assert.ok(context.slot.updated_at);
    assert.equal(context.shift.id, id(500));
    assert.equal(context.shift.status, 'in_progress');
    assert.ok(context.shift.actual_start);
    assert.equal(context.shift.actual_end, null);
    assert.ok(context.shift.updated_at);
    assert.equal(context.contact.version, id(700));
    assert.equal(context.finish_preview.open_dispatch_jobs, 1);
    assert.equal(context.finish_preview.open_welfare_alerts, 1);
    for (const actor of [id(2), id(3), id(4)]) {
      fails(`${as(actor)} SELECT public.get_roster_slot_edit_context('${id(300)}'); COMMIT;`,
        /administrator|access|authori[sz]/i);
    }
    fails(`${as('', 'anon')} SELECT public.get_roster_slot_edit_context('${id(300)}'); COMMIT;`,
      /permission denied/i);
    fails(`${as(id(1))} SELECT public.get_roster_slot_edit_context('${id(999)}'); COMMIT;`,
      /not found|access/i);
    const open = JSON.parse(sql(`${as(id(1))}
      SELECT public.get_roster_slot_edit_context('${id(301)}')::text; COMMIT;`).trim());
    assert.equal(open.slot.staff_id, null);
    assert.equal(open.shift, null);
    assert.equal(open.contact, null);
    assert.equal(open.finish_preview, null);

    const changes = {
      staff_id: null, work_unit_id: id(11),
      scheduled_start: '2099-01-01T08:00:00Z', scheduled_end: '2099-01-01T16:00:00Z',
      planned_break_minutes: 30, break_unpaid: true, notes: 'Revised synthetic briefing',
      contact_name: null, contact_phone: null, expected_contact_version: null,
    };
    const request = id(1000);
    const amend = (actor, requestId, delta = changes, expected = open.slot.updated_at) => `${as(actor)}
      SELECT public.amend_roster_slot('${requestId}','${id(301)}','${expected}',NULL,
        '${JSON.stringify(delta).replaceAll("'", "''")}'::jsonb,'Confirmed revised briefing',NULL,false)::text; COMMIT;`;
    fails(amend(id(1), open.slot.client_request_id), /request.*already|different amendment/i);
    const receipt = JSON.parse(sql(amend(id(1), request)).trim());
    assert.equal(receipt.client_request_id, request);
    assert.equal(receipt.slot_id, id(301));
    assert.equal(receipt.source, 'roster_slot_amended');
    assert.equal(receipt.shift_id, null);
    assert.equal(receipt.replacement_slot_id, null);
    assert.equal(receipt.replacement_shift_id, null);
    assert.equal(receipt.replayed, false);
    const saved = JSON.parse(sql(`SELECT row_to_json(s) FROM roster_slots s WHERE id='${id(301)}'`).trim());
    assert.equal(saved.notes, changes.notes);
    assert.equal(saved.planned_break_minutes, 30);
    assert.equal(saved.break_unpaid, true);
    assert.equal(saved.staff_id, null);
    assert.notEqual(saved.updated_at, open.slot.updated_at);
    const auditCount = sql(`SELECT count(*) FROM audit_log`).trim();
    const replay = JSON.parse(sql(amend(id(1), request)).trim());
    assert.equal(replay.replayed, true);
    assert.equal(replay.slot_updated_at, receipt.slot_updated_at);
    assert.equal(sql(`SELECT count(*) FROM audit_log`).trim(), auditCount);
    fails(amend(id(1), request, { ...changes, notes: 'Different request content' }), /request.*different|already used/i);
    fails(amend(id(1), id(1001)), /changed|reload/i);
    for (const actor of [id(2), id(3), id(4)]) {
      fails(amend(actor, randomUUID(), changes, saved.updated_at), /administrator|access|authori[sz]/i);
    }
    for (const delta of [
      { ...changes, actual_start: '2099-01-01T08:00:00Z' },
      { ...changes, scheduled_end: '2099-01-01T07:00:00Z' },
      { ...changes, planned_break_minutes: 480 },
      { ...changes, planned_break_minutes: -1 },
      { ...changes, planned_break_minutes: 0.5 },
      { ...changes, break_unpaid: 'true' },
      { ...changes, staff_id: 21 },
      { ...changes, work_unit_id: null },
    ]) {
      fails(amend(id(1), randomUUID(), delta, saved.updated_at),
        /unsupported|unknown|invalid|required|break|tim|type|after|unit/i);
      assert.equal(sql(`SELECT count(*) FROM audit_log`).trim(), auditCount);
    }

    const liveChanges = {
      staff_id: id(21), work_unit_id: id(10),
      scheduled_start: context.slot.scheduled_start, scheduled_end: context.slot.scheduled_end,
      planned_break_minutes: 20, break_unpaid: true, notes: 'Updated live briefing',
      contact_name: 'Revised synthetic contact', contact_phone: '03 555 5678', expected_contact_version: id(700),
    };
    const liveCall = (requestId, delta = liveChanges, slotVersion = context.slot.updated_at,
      shiftVersion = context.shift.updated_at, handover = null, safe = false) => `${as(id(1))}
      SELECT public.amend_roster_slot('${requestId}','${id(300)}','${slotVersion}','${shiftVersion}',
        '${JSON.stringify(delta).replaceAll("'", "''")}'::jsonb,'Confirmed revised live briefing',
        ${handover ? `'${handover}'` : 'NULL'},${safe})::text; COMMIT;`;
    sql(`UPDATE roster_work_units SET active=false WHERE id='${id(10)}';
      UPDATE validation_flags SET unavailable=true,fatigue='Synthetic fatigue restriction';`);
    const liveReceipt = JSON.parse(sql(liveCall(id(1100))).trim());
    assert.equal(liveReceipt.source, 'roster_slot_amended');
    const persistedShift = JSON.parse(sql(`SELECT row_to_json(s) FROM shifts s WHERE id='${id(500)}'`).trim());
    assert.equal(persistedShift.officer_user_id, id(4));
    assert.equal(persistedShift.actual_start, context.shift.actual_start);
    assert.equal(persistedShift.actual_end, null);
    assert.equal(persistedShift.status, 'in_progress');
    assert.equal(persistedShift.notes, liveChanges.notes);
    assert.equal(sql(`SELECT status FROM dispatch_jobs WHERE id='${id(800)}'`).trim(), 'on_scene');
    assert.equal(sql(`SELECT status FROM welfare_alerts WHERE id='${id(900)}'`).trim(), 'pending');
    const currentLive = JSON.parse(sql(`${as(id(1))} SELECT get_roster_slot_edit_context('${id(300)}'); COMMIT;`).trim());
    fails(liveCall(randomUUID(), liveChanges, currentLive.slot.updated_at, currentLive.shift.updated_at),
      /contact.*changed|contact.*version/i);
    fails(liveCall(randomUUID(), { ...liveChanges, expected_contact_version: currentLive.contact.version },
      currentLive.slot.updated_at, '2000-01-01T00:00:00Z'), /shift.*changed|reload/i);
    sql(`UPDATE roster_work_units SET active=true WHERE id='${id(10)}';
      UPDATE validation_flags SET unavailable=false,fatigue=NULL;`);
    sql(`INSERT INTO shifts(id,organization_id,officer_user_id,status,scheduled_start,scheduled_end)
      VALUES('${id(550)}','${id(100)}','${id(4)}','published',now()+interval '6 hours',now()+interval '9 hours')`);
    fails(liveCall(id(1150), { ...liveChanges, expected_contact_version: currentLive.contact.version,
      scheduled_end: new Date(Date.now() + 7 * 3600_000).toISOString() },
    currentLive.slot.updated_at, currentLive.shift.updated_at), /overlap/i);
    sql(`DELETE FROM shifts WHERE id='${id(550)}'`);

    let raceContext = JSON.parse(sql(`${as(id(1))} SELECT get_roster_slot_edit_context('${id(301)}'); COMMIT;`).trim());
    const execDocker = promisify(execFile);
    const race = (requestId, note, hold) => execDocker('docker', [
      'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
      '-c', `${as(id(1))}${hold === true ? `SELECT 1 FROM roster_slots WHERE id='${id(301)}' FOR UPDATE; SELECT pg_sleep(0.5);` : ''}
        SELECT amend_roster_slot('${requestId}','${id(301)}','${raceContext.slot.updated_at}',NULL,
        '${JSON.stringify({ ...changes, notes: note })}'::jsonb,'Concurrent roster save',NULL,false);
        ${hold === 'after' ? 'SELECT pg_sleep(0.5);' : ''} COMMIT;`,
    ], { encoding: 'utf8' });
    const outcomes = await Promise.allSettled([
      race(id(1200), 'First concurrent briefing', true),
      race(id(1201), 'Second concurrent briefing', false),
    ]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
    for (const result of outcomes) if (result.status === 'rejected') {
      assert.match(String(result.reason.stderr), /changed|reload/i);
    }
    raceContext = JSON.parse(sql(`${as(id(1))} SELECT get_roster_slot_edit_context('${id(301)}'); COMMIT;`).trim());
    const duplicates = await Promise.all([
      race(id(1202), 'Identical concurrent briefing', 'after'),
      race(id(1202), 'Identical concurrent briefing', false),
    ]);
    assert.equal(duplicates.length, 2);
    assert.equal(sql(`SELECT count(*) FROM audit_log WHERE action='roster_slot_amended'
      AND metadata->>'client_request_id'='${id(1202)}'`).trim(), '1');
    const waitForSleep = async (name) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${name}'
          AND wait_event='PgSleep'`).trim() === '1') return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Concurrent transaction ${name} did not reach its lock checkpoint`);
    };
    const backgroundSql = (input) => execDocker('docker', [
      'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c', input,
    ], { encoding: 'utf8' });
    sql(`INSERT INTO roster_slots(id,organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,status)
      VALUES ('${id(310)}','${id(100)}','${id(11)}','${id(22)}','2099-02-01T08:00Z','2099-02-01T10:00Z','draft'),
        ('${id(311)}','${id(100)}','${id(11)}','${id(22)}','2099-02-01T14:00Z','2099-02-01T16:00Z','draft')`);
    const firstVersion = sql(`SELECT updated_at FROM roster_slots WHERE id='${id(310)}'`).trim();
    const secondVersion = sql(`SELECT updated_at FROM roster_slots WHERE id='${id(311)}'`).trim();
    const firstAssignment = backgroundSql(`${as(id(1))}
      SET LOCAL application_name='roster-staff-assignment-race';
      SELECT amend_roster_slot('${id(1210)}','${id(310)}','${firstVersion}',NULL,
        '${JSON.stringify({ ...changes, staff_id: id(22), scheduled_start: '2099-02-01T08:00Z',
    scheduled_end: '2099-02-01T12:00Z' })}',
        'Extend the first assignment',NULL,false); SELECT pg_sleep(1.5); COMMIT;`);
    await waitForSleep('roster-staff-assignment-race');
    try {
      fails(`${as(id(1))} SELECT amend_roster_slot('${id(1211)}','${id(311)}','${secondVersion}',NULL,
        '${JSON.stringify({ ...changes, staff_id: id(22), scheduled_start: '2099-02-01T11:00Z',
    scheduled_end: '2099-02-01T13:00Z' })}',
        'Move the second assignment',NULL,false); COMMIT;`, /overlap|concurrent|retry|lock/i);
      fails(`${as(id(1))} SELECT create_roster_slot('${id(1212)}','${id(11)}','${id(22)}',
        '2099-02-01T11:00Z','2099-02-01T13:00Z',false,'Competing creation'); COMMIT;`,
      /overlap|concurrent|retry|lock/i);
      fails(`${as(id(1))} SELECT create_roster_shift('${id(5)}','patrol',
        '2099-02-01T11:00Z','2099-02-01T13:00Z',NULL,NULL,NULL,
        'Competing field creation',false,'${id(100)}'); COMMIT;`,
      /overlap|concurrent|retry|lock/i);
    } finally {
      await firstAssignment;
    }
    assert.equal(sql(`SELECT scheduled_start='2099-02-01T14:00Z'::timestamptz
      FROM roster_slots WHERE id='${id(311)}'`).trim(), 't');
    sql(`DELETE FROM roster_slots WHERE id IN ('${id(310)}','${id(311)}')`);
    const finishLock = execDocker('docker', [
      'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
      '-c', `${as(id(1))} SET LOCAL application_name='roster-finish-race';
        SELECT id FROM shifts WHERE id='${id(500)}' FOR UPDATE; SELECT pg_sleep(0.7);
        SELECT record_admin_shift_attendance('${id(1250)}','${id(500)}','${currentLive.shift.updated_at}',
          'admin_finish',clock_timestamp(),'Concurrent authorized finish',false,true); ROLLBACK;`,
    ], { encoding: 'utf8' });
    let finishReady = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      finishReady = sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='roster-finish-race'
        AND wait_event='PgSleep'`).trim() === '1';
      if (finishReady) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(finishReady, 'Concurrent real finish must hold the shift lock');
    fails(liveCall(id(1251), { ...liveChanges, expected_contact_version: currentLive.contact.version },
      currentLive.slot.updated_at, currentLive.shift.updated_at), /lock|could not obtain/i);
    await finishLock;

    sql(`
      INSERT INTO roster_work_units(id,organization_id,work_unit_type,service_type,active,patrol_route_id)
        VALUES ('${id(12)}','${id(100)}','patrol','patrol',true,'${id(13)}');
      UPDATE roster_slots SET work_unit_id='${id(12)}' WHERE id='${id(300)}';
      UPDATE shifts SET service_type='patrol',patrol_route_id='${id(13)}',roster_slot_id='${id(300)}' WHERE id='${id(500)}';
      INSERT INTO shift_stops(id,organization_id,shift_id,site_id,module_key,stop_order,sla_arrive_by,
        status,actual_arrived_at,actual_departed_at) VALUES
        ('${id(601)}','${id(100)}','${id(500)}','${id(14)}','patrol',1,now(),'completed',now()-interval '1 hour',now()-interval '50 minutes'),
        ('${id(602)}','${id(100)}','${id(500)}','${id(15)}','patrol',2,now(),'pending',NULL,NULL),
        ('${id(603)}','${id(100)}','${id(500)}','${id(16)}','patrol',3,now()+interval '1 hour','en_route',NULL,NULL);
      INSERT INTO shift_stop_modules(organization_id,shift_stop_id,module_key,is_required)
        VALUES ('${id(100)}','${id(602)}','patrol',true),('${id(100)}','${id(603)}','patrol',true);
      DELETE FROM roster_slot_contacts WHERE roster_slot_id='${id(300)}';
    `);
    const handoverContext = JSON.parse(sql(`${as(id(1))} SELECT get_roster_slot_edit_context('${id(300)}'); COMMIT;`).trim());
    const handoverAt = new Date(Date.now() - 1000).toISOString();
    const handoverChanges = {
      ...liveChanges, staff_id: id(22), work_unit_id: id(12), scheduled_start: handoverAt,
      contact_name: null, contact_phone: null, expected_contact_version: null,
    };
    const handoverCall = (requestId, safe) => liveCall(requestId, handoverChanges,
      handoverContext.slot.updated_at, handoverContext.shift.updated_at, handoverAt, safe);
    const completedBefore = sql(`SELECT row_to_json(s) FROM shift_stops s WHERE id='${id(601)}'`).trim();
    const beforeHandover = sql(`SELECT row_to_json(s) FROM shifts s WHERE id='${id(500)}'`).trim();
    fails(handoverCall(id(1300), false), /welfare|safe/i);
    assert.equal(sql(`SELECT row_to_json(s) FROM shifts s WHERE id='${id(500)}'`).trim(), beforeHandover);
    sql(`UPDATE staff_profiles SET work_ready=false WHERE id='${id(22)}'`);
    fails(handoverCall(id(1300), true), /work.ready/i);
    assert.equal(sql(`SELECT row_to_json(s) FROM shifts s WHERE id='${id(500)}'`).trim(), beforeHandover);
    assert.equal(sql(`SELECT count(*) FROM shifts`).trim(), '1');
    assert.equal(sql(`SELECT status FROM dispatch_jobs WHERE id='${id(800)}'`).trim(), 'on_scene');
    sql(`UPDATE staff_profiles SET work_ready=true WHERE id='${id(22)}'`);
    sql(`UPDATE validation_flags SET unavailable_staff='${id(22)}'`);
    fails(handoverCall(id(1300), true), /unavailable/i);
    assert.equal(sql(`SELECT row_to_json(s) FROM shifts s WHERE id='${id(500)}'`).trim(), beforeHandover);
    sql('UPDATE validation_flags SET unavailable_staff=NULL');
    const stopCancellation = backgroundSql(`BEGIN;
      SET LOCAL application_name='roster-stop-cancellation-race';
      UPDATE shift_stops SET status='cancelled' WHERE id='${id(602)}';
      SELECT pg_sleep(1.5); ROLLBACK;`);
    await waitForSleep('roster-stop-cancellation-race');
    try {
      fails(handoverCall(id(1299), true).replace('COMMIT;', 'ROLLBACK;'), /lock|concurrent|retry/i);
    } finally {
      await stopCancellation;
    }
    assert.equal(sql(`SELECT status FROM shifts WHERE id='${id(500)}'`).trim(), 'in_progress');
    sql(`UPDATE validation_flags SET unavailable_staff='${id(21)}'`);
    const handoverReceipt = JSON.parse(sql(handoverCall(id(1300), true)).trim());
    fails(`${as(id(1))} UPDATE roster_slots SET scheduled_end=scheduled_end+interval '1 hour'
      WHERE id='${id(300)}'; ROLLBACK;`, /unavailable/i);
    sql('UPDATE validation_flags SET unavailable_staff=NULL');
    assert.equal(handoverReceipt.source, 'roster_slot_handover');
    assert.ok(handoverReceipt.replacement_slot_id);
    assert.ok(handoverReceipt.replacement_shift_id);
    assert.equal(handoverReceipt.released_dispatch_jobs, 1);
    assert.equal(handoverReceipt.resolved_welfare_alerts, 1);
    const original = JSON.parse(sql(`SELECT row_to_json(s) FROM shifts s WHERE id='${id(500)}'`).trim());
    assert.equal(original.officer_user_id, id(4));
    assert.equal(original.actual_start, context.shift.actual_start);
    assert.equal(new Date(original.actual_end).toISOString(), handoverAt);
    assert.equal(original.status, 'completed');
    assert.equal(sql(`SELECT row_to_json(s) FROM shift_stops s WHERE id='${id(601)}'`).trim(), completedBefore);
    const replacement = JSON.parse(sql(`SELECT row_to_json(s) FROM shifts s WHERE id='${handoverReceipt.replacement_shift_id}'`).trim());
    assert.equal(replacement.officer_user_id, id(5));
    assert.equal(replacement.status, 'published');
    assert.equal(replacement.actual_start, null);
    assert.equal(replacement.actual_end, null);
    assert.equal(new Date(replacement.scheduled_start).toISOString(), handoverAt);
    assert.equal(sql(`SELECT count(*) FROM shift_stops WHERE shift_id='${replacement.id}' AND status='pending'
      AND actual_arrived_at IS NULL AND actual_departed_at IS NULL`).trim(), '2');
    assert.equal(sql(`SELECT count(*) FROM shift_stops WHERE shift_id='${replacement.id}' AND site_id='${id(14)}'`).trim(), '0');
    assert.equal(sql(`SELECT count(*) FROM shift_stop_modules m JOIN shift_stops s ON s.id=m.shift_stop_id
      WHERE s.shift_id='${replacement.id}' AND m.status='pending'`).trim(), '2');
    assert.equal(sql(`SELECT (shift_id IS NULL)::text FROM dispatch_jobs WHERE id='${id(800)}'`).trim(), 'true');
    const handoverReplay = JSON.parse(sql(handoverCall(id(1300), true)).trim());
    assert.equal(handoverReplay.replayed, true);
    assert.equal(handoverReplay.replacement_shift_id, replacement.id);
    assert.equal(sql(`SELECT count(*) FROM shifts`).trim(), '2');

    const sameOfficerContext = JSON.parse(sql(`${as(id(1))} SELECT get_roster_slot_edit_context('${handoverReceipt.replacement_slot_id}'); COMMIT;`).trim());
    fails(`${as(id(1))} SELECT amend_roster_slot('${id(1000)}','${sameOfficerContext.slot.id}',
      '${sameOfficerContext.slot.updated_at}','${sameOfficerContext.shift.updated_at}',
      '${JSON.stringify({ ...handoverChanges, staff_id: id(22) })}'::jsonb,
      'Request identifier cannot be reused',NULL,false); COMMIT;`, /request.*already|different amendment/i);
    sql(`INSERT INTO organization_fatigue_rules(organization_id) VALUES('${id(100)}');
      UPDATE shifts SET status='in_progress',actual_start='${handoverAt}' WHERE id='${replacement.id}';
      UPDATE roster_slots SET status='accepted' WHERE id='${sameOfficerContext.slot.id}';`);
    const placeContext = JSON.parse(sql(`${as(id(1))} SELECT get_roster_slot_edit_context('${sameOfficerContext.slot.id}'); COMMIT;`).trim());
    const placeTime = new Date(Date.now() - 10).toISOString();
    const placeChanges = { ...handoverChanges, work_unit_id: id(11), scheduled_start: placeTime };
    const placeCall = `${as(id(1))} SELECT amend_roster_slot('${id(1400)}','${placeContext.slot.id}',
      '${placeContext.slot.updated_at}','${placeContext.shift.updated_at}','${JSON.stringify(placeChanges)}',
      'Officer continues duty on a different work unit','${placeTime}',false); COMMIT;`;
    const placeReceipt = JSON.parse(sql(placeCall).trim());
    assert.equal(placeReceipt.source, 'roster_slot_handover');
    assert.equal(placeReceipt.replacement_shift_id, null);
    const rest = sql(`SELECT staff_fatigue_conflict('${id(22)}','${placeTime}',
      '${placeChanges.scheduled_end}','${placeReceipt.replacement_slot_id}')`).trim();
    assert.equal(rest, '', 'A responsibility segment is not a new rested duty');
    sql(`UPDATE organization_fatigue_rules SET max_hours_per_week=2`);
    assert.match(sql(`SELECT staff_fatigue_conflict('${id(22)}','${placeTime}',
      '${placeChanges.scheduled_end}','${placeReceipt.replacement_slot_id}')`), /over.*hour.limit/i,
    'Continuation must still enforce the complete duty hours');
    sql(`UPDATE organization_fatigue_rules SET max_hours_per_week=60`);
    const futureStart = new Date(Date.now() + 3 * 86400_000).toISOString();
    const futureEnd = new Date(Date.now() + 3 * 86400_000 + 8 * 3600_000).toISOString();
    const published = JSON.parse(sql(`${as(id(1))}
      SELECT row_to_json(s) FROM create_roster_slot_with_break('${id(1500)}','${id(10)}','${id(21)}',
        '${futureStart}','${futureEnd}',true,'Published synthetic static shift',30,true) s; COMMIT;`).trim());
    const futureContext = JSON.parse(sql(`${as(id(1))} SELECT get_roster_slot_edit_context('${published.id}'); COMMIT;`).trim());
    const futureChanges = {
      ...changes, staff_id: id(22), work_unit_id: id(10), scheduled_start: futureContext.slot.scheduled_start,
      scheduled_end: futureContext.slot.scheduled_end,
    };
    const futureReceipt = JSON.parse(sql(`${as(id(1))} SELECT amend_roster_slot('${id(1501)}','${published.id}',
      '${futureContext.slot.updated_at}','${futureContext.shift.updated_at}','${JSON.stringify(futureChanges)}',
      'Reassign the unstarted static shift',NULL,false); COMMIT;`).trim());
    assert.equal(futureReceipt.source, 'roster_slot_amended');
    assert.notEqual(futureReceipt.shift_id, futureContext.shift.id);
    assert.equal(sql(`SELECT status FROM shifts WHERE id='${futureContext.shift.id}'`).trim(), 'cancelled');
    assert.equal(sql(`SELECT officer_user_id FROM shifts WHERE id='${futureReceipt.shift_id}'`).trim(), id(5));
    assert.equal(sql(`SELECT status FROM shifts WHERE id='${futureReceipt.shift_id}'`).trim(), 'published');
  } finally {
    if (created) docker(['rm', '-f', container]);
  }
});
