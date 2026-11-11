'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261111100001_bob_human_references.sql');
const schemaPath = path.join(__dirname, '../supabase/schema.sql');
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EARLIER = '11111111-1111-4111-8111-111111111111';
const LATER = '22222222-2222-4222-8222-222222222222';

function schemaFunction(schema, name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.notEqual(start, -1, `Missing live-snapshot function ${name}`);
  const end = schema.indexOf('\n$function$;', start);
  assert.notEqual(end, -1, `Incomplete live-snapshot function ${name}`);
  return schema.slice(start, end + '\n$function$;'.length);
}

function schemaTrigger(schema, name) {
  const line = schema.split('\n').find(row => row.startsWith(`CREATE TRIGGER "${name}" `));
  assert.ok(line, `Missing live-snapshot trigger ${name}`);
  return line;
}

test('human references survive migration, concurrent creation, retries, deletion and tenant access', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 90000,
}, async t => {
  const name = `fcm-human-references-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = query => execFileSync('docker', ['exec', '-i', name, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
      input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const sqlAsync = query => new Promise(resolve => {
      const child = spawn('docker', ['exec', '-i', name, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let error = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      child.on('close', code => resolve({ code, output: output.trim(), error }));
      child.stdin.end(query);
    });

    sql(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('test.user_id', true), '')::uuid
      $$;
      CREATE TABLE public.user_profiles (id uuid PRIMARY KEY, role text NOT NULL, deactivated_at timestamptz);
      INSERT INTO public.user_profiles(id, role) VALUES
        ('${USER}', 'grand_master'), ('${ORG_B}', 'grand_master'), ('${ORG_A}', 'officer');
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      CREATE TABLE public.builder_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        title text NOT NULL, status text NOT NULL DEFAULT 'intake',
        autopilot_state text, autopilot_requested_by uuid, created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.builder_vibe_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid NOT NULL,
        title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        last_activity_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.builder_vibe_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigint GENERATED ALWAYS AS IDENTITY,
        session_id uuid NOT NULL REFERENCES public.builder_vibe_sessions(id),
        role text NOT NULL, kind text NOT NULL DEFAULT 'message',
        content text NOT NULL DEFAULT '', payload jsonb NOT NULL DEFAULT '{}', created_by uuid
      );
      CREATE TABLE public.bob_conversations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        user_id uuid NOT NULL, module_key text NOT NULL DEFAULT 'operations', title text, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), pinned boolean NOT NULL DEFAULT false, archived_at timestamptz
      );
      CREATE TABLE public.bob_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        conversation_id uuid NOT NULL REFERENCES public.bob_conversations(id),
        role text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION public.accessible_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT CASE WHEN EXISTS (SELECT 1 FROM public.user_profiles
          WHERE id = auth.uid() AND deactivated_at IS NULL)
          THEN ARRAY[nullif(current_setting('test.organization_id', true), '')::uuid]
          ELSE ARRAY[]::uuid[] END
      $$;
      CREATE TABLE public.notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, recipient_user_id uuid,
        recipient_role text, category text, severity text, title text, body text,
        link_page text, link_payload jsonb, dedup_key text
      );
      CREATE TABLE public.audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid,
        action text NOT NULL, target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}'
      );
      GRANT SELECT, UPDATE ON public.builder_jobs TO service_role;
      GRANT INSERT ON public.audit_log TO service_role;
      CREATE FUNCTION public.builder_require_implementation_acceptance(
        _job_id uuid, _require_passed boolean DEFAULT true
      ) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Acceptance gate reached'; END;
      $$;
      ALTER TABLE public.bob_conversations ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.bob_conversations TO authenticated;
      GRANT SELECT, UPDATE ON public.bob_conversations TO service_role;
      CREATE POLICY conversation_tenant ON public.bob_conversations TO authenticated
        USING (organization_id = current_setting('test.organization_id', true)::uuid)
        WITH CHECK (organization_id = current_setting('test.organization_id', true)::uuid);
      ALTER TABLE public.bob_messages ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT ON public.bob_messages TO authenticated, service_role;
      CREATE POLICY message_tenant ON public.bob_messages TO authenticated
        USING (organization_id = current_setting('test.organization_id', true)::uuid)
        WITH CHECK (organization_id = current_setting('test.organization_id', true)::uuid);
      INSERT INTO public.builder_jobs(id, organization_id, title, status, created_by, created_at, updated_at) VALUES
        ('${LATER}', '${ORG_A}', 'Later', 'failed', '${USER}', '2026-02-01', '2026-02-02'),
        ('${EARLIER}', '${ORG_A}', 'Earlier', 'intake', '${USER}', '2026-01-01', '2026-01-02');
      INSERT INTO public.builder_vibe_sessions(id, created_by, title, created_at, last_activity_at) VALUES
        ('${LATER}', '${USER}', 'Untitled vibe session', '2026-02-01', '2026-02-02'),
        ('${EARLIER}', '${USER}', 'Earlier', '2026-01-01', '2026-01-02');
      INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload) VALUES
        ('${LATER}', 'system', 'status', 'Session opened', '{}'),
        ('${LATER}', 'owner', 'message', 'First   useful request', '{"action":"message"}'),
        ('${LATER}', 'owner', 'message', 'Later request', '{"action":"message"}');
      INSERT INTO public.bob_conversations(id, organization_id, user_id, title, created_at, updated_at) VALUES
        ('${LATER}', '${ORG_A}', '${USER}', 'Bob Operations', '2026-02-01', '2026-02-02'),
        ('${EARLIER}', '${ORG_A}', '${USER}', 'Earlier', '2026-01-01', '2026-01-02');
      INSERT INTO public.bob_messages(organization_id, conversation_id, role, content, created_at) VALUES
        ('${ORG_A}', '${LATER}', 'user', 'Review the site', '2026-02-01'),
        ('${ORG_A}', '${LATER}', 'user', 'Later question', '2026-02-02');
    `);
    const schema = fs.readFileSync(schemaPath, 'utf8');
    sql([
      schemaFunction(schema, 'is_grand_master'),
      schemaFunction(schema, 'builder_vibe_require_owner'),
      schemaFunction(schema, 'builder_vibe_session_open'),
      schemaFunction(schema, 'enqueue_notification'),
      schemaFunction(schema, 'notify_builder_job_terminal'),
      schemaFunction(schema, 'builder_enforce_implementation_acceptance'),
      schemaTrigger(schema, 'builder_job_terminal_notification'),
      schemaTrigger(schema, 'builder_whole_job_acceptance_release'),
    ].join('\n'));
    sql(`REVOKE ALL ON FUNCTION public.builder_vibe_session_open(text) FROM PUBLIC, anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.builder_vibe_session_open(text) TO authenticated, service_role;`);
    const migration = fs.readFileSync(migrationPath, 'utf8');
    sql(migration);

    await t.test('backfill preserves activity timestamps and does not send terminal notifications', () => {
      assert.equal(sql(`SELECT updated_at = '2026-01-02'::timestamptz FROM public.builder_jobs WHERE id = '${EARLIER}';`), 't');
      assert.equal(sql(`SELECT last_activity_at = '2026-01-02'::timestamptz FROM public.builder_vibe_sessions WHERE id = '${EARLIER}';`), 't');
      assert.equal(sql(`SELECT updated_at = '2026-01-02'::timestamptz FROM public.bob_conversations WHERE id = '${EARLIER}';`), 't');
      assert.equal(sql('SELECT count(*) FROM public.notifications;'), '0');
    });

    await t.test('names an existing untitled Vibe session from its first owner request', () => {
      assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${LATER}';`), 'First useful request');
      assert.equal(sql(`SELECT last_activity_at = '2026-02-02'::timestamptz FROM public.builder_vibe_sessions WHERE id = '${LATER}';`), 't');
    });

    await t.test('names an existing generic Bob conversation from its first user request', () => {
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${LATER}';`), 'Review the site');
      assert.equal(sql(`SELECT updated_at = '2026-02-02'::timestamptz FROM public.bob_conversations WHERE id = '${LATER}';`), 't');
    });

    await t.test('the original Builder notification and acceptance triggers still run on status changes', () => {
      assert.equal(sql(`BEGIN;
        UPDATE public.builder_jobs SET status = 'failed' WHERE id = '${EARLIER}';
        SELECT count(*) FROM public.notifications WHERE category = 'builder_job';
        ROLLBACK;`), '1');
      assert.throws(() => sql(`UPDATE public.builder_jobs SET status = 'release_ready' WHERE id = '${EARLIER}';`), /Acceptance gate reached/);
    });

    await t.test('the Builder history cursor has an index in its sort order', () => {
      const plan = sql(`SET enable_seqscan = off;
        EXPLAIN SELECT id FROM public.builder_jobs
        WHERE created_at < '2026-02-01'::timestamptz
           OR (created_at = '2026-02-01'::timestamptz AND id < '${LATER}'::uuid)
        ORDER BY created_at DESC, id DESC LIMIT 101;`);
      assert.match(plan, /builder_jobs_created_id_history_idx/);
    });

    await t.test('renames a Builder job atomically with an audit receipt and preserves its reference', () => {
      const call = (expected, title, org = ORG_A) => `SELECT (public.builder_rename_job(
        '${EARLIER}', '${org}', '${USER}', '${expected}', '${title}')).human_reference;`;
      assert.equal(sql(`SET ROLE service_role; ${call('Earlier', 'Clarified work')}`), 'BB-1');
      assert.equal(sql(`SELECT title FROM public.builder_jobs WHERE id = '${EARLIER}';`), 'Clarified work');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action = 'builder_job_renamed'
        AND actor_user_id = '${USER}' AND target_id = '${EARLIER}'
        AND metadata->>'previous_title' = 'Earlier' AND metadata->>'title' = 'Clarified work';`), '1');
      assert.equal(sql(`SET ROLE service_role; ${call('Earlier', 'Clarified work')}`), 'BB-1');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action = 'builder_job_renamed';`), '1');
      assert.throws(() => sql(`SET ROLE authenticated; ${call('Clarified work', 'Unauthorized')}`), /permission denied/i);
      assert.throws(() => sql(`SET ROLE service_role; ${call('Clarified work', 'Wrong tenant', ORG_B)}`), /unavailable/i);
      assert.throws(() => sql(`SET ROLE service_role; ${call('Earlier', 'Stale change')}`), /changed/i);
      assert.throws(() => sql(`\\set VERBOSITY verbose\nSET ROLE service_role; ${call('Earlier', 'Stale change')}`), /PT409.*title changed/i);
      assert.throws(() => sql(`SET ROLE service_role; ${call('Clarified work', ' ')}`), /title/i);
      assert.throws(() => sql(`SET ROLE service_role; SELECT public.builder_rename_job(
        '${EARLIER}', '${ORG_A}', '${USER}', 'Clarified work', repeat('x', 201));`), /title/i);
      assert.equal(sql('SELECT count(*) FROM public.notifications;'), '0');
    });

    await t.test('a rename cannot bypass privileges missing from the service caller', () => {
      sql('REVOKE UPDATE ON public.builder_jobs FROM service_role;');
      try {
        assert.throws(() => sql(`BEGIN; SET ROLE service_role; SELECT public.builder_rename_job(
          '${EARLIER}', '${ORG_A}', '${USER}', 'Clarified work', 'Unprivileged change'); ROLLBACK;`), /permission denied/i);
        assert.equal(sql(`SELECT title FROM public.builder_jobs WHERE id = '${EARLIER}';`), 'Clarified work');
      } finally {
        sql('GRANT UPDATE ON public.builder_jobs TO service_role;');
      }
    });

    await t.test('rolls back a Builder rename when its audit receipt cannot be recorded', () => {
      sql("ALTER TABLE public.audit_log ADD CONSTRAINT fixture_deny_rename CHECK (action <> 'builder_job_renamed') NOT VALID;");
      try {
        assert.throws(() => sql(`SET ROLE service_role; SELECT public.builder_rename_job(
          '${EARLIER}', '${ORG_A}', '${USER}', 'Clarified work', 'Unaudited name');`), /fixture_deny_rename/);
        assert.equal(sql(`SELECT title FROM public.builder_jobs WHERE id = '${EARLIER}';`), 'Clarified work');
      } finally {
        sql('ALTER TABLE public.audit_log DROP CONSTRAINT fixture_deny_rename;');
      }
    });

    await t.test('concurrent edits of the same original title cannot overwrite each other', async () => {
      const results = await Promise.all(['Candidate A', 'Candidate B'].map(title => sqlAsync(`
        SET ROLE service_role;
        SELECT (public.builder_rename_job('${LATER}', '${ORG_A}', '${USER}', 'Later', '${title}')).human_reference;
      `)));
      const successes = results.filter(result => result.code === 0);
      const conflicts = results.filter(result => result.code !== 0);
      assert.equal(successes.length, 1, JSON.stringify(results));
      assert.equal(successes[0].output, 'BB-2');
      assert.equal(conflicts.length, 1, JSON.stringify(results));
      assert.match(conflicts[0].error, /title changed/i);
      assert.equal(sql(`SELECT count(*) FROM public.audit_log
        WHERE action = 'builder_job_renamed' AND target_id = '${LATER}';`), '1');
      assert.ok(['Candidate A', 'Candidate B'].includes(
        sql(`SELECT title FROM public.builder_jobs WHERE id = '${LATER}';`),
      ));
    });

    await t.test('the session owner can rename Vibe history with an atomic audit receipt', () => {
      const call = (expected, title) => `SELECT (public.builder_vibe_rename_session(
        '${EARLIER}', '${expected}', '${title}')).human_reference;`;
      const owner = `SET ROLE authenticated; SET test.user_id = '${USER}';`;
      assert.equal(sql(`${owner} ${call('Earlier', 'Clear Vibe name')}`), 'VB-1');
      assert.equal(sql(`${owner} ${call('Earlier', 'Clear Vibe name')}`), 'VB-1');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action = 'builder_vibe_session_renamed'
        AND target_id = '${EARLIER}' AND actor_user_id = '${USER}' AND organization_id IS NULL
        AND metadata->>'previous_title' = 'Earlier' AND metadata->>'title' = 'Clear Vibe name';`), '1');
      assert.throws(() => sql(`${owner} ${call('Earlier', 'Stale change')}`), /title changed/i);
      assert.throws(() => sql(`SET ROLE authenticated; SET test.user_id = '${ORG_B}'; ${call('Clear Vibe name', 'Another owner')}`), /unavailable/i);
      assert.throws(() => sql(`SET ROLE authenticated; SET test.user_id = '${ORG_A}'; ${call('Clear Vibe name', 'Officer')}`), /platform owner/i);
      assert.throws(() => sql(`SET ROLE anon; ${call('Clear Vibe name', 'Anonymous')}`), /permission denied/i);
      assert.throws(() => sql(`${owner} ${call('Clear Vibe name', ' ')}`), /title/i);
      assert.equal(sql(`SELECT last_activity_at = '2026-01-02'::timestamptz FROM public.builder_vibe_sessions WHERE id = '${EARLIER}';`), 't');
    });

    await t.test('a Vibe rename rolls back when its audit receipt fails', () => {
      sql("ALTER TABLE public.audit_log ADD CONSTRAINT fixture_deny_vibe_rename CHECK (action <> 'builder_vibe_session_renamed') NOT VALID;");
      try {
        assert.throws(() => sql(`SET ROLE authenticated; SET test.user_id = '${USER}';
          SELECT public.builder_vibe_rename_session('${EARLIER}', 'Clear Vibe name', 'Unaudited');`), /fixture_deny_vibe_rename/);
        assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${EARLIER}';`), 'Clear Vibe name');
      } finally {
        sql('ALTER TABLE public.audit_log DROP CONSTRAINT fixture_deny_vibe_rename;');
      }
    });

    await t.test('backfills existing records in creation order using separate namespaces', () => {
      assert.equal(sql('SELECT string_agg(human_reference, \',\' ORDER BY created_at, id) FROM public.builder_jobs;'), 'BB-1,BB-2');
      assert.equal(sql('SELECT string_agg(human_reference, \',\' ORDER BY created_at, id) FROM public.builder_vibe_sessions;'), 'VB-1,VB-2');
      assert.equal(sql('SELECT string_agg(human_reference, \',\' ORDER BY created_at, id) FROM public.bob_conversations;'), 'BOB-1,BOB-2');
    });

    await t.test('assigns the next reference to new records in each namespace', () => {
      assert.equal(sql(`INSERT INTO public.builder_jobs(organization_id, title) VALUES ('${ORG_A}', 'New job') RETURNING human_reference;`), 'BB-3');
      assert.equal(sql(`INSERT INTO public.builder_vibe_sessions(created_by, title) VALUES ('${USER}', 'New session') RETURNING human_reference;`), 'VB-3');
      assert.equal(sql(`SET ROLE authenticated; SET test.organization_id = '${ORG_B}';
        INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_B}', '${USER}', 'New conversation') RETURNING human_reference;`), 'BOB-3');
    });

    await t.test('prevents references and their counters being changed by an authenticated client', () => {
      const prefix = `SET ROLE authenticated; SET test.organization_id = '${ORG_A}';`;
      assert.throws(() => sql(`${prefix} UPDATE public.bob_conversations SET human_reference_number = DEFAULT WHERE id = '${EARLIER}';`), /immutable/i);
      assert.throws(() => sql(`${prefix} UPDATE public.bob_conversations SET human_reference = 'BOB-900' WHERE id = '${EARLIER}';`), /generated/i);
      assert.throws(() => sql(`${prefix} SELECT nextval(pg_get_serial_sequence('public.bob_conversations', 'human_reference_number'));`), /permission denied/i);
      assert.equal(sql(`SELECT human_reference FROM public.bob_conversations WHERE id = '${EARLIER}';`), 'BOB-1');
      assert.equal(sql(`SELECT has_sequence_privilege('anon', pg_get_serial_sequence('public.bob_conversations', 'human_reference_number'), 'USAGE'),
        has_sequence_privilege('authenticated', pg_get_serial_sequence('public.bob_conversations', 'human_reference_number'), 'USAGE'),
        has_sequence_privilege('service_role', pg_get_serial_sequence('public.bob_conversations', 'human_reference_number'), 'UPDATE');`), 'f|f|f');
    });

    await t.test('does not expose another organization through reference lookup', () => {
      const prefix = `SET ROLE authenticated; SET test.organization_id = '${ORG_B}';`;
      assert.equal(sql(`${prefix} SELECT count(*) FROM public.bob_conversations WHERE human_reference = 'BOB-1';`), '0');
      assert.equal(sql(`${prefix} UPDATE public.bob_conversations SET title = 'Changed' WHERE human_reference = 'BOB-1' RETURNING id;`), '');
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${EARLIER}';`), 'Earlier');
    });

    await t.test('a Bob conversation can be renamed only by its active owner in its org and workspace', () => {
      const call = (org, mode, expected, title) => `SELECT (public.bob_rename_conversation(
        '${EARLIER}', '${org}', '${mode}', '${expected}', '${title}')).human_reference;`;
      const owner = `SET ROLE authenticated; SET test.user_id = '${USER}'; SET test.organization_id = '${ORG_A}';`;
      assert.equal(sql(`${owner} ${call(ORG_A, 'operations', 'Earlier', 'Clear conversation')}`), 'BOB-1');
      assert.equal(sql(`${owner} ${call(ORG_A, 'operations', 'Earlier', 'Clear conversation')}`), 'BOB-1');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action = 'bob_conversation_renamed'
        AND target_id = '${EARLIER}' AND actor_user_id = '${USER}' AND organization_id = '${ORG_A}'
        AND metadata->>'previous_title' = 'Earlier' AND metadata->>'title' = 'Clear conversation';`), '1');
      assert.throws(() => sql(`${owner} ${call(ORG_A, 'operations', 'Earlier', 'Stale name')}`), /title changed/i);
      assert.throws(() => sql(`${owner} ${call(ORG_A, 'builder', 'Clear conversation', 'Wrong workspace')}`), /unavailable/i);
      assert.throws(() => sql(`${owner} ${call(ORG_B, 'operations', 'Clear conversation', 'Wrong org')}`), /unavailable/i);
      assert.throws(() => sql(`SET ROLE authenticated; SET test.user_id = '${ORG_A}'; SET test.organization_id = '${ORG_A}';
        ${call(ORG_A, 'operations', 'Clear conversation', 'Another user')}`), /unavailable/i);
      assert.throws(() => sql(`SET ROLE anon; ${call(ORG_A, 'operations', 'Clear conversation', 'Anonymous')}`), /permission denied/i);
      sql(`UPDATE public.user_profiles SET deactivated_at = now() WHERE id = '${USER}';`);
      try {
        assert.throws(() => sql(`${owner} ${call(ORG_A, 'operations', 'Clear conversation', 'Inactive')}`), /unavailable/i);
      } finally {
        sql(`UPDATE public.user_profiles SET deactivated_at = NULL WHERE id = '${USER}';`);
      }
    });

    await t.test('a Bob rename rolls back when its audit receipt fails', () => {
      sql("ALTER TABLE public.audit_log ADD CONSTRAINT fixture_deny_bob_rename CHECK (action <> 'bob_conversation_renamed') NOT VALID;");
      try {
        assert.throws(() => sql(`SET ROLE authenticated; SET test.user_id = '${USER}'; SET test.organization_id = '${ORG_A}';
          SELECT public.bob_rename_conversation('${EARLIER}', '${ORG_A}', 'operations', 'Clear conversation', 'Unaudited');`), /fixture_deny_bob_rename/);
        assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${EARLIER}';`), 'Clear conversation');
      } finally {
        sql('ALTER TABLE public.audit_log DROP CONSTRAINT fixture_deny_bob_rename;');
      }
    });

    await t.test('an active officer can rename their own untitled conversation but not one outside their reachable org', () => {
      const id = sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${ORG_A}', NULL) RETURNING id;`);
      const actor = `SET ROLE authenticated; SET test.user_id = '${ORG_A}';`;
      assert.equal(sql(`${actor} SET test.organization_id = '${ORG_A}';
        SELECT (public.bob_rename_conversation('${id}', '${ORG_A}', 'operations', NULL, 'Officer request')).title;`), 'Officer request');
      assert.throws(() => sql(`${actor} SET test.organization_id = '${ORG_B}';
        SELECT public.bob_rename_conversation('${id}', '${ORG_A}', 'operations', 'Officer request', 'Outside reach');`), /unavailable/i);
    });

    await t.test('Bob history searches literal names and references through scoped, stable pages', () => {
      sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title, updated_at)
        SELECT '${ORG_A}', '${USER}', 'Match%_.' || n, '2028-01-01' FROM generate_series(1, 120) n;
        INSERT INTO public.bob_conversations(organization_id, user_id, title, updated_at) VALUES
          ('${ORG_A}', '${USER}', 'MatchXX. excluded', '2028-01-02'),
          ('${ORG_A}', '${ORG_A}', 'Match%_. other user', '2028-01-02'),
          ('${ORG_B}', '${USER}', 'Match%_. other org', '2028-01-02');
        INSERT INTO public.bob_conversations(organization_id, user_id, module_key, title, updated_at)
          VALUES ('${ORG_A}', '${USER}', 'builder', 'Match%_. other mode', '2028-01-02');`);
      const owner = `SET ROLE authenticated; SET test.user_id = '${USER}'; SET test.organization_id = '${ORG_A}';`;
      const page = cursor => JSON.parse(sql(`${owner}
        SELECT coalesce(json_agg(row_to_json(result)), '[]') FROM public.bob_list_conversations(
          '${ORG_A}', 'operations', 'Match%_.', 'all',
          ${cursor ? `'${cursor.updated_at}', '${cursor.id}'` : 'NULL, NULL'}, 50) result;`));
      const first = page(null);
      assert.equal(first.length, 51);
      assert.ok(first.every(row => row.title.startsWith('Match%_.') && !row.title.includes('other')));
      const second = page(first[49]);
      assert.equal(second.length, 51);
      assert.ok(!second.some(row => first.slice(0, 50).some(prior => prior.id === row.id)));
      const third = page(second[49]);
      assert.equal(third.length, 20);
      const ref = first[0].human_reference;
      const byReference = JSON.parse(sql(`${owner}
        SELECT coalesce(json_agg(row_to_json(result)), '[]') FROM public.bob_list_conversations(
          '${ORG_A}', 'operations', '${ref}', 'all', NULL, NULL, 50) result;`));
      assert.ok(byReference.some(row => row.id === first[0].id));
      assert.ok(byReference.every(row => row.human_reference.includes(ref)));
      assert.throws(() => sql(`${owner} SELECT * FROM public.bob_list_conversations(
        '${ORG_A}', 'operations', '', 'all', '2028-01-01', NULL, 50);`), /cursor/i);
    });

    await t.test('rejects a client-supplied reference-number override', () => {
      assert.throws(() => sql(`SET ROLE authenticated; SET test.organization_id = '${ORG_A}';
        INSERT INTO public.bob_conversations(organization_id, user_id, title, human_reference_number)
        OVERRIDING SYSTEM VALUE VALUES ('${ORG_A}', '${USER}', 'Override', 500)
        RETURNING human_reference;`), /allocated automatically/i);
    });

    await t.test('allocates distinct references when conversations are created concurrently', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => sqlAsync(`
        SET ROLE authenticated; SET test.organization_id = '${ORG_A}';
        INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${USER}', 'Concurrent') RETURNING human_reference;
      `)));
      for (const result of results) assert.equal(result.code, 0, result.error);
      assert.equal(new Set(results.map(result => result.output)).size, 12);
      for (const result of results) assert.match(result.output, /^BOB-\d+$/);
    });

    await t.test('continues past 100 and never reuses a deleted or rolled-back reference', () => {
      sql(`INSERT INTO public.builder_vibe_sessions(created_by, title)
        SELECT '${USER}', 'Bulk session' FROM generate_series(1, 105);`);
      assert.equal(sql(`SELECT human_reference FROM public.builder_vibe_sessions
        ORDER BY human_reference_number DESC LIMIT 1;`), 'VB-108');
      const rolledBack = sql(`BEGIN; INSERT INTO public.builder_vibe_sessions(created_by, title)
        VALUES ('${USER}', 'Rolled back') RETURNING human_reference; ROLLBACK;`);
      const deleted = sql(`INSERT INTO public.builder_vibe_sessions(created_by, title)
        VALUES ('${USER}', 'Deleted') RETURNING human_reference;`);
      sql(`DELETE FROM public.builder_vibe_sessions WHERE human_reference = '${deleted}';`);
      const next = sql(`INSERT INTO public.builder_vibe_sessions(created_by, title)
        VALUES ('${USER}', 'After deletion') RETURNING human_reference;`);
      assert.equal(rolledBack, 'VB-109');
      assert.equal(deleted, 'VB-110');
      assert.equal(next, 'VB-111');
    });

    await t.test('reapplying the migration does not reset a sequence or change existing references', () => {
      sql(migration);
      assert.equal(sql(`SELECT human_reference FROM public.builder_vibe_sessions WHERE id = '${EARLIER}';`), 'VB-1');
      assert.equal(sql(`INSERT INTO public.builder_vibe_sessions(created_by, title)
        VALUES ('${USER}', 'After reapplication') RETURNING human_reference;`), 'VB-112');
    });

    await t.test('preserves the full decimal reference beyond JavaScript safe integer precision', () => {
      sql(`SELECT setval(pg_get_serial_sequence('public.bob_conversations', 'human_reference_number'), 9007199254740991, true);`);
      assert.equal(sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${USER}', 'Large reference') RETURNING human_reference;`), 'BOB-9007199254740992');
    });

    await t.test('names a new Vibe session once from the first request without replacing an explicit name', () => {
      const sessionId = sql(`INSERT INTO public.builder_vibe_sessions(created_by, title)
        VALUES ('${USER}', 'Untitled vibe session') RETURNING id;`);
      sql(`INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload) VALUES
        ('${sessionId}', 'system', 'status', 'Opened', '{}'),
        ('${sessionId}', 'owner', 'message', 'ship', '{"action":"ship"}');`);
      assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${sessionId}';`), 'Untitled vibe session');
      sql(`INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload)
        VALUES ('${sessionId}', 'owner', 'message', E'  Inspect\\n  the roster  ', '{"action":"message"}');`);
      assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${sessionId}';`), 'Inspect the roster');
      sql(`UPDATE public.builder_vibe_sessions SET title = 'Untitled vibe session' WHERE id = '${sessionId}';
        INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload)
        VALUES ('${sessionId}', 'owner', 'message', 'A later request', '{"action":"message"}');`);
      assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${sessionId}';`), 'Untitled vibe session');

      const namedId = sql(`INSERT INTO public.builder_vibe_sessions(created_by, title)
        VALUES ('${USER}', 'A deliberate name') RETURNING id;`);
      sql(`INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload)
        VALUES ('${namedId}', 'owner', 'message', 'Different request', '{"action":"message"}');`);
      assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${namedId}';`), 'A deliberate name');
    });

    await t.test('preserves an explicitly chosen generic Vibe session name', () => {
      const id = sql(`INSERT INTO public.builder_vibe_sessions(created_by, title)
        VALUES ('${USER}', 'Untitled vibe session') RETURNING id;`);
      const owner = `SET ROLE authenticated; SET test.user_id = '${USER}'; SET test.organization_id = '${ORG_A}';`;
      const rename = `SELECT public.builder_vibe_rename_session('${id}', 'Untitled vibe session', 'Untitled vibe session');`;
      sql(`${owner} ${rename} ${rename}`);
      sql(`INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload)
        VALUES ('${id}', 'owner', 'message', 'A different first request', '{"action":"message"}');`);
      assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${id}';`), 'Untitled vibe session');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action = 'builder_vibe_session_renamed'
        AND target_id = '${id}' AND metadata->>'title' = 'Untitled vibe session';`), '1');
    });

    await t.test('preserves a generic Vibe name explicitly supplied when opening a session', () => {
      const owner = `SET ROLE authenticated; SET test.user_id = '${USER}';`;
      const id = sql(`${owner} SELECT public.builder_vibe_session_open('Untitled vibe session');`);
      sql(`INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload)
        VALUES ('${id}', 'owner', 'message', 'A different first request', '{"action":"message"}');`);
      assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${id}';`), 'Untitled vibe session');
    });

    await t.test('names a Vibe session opened without a title from its first request', () => {
      const owner = `SET ROLE authenticated; SET test.user_id = '${USER}';`;
      const id = sql(`${owner} SELECT public.builder_vibe_session_open(NULL);`);
      sql(`INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload)
        VALUES ('${id}', 'owner', 'message', 'First actual request', '{"action":"message"}');`);
      assert.equal(sql(`SELECT title FROM public.builder_vibe_sessions WHERE id = '${id}';`), 'First actual request');
    });

    await t.test('preserves Vibe session creation authorization', () => {
      assert.throws(() => sql(`SET ROLE anon; SELECT public.builder_vibe_session_open(NULL);`), /permission denied/i);
      assert.throws(() => sql(`SET ROLE authenticated; SET test.user_id = '${ORG_A}';
        SELECT public.builder_vibe_session_open(NULL);`), /platform owner/i);
    });

    await t.test('names a generic Bob conversation once without replacing a deliberate name', () => {
      const conversationId = sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${USER}', 'Bob Operations') RETURNING id;`);
      sql(`INSERT INTO public.bob_messages(organization_id, conversation_id, role, content)
        VALUES ('${ORG_A}', '${conversationId}', 'user', E'  Check\\n the roster  ');`);
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${conversationId}';`), 'Check the roster');
      sql(`UPDATE public.bob_conversations SET title = 'Bob Operations' WHERE id = '${conversationId}';
        INSERT INTO public.bob_messages(organization_id, conversation_id, role, content)
        VALUES ('${ORG_A}', '${conversationId}', 'user', 'Later question');`);
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${conversationId}';`), 'Bob Operations');
      const namedId = sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${USER}', 'Deliberate name') RETURNING id;`);
      sql(`INSERT INTO public.bob_messages(organization_id, conversation_id, role, content)
        VALUES ('${ORG_A}', '${namedId}', 'user', 'Different question');`);
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${namedId}';`), 'Deliberate name');
    });

    await t.test('preserves explicit Bob names that match either generic default', () => {
      const owner = `SET ROLE authenticated; SET test.user_id = '${USER}'; SET test.organization_id = '${ORG_A}';`;
      for (const title of ['Bob Operations', 'Bob Builder']) {
        const id = sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
          VALUES ('${ORG_A}', '${USER}', 'Bob Operations') RETURNING id;`);
        const rename = `SELECT public.bob_rename_conversation('${id}', '${ORG_A}', 'operations', 'Bob Operations', '${title}');`;
        sql(`${owner} ${rename} ${rename}`);
        sql(`SET ROLE service_role; INSERT INTO public.bob_messages(organization_id, conversation_id, role, content)
          VALUES ('${ORG_A}', '${id}', 'user', 'A different first request');`);
        assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${id}';`), title);
        assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action = 'bob_conversation_renamed'
          AND target_id = '${id}' AND metadata->>'title' = '${title}';`), '1');
      }
    });

    await t.test('does not name a Bob conversation from a message belonging to another org', () => {
      const id = sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${USER}', 'Bob Operations') RETURNING id;`);
      sql(`INSERT INTO public.bob_messages(organization_id, conversation_id, role, content)
        VALUES ('${ORG_B}', '${id}', 'user', 'Other org message');`);
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${id}';`), 'Bob Operations');
    });

    await t.test('does not let another user rename a conversation by inserting a message', () => {
      const id = sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${USER}', 'Bob Operations') RETURNING id;`);
      sql(`SET ROLE authenticated; SET test.user_id = '${ORG_A}'; SET test.organization_id = '${ORG_A}';
        INSERT INTO public.bob_messages(organization_id, conversation_id, role, content)
        VALUES ('${ORG_A}', '${id}', 'user', 'Someone else text');`);
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${id}';`), 'Bob Operations');
      const owned = sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${ORG_A}', 'Bob Operations') RETURNING id;`);
      sql(`SET ROLE authenticated; SET test.user_id = '${ORG_A}'; SET test.organization_id = '${ORG_A}';
        INSERT INTO public.bob_messages(organization_id, conversation_id, role, content)
        VALUES ('${ORG_A}', '${owned}', 'user', 'Own first request');`);
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${owned}';`), 'Own first request');
      const service = sql(`INSERT INTO public.bob_conversations(organization_id, user_id, title)
        VALUES ('${ORG_A}', '${USER}', 'Bob Operations') RETURNING id;`);
      sql(`SET ROLE service_role; INSERT INTO public.bob_messages(organization_id, conversation_id, role, content)
        VALUES ('${ORG_A}', '${service}', 'user', 'Service first request');`);
      assert.equal(sql(`SELECT title FROM public.bob_conversations WHERE id = '${service}';`), 'Service first request');
    });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
