'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing SQL section: ${start}`);
  return source.slice(first, last);
}

function schemaFunction(schema, name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  const end = schema.indexOf('\n$function$;', start);
  assert.ok(start >= 0 && end > start, `Missing schema function ${name}`);
  return schema.slice(start, end + '\n$function$;'.length);
}

test('Bob and Vibe references, paging and rename conflicts work through PostgREST', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 180000,
}, async () => {
  const suffix = randomUUID();
  const network = `fcm-bob-ref-query-${suffix}`;
  const database = `fcm-bob-ref-db-${suffix}`;
  const api = `fcm-bob-ref-api-${suffix}`;
  const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const owner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const vibe = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261111100001_bob_human_references.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
  const listSql = between(migration, 'CREATE OR REPLACE FUNCTION public.bob_list_conversations(', 'CREATE OR REPLACE FUNCTION public.bob_name_first_request()');
  const bobRenameSql = between(migration, 'CREATE OR REPLACE FUNCTION public.bob_rename_conversation(', 'CREATE OR REPLACE FUNCTION public.builder_vibe_name_first_request()');
  const vibeRenameSql = between(migration, 'CREATE OR REPLACE FUNCTION public.builder_vibe_rename_session(', 'CREATE OR REPLACE FUNCTION public.builder_rename_job(');
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  let hasNetwork = false;
  let hasDatabase = false;
  let hasApi = false;
  try {
    docker(['network', 'create', '--internal', network]);
    hasNetwork = true;
    docker(['run', '--detach', '--name', database, '--network', network, '--network-alias', 'fixture-db',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    hasDatabase = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        docker(['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = query => execFileSync('docker', ['exec', '-i', database, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
      input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    sql(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif((current_setting('request.headers', true)::jsonb ->> 'x-test-user'), '')::uuid
      $$;
      CREATE TABLE public.user_profiles (
        id uuid PRIMARY KEY, role text NOT NULL, organization_id uuid NOT NULL, deactivated_at timestamptz
      );
      INSERT INTO public.user_profiles VALUES
        ('${owner}', 'grand_master', '${org}', NULL),
        ('${other}', 'grand_master', '${org}', NULL);
      ${schemaFunction(schema, 'is_grand_master')}
      ${schemaFunction(schema, 'builder_vibe_require_owner')}
      CREATE FUNCTION public.accessible_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT coalesce(array_agg(organization_id), ARRAY[]::uuid[]) FROM public.user_profiles
        WHERE id = auth.uid() AND deactivated_at IS NULL
      $$;
      CREATE TABLE public.bob_conversations (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL,
        module_key text NOT NULL, title text, human_reference text NOT NULL,
        pinned boolean NOT NULL DEFAULT false, archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL,
        title_manually_set boolean NOT NULL DEFAULT false
      );
      CREATE TABLE public.builder_vibe_sessions (
        id uuid PRIMARY KEY, created_by uuid NOT NULL, title text NOT NULL,
        human_reference text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        last_activity_at timestamptz NOT NULL DEFAULT now(),
        title_manually_set boolean NOT NULL DEFAULT false
      );
      CREATE TABLE public.audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid,
        action text NOT NULL, target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}'
      );
      ALTER TABLE public.bob_conversations ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.bob_conversations TO authenticated;
      CREATE POLICY conversation_read ON public.bob_conversations FOR SELECT TO authenticated
        USING (public.is_grand_master() OR organization_id = ANY(public.accessible_org_ids()));
      ALTER TABLE public.builder_vibe_sessions ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.builder_vibe_sessions TO authenticated;
      CREATE POLICY vibe_read ON public.builder_vibe_sessions FOR SELECT TO authenticated
        USING (public.is_grand_master());
      INSERT INTO public.bob_conversations(id, organization_id, user_id, module_key, title, human_reference, updated_at)
      SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
        '${org}', '${owner}', 'operations', 'Old 100%_[gate] ' || n, 'BOB-' || n,
        '2026-01-03T00:00:00.123456+00:00'
      FROM generate_series(1, 105) n;
      INSERT INTO public.bob_conversations VALUES
        ('40000000-0000-4000-8000-000000000001', '${org}', '${other}', 'operations',
         'Old 100%_[gate] other user', 'BOB-106', false, NULL, now(), now());
      INSERT INTO public.builder_vibe_sessions(id, created_by, title, human_reference)
        VALUES ('${vibe}', '${owner}', 'Original Vibe', 'VB-7');
      INSERT INTO public.builder_vibe_sessions(id, created_by, title, human_reference, last_activity_at)
      SELECT ('50000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${owner}',
        CASE WHEN n <= 55 THEN 'VB-1 title match ' || n WHEN n = 60 THEN 'Literal .* characters' ELSE 'Other title ' || n END,
        CASE WHEN n <= 15 OR n > 55 THEN 'VB-1' || n ELSE 'VB-2' || n END,
        '2026-01-03T00:00:00.123456+00:00'
      FROM generate_series(1, 105) n;
      ${listSql}
      ${bobRenameSql}
      ${vibeRenameSql}
    `);
    docker(['run', '--detach', '--name', api, '--network', network, '--network-alias', 'fixture-api',
      '-e', 'PGRST_DB_URI=postgres://postgres@fixture-db:5432/postgres',
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=authenticated',
      'public.ecr.aws/supabase/postgrest:v14.5']);
    hasApi = true;
    const clientProgram = [
      "const base = 'http://fixture-api:3000';",
      `const org = '${org}', owner = '${owner}', other = '${other}', vibe = '${vibe}';`,
      "const request = async (name, body, actor = owner, single = false) => {",
      "  const response = await fetch(base + '/rpc/' + name, {method:'POST', signal:AbortSignal.timeout(5000),",
      "    headers:{'content-type':'application/json','x-test-user':actor,...(single ? {accept:'application/vnd.pgrst.object+json'} : {})}, body:JSON.stringify(body)});",
      "  return {status:response.status, body:await response.json()};",
      "};",
      "async function main() {",
      "  let ready = false;",
      "  for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }",
      "  if (!ready) throw Error('Disposable PostgREST did not become ready');",
      "  const args = {p_organization_id:org,p_module_key:'operations',p_search:'100%_[gate]',p_filter:'all',p_cursor_updated_at:null,p_cursor_id:null,p_page_size:50};",
      "  const first = await request('bob_list_conversations', args);",
      "  const cursor1 = first.body[49];",
      "  const second = await request('bob_list_conversations', {...args,p_cursor_updated_at:cursor1.updated_at,p_cursor_id:cursor1.id});",
      "  const cursor2 = second.body[49];",
      "  const third = await request('bob_list_conversations', {...args,p_cursor_updated_at:cursor2.updated_at,p_cursor_id:cursor2.id});",
      "  const reference = await request('bob_list_conversations', {...args,p_search:'BOB-105'});",
      "  const target = reference.body[0];",
      "  const renameArgs = {p_conversation_id:target.id,p_organization_id:org,p_module_key:'operations',p_expected_title:target.title,p_title:'Readable Bob name'};",
      "  const renamed = await request('bob_rename_conversation', renameArgs, owner, true);",
      "  const conflict = await request('bob_rename_conversation', {...renameArgs,p_title:'Stale Bob name'}, owner, true);",
      "  const denied = await request('bob_rename_conversation', {...renameArgs,p_expected_title:'Readable Bob name'}, other, true);",
      "  const vibeArgs = {p_session_id:vibe,p_expected_title:'Original Vibe',p_title:'Readable Vibe name'};",
      "  const vibeRenamed = await request('builder_vibe_rename_session', vibeArgs, owner, true);",
      "  const vibeConflict = await request('builder_vibe_rename_session', {...vibeArgs,p_title:'Stale Vibe name'}, owner, true);",
      "  const vibeDenied = await request('builder_vibe_rename_session', {...vibeArgs,p_expected_title:'Readable Vibe name'}, other, true);",
      "  const searchField = async (field, literal, cursor) => {",
      "    const params = new URLSearchParams({select:'id,title,human_reference,last_activity_at',order:'last_activity_at.desc,id.desc',limit:'51'});",
      "    params.set(field, 'imatch.' + literal);",
      "    if (cursor) params.set('or', '(last_activity_at.lt.' + cursor.last_activity_at + ',and(last_activity_at.eq.' + cursor.last_activity_at + ',id.lt.' + cursor.id + '))');",
      "    const response = await fetch(base + '/builder_vibe_sessions?' + params, {headers:{'x-test-user':owner}});",
      "    const body = await response.json(); if (!response.ok) throw Error(JSON.stringify(body)); return body;",
      "  };",
      "  const searchPage = async cursor => {",
      "    const [names, references] = await Promise.all([searchField('title','VB-1',cursor),searchField('human_reference','VB-1',cursor)]);",
      "    const matches = [...new Map([...names,...references].map(row => [row.id,row])).values()]",
      "      .sort((a,b) => b.last_activity_at.localeCompare(a.last_activity_at) || b.id.localeCompare(a.id));",
      "    return {rows:matches.slice(0,50),more:matches.length > 50};",
      "  };",
      "  const vibePage1 = await searchPage(null);",
      "  const vibePage2 = await searchPage(vibePage1.rows.at(-1));",
      "  const vibePage3 = await searchPage(vibePage2.rows.at(-1));",
      `  const vibeLiteral = await searchField('title', ${JSON.stringify('.*'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}, null);`,
      "  console.log(JSON.stringify({first,second,third,reference,renamed,conflict,denied,vibeRenamed,vibeConflict,vibeDenied,vibePage1,vibePage2,vibePage3,vibeLiteral}));",
      "}",
      "main().catch(error => { console.error(error); process.exit(1); });",
    ].join('\n');
    const output = execFileSync('docker', ['run', '--rm', '--interactive', '--network', network, 'node:22-alpine', 'node', '-'], {
      input: clientProgram, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90000,
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.first.status, 200);
    assert.equal(result.first.body.length, 51);
    assert.match(result.first.body[49].updated_at, /\.123456/);
    assert.equal(result.second.body.length, 51);
    assert.equal(result.third.body.length, 5);
    assert.equal(new Set([...result.first.body.slice(0, 50), ...result.second.body.slice(0, 50), ...result.third.body].map(row => row.id)).size, 105);
    assert.equal(result.reference.body.length, 1);
    assert.equal(result.reference.body[0].human_reference, 'BOB-105');
    assert.equal(result.renamed.status, 200);
    assert.equal(result.renamed.body.title, 'Readable Bob name');
    assert.equal(result.renamed.body.human_reference, 'BOB-105');
    assert.equal(result.conflict.status, 409);
    assert.equal(result.conflict.body.code, 'PT409');
    assert.ok(result.denied.status >= 400);
    assert.equal(result.vibeRenamed.status, 200);
    assert.equal(result.vibeRenamed.body.human_reference, 'VB-7');
    assert.equal(result.vibeConflict.status, 409);
    assert.equal(result.vibeConflict.body.code, 'PT409');
    assert.ok(result.vibeDenied.status >= 400);
    assert.deepEqual([result.vibePage1.rows.length, result.vibePage2.rows.length, result.vibePage3.rows.length], [50, 50, 5]);
    assert.deepEqual([result.vibePage1.more, result.vibePage2.more, result.vibePage3.more], [true, true, false]);
    const vibeMatches = [...result.vibePage1.rows, ...result.vibePage2.rows, ...result.vibePage3.rows];
    assert.equal(new Set(vibeMatches.map(row => row.id)).size, 105);
    assert.ok(vibeMatches.some(row => row.title.includes('VB-1') && !row.human_reference.includes('VB-1')));
    assert.ok(vibeMatches.some(row => !row.title.includes('VB-1') && row.human_reference.includes('VB-1')));
    assert.deepEqual(result.vibeLiteral.map(row => row.title), ['Literal .* characters']);
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action IN ('bob_conversation_renamed', 'builder_vibe_session_renamed');`), '2');
  } finally {
    if (hasApi) docker(['rm', '-f', api]);
    if (hasDatabase) docker(['rm', '-f', database]);
    if (hasNetwork) docker(['network', 'rm', network]);
  }
});
