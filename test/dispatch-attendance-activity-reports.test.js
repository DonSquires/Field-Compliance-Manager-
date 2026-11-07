const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20261107212000_dispatch_attendance_in_activity_reports.sql');
const schema = read('supabase/schema.sql');
const load = () => import('../supabase/functions/_shared/report-activity-sections.mjs');

const fnBody = (sql, head) => {
  const start = sql.indexOf(head);
  assert.ok(start >= 0, `missing ${head}`);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
};
const migrationBody = (name) => fnBody(migration, `create or replace function public.${name}(`);
const liveBody = (name) => fnBody(schema, `CREATE OR REPLACE FUNCTION "public"."${name}"(`);
// Before release the snapshot holds the prior definition; after release the live catalog refresh makes it identical to the migration.
const assertPriorOrApplied = (migrated, prior, live) => {
  if (migrated === live) return;
  assert.equal(prior, live);
};

test('the existing dispatch_callout projection stays the single ledger row per job, enriched for the client', () => {
  const sql = migrationBody('project_dispatch_job_to_ledger');
  const live = liveBody('project_dispatch_job_to_ledger');
  // Main's boundaries survive: staff-sensitive investigations and incident-raised jobs are never projected.
  for (const rule of [/i\.investigation_id = j\.investigation_id and i\.is_staff_sensitive/, /i\.dispatch_job_id = j\.id/]) {
    assert.match(live, rule);
    assert.match(sql, rule);
  }
  assert.match(sql, /not \(j\.status = 'completed' or \(j\.status = 'cancelled' and j\.on_scene_at is not null\)\)/);
  assert.match(sql, /'dispatch_callout',\s*j\.module_key,/);
  assert.match(sql, /case when j\.zone_id is null then j\.client_site_id end/);
  assert.match(sql, /on conflict \(organization_id, event_type, external_ref\) where external_ref is not null\s+do update set payload = excluded\.payload/);
  assert.match(sql, /from public\.sla_clocks c\s+where c\.dispatch_job_id = j\.id/);
  for (const key of ['issue', 'comments', 'action_notes', 'requested_at', 'on_scene_at', 'completed_at', 'response_minutes', 'sla_target_minutes', 'sla_status']) {
    assert.match(sql, new RegExp(`'${key}'`));
  }
  // The call-out category comes from the event type, not an "other" work activity.
  assert.doesNotMatch(sql, /work_activity_code/);
  // Briefing notes, the harmed party, officer identity and costs never enter the payload.
  assert.doesNotMatch(sql.replace(/-- briefing_notes can carry[^\n]*\n/, ''), /briefing_notes|harmed_party|assigned_officer_id|cost|created_by/);
  // No second event type or trigger: that would count each call-out twice.
  assert.doesNotMatch(migration, /'dispatch_attendance'|record_dispatch_attendance_event|create trigger trg_dispatch_job_record/);
});

test('the projection trigger also fires for on-scene cancellations and the backfill refreshes closed jobs', () => {
  assert.match(migration, /drop trigger if exists trg_dispatch_jobs_project_to_ledger on public\.dispatch_jobs;\ncreate trigger trg_dispatch_jobs_project_to_ledger\n\s+after insert or update of status, on_scene_at, completed_at, client_site_id, zone_id on public\.dispatch_jobs\n\s+for each row\n\s+when \(new\.status = 'completed' or \(new\.status = 'cancelled' and new\.on_scene_at is not null\)\)\n\s+execute function public\.tg_project_dispatch_job_to_ledger\(\);/);
  assert.match(migration, /perform public\.project_dispatch_job_to_ledger\(j\.id\)\s+from public\.dispatch_jobs j\s+where j\.status = 'completed' or \(j\.status = 'cancelled' and j\.on_scene_at is not null\)/);
  assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.project_dispatch_job_to_ledger(uuid) FROM PUBLIC, "anon", "authenticated", "service_role";'));
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.project_dispatch_job_to_ledger\(uuid\) TO "(anon|authenticated|service_role)"/);
  assert.doesNotMatch(migration, /\bdrop\s+(table|column|function)\b|\btruncate\b|\bdelete\s+from\b/i);
});

