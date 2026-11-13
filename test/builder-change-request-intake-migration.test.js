'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261113150000_change_request_builder_intake.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

const SIGNATURES = [
  'builder_change_request_enqueue(uuid, uuid, text)',
  'builder_change_request_bind_job(uuid, uuid, uuid)',
  'builder_change_request_park(uuid, text)',
  'builder_change_request_park_stale(integer)',
];

test('change-request intake RPCs are service-only with explicit grants', () => {
  for (const signature of SIGNATURES) {
    const escaped = signature.replace(/[().]/g, '\\$&');
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM PUBLIC, anon, authenticated;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped} TO service_role;`));
  }
  assert.equal((migration.match(/IF auth\.role\(\) IS DISTINCT FROM 'service_role'/g) || []).length, 4);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION [^;]+ TO (?:anon|authenticated|PUBLIC)/);
});

test('protected and stop-line requests are never routed, and a human review is not stamped by automation', () => {
  assert.match(migration, /_packet\.repair_risk = 'protected'/);
  assert.match(migration, /_packet\.stop_line_hit IS NOT NULL/);
  assert.match(migration, /role = 'grand_master'/);
  assert.match(migration, /public\.can_approve_action\(/);
  assert.doesNotMatch(migration, /SET disposition/);
});

test('change-request intake routes, binds and parks with the governed state transitions', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, async () => {
  const name = `fcm-change-request-${randomUUID()}`;
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
    const service = (query) => sql(`SET test.role = 'service_role'; ${query}`).split('\n').at(-1);
    const fails = (query, pattern) => assert.throws(() => sql(query), (error) => pattern.test(String(error.stderr || error.message)));

    const org = '00000000-0000-4000-8000-000000000001';
    const owner = '00000000-0000-4000-8000-000000000002';
    const officer = '00000000-0000-4000-8000-000000000003';
    const project = '00000000-0000-4000-8000-000000000010';
    const strayProject = '00000000-0000-4000-8000-000000000011';
    const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    // The live shape of the tables the migration reads and writes.
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT nullif(current_setting('test.role', true), '') $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE TABLE public.user_profiles (id uuid PRIMARY KEY, role text NOT NULL, deactivated_at timestamptz);
      CREATE FUNCTION public.can_approve_action(p_user_id uuid, p_action_org_id uuid) RETURNS boolean LANGUAGE sql
        AS $$ SELECT p_user_id = '${owner}'::uuid AND p_action_org_id = '${org}'::uuid $$;
      CREATE TABLE public.builder_projects (id uuid PRIMARY KEY, organization_id uuid NOT NULL, status text NOT NULL, created_by uuid);
      CREATE TABLE public.bob_friction_packets (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL, envelope jsonb NOT NULL DEFAULT '{}',
        route text, stop_line_hit text, disposition text NOT NULL DEFAULT 'open',
        created_at timestamptz NOT NULL DEFAULT now(), repair_risk text NOT NULL DEFAULT 'significant',
        automation_status text NOT NULL DEFAULT 'awaiting_grandmaster',
        automation_attempt_count integer NOT NULL DEFAULT 0 CHECK (automation_attempt_count BETWEEN 0 AND 5),
        builder_job_id uuid UNIQUE, automation_error_redacted text, automation_updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.builder_jobs (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid, status text NOT NULL DEFAULT 'intake',
        autopilot_requested_by uuid, autopilot_conversation_id uuid, autopilot_source text,
        source_friction_packet_id uuid UNIQUE REFERENCES public.bob_friction_packets(id) ON DELETE SET NULL,
        repair_risk text, autopilot_state text, autopilot_updated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.builder_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, job_id uuid NOT NULL,
        event_type text NOT NULL, actor_user_id uuid, actor_type text, new_value jsonb, change_summary text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.builder_chat_threads (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid NOT NULL, title text NOT NULL DEFAULT 'Bob Builder chat',
        status text NOT NULL DEFAULT 'open', last_activity_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
      );
      CREATE TABLE public.builder_chat_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigint GENERATED ALWAYS AS IDENTITY,
        thread_id uuid NOT NULL REFERENCES public.builder_chat_threads(id) ON DELETE CASCADE,
        role text NOT NULL, kind text NOT NULL DEFAULT 'message', content text NOT NULL DEFAULT '',
        payload jsonb NOT NULL DEFAULT '{}', status text, client_request_id text, created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (thread_id, client_request_id)
      );
      INSERT INTO public.user_profiles VALUES ('${owner}', 'grand_master', NULL), ('${officer}', 'officer', NULL);
      INSERT INTO public.builder_projects VALUES ('${project}', '${org}', 'active', '${owner}'), ('${strayProject}', '${org}', 'active', '${officer}');
    `);
    const report = `'{"before":{"page":"/admin/timesheets"},"during":{"user_report":{"kind":"change_request","desired_behavior":"Add approve buttons"}}}'::jsonb`;
    const packet = (n, fields = '') => sql(`INSERT INTO public.bob_friction_packets (id, organization_id, user_id, envelope${fields ? `, ${fields.split('=')[0]}` : ''})
      VALUES ('${id(n)}', '${org}', '${officer}', ${report}${fields ? `, ${fields.split('=')[1]}` : ''});`);
    packet(1);
    packet(2, "repair_risk='protected'");
    packet(3, "stop_line_hit='payroll'");
    sql(`INSERT INTO public.bob_friction_packets (id, organization_id, user_id, envelope) VALUES ('${id(4)}', '${org}', '${officer}', '{"during":{}}');`);
    packet(5);
    sql(migration);

    const enqueue = (packetId, projectId = project) => `SELECT public.builder_change_request_enqueue('${packetId}', '${projectId}', 'Assess the change request and propose a Builder job.');`;
    fails(`SET test.role = 'authenticated'; ${enqueue(id(1))}`, /Service identity required/);
    fails(`SET ROLE anon; ${enqueue(id(1))}`, /permission denied/);
    fails(`SET test.role = 'service_role'; ${enqueue(id(1), strayProject)}`, /grand master/i);
    fails(`SET test.role = 'service_role'; ${enqueue(id(2))}`, /not eligible/);
    fails(`SET test.role = 'service_role'; ${enqueue(id(3))}`, /not eligible/);
    fails(`SET test.role = 'service_role'; ${enqueue(id(4))}`, /not eligible/);

    // No open owner thread yet: one is opened for the routed request.
    const messageId = service(enqueue(id(1)));
    assert.match(messageId, /^[0-9a-f-]{36}$/);
    assert.equal(sql(`SELECT count(*) FROM public.builder_chat_threads WHERE created_by = '${owner}' AND status = 'open';`), '1');
    assert.equal(sql(`SELECT role || '|' || kind || '|' || status || '|' || client_request_id || '|' || created_by FROM public.builder_chat_messages WHERE id = '${messageId}';`),
      `owner|message|queued|change-request:${id(1)}|${owner}`);
    assert.equal(sql(`SELECT payload->'change_request'->>'packet_id' || '|' || (payload->'change_request'->>'auto_implement') || '|' || (payload->'context'->>'surface') FROM public.builder_chat_messages WHERE id = '${messageId}';`),
      `${id(1)}|true|change_request_intake`);
    assert.equal(sql(`SELECT disposition || '|' || automation_status || '|' || automation_attempt_count FROM public.bob_friction_packets WHERE id = '${id(1)}';`), 'open|claimed|1');
    fails(`SET test.role = 'service_role'; ${enqueue(id(1))}`, /not eligible/);

    // A later request lands in the owner's most recently active open thread.
    const thread = sql(`SELECT thread_id FROM public.builder_chat_messages WHERE id = '${messageId}';`);
    const second = service(enqueue(id(5)));
    assert.equal(sql(`SELECT thread_id FROM public.builder_chat_messages WHERE id = '${second}';`), thread);

    // Binding links the packet, the job and the proposal; the owner is the autopilot requester.
    sql(`INSERT INTO public.builder_chat_messages (thread_id, role, kind, content, payload)
      VALUES ('${thread}', 'bob', 'proposal', 'Proposal', jsonb_build_object('message_id', '${messageId}', 'proposal', '{}'::jsonb));`);
    sql(`INSERT INTO public.builder_jobs (id, organization_id, project_id) VALUES ('${id(100)}', '${org}', '${project}'), ('${id(101)}', '${org}', '${project}');`);
    fails(`SET test.role = 'authenticated'; SELECT public.builder_change_request_bind_job('${id(100)}', '${id(1)}', '${messageId}');`, /Service identity required/);
    fails(`SET test.role = 'service_role'; SELECT public.builder_change_request_bind_job('${id(100)}', '${id(5)}', '${messageId}');`, /does not belong/);
    service(`SELECT (public.builder_change_request_bind_job('${id(100)}', '${id(1)}', '${messageId}')).id;`);
    assert.equal(sql(`SELECT autopilot_requested_by || '|' || coalesce(autopilot_source, 'chat') || '|' || source_friction_packet_id || '|' || repair_risk || '|' || autopilot_state FROM public.builder_jobs WHERE id = '${id(100)}';`),
      `${owner}|chat|${id(1)}|significant|driving`);
    assert.equal(sql(`SELECT builder_job_id || '|' || automation_status || '|' || disposition FROM public.bob_friction_packets WHERE id = '${id(1)}';`), `${id(100)}|builder_started|open`);
    assert.equal(sql(`SELECT payload->>'job_id' FROM public.builder_chat_messages WHERE kind = 'proposal' AND payload->>'message_id' = '${messageId}';`), id(100));
    assert.equal(sql(`SELECT event_type || '|' || actor_user_id FROM public.builder_audit_events WHERE job_id = '${id(100)}';`), `builder_job_policy_bound|${owner}`);
    fails(`SET test.role = 'service_role'; SELECT public.builder_change_request_bind_job('${id(101)}', '${id(1)}', '${messageId}');`, /not claimed/);

    // Parking records the reason and takes the request out of automatic routing.
    fails(`SET test.role = 'authenticated'; SELECT public.builder_change_request_park('${id(5)}', 'No proposal');`, /Service identity required/);
    service(`SELECT public.builder_change_request_park('${id(5)}', 'No proposal');`);
    assert.equal(sql(`SELECT automation_status || '|' || automation_error_redacted || '|' || disposition FROM public.bob_friction_packets WHERE id = '${id(5)}';`), 'failed|No proposal|open');
    service(`SELECT public.builder_change_request_park('${id(1)}', 'Late park');`);
    assert.equal(sql(`SELECT automation_status FROM public.bob_friction_packets WHERE id = '${id(1)}';`), 'builder_started', 'a bound request is not parked');

    // A reviewer's decline during assessment wins over Bob's proposal.
    packet(6);
    const declined = service(enqueue(id(6)));
    sql(`UPDATE public.bob_friction_packets SET disposition = 'dismissed' WHERE id = '${id(6)}';`);
    fails(`SET test.role = 'service_role'; SELECT public.builder_change_request_bind_job('${id(101)}', '${id(6)}', '${declined}');`, /not claimed/);

    // Only abandoned claims without a job are parked by the stale sweep.
    packet(7);
    service(enqueue(id(7)));
    sql(`UPDATE public.bob_friction_packets SET automation_updated_at = now() - interval '4 hours' WHERE id IN ('${id(7)}', '${id(1)}');`);
    fails(`SET test.role = 'authenticated'; SELECT public.builder_change_request_park_stale(180);`, /Service identity required/);
    assert.equal(service(`SELECT public.builder_change_request_park_stale(180);`), '1');
    assert.equal(sql(`SELECT automation_status || '|' || automation_error_redacted FROM public.bob_friction_packets WHERE id = '${id(7)}';`), 'failed|Builder chat turn did not finish');
    assert.equal(sql(`SELECT automation_status FROM public.bob_friction_packets WHERE id = '${id(6)}';`), 'claimed', 'a fresh claim is left alone');
    assert.equal(sql(`SELECT automation_status FROM public.bob_friction_packets WHERE id = '${id(1)}';`), 'builder_started');
  } finally {
    if (created) {
      try { docker(['rm', '--force', name]); } catch { /* best effort */ }
    }
  }
});
