'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261025160000_builder_chat_public_research.sql'), 'utf8');

test('research RPC binds per-message consent, ownership, file bounds and immutable replay without browser write grants', () => {
  assert.match(migration, /p_allow_cloud IS DISTINCT FROM true/);
  assert.match(migration, /created_by = v_user AND status <> 'closed' FOR UPDATE/);
  assert.match(migration, /o\.owner_id = v_user::text/);
  assert.match(migration, /different research or consent/);
  assert.match(migration, /v_size > 20971520/);
  assert.match(migration, /v_size > 10485760/);
  assert.match(migration, /'policy_version', 'builder_research_v1'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE|ALL) ON (?:TABLE|public\.builder_chat_messages)/);
});

test('research migration executes with owner/consent/storage/idempotency authorization checks in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-research-test-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const base = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261025090000_builder_chat_lane.sql'), 'utf8');
    const fixture = `
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.owner', true) = 'on' $$;
      CREATE TABLE public.builder_jobs(id uuid PRIMARY KEY);
      CREATE TABLE storage.objects(bucket_id text, name text, owner_id text);
      CREATE PUBLICATION supabase_realtime;
      CREATE FUNCTION public.expect_error(command text, expected text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN
          IF position(expected in SQLERRM) = 0 THEN RAISE EXCEPTION 'Unexpected error: %', SQLERRM; END IF;
          RETURN;
        END;
        RAISE EXCEPTION 'Expected error was not raised: %', expected;
      END $$;
    `;
    const checks = `
      SELECT set_config('test.actor', '11111111-1111-4111-8111-111111111111', false);
      SELECT set_config('test.owner', 'on', false);
      INSERT INTO public.builder_chat_threads(id, created_by) VALUES
        ('22222222-2222-4222-8222-222222222222', auth.uid()),
        ('22222222-2222-4222-8222-222222222223', '11111111-1111-4111-8111-111111111112');
      INSERT INTO storage.objects VALUES ('bob-uploads',
        'desktop/11111111-1111-4111-8111-111111111111/builder-chat/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333-fixture.txt',
        auth.uid()::text);
      GRANT USAGE ON SCHEMA auth TO authenticated;
      SET ROLE authenticated;
      DO $$
      DECLARE result uuid; again uuid; files jsonb; changed jsonb;
      BEGIN
        IF has_function_privilege('anon', 'public.builder_chat_send_research(uuid,text,text,jsonb,jsonb,boolean,boolean)', 'EXECUTE')
          OR NOT has_function_privilege('authenticated', 'public.builder_chat_send_research(uuid,text,text,jsonb,jsonb,boolean,boolean)', 'EXECUTE')
          OR has_table_privilege('authenticated', 'public.builder_chat_messages', 'INSERT') THEN
          RAISE EXCEPTION 'Unexpected research privilege';
        END IF;
        files := jsonb_build_array(jsonb_build_object(
          'id', '33333333-3333-4333-8333-333333333333', 'file_name', 'fixture.txt', 'file_type', 'text/plain',
          'file_size_bytes', 20, 'sha256', repeat('a',64), 'extracted_text', 'Synthetic public document text.',
          'storage_path', 'desktop/11111111-1111-4111-8111-111111111111/builder-chat/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333-fixture.txt'
        ));
        result := public.builder_chat_send_research('22222222-2222-4222-8222-222222222222', 'Public fixture question', 'request-1', files, '[]', false, true);
        again := public.builder_chat_send_research('22222222-2222-4222-8222-222222222222', 'Public fixture question', 'request-1', files, '[]', false, true);
        IF result <> again OR (SELECT count(*) FROM public.builder_chat_messages WHERE client_request_id = 'request-1') <> 1
          OR NOT EXISTS (SELECT 1 FROM public.builder_chat_messages WHERE id = result AND status = 'queued'
            AND payload->'research_consent'->>'actor_user_id' = auth.uid()::text
            AND payload->>'research_mode' = 'public_cloud') THEN
          RAISE EXCEPTION 'Research consent/replay was not persisted correctly';
        END IF;
        PERFORM public.expect_error(format('SELECT public.builder_chat_send_research(%L,%L,%L,%L,%L,false,false)',
          '22222222-2222-4222-8222-222222222222', 'Question', 'denied', '[]', '[]'), 'explicit');
        PERFORM public.expect_error(format('SELECT public.builder_chat_send_research(%L,%L,%L,%L,%L,false,true)',
          '22222222-2222-4222-8222-222222222223', 'Question', 'wrong-owner', '[]', '[]'), 'this owner');
        PERFORM public.expect_error(format('SELECT public.builder_chat_send_research(%L,%L,%L,%L,%L,false,true)',
          '22222222-2222-4222-8222-222222222222', 'Different question', 'request-1', files, '[]'), 'different research');
        changed := jsonb_set(files, '{0,storage_path}', '"desktop/another-owner/fixture.txt"');
        PERFORM public.expect_error(format('SELECT public.builder_chat_send_research(%L,%L,%L,%L,%L,false,true)',
          '22222222-2222-4222-8222-222222222222', 'Question', 'bad-path', changed, '[]'), 'not owned');
        changed := jsonb_set(files, '{0,file_size_bytes}', '20971521');
        PERFORM public.expect_error(format('SELECT public.builder_chat_send_research(%L,%L,%L,%L,%L,false,true)',
          '22222222-2222-4222-8222-222222222222', 'Question', 'oversized', changed, '[]'), 'too large');
        changed := files || files;
        PERFORM public.expect_error(format('SELECT public.builder_chat_send_research(%L,%L,%L,%L,%L,false,true)',
          '22222222-2222-4222-8222-222222222222', 'Question', 'duplicate', changed, '[]'), 'unique ids');
        PERFORM set_config('test.owner', 'off', false);
        PERFORM public.expect_error(format('SELECT public.builder_chat_send_research(%L,%L,%L,%L,%L,false,true)',
          '22222222-2222-4222-8222-222222222222', 'Question', 'not-grandmaster', '[]', '[]'), 'platform owner');
      END $$;
    `;
    const output = execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
      encoding: 'utf8', input: fixture + base + migration + checks, stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.match(output, /DO/);
  } finally { if (created) docker(['rm', '--force', name]); }
});
