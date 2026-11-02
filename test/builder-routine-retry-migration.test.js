'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261107210000_routine_repair_retry_after_release.sql'), 'utf8');

test('routine retry migration keeps one live intake job per packet and a service-only, bounded requeue', () => {
  assert.match(migration, /WHERE source_friction_packet_id IS NOT NULL\s+AND parent_job_id IS NULL\s+AND status NOT IN \('failed', 'cancelled'\)/);
  assert.match(migration, /IF auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  assert.match(migration, /packet\.automation_attempt_count < 3/);
  assert.match(migration, /packet\.automation_updated_at < _released_at/);
  assert.match(migration, /packet\.created_at > now\(\) - interval '21 days'/);
  assert.match(migration, /packet\.disposition IN \('open', 'reviewing'\)/);
  assert.match(migration, /FOR UPDATE OF packet SKIP LOCKED/);
  assert.match(migration, /'routine_repair_requeued'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.builder_requeue_failed_routine_repairs\(text, timestamptz, integer\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.builder_requeue_failed_routine_repairs\(text, timestamptz, integer\) TO service_role;/);
});

test('continuations share a packet, failed roots release it, and failed routine packets retry once per release', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, async () => {
  const name = `fcm-routine-retry-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = (query) => execFileSync('docker', ['exec', '-i', name, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
      input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const fails = (query, pattern) => assert.throws(() => sql(query), (error) => pattern.test(String(error.stderr || error.message)));

    // The live shape of the three tables the migration touches, with the pre-migration index and check.
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT nullif(current_setting('test.role', true), '') $$;
      CREATE TABLE public.bob_friction_packets (
        id uuid PRIMARY KEY, user_id uuid NOT NULL, envelope jsonb NOT NULL DEFAULT '{}',
        route text NOT NULL, stop_line_hit text, disposition text NOT NULL DEFAULT 'open',
        created_at timestamptz NOT NULL DEFAULT now(), repair_risk text NOT NULL DEFAULT 'routine',
        automation_status text NOT NULL DEFAULT 'not_eligible', automation_attempt_count integer NOT NULL DEFAULT 0,
        builder_job_id uuid, automation_error_redacted text, automation_updated_at timestamptz NOT NULL DEFAULT now(),
        covered_by_job_id uuid
      );
      CREATE TABLE public.builder_jobs (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, status text NOT NULL,
        parent_job_id uuid REFERENCES public.builder_jobs(id) ON DELETE RESTRICT,
        source_friction_packet_id uuid REFERENCES public.bob_friction_packets(id) ON DELETE SET NULL,
        last_error text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX builder_jobs_source_friction_packet_unique ON public.builder_jobs (source_friction_packet_id)
        WHERE source_friction_packet_id IS NOT NULL;
      CREATE TABLE public.builder_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, job_id uuid NOT NULL,
        event_type text NOT NULL, actor_user_id uuid, actor_type text, previous_value jsonb, new_value jsonb,
        change_summary text, created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT builder_audit_events_event_type_check CHECK (event_type = ANY (ARRAY['job_created', 'builder_job_policy_bound']::text[]))
      );
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    `);
    sql(migration);

    const org = '00000000-0000-4000-8000-000000000001';
    const user = '00000000-0000-4000-8000-000000000002';
    const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const job = (n, status, packet, parent = null) => `INSERT INTO public.builder_jobs (id, organization_id, status, source_friction_packet_id, parent_job_id, last_error)
      VALUES ('${id(n)}', '${org}', '${status}', ${packet ? `'${id(packet)}'` : 'NULL'}, ${parent ? `'${id(parent)}'` : 'NULL'}, 'stopped ${n}');`;
    const packet = (n, fields = {}) => {
      const row = {
        route: "'dispatch_flow'", repair_risk: "'routine'", automation_status: "'failed'", automation_attempt_count: '1',
        disposition: "'open'", created_at: "now() - interval '1 day'", automation_updated_at: "now() - interval '2 hours'",
        builder_job_id: 'NULL', covered_by_job_id: 'NULL', stop_line_hit: 'NULL', ...fields,
      };
      return `INSERT INTO public.bob_friction_packets (id, user_id, ${Object.keys(row).join(', ')})
        VALUES ('${id(n)}', '${user}', ${Object.values(row).join(', ')});`;
    };

    // 1. One live intake job per packet; continuations share it; a failed root releases it.
    sql(packet(1, { automation_status: "'builder_started'" }) + job(101, 'implementation_pending', 1));
    sql(job(102, 'implementation_pending', 1, 101));
    fails(job(103, 'intake', 1), /builder_jobs_source_friction_packet_unique/);
    sql(`UPDATE public.builder_jobs SET status = 'failed' WHERE id = '${id(101)}';`);
    sql(job(104, 'intake', 1));
    fails(job(105, 'intake', 1), /builder_jobs_source_friction_packet_unique/);

    // 2. Only the service identity may requeue, and only for a full SHA and a past release time.
    const releaseSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const requeue = (releasedAt, role = 'service_role', sha = releaseSha) =>
      sql(`SET test.role = '${role}'; SELECT id FROM public.builder_requeue_failed_routine_repairs('${sha}', ${releasedAt}, 10) ORDER BY id;`)
        .split('\n').filter((line) => /^[0-9a-f-]{36}$/.test(line));
    const signature = 'public.builder_requeue_failed_routine_repairs(text,timestamptz,integer)';
    assert.equal(sql(`SELECT string_agg(r || '=' || has_function_privilege(r, '${signature}', 'EXECUTE'), ',' ORDER BY r)
      FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;`), 'anon=false,authenticated=false,service_role=true');
    fails(`SET test.role = 'authenticated'; SELECT public.builder_requeue_failed_routine_repairs('${releaseSha}', now(), 3);`, /Service identity required/);
    fails('SELECT public.builder_requeue_failed_routine_repairs(\'' + releaseSha + '\', now(), 3);', /Service identity required/);
    fails(`SET test.role = 'service_role'; SELECT public.builder_requeue_failed_routine_repairs('ABC', now(), 3);`, /full lowercase release SHA/);
    fails(`SET test.role = 'service_role'; SELECT public.builder_requeue_failed_routine_repairs('${releaseSha}', now() + interval '1 hour', 3);`, /past release time/);

    // 3. Eligibility: failed under replaced code, routine, open, under the cap, recent, and not still being worked.
    sql([
      packet(10, { builder_job_id: `'${id(110)}'` }), job(110, 'failed', 10), // eligible: its own job failed
      packet(11, { automation_attempt_count: '3' }), // attempt cap reached
      packet(12, { automation_updated_at: 'now() - interval \'10 minutes\'' }), // failed under this release
      packet(13, { disposition: "'resolved'" }), // a person closed it
      packet(14, { created_at: "now() - interval '30 days'" }), // too old
      packet(15), job(115, 'testing', 15), // its own intake job is still live
      packet(16), job(116, 'building', null), `UPDATE public.bob_friction_packets SET covered_by_job_id = '${id(116)}' WHERE id = '${id(16)}';`, // covered by a live repair
      packet(17), job(117, 'failed', null), `UPDATE public.bob_friction_packets SET covered_by_job_id = '${id(117)}' WHERE id = '${id(17)}';`, // covered by a failed repair: eligible
      packet(18, { automation_status: "'queued'" }), // already queued
      packet(19, { repair_risk: "'protected'" }), // never automatic
      packet(20, { stop_line_hit: "'legal'" }), // stop line
      packet(21, { route: "'grandmaster_review'" }), // not a dispatch packet
      packet(22), // failed with no recorded job: requeued, nothing to audit against
    ].join('\n'));
    const released = "now() - interval '1 hour'";
    assert.deepEqual(requeue(released), [id(10), id(17), id(22)]);
    assert.equal(sql(`SELECT string_agg(automation_status || ':' || coalesce(covered_by_job_id::text, '-') || ':' || automation_error_redacted, '|' ORDER BY id)
      FROM public.bob_friction_packets WHERE id IN ('${id(10)}', '${id(17)}');`),
    'queued:-:Re-queued after release abcdef12 for attempt 2 of 3.|queued:-:Re-queued after release abcdef12 for attempt 2 of 3.');
    assert.equal(sql(`SELECT string_agg(job_id || ':' || actor_type || ':' || (new_value->>'release_sha') || ':' || (new_value->>'next_attempt'), '|' ORDER BY job_id)
      FROM public.builder_audit_events WHERE event_type = 'routine_repair_requeued';`),
    `${id(110)}:bot:${releaseSha}:2|${id(117)}:bot:${releaseSha}:2`);

    // 4. One retry per release: a retry that fails again under the same release waits for the next one.
    sql(`UPDATE public.bob_friction_packets SET automation_status = 'failed', automation_attempt_count = 2,
      automation_updated_at = now() - interval '30 minutes' WHERE id = '${id(10)}';`);
    assert.deepEqual(requeue(released), []);
    // The newer release also replaces the code packet 12 failed under ten minutes ago.
    assert.deepEqual(requeue("now() - interval '1 minute'"), [id(10), id(12)]);
    sql(`UPDATE public.bob_friction_packets SET automation_status = 'failed', automation_attempt_count = 3,
      automation_updated_at = now() - interval '5 minutes' WHERE id = '${id(10)}';`);
    assert.deepEqual(requeue('now()'), [], 'three attempts is the ceiling');

    // 5. The audit check still rejects unknown event types.
    fails(`INSERT INTO public.builder_audit_events (organization_id, job_id, event_type) VALUES ('${org}', '${id(110)}', 'made_up');`,
      /builder_audit_events_event_type_check/);
  } finally {
    if (created) {
      try { docker(['rm', '--force', name]); } catch { /* best effort */ }
    }
  }
});
