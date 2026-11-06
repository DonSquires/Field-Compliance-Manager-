'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261107190000_vibe_governed_turn_recovery.sql'), 'utf8');

test('governed Vibe recovery is service-only, branch-bound, idempotent and audited', () => {
  assert.match(migration, /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /TO service_role/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /head_sha IS DISTINCT FROM p_expected_head/);
  assert.match(migration, /seq > v_message\.seq OR status IN \('queued', 'claimed'\)/);
  assert.match(migration, /governed_recovery_request_id/);
  assert.match(migration, /'reason', 'governed_turn_recovery'/);
  assert.doesNotMatch(migration, /INSERT INTO public\.builder_vibe_messages[\s\S]*VALUES\s*\([^;]*'owner'/);
});

test('governed recovery preserves ownership, evidence, concurrency and rollback', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-vibe-recovery-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = query => execFileSync('docker', ['exec', '-i', name, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
      input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const sqlAsync = query => new Promise(resolve => {
      const child = spawn('docker', ['exec', '-i', name, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let error = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      child.on('close', code => resolve({ code, output: output.trim(), error }));
      child.stdin.end(query);
    });
    const initial = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261021130000_builder_vibe_sessions.sql'), 'utf8');
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE EXTENSION pgcrypto;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE PUBLICATION supabase_realtime;
      ${initial}
      ${migration}
    `);
    const owner = '11111111-1111-4111-8111-111111111111';
    const head = 'a'.repeat(40);
    const otherHead = 'b'.repeat(40);
    const seed = ({ session = randomUUID(), message = randomUUID(), error = 'Changes are not verified: browser_test failed.', committed = true } = {}) => {
      sql(`
        INSERT INTO public.builder_vibe_sessions(id, created_by, base_sha, head_sha)
        VALUES ('${session}', '${owner}', '${otherHead}', '${head}');
        INSERT INTO public.builder_vibe_messages(id, session_id, role, content, payload, status, created_by, completed_at)
        VALUES ('${message}', '${session}', 'owner', 'Improve the synthetic greeting', '{"action":"message"}', 'failed', '${owner}', now());
        ${committed ? `INSERT INTO public.builder_vibe_messages(session_id, role, kind, content, payload)
          VALUES ('${session}', 'bob', 'diff', 'Synthetic diff', jsonb_build_object('commit', '${head}'));` : ''}
        INSERT INTO public.builder_vibe_messages(session_id, role, kind, content)
        VALUES ('${session}', 'bob', 'error', '${error}');
      `);
      return { session, message };
    };
    const invoke = ({ session, message }, request, expectedHead = head) =>
      `SET ROLE service_role; SELECT public.builder_vibe_recover_failed_turn('${session}', '${message}', '${expectedHead}', '${request}');`;
    const receipt = value => JSON.parse(value.split('\n').at(-1));
    const status = ({ message }) => sql(`SELECT status FROM public.builder_vibe_messages WHERE id='${message}';`);
    const auditCount = ({ session }) => sql(`SELECT count(*) FROM public.builder_vibe_messages WHERE session_id='${session}' AND payload->>'reason'='governed_turn_recovery';`);

    const signature = 'public.builder_vibe_recover_failed_turn(uuid,uuid,text,uuid)';
    assert.equal(sql(`SELECT has_function_privilege('anon', '${signature}', 'execute'),
      has_function_privilege('authenticated', '${signature}', 'execute'),
      has_function_privilege('service_role', '${signature}', 'execute');`), 'f|f|t');
    const first = seed();
    const request = randomUUID();
    assert.throws(() => sql(invoke(first, request).replace('SET ROLE service_role', 'SET ROLE authenticated')), /permission denied for function/);
    assert.deepEqual(receipt(sql(invoke(first, request))), { result: 'scheduled', message_status: 'queued' });
    assert.equal(status(first), 'queued');
    assert.equal(auditCount(first), '1');
    const payload = JSON.parse(sql(`SELECT payload FROM public.builder_vibe_messages WHERE id='${first.message}';`));
    assert.equal(payload.restart_retries, 1);
    assert.equal(payload.governed_recovery_committed_edits, true);
    assert.equal(payload.governed_recovery_request_id, request);
    assert.equal(sql(`SELECT count(*) FROM public.builder_vibe_messages WHERE session_id='${first.session}' AND role='owner';`), '1');
    assert.deepEqual(receipt(sql(invoke(first, request))), { result: 'already_scheduled', message_status: 'queued' });
    assert.equal(auditCount(first), '1');
    assert.throws(() => sql(invoke(first, randomUUID())), /already been used/);

    const stale = seed();
    assert.throws(() => sql(invoke(stale, randomUUID(), otherHead)), /no longer at the expected branch head/);
    assert.equal(status(stale), 'failed');
    assert.equal(auditCount(stale), '0');
    const closed = seed();
    sql(`UPDATE public.builder_vibe_sessions SET status='closed' WHERE id='${closed.session}';`);
    assert.throws(() => sql(invoke(closed, randomUUID())), /closed, busy, published/);
    assert.equal(status(closed), 'failed');
    const newer = seed();
    sql(`INSERT INTO public.builder_vibe_messages(session_id, role, content, status) VALUES ('${newer.session}', 'owner', 'New instruction', 'queued');`);
    assert.throws(() => sql(invoke(newer, randomUUID())), /newer or pending owner instruction/);
    assert.equal(status(newer), 'failed');
    const human = seed({ error: 'A human decision is required.' });
    assert.throws(() => sql(invoke(human, randomUUID())), /no recoverable verification or budget failure/);
    assert.equal(status(human), 'failed');
    const noDiff = seed({ committed: false });
    assert.equal(receipt(sql(invoke(noDiff, randomUUID()))).result, 'scheduled');
    assert.equal(sql(`SELECT payload->>'governed_recovery_committed_edits' FROM public.builder_vibe_messages WHERE id='${noDiff.message}';`), 'false');
    const duplicateRequest = seed();
    assert.throws(() => sql(invoke(duplicateRequest, request)), /already been used/);
    assert.equal(status(duplicateRequest), 'failed');

    const concurrent = seed();
    const concurrentRequest = randomUUID();
    const calls = await Promise.all([sqlAsync(invoke(concurrent, concurrentRequest)), sqlAsync(invoke(concurrent, concurrentRequest))]);
    assert.deepEqual(calls.map(call => call.code), [0, 0], JSON.stringify(calls));
    assert.deepEqual(calls.map(call => receipt(call.output).result).sort(), ['already_scheduled', 'scheduled']);
    assert.equal(auditCount(concurrent), '1');

    sql(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${owner}'::uuid $$;
      CREATE OR REPLACE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    `);
    for (const action of ['send', 'close']) {
      const competing = seed();
      const application = `vibe-recovery-${action}`;
      const ownerAction = action === 'send'
        ? `SELECT public.builder_vibe_send('${competing.session}', 'New owner direction', NULL, 'message');`
        : `SELECT public.builder_vibe_session_close('${competing.session}');`;
      const transaction = sqlAsync(`
        SET application_name = '${application}';
        BEGIN;
        ${ownerAction}
        SELECT pg_sleep(3);
        COMMIT;
      `);
      let sleeping = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        sleeping = sql(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE application_name='${application}' AND wait_event='PgSleep'
        );`) === 't';
        if (sleeping) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(sleeping, 'The competing owner operation must hold the session lock');
      const recovery = await sqlAsync(invoke(competing, randomUUID()));
      assert.equal((await transaction).code, 0);
      assert.notEqual(recovery.code, 0);
      assert.match(recovery.error, action === 'send' ? /newer or pending owner instruction/ : /closed, busy, published/);
      assert.equal(status(competing), 'failed');
      assert.equal(auditCount(competing), '0');
    }

    const rollback = seed();
    sql(`
      CREATE FUNCTION public.test_reject_vibe_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload->>'reason' = 'governed_turn_recovery' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_reject_vibe_audit BEFORE INSERT ON public.builder_vibe_messages
      FOR EACH ROW EXECUTE FUNCTION public.test_reject_vibe_audit();
    `);
    assert.throws(() => sql(invoke(rollback, randomUUID())), /synthetic audit failure/);
    assert.equal(status(rollback), 'failed');
    assert.equal(auditCount(rollback), '0');
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
