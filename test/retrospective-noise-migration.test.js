'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const migration = readFileSync(join(__dirname, '../supabase/migrations/20261107180000_retrospective_dispatch_job_outcome.sql'), 'utf8');
const schema = readFileSync(join(__dirname, '../supabase/schema.sql'), 'utf8');
const schemaFunction = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  const end = schema.indexOf('$function$;', start) + '$function$;'.length;
  assert.ok(start >= 0 && end > start, `Snapshot contains ${name}`);
  return schema.slice(start, end);
};

test('historical outcomes are guarded, audited and never manufacture presence', () => {
  assert.match(migration, /NOT public\.is_admin_for_org\(v_job\.organization_id\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /FROM PUBLIC, anon/);
  assert.doesNotMatch(migration, /INSERT INTO public\.(shift_stops|gps_fixes|shift_gps)/i);
});

test('historical outcomes execute the real milestone, SLA and client-ledger triggers', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-retro-noise-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
  });
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
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = query => docker(['exec', '-i', name, 'psql', '-XqAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], query).trim();
    const org = '10000000-0000-4000-8000-000000000001';
    const otherOrg = '10000000-0000-4000-8000-000000000002';
    const admin = '20000000-0000-4000-8000-000000000001';
    const officer = '20000000-0000-4000-8000-000000000002';
    const job = n => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT auth.uid() = '${admin}'::uuid AND $1 = '${org}'::uuid $$;
      CREATE TABLE public.dispatch_jobs (
        id uuid PRIMARY KEY, organization_id uuid, status text DEFAULT 'pending',
        job_type text DEFAULT 'noise_control', module_key text DEFAULT 'noise_control',
        client_site_id uuid DEFAULT gen_random_uuid(), zone_id uuid, shift_stop_id uuid,
        shift_id uuid, investigation_id uuid, priority text DEFAULT 'normal',
        briefing_notes text DEFAULT 'Source register 12345; PRIVATE_COMPLAINANT',
        outcome_notes text, dispatched_at timestamptz, acknowledged_at timestamptz,
        en_route_at timestamptz, on_scene_at timestamptz, completed_at timestamptz,
        insert_gps_lat numeric, insert_gps_lng numeric, sla_minutes integer, sla_delay_reason text,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.shifts (id uuid PRIMARY KEY, organization_id uuid, officer_user_id uuid);
      CREATE TABLE public.audit_log (
        id uuid DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid,
        action text, target_table text, target_id uuid, metadata jsonb, created_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.sla_clocks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, dispatch_job_id uuid,
        started_at timestamptz DEFAULT now(), target_minutes integer DEFAULT 10,
        arrived_at timestamptz, elapsed_minutes integer, status text DEFAULT 'running',
        updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.incidents (investigation_id uuid, is_staff_sensitive boolean, dispatch_job_id uuid);
      CREATE TABLE public.location_events (
        id uuid DEFAULT gen_random_uuid(), organization_id uuid, client_site_id uuid, zone_id uuid,
        event_type text, module_key text, occurred_at timestamptz, status text, source text,
        external_ref text, payload jsonb
      );
      CREATE UNIQUE INDEX location_events_source ON public.location_events
        (organization_id, event_type, external_ref) WHERE external_ref IS NOT NULL;
      CREATE FUNCTION public.resolve_dispatch_job_financials_internal(uuid, uuid, uuid, text)
        RETURNS TABLE(lines_written integer, total_pay numeric, unresolved_count integer,
          charge_lines_written integer, total_charge numeric) LANGUAGE sql AS
        $$ SELECT 1, 25::numeric, 0, 1, 50::numeric $$;
      ${schemaFunction('project_dispatch_job_to_ledger')}
      ${schemaFunction('tg_project_dispatch_job_to_ledger')}
      ${schemaFunction('tg_dispatch_job_close_sla_clock')}
      ${migration}
      CREATE TRIGGER stamp BEFORE UPDATE ON public.dispatch_jobs
        FOR EACH ROW EXECUTE FUNCTION public.tg_dispatch_job_stamp_milestones();
      CREATE TRIGGER close_sla AFTER UPDATE ON public.dispatch_jobs
        FOR EACH ROW EXECUTE FUNCTION public.tg_dispatch_job_close_sla_clock();
      CREATE TRIGGER project_ledger AFTER UPDATE ON public.dispatch_jobs
        FOR EACH ROW EXECUTE FUNCTION public.tg_project_dispatch_job_to_ledger();
      INSERT INTO public.dispatch_jobs(id, organization_id)
        SELECT ('40000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '${org}'::uuid
        FROM generate_series(1, 15) n;
      INSERT INTO public.sla_clocks(organization_id, dispatch_job_id)
        SELECT organization_id, id FROM public.dispatch_jobs;
    `);
    const quote = value => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
    const invoke = (n, request = randomUUID(), changes = {}, actor = admin) => {
      const values = {
        request, job: job(n), expected: 'pending', name: 'synthetic-register.xlsx',
        hash: 'a'.repeat(64), reference: '12345', zone: 'Pacific/Auckland',
        received: '2026-01-15T20:00', arrived: '2026-01-15T20:15',
        departed: '2026-01-15T20:30', outcome: 'Source reports no further action.',
        reason: 'Correct imported historical records using the source register.',
        ...changes,
      };
      return `SET ROLE authenticated; SET request.jwt.claim.sub = ${quote(actor ?? '')};
        SELECT public.record_retrospective_noise_job_outcome(${Object.values(values).map(quote).join(',')});`;
    };

    assert.equal(sql(`SELECT has_function_privilege('anon',
      'public.record_retrospective_noise_job_outcome(uuid,uuid,text,text,text,text,text,text,text,text,text,text)',
      'execute')`), 'f');
    assert.throws(() => sql(invoke(1, randomUUID(), {}, officer)), /access denied/);
    assert.throws(() => sql(invoke(1, randomUUID(), {}, null)), /Authentication is required/);
    sql(`UPDATE public.dispatch_jobs SET organization_id='${otherOrg}' WHERE id='${job(2)}'`);
    assert.throws(() => sql(invoke(2)), /access denied/);
    for (const [changes, error] of [
      [{ reference: '2345' }, /exactly match/],
      [{ hash: 'invalid' }, /SHA-256/],
      [{ name: 'private/source.xlsx' }, /source file name/],
      [{ zone: 'UTC' }, /Pacific\/Auckland/],
      [{ arrived: '2026-01-15T19:00' }, /received, on-site, off-site order/],
      [{ received: '2026-02-30T20:00' }, /date\/time values are invalid/],
      [{ departed: '2999-01-15T20:30' }, /cannot be in the future/],
      [{ expected: 'completed' }, /changed since it was opened/],
    ]) assert.throws(() => sql(invoke(1, randomUUID(), changes)), error);
    sql(`UPDATE public.dispatch_jobs SET shift_stop_id=gen_random_uuid() WHERE id='${job(3)}';
      UPDATE public.dispatch_jobs SET module_key='parking', job_type='parking' WHERE id='${job(4)}';
      UPDATE public.dispatch_jobs SET dispatched_at=now() WHERE id='${job(5)}'`);
    assert.throws(() => sql(invoke(3)), /already on an officer stop/);
    assert.throws(() => sql(invoke(4)), /only for noise-control/);
    assert.throws(() => sql(invoke(5)), /already has lifecycle timestamps/);
    assert.equal(sql(`SELECT status FROM public.dispatch_jobs WHERE id='${job(1)}'`), 'pending');
    assert.equal(sql('SELECT count(*) FROM public.audit_log'), '0');

    const request = randomUUID();
    const result = JSON.parse(sql(invoke(1, request)));
    assert.equal(result.replayed, false);
    assert.equal(result.finance.status, 'review_required');
    assert.equal(result.resulting.gps_captured, false);
    assert.equal(result.resulting.shift_stop_created, false);
    assert.equal(sql(`SELECT on_scene_at='2026-01-15T07:15Z' AND completed_at='2026-01-15T07:30Z'
      AND dispatched_at IS NULL AND shift_stop_id IS NULL AND insert_gps_lat IS NULL
      AND insert_gps_lng IS NULL FROM public.dispatch_jobs WHERE id='${job(1)}'`), 't');
    assert.equal(sql(`SELECT elapsed_minutes || ':' || status FROM public.sla_clocks
      WHERE dispatch_job_id='${job(1)}'`), '15:breached', 'SLA uses source receipt, not import time');
    const event = JSON.parse(sql(`SELECT payload FROM public.location_events WHERE external_ref='${job(1)}'`));
    // The snapshot projection is either the original or the enriched call-out (20261107212000).
    assert.match(event.issue, /^(Callout attendance|Call-out attended: Noise Control)$/);
    assert.match(event.comments, /Retrospective source-register.*did not capture GPS/);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_COMPLAINANT/);
    assert.equal(JSON.parse(sql(invoke(1, request))).replayed, true);
    assert.throws(() => sql(invoke(6, request)), /different dispatch job/);
    assert.equal(sql('SELECT count(*) FROM public.audit_log'), '1');
    assert.equal(sql('SELECT count(*) FROM public.location_events'), '1');
    const receipt = JSON.parse(sql('SELECT metadata FROM public.audit_log'));
    assert.equal(receipt.source.sha256, 'a'.repeat(64));
    assert.equal(receipt.source.received_local, '2026-01-15T20:00');
    assert.equal(receipt.previous.sla_clocks[0].status, 'running');
    assert.equal(receipt.resulting.sla_clocks[0].elapsed_minutes, 15);

    const shift = randomUUID();
    sql(`INSERT INTO public.shifts VALUES ('${shift}', '${org}', '${officer}');
      UPDATE public.dispatch_jobs SET shift_id='${shift}' WHERE id IN ('${job(7)}','${job(8)}');
      UPDATE public.dispatch_jobs SET insert_gps_lat=-41, insert_gps_lng=173 WHERE id='${job(8)}'`);
    assert.equal(JSON.parse(sql(invoke(7))).finance.status, 'resolved');
    assert.equal(JSON.parse(sql(invoke(8))).finance.status, 'review_required');
    assert.equal(sql(`SELECT insert_gps_lat || ':' || insert_gps_lng FROM public.dispatch_jobs WHERE id='${job(8)}'`), '-41:173');
    const sameTransaction = sql(`BEGIN; ${invoke(9)} RESET ROLE;
      UPDATE public.dispatch_jobs SET status='completed' WHERE id='${job(10)}';
      SELECT dispatched_at IS NOT NULL FROM public.dispatch_jobs WHERE id='${job(10)}'; ROLLBACK;`);
    assert.ok(sameTransaction.endsWith('\nt'), 'Historical milestone suppression must not leak into later operations');

    sql(`CREATE FUNCTION public.reject_synthetic_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER reject_audit BEFORE INSERT ON public.audit_log FOR EACH ROW
        EXECUTE FUNCTION public.reject_synthetic_audit()`);
    assert.throws(() => sql(invoke(11)), /synthetic audit failure/);
    assert.equal(sql(`SELECT status FROM public.dispatch_jobs WHERE id='${job(11)}'`), 'pending');
    assert.equal(sql(`SELECT status FROM public.sla_clocks WHERE dispatch_job_id='${job(11)}'`), 'running');
    assert.equal(sql(`SELECT count(*) FROM public.location_events WHERE external_ref='${job(11)}'`), '0');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