test('the migration runs against PostgreSQL: one refreshed call-out per job, never twice', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-dispatch-callout-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = (query) => docker(['exec', '-i', name, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], query).trim();
    const liveFunction = (fn) => {
      const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${fn}"(`);
      const end = schema.indexOf('$function$;', start) + '$function$;'.length;
      assert.ok(start >= 0 && end > start, `Snapshot contains ${fn}`);
      return schema.slice(start, end);
    };
    const org = '10000000-0000-4000-8000-000000000001';
    const site = '30000000-0000-4000-8000-000000000001';
    const job = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const payload = (n) => JSON.parse(sql(`SELECT payload FROM public.location_events WHERE external_ref='${job(n)}'`));
    const rows = (n) => sql(`SELECT count(*) FROM public.location_events WHERE external_ref='${job(n)}'`);

    // The live state before this migration: main's thin projection and trigger.
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.dispatch_jobs (
        id uuid PRIMARY KEY, organization_id uuid, client_site_id uuid, zone_id uuid,
        service_agreement_id uuid, investigation_id uuid, shift_id uuid,
        job_type text NOT NULL DEFAULT 'noise_control', priority text NOT NULL DEFAULT 'normal',
        status text NOT NULL DEFAULT 'pending', module_key text DEFAULT 'noise_control',
        sla_minutes integer, sla_breached boolean NOT NULL DEFAULT false, sla_delay_reason text,
        briefing_notes text DEFAULT 'PRIVATE_COMPLAINANT 021 555 0100', outcome_notes text,
        assigned_officer_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
        dispatched_at timestamptz, acknowledged_at timestamptz, en_route_at timestamptz,
        on_scene_at timestamptz, completed_at timestamptz
      );
      CREATE TABLE public.incidents (investigation_id uuid, is_staff_sensitive boolean, dispatch_job_id uuid);
      CREATE TABLE public.sla_clocks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_job_id uuid, started_at timestamptz,
        target_minutes integer, elapsed_minutes integer, status text, created_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.location_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, client_site_id uuid, zone_id uuid,
        event_type text, module_key text, occurred_at timestamptz, status text, source text,
        external_ref text, payload jsonb
      );
      CREATE UNIQUE INDEX uq_location_events_source_ref ON public.location_events
        (organization_id, event_type, external_ref) WHERE external_ref IS NOT NULL;
      ${liveFunction('project_dispatch_job_to_ledger')}
      ${liveFunction('tg_project_dispatch_job_to_ledger')}
      ${liveFunction('report_activity_category')}
      CREATE TRIGGER trg_dispatch_jobs_project_to_ledger
        AFTER INSERT OR UPDATE OF status, completed_at, client_site_id, zone_id ON public.dispatch_jobs
        FOR EACH ROW WHEN (new.status = 'completed') EXECUTE FUNCTION public.tg_project_dispatch_job_to_ledger();
      INSERT INTO public.incidents VALUES (NULL, false, '${job(4)}');
      INSERT INTO public.sla_clocks(dispatch_job_id, started_at, target_minutes, elapsed_minutes, status) VALUES
        ('${job(1)}', '2026-01-15T09:32Z', 30, 12, 'met'),
        ('${job(5)}', '2026-01-15T09:00Z', 10, NULL, 'running');
      INSERT INTO public.dispatch_jobs(id, organization_id, client_site_id, priority, status, outcome_notes, sla_delay_reason, dispatched_at, on_scene_at, completed_at) VALUES
        ('${job(1)}', '${org}', '${site}', 'high', 'completed', 'No one inside during site visit.', NULL, '2026-01-15T09:33Z', '2026-01-15T09:44Z', '2026-01-15T10:07Z'),
        ('${job(2)}', '${org}', '${site}', 'normal', 'cancelled', 'Resolved before arrival was confirmed.', NULL, '2026-01-15T09:33Z', '2026-01-15T09:50Z', NULL),
        ('${job(3)}', '${org}', '${site}', 'normal', 'cancelled', NULL, NULL, '2026-01-15T09:33Z', NULL, NULL),
        ('${job(4)}', '${org}', '${site}', 'normal', 'completed', 'Incident raised.', NULL, NULL, '2026-01-15T09:40Z', '2026-01-15T10:00Z'),
        ('${job(6)}', '${org}', NULL, 'normal', 'completed', NULL, NULL, NULL, '2026-01-15T09:40Z', '2026-01-15T10:00Z');
    `);
    if (migrationBody('project_dispatch_job_to_ledger') !== liveBody('project_dispatch_job_to_ledger')) {
      assert.equal(payload(1).issue, 'Callout attendance', 'the live projection wrote its thin row first');
      assert.equal(payload(1).work_activity_code, 'other');
    }

    sql(`SET check_function_bodies = off;\n${migration}`);

    assert.equal(rows(1), '1', 'the backfill refreshes the existing row instead of adding a second');
    assert.equal(sql("SELECT count(*) FROM public.location_events WHERE event_type <> 'dispatch_callout'"), '0');
    const completed = payload(1);
    assert.equal(completed.issue, 'Call-out attended: Noise Control (high priority)');
    assert.equal(completed.comments, 'No one inside during site visit.');
    assert.equal(completed.action_notes, 'Requested 22:32, on scene 22:44 (12 min response; 30 min target met), completed 23:07.');
    assert.equal(completed.response_minutes, 12);
    assert.equal(completed.sla_status, 'met');
    assert.equal(completed.work_activity_code, undefined);
    assert.equal(sql(`SELECT status || ':' || (occurred_at = '2026-01-15T10:07Z') FROM public.location_events WHERE external_ref='${job(1)}'`), 'completed:true');

    assert.equal(rows(2), '1', 'a call-out cancelled on scene happened at the place');
    assert.match(payload(2).issue, /^Call-out cancelled on scene: Noise Control$/);
    assert.match(payload(2).action_notes, /on scene 22:50 .*, cancelled\.$/);
    assert.equal(rows(3), '0', 'a call-out cancelled before anyone attended is not reported');
    assert.equal(rows(4), '0', 'an incident raised from the call-out already reports it');
    assert.equal(rows(6), '0', 'a job with no place is not reported');
    assert.doesNotMatch(sql('SELECT string_agg(payload::text, \'\') FROM public.location_events'), /PRIVATE_COMPLAINANT|021 555/);

    // New jobs: one row through the trigger, refreshed on later edits, SLA miss explained.
    sql(`INSERT INTO public.dispatch_jobs(id, organization_id, client_site_id, sla_delay_reason) VALUES ('${job(5)}', '${org}', '${site}', 'Second call-out in progress');
      UPDATE public.dispatch_jobs SET status='en_route' WHERE id='${job(5)}';`);
    assert.equal(rows(5), '0');
    sql(`UPDATE public.dispatch_jobs SET status='completed', on_scene_at='2026-01-15T09:25Z', completed_at='2026-01-15T09:45Z' WHERE id='${job(5)}'`);
    assert.equal(rows(5), '1');
    assert.equal(payload(5).action_notes, 'Requested 22:00, on scene 22:25 (25 min response; 10 min target missed), completed 22:45. Delay: Second call-out in progress');
    sql(`UPDATE public.dispatch_jobs SET outcome_notes='Music turned down.', completed_at='2026-01-15T09:46Z' WHERE id='${job(5)}'`);
    assert.equal(rows(5), '1');
    assert.equal(payload(5).comments, 'Music turned down.');
    assert.equal(sql('SELECT count(*) FROM public.location_events'), '3');

    assert.equal(sql("SELECT public.report_activity_category('event', 'dispatch_callout', NULL, NULL, 'other', NULL, NULL, NULL)"), 'call_out');
    assert.equal(sql("SELECT public.report_activity_category('incident', 'dispatch_callout', NULL, NULL, NULL, NULL, NULL, NULL)"), 'incident');
    assert.equal(sql("SELECT public.report_activity_category('event', 'patrol_visit', NULL, NULL, 'other', NULL, NULL, NULL)"), 'other_work');

    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(sql(`SELECT has_function_privilege('${role}', 'public.project_dispatch_job_to_ledger(uuid)', 'execute')`), 'f', role);
      assert.equal(sql(`SELECT has_function_privilege('${role}', 'public.report_activity_category(text,text,text,text,text,text,text,text)', 'execute')`), 'f', role);
      assert.equal(sql(`SELECT has_function_privilege('${role}', 'public.build_agreement_activity_report_core(uuid,timestamptz,timestamptz,integer)', 'execute')`), 'f', role);
      assert.equal(sql(`SELECT has_function_privilege('${role}', 'public.get_officer_activity_timeline_unlogged(uuid,timestamptz,timestamptz,integer)', 'execute')`), role === 'service_role' ? 't' : 'f', role);
      assert.equal(sql(`SELECT has_function_privilege('${role}', 'public.get_officer_activity_timeline(uuid,timestamptz,timestamptz,integer)', 'execute')`), role === 'anon' ? 'f' : 't', role);
    }
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});

test('call-outs are their own client category, after incidents and before everything else', () => {
  const sql = migrationBody('report_activity_category');
  assert.match(sql, /when p_kind = 'incident' then 'incident'\n\t\twhen p_event_type = 'dispatch_callout' then 'call_out'\n\t\twhen p_service_line = 'pest_control'/);
  assertPriorOrApplied(sql, sql.replace("\t\twhen p_event_type = 'dispatch_callout' then 'call_out'\n", ''), liveBody('report_activity_category'));
});

test('the report builder counts and labels call-outs and otherwise keeps the live definition', () => {
  const sql = migrationBody('build_agreement_activity_report_core');
  assert.match(sql, /\('incident', 'Incidents and investigations', 0\),\n\t\t\('call_out', 'Call-outs and responses', 1\),\n\t\t\('pest_control', 'Pest control', 2\)/);
  assert.match(sql, /\('travel_admin', 'Travel and materials', 14\)/);
  assert.match(sql, /count\(\*\) filter \(where category = 'call_out'\) as call_outs/);
  assert.match(sql, /'callOuts', t\.call_outs/);
  // Comments and response notes still pass the identified-person redaction.
  assert.match(sql, /'n', public\.report_redact_identified_persons\(n\.note\)/);
  assert.match(sql, /'ac', public\.report_redact_identified_persons\(n\.action\)/);
  let restored = sql
    .replace("\t\t('call_out', 'Call-outs and responses', 1),\n", '')
    .replace("\t\tcount(*) filter (where category = 'call_out') as call_outs,\n", '')
    .replace("\t\t\t'callOuts', t.call_outs,\n", '')
    .replace('agreement: call-outs attended, patrols', 'agreement: patrols');
  for (const [code, order] of [['pest_control', 2], ['maintenance', 3], ['manufacture', 4], ['installation_removal', 5], ['securing', 6], ['inspection', 7],
    ['camera_activation', 8], ['vehicle_observation', 9], ['other_work', 10], ['administration', 11], ['patrol_visit', 12], ['unclassified', 13], ['travel_admin', 14]]) {
    restored = restored.replace(new RegExp(`(\\('${code}', '[^']+', )${order}\\)`), `$1${order - 1})`);
  }
  assertPriorOrApplied(sql, restored, liveBody('build_agreement_activity_report_core'));
  assert.match(migration, /REVOKE ALL ON FUNCTION "public"\."build_agreement_activity_report_core"\([^)]*\) FROM PUBLIC, "anon", "authenticated", "service_role";/);
});

