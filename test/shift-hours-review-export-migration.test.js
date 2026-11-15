'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261115101502_shift_hours_review_exports.sql'), 'utf8');
const sourceReader = fs.readFileSync(path.join(root, 'supabase/migrations/20261111120000_timesheet_shift_rows_rates.sql'), 'utf8');
const definition = (kind, name, end) => {
  const start = schema.indexOf(`${kind} "public"."${name}"`);
  assert.notEqual(start, -1, name);
  return schema.slice(start, schema.indexOf(end, start) + end.length);
};
const table = (name) => definition('CREATE TABLE IF NOT EXISTS', name, '\n);');
const fn = (name) => definition('CREATE OR REPLACE FUNCTION', name, '$function$;');

test('shift review preserves source evidence, guards decisions and corrects approved unexported hours', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-shift-review-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input).trim();
  const fails = (input, message) => assert.throws(() => sql(input), (error) => message.test(String(error.stderr ?? error.message)));
  const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const org = id(1), admin = id(2), officer = id(3), staff = id(4), outsider = id(5);
  const shift = id(6), second = id(7), client = id(8), placeOwner = id(9), place = id(10), site = id(11), agreement = id(12), link = id(13), slot = id(14);
  const as = (user, statement) => `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${user}'; ${statement} COMMIT;`;
  const read = () => JSON.parse(sql(as(admin, `SELECT public.get_timesheet_shift_rows('${org}','2020-06-01','2020-06-02');`)));
  const decision = (request, rows, status = 'approved', reason = 'Hours compared with attendance') =>
    `SELECT public.review_shift_timesheet_hours('${request}','${org}','${JSON.stringify(rows)}'::jsonb,'${status}','${reason}');`;
  const reviewedRow = (row) => ({ shift_id: row.id, source_revision: row.source_revision, review_revision: row.review_revision });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    sql(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY,name text);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,organization_id uuid,employer_organization_id uuid,
        role text,deactivated_at timestamptz,display_name text);
      CREATE TABLE public.staff_profiles(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,role_code text,employee_number text);
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=$1
          AND role IN ('admin','admin_officer') AND deactivated_at IS NULL) $$;
      CREATE FUNCTION public.is_timesheet_payroll_admin(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=$1
          AND employer_organization_id=$1 AND role IN ('admin','admin_officer') AND deactivated_at IS NULL) $$;
      CREATE FUNCTION public.user_can_operate_organization(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.user_can_exercise_branch_authority(uuid,uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.resolve_rate_rule(uuid,text,timestamptz,text,text,text,uuid,uuid,uuid,text,text,text,text)
        RETURNS TABLE(amount numeric) LANGUAGE sql STABLE AS $$ SELECT CASE WHEN $2='pay' THEN 30::numeric ELSE 50::numeric END $$;
      CREATE FUNCTION public.enqueue_notification(p_organization_id uuid,p_category text,p_title text,p_body text,
        p_severity text,p_recipient_user_id uuid,p_link_page text,p_link_payload jsonb,p_dedup_key text)
        RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
      CREATE TABLE public.audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,
        actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
      ${['timesheets','timesheet_work_entries','payroll_export_batches','shifts','roster_slots','shift_breaks','shift_timesheet_hour_corrections',
        'service_agreements','service_agreement_locations','client_sites','locations','location_zones'].map(table).join('\n')}
      ALTER TABLE public.shifts ADD PRIMARY KEY(id);
      ALTER TABLE public.shift_timesheet_hour_corrections ADD PRIMARY KEY(shift_id);
      CREATE TABLE public.staff_branch_authorisations(user_id uuid,branch_org_id uuid,status text);
      CREATE TABLE public.shift_stop_actions(shift_id uuid);
      CREATE TABLE public.officer_gps_log(shift_id uuid);
      CREATE TABLE public.shift_debriefs(shift_id uuid);
      ${sourceReader}
      ${fn('correct_timesheet_shift_hours')}
      ${fn('reopen_approved_timesheet')}
      INSERT INTO public.organizations VALUES ('${org}','Employer'),('${client}','Agreement recipient'),('${placeOwner}','Place owner');
      INSERT INTO public.user_profiles VALUES
        ('${admin}','${org}','${org}','admin',null,'Reviewer'),
        ('${officer}','${org}','${org}','officer',null,'Fixture officer'),
        ('${outsider}','${placeOwner}','${placeOwner}','admin',null,'Other reviewer');
      INSERT INTO public.staff_profiles VALUES ('${staff}','${officer}','${org}','guard','EMP-12');
      INSERT INTO public.locations(id,organization_id,name,canonical_place_id) VALUES ('${place}','${placeOwner}','Fixture workplace','${place}');
      INSERT INTO public.client_sites(id,client_organization_id,name,location_id) VALUES ('${site}','${placeOwner}','Site facet','${place}');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name)
        VALUES ('${agreement}','${org}','${client}','Fixture agreement');
      INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id) VALUES ('${link}','${agreement}','${site}');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,
        actual_start,actual_end,status,updated_at,location_id,service_agreement_location_id)
        SELECT value,'${org}','${officer}','static_guarding','2020-05-31T21:00Z','2020-06-01T05:30Z',
          '2020-05-31T21:00Z','2020-06-01T05:30Z','completed','2020-06-01T06:00Z','${place}','${link}'
        FROM unnest(ARRAY['${shift}'::uuid,'${second}'::uuid]) value;
      INSERT INTO public.roster_slots(id,organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,
        status,linked_shift_id,client_request_id,planned_break_minutes,break_unpaid)
        VALUES ('${slot}','${org}','${id(16)}','${staff}','2020-05-31T21:00Z','2020-06-01T05:30Z',
          'published','${shift}','${id(17)}',30,true);
      INSERT INTO public.shift_breaks(id,organization_id,shift_id,officer_user_id,break_type,
        started_at,ended_at,is_paid,client_request_id)
        VALUES ('${id(15)}','${org}','${shift}','${officer}','meal',
          '2020-06-01T01:00Z','2020-06-01T01:30Z',false,'${id(18)}');
      ${migration}
    `);
    let rows = read();
    assert.equal(typeof rows[0].source_revision, 'string', 'reader must bind decisions to actual source evidence');
    assert.equal(rows[0].client_name, 'Agreement recipient', 'recipient is not the site owner');
    assert.equal(rows[0].location_name, 'Fixture workplace');
    assert.equal(rows[0].employee_number, 'EMP-12');
    sql(`INSERT INTO public.locations(id,organization_id,name,canonical_place_id)
      VALUES ('${id(50)}','${placeOwner}','Actual zone workplace','${id(50)}');
      INSERT INTO public.location_zones(id,organization_id,name,location_id)
      VALUES ('${id(51)}','${placeOwner}','Actual worked zone','${id(50)}');
      UPDATE public.shifts SET location_id=null,zone_id='${id(51)}' WHERE id='${shift}'`);
    const zoneSource = read()[0];
    assert.equal(zoneSource.location_name, 'Actual zone workplace', 'worked zone takes priority over an agreement site');
    assert.match(zoneSource.client_link_problem, /disagree/i, 'agreement/place disagreement must not masquerade as client evidence');
    sql(`UPDATE public.shifts SET location_id='${place}',zone_id=null WHERE id='${shift}'`);
    assert.equal(rows[0].review_status, 'needs_review', 'auto-confirmed attendance is not human approval');
    assert.equal(rows[0].can_edit_hours, true);
    sql(`UPDATE public.shifts SET scheduled_start='2020-05-31T10:00Z',scheduled_end='2020-05-31T18:00Z',
      actual_start='2020-05-31T10:00Z',actual_end='2020-05-31T18:00Z' WHERE id='${second}';
      INSERT INTO public.timesheets(id,organization_id,staff_id,shift_id,period_start,period_end,status,
        actual_hours,work_derived_hours,overtime_hours,adjustment_hours,revision,approved_by,approved_at)
      VALUES ('${id(52)}','${org}','${staff}','${second}','2020-05-31','2020-05-31','approved',2,2,0,0,1,'${admin}','2020-06-02');
      INSERT INTO public.timesheet_work_entries(organization_id,timesheet_id,source_type,source_id,work_status,
        started_at,ended_at,calculated_minutes) VALUES ('${org}','${id(52)}','shift','${second}','completed',
        '2020-05-31T10:00Z','2020-05-31T12:00Z',120);`);
    const overnight = JSON.parse(sql(as(admin,
      `SELECT public.get_timesheet_shift_rows('${org}','2020-05-31','2020-06-02');`))).find((row) => row.id === second);
    assert.equal(overnight.review_status, 'needs_review', 'partial period approval cannot approve the whole overnight shift');
    sql(`DELETE FROM public.timesheet_work_entries WHERE timesheet_id='${id(52)}';
      DELETE FROM public.timesheets WHERE id='${id(52)}';
      UPDATE public.shifts SET scheduled_start='2020-05-31T21:00Z',scheduled_end='2020-06-01T05:30Z',
        actual_start='2020-05-31T21:00Z',actual_end='2020-06-01T05:30Z' WHERE id='${second}';`);
    const request = id(20), selection = [reviewedRow(rows[0])];
    fails(as(officer, decision(request, selection)), /authority|required|authoris/i);
    fails(as(outsider, decision(request, selection)), /authority|required|authoris/i);
    const receipt = sql(as(admin, decision(request, selection)));
    assert.equal(JSON.parse(receipt).shift_count, 1);
    assert.equal(sql(as(admin, decision(request, selection))), receipt);
    fails(as(admin, decision(request, selection, 'rejected', 'Different inputs')), /already used|different/i);
    assert.equal(read()[0].review_status, 'approved');
    fails(as(admin, decision(id(21), selection, 'rejected', 'Stale review')), /changed|reload/i);

    rows = read();
    sql(`UPDATE public.roster_slots SET planned_break_minutes=20 WHERE id='${slot}'`);
    const changed = read();
    assert.notEqual(changed[0].source_revision, rows[0].source_revision, 'roster/break change invalidates source approval');
    assert.equal(changed[0].review_status, 'needs_review');
    fails(as(admin, decision(id(22), [reviewedRow(rows[0])])), /changed|reload/i);
    sql(`UPDATE public.shifts SET updated_at='2020-06-02T06:00Z' WHERE id='${second}'`);
    fails(as(admin, decision(id(24), [reviewedRow(changed[0]), reviewedRow(changed[1])])), /changed|reload/i);
    assert.equal(read()[0].review_status, 'needs_review', 'a later stale row rolls back the first shift decision');
    rows = read();
    sql(as(admin, decision(id(23), [reviewedRow(rows[0])], 'rejected', 'Break needs correction')));
    assert.equal(read()[0].review_status, 'rejected');
    assert.equal(sql('SELECT count(*) FROM public.payroll_export_batches'), '0');
    assert.equal(sql("SELECT has_function_privilege('authenticated','ops.get_timesheet_shift_rows_source(uuid,date,date,uuid)','execute')"), 'f');
    assert.equal(sql("SELECT has_table_privilege('authenticated','public.shift_timesheet_reviews','update')"), 'f');
    assert.equal(sql(as(admin, 'SELECT count(*) FROM public.shift_timesheet_reviews;')), '1');
    assert.equal(sql(as(officer, 'SELECT count(*) FROM public.shift_timesheet_reviews;')), '0');
    assert.equal(sql(as(outsider, 'SELECT count(*) FROM public.shift_timesheet_reviews;')), '0');
    fails(as(admin, 'UPDATE public.shift_timesheet_reviews SET decision=\'approved\';'), /permission denied/i);
    sql(`UPDATE public.shifts SET actual_end=null WHERE id='${second}'`);
    const incomplete = read()[1];
    fails(as(admin, decision(id(28), [reviewedRow(incomplete)])), /complete|review|authority/i);
    sql(as(admin, decision(id(29), [reviewedRow(incomplete)], 'rejected', 'Finish time needs correction')));
    assert.equal(read()[1].review_status, 'rejected', 'incomplete hours can be rejected without approving them');
    sql(`UPDATE public.shifts SET actual_end='2020-06-01T05:30Z' WHERE id='${second}'`);
    sql(`UPDATE public.user_profiles SET role='admin_officer' WHERE id='${admin}'`);
    sql(as(admin, decision(id(25), [reviewedRow(read()[1])])));
    assert.equal(read()[1].review_status, 'approved', 'admin-officer has the same governed review path');
    sql(`UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${admin}'`);
    fails(as(admin, decision(id(26), [reviewedRow(rows[0])])), /authority|required|authoris/i);
    sql(`UPDATE public.user_profiles SET role='admin',deactivated_at=null WHERE id='${admin}'`);

    const sheet = id(30);
    sql(`INSERT INTO public.timesheets(id,organization_id,staff_id,period_start,period_end,status,
      actual_hours,work_derived_hours,overtime_hours,adjustment_hours,revision,approved_by,approved_at)
      VALUES ('${sheet}','${org}','${staff}','2020-06-01','2020-06-01','approved',8,8,0,0,2,'${admin}','2020-06-02');
      INSERT INTO public.timesheet_work_entries(organization_id,timesheet_id,source_type,source_id,work_status,
        started_at,ended_at,calculated_minutes) VALUES ('${org}','${sheet}','shift','${shift}','completed',
        '2020-05-31T21:00Z','2020-06-01T05:30Z',480);`);
    const oldSource = read()[0].source_revision;
    sql(`UPDATE public.timesheets SET revision=3,adjustment_hours=1 WHERE id='${sheet}'`);
    assert.equal(read()[0].can_review_hours, false, 'unallocated payroll adjustments need resolution first');
    fails(as(admin, decision(id(27), [reviewedRow(read()[0])])), /cannot|review|eligible/i);
    sql(`UPDATE public.timesheets SET adjustment_hours=0 WHERE id='${sheet}'`);
    fails(as(admin, `SELECT public.correct_reviewed_timesheet_shift_hours('${id(33)}','${shift}','2020-06-01T06:00Z',
      null,'${staff}','2020-05-31T21:00Z','2020-06-01T05:30Z',30,'Stale payroll source','${oldSource}');`), /changed|reload/i);
    assert.equal(sql(`SELECT status FROM public.timesheets WHERE id='${sheet}'`), 'approved', 'stale correction must not reopen an approved header');
    const correction = `SELECT public.correct_reviewed_timesheet_shift_hours('${id(31)}','${shift}','2020-06-01T06:00Z',
      null,'${staff}','2020-05-31T21:00Z','2020-06-01T05:30Z',30,'Supervisor verified unpaid break','${read()[0].source_revision}');`;
    sql(as(admin, correction));
    assert.equal(sql(`SELECT status FROM public.timesheets WHERE id='${sheet}'`), 'submitted');
    assert.equal(sql(`SELECT actual_end='2020-06-01T05:30Z'::timestamptz FROM public.shifts WHERE id='${shift}'`), 't');
    assert.equal(sql("SELECT count(*) FROM public.audit_log WHERE action='timesheet_reopened' AND metadata->>'previous_status'='approved'"), '1');
    sql(as(admin, correction));
    assert.equal(sql("SELECT count(*) FROM public.audit_log WHERE action='timesheet_reopened'"), '1', 'receipt retry must not reopen again');
    sql(`UPDATE public.timesheets SET status='paid',payroll_export_batch_id='${id(40)}' WHERE id='${sheet}'`);
    assert.equal(read()[0].can_edit_hours, false);
    fails(as(admin, correction.replace(id(31), id(32))), /finalis|export|paid/i);
    assert.equal(sql(`SELECT status FROM public.timesheets WHERE id='${sheet}'`), 'paid');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
