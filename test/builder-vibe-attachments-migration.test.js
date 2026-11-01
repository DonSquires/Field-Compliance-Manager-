'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261022140000_builder_vibe_attachments.sql'), 'utf8');

test('Vibe attachments are session-bound and readable only by the owner', () => {
  assert.match(migration, /session_id uuid NOT NULL REFERENCES public\.builder_vibe_sessions\(id\) ON DELETE CASCADE/);
  assert.match(migration, /ALTER TABLE public\.builder_vibe_attachments ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.builder_vibe_attachments FROM anon, authenticated/);
  assert.match(migration, /public\.is_grand_master\(\)[\s\S]*s\.created_by = auth\.uid\(\)/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE|ALL) ON public\.builder_vibe_attachments TO authenticated/);
});

test('Vibe attachment RPCs bind private storage paths, file bounds, and message IDs', () => {
  assert.match(migration, /desktop\/' \|\| v_user::text \|\| '\/vibe\/' \|\| p_session_id::text/);
  assert.match(migration, /p_file_size_bytes > 20971520/);
  assert.match(migration, /p_file_size_bytes > 10485760/);
  assert.match(migration, /cardinality\(v_ids\) > 5/);
  assert.match(migration, /a\.id = requested\.id AND a\.session_id = p_session_id AND a\.uploaded_by = v_user/);
});

test('attachment consent executes with owner scope, immutable replay and explicit grants', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-vibe-consent-${randomUUID()}`;
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
    const readMigration = file => fs.readFileSync(path.join(__dirname, '../supabase/migrations', file), 'utf8');
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE EXTENSION pgcrypto;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('test.actor', true), '')::uuid
      $$;
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql AS $$
        SELECT current_setting('test.owner', true) = 'on'
      $$;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY);
      CREATE PUBLICATION supabase_realtime;
      ${readMigration('20261021130000_builder_vibe_sessions.sql')}
      ${migration}
      ${readMigration('20261025130000_builder_vibe_attachment_cloud_opt_in.sql')}
    `);
    const owner = '11111111-1111-4111-8111-111111111111';
    const session = '22222222-2222-4222-8222-222222222222';
    const attachment = '33333333-3333-4333-8333-333333333333';
    sql(`
      INSERT INTO public.user_profiles VALUES ('${owner}');
      INSERT INTO public.builder_vibe_sessions(id, created_by) VALUES ('${session}', '${owner}');
      INSERT INTO public.builder_vibe_attachments
        (id, session_id, uploaded_by, file_name, file_type, file_size_bytes, storage_path, extraction_status)
      VALUES ('${attachment}', '${session}', '${owner}', 'Bob Test.txt', 'text/plain', 9,
        'desktop/${owner}/vibe/${session}/${attachment}-Bob-Test.txt', 'extracted');
    `);
    const asOwner = `SET ROLE authenticated; SET test.actor='${owner}'; SET test.owner='on';`;
    const send = (request, consent) => `SELECT public.builder_vibe_send_with_attachments_opt_in(
      '${session}', 'Bob Test synthetic context', ${request}, ARRAY['${attachment}']::uuid[], ${consent});`;
    const payload = request => sql(`SELECT payload FROM public.builder_vibe_messages WHERE client_request_id='${request}';`);

    sql(asOwner + send("'local'", 'NULL'));
    assert.equal(JSON.parse(payload('local')).external_attachment_consent, false);
    assert.throws(() => sql(asOwner + send("'local'", 'true')), /different attachment consent/);
    sql(asOwner + send("'approved'", 'true'));
    const approved = payload('approved');
    const receipt = JSON.parse(approved).external_attachment_consent_receipt;
    assert.equal(receipt.allowed, true);
    assert.equal(receipt.actor_user_id, owner);
    assert.equal(receipt.policy_version, 'non_sensitive_context_v1');
    assert.deepEqual(receipt.attachment_ids, [attachment]);
    assert.ok(receipt.recorded_at);
    sql(asOwner + send("'approved'", 'true'));
    assert.equal(payload('approved'), approved, 'Replay preserves the original receipt');
    assert.throws(() => sql(asOwner + send("'approved'", 'false')), /different attachment consent/);
    assert.throws(() => sql(asOwner + send('NULL', 'true')), /requires a request id/);
    assert.throws(() => sql(asOwner + send("''", 'true')), /requires a request id/);
    assert.throws(() => sql(`${asOwner} SET test.owner='off'; ${send("'denied'", 'true')}`), /limited to the platform owner/);
    assert.throws(() => sql(`${asOwner} SET test.actor='44444444-4444-4444-8444-444444444444'; ${send("'other'", 'true')}`), /not found for this owner/);
    assert.throws(() => sql(`${asOwner} UPDATE public.builder_vibe_messages SET payload='{}';`), /permission denied/);
    const signature = 'public.builder_vibe_send_with_attachments_opt_in(uuid,text,text,uuid[],boolean)';
    assert.equal(sql(`SELECT has_function_privilege('anon', '${signature}', 'execute'),
      has_function_privilege('authenticated', '${signature}', 'execute');`), 'f|t');
    sql(`UPDATE public.builder_vibe_sessions SET status='closed' WHERE id='${session}';`);
    assert.throws(() => sql(asOwner + send("'closed'", 'true')), /not found for this owner/);
    assert.equal(sql("SELECT count(*) FROM public.builder_vibe_messages WHERE role='owner';"), '2');
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