test('both officer timelines list each dispatch milestone the officer recorded, keeping their grants', () => {
  for (const name of ['get_officer_activity_timeline', 'get_officer_activity_timeline_unlogged']) {
    const sql = migrationBody(name).toLowerCase();
    assert.match(sql, /'dispatch_job:' \|\| j\.id::text \|\| ':' \|\| m\.milestone, 'dispatch_' \|\| m\.milestone/);
    assert.match(sql, /from public\.dispatch_jobs j/);
    assert.match(sql, /where j\.organization_id = v_org_id and j\.assigned_officer_id = p_officer_id and m\.at between p_from and p_to/);
    const live = liveBody(name).toLowerCase();
    assertPriorOrApplied(sql, sql.slice(0, sql.indexOf('\n\n    union all\n    select \'dispatch_job:')), live === sql ? live : live.slice(0, live.lastIndexOf('\n  )')));
  }
  assert.match(migration, /REVOKE ALL ON FUNCTION "public"\."get_officer_activity_timeline_unlogged"\([^)]*\) FROM PUBLIC, "anon", "authenticated", "service_role";/);
  assert.ok(!/GRANT EXECUTE ON FUNCTION "public"\."get_officer_activity_timeline_unlogged"\([^)]*\) TO "authenticated"/.test(migration));
});

test('the client report shows an attended call-out with its request, response and outcome', async () => {
  const { notableEventBlocks, siteLogBlocks, isInternalWorkLine } = await load();
  const report = {
    version: 2,
    totals: { entries: 1, events: 1, places: 1, callOuts: 1 },
    categories: [{ code: 'call_out', entries: 1, photos: 0 }],
    byPlace: [{ place: 'Burger N Beast Richmond', entries: 1, photos: 0, categories: { call_out: 1 } }],
    labels: { category: { call_out: 'Call-outs and responses' } },
  };
  const line = {
    d: '2026-11-04', t: '22:44', p: 'Burger N Beast Richmond', k: 'event', c: 'call_out',
    ti: 'Call-out attended: Patrol Support (high priority)',
    n: 'No one inside during site visit, full external check.',
    ac: 'Requested 22:32, on scene 22:44 (12 min response; 30 min target met), completed 23:07.',
  };
  assert.equal(isInternalWorkLine(line), false);
  const lines = { version: 2, lines: [line] };
  for (const blocks of [notableEventBlocks({ activityReport: report }, lines), siteLogBlocks({ activityReport: report }, lines)]) {
    const entry = blocks.find((block) => block.kind === 'entry');
    assert.ok(entry);
    assert.equal(entry.title, 'Call-out attended: Patrol Support (high priority)');
    assert.deepEqual(entry.tags, ['Call-outs and responses']);
    assert.deepEqual(entry.lines, [
      { text: 'No one inside during site visit, full external check.' },
      { label: 'Response', text: 'Requested 22:32, on scene 22:44 (12 min response; 30 min target met), completed 23:07.' },
    ]);
  }
});
