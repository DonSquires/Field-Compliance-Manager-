'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

test('Builder cursor and literal name filters work against PostgreSQL through PostgREST', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 180000,
}, async () => {
  const suffix = randomUUID();
  const network = `fcm-builder-query-${suffix}`;
  const database = `fcm-builder-db-${suffix}`;
  const api = `fcm-builder-api-${suffix}`;
  const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261111100001_bob_human_references.sql'), 'utf8');
  const renameStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.builder_rename_job(');
  const renameEnd = migration.lastIndexOf('\nCOMMIT;');
  assert.ok(renameStart >= 0 && renameEnd > renameStart, 'The actual rename RPC must be present in the migration');
  const renameSql = migration.slice(renameStart, renameEnd);
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
    execFileSync('docker', ['exec', '-i', database, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
      input: `
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.builder_jobs (
          id uuid PRIMARY KEY, organization_id uuid NOT NULL, created_at timestamptz NOT NULL,
          title text NOT NULL, human_reference text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE public.audit_log (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid,
          action text NOT NULL, target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}'
        );
        GRANT USAGE ON SCHEMA public TO service_role;
        GRANT SELECT, UPDATE ON public.builder_jobs TO service_role;
        GRANT SELECT, INSERT ON public.audit_log TO service_role;
        INSERT INTO public.builder_jobs(id, organization_id, created_at, title, human_reference)
        SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
          '${orgA}', '2026-01-03T00:00:00.123456+00:00', 'Fixture job ' || n, 'BB-' || n
        FROM generate_series(1, 105) n;
        INSERT INTO public.builder_jobs(id, organization_id, created_at, title, human_reference) VALUES
          ('11111111-1111-4111-8111-111111111111', '${orgA}', '2026-01-02T00:00:00Z', 'Old 100% literal_rate * dot', 'BB-106'),
          ('22222222-2222-4222-8222-222222222222', '${orgB}', '2026-01-01T00:00:00Z', 'Old 100% literal_rate * dot', 'BB-107');
        ${renameSql}
      `,
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    docker(['run', '--detach', '--name', api, '--network', network, '--network-alias', 'fixture-api',
      '-e', 'PGRST_DB_URI=postgres://postgres@fixture-db:5432/postgres',
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role',
      'public.ecr.aws/supabase/postgrest:v14.5']);
    hasApi = true;
    const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const clientProgram = [
      "const base = 'http://fixture-api:3000/builder_jobs';",
      `const organization = ${JSON.stringify(`in.(${orgA})`)};`,
      "const parameters = () => new URLSearchParams({select:'id,human_reference,created_at',order:'created_at.desc,id.desc',limit:'101',organization_id:organization});",
      "const get = async params => { const r = await fetch(base + '?' + params); const b = await r.json(); if (!r.ok) throw Error(JSON.stringify(b)); return b; };",
      "async function main() {",
      "  let ready = false;",
      "  for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }",
      "  if (!ready) throw Error('Disposable PostgREST did not become ready');",
      "  const first = await get(parameters()); const last = first[99]; const next = parameters();",
      "  next.set('or', '(created_at.lt.' + last.created_at + ',and(created_at.eq.' + last.created_at + ',id.lt.' + last.id + '))');",
      "  const second = await get(next); const name = parameters();",
      `  name.set('title', ${JSON.stringify(`imatch.${escapeRegex('100% literal_rate * dot')}`)});`,
      "  const nameResult = await get(name);",
      `  name.set('title', ${JSON.stringify(`imatch.${escapeRegex('.*')}`)});`,
      "  const regexResult = await get(name);",
      "  const rpc = async (expected, title) => {",
      "    const r = await fetch('http://fixture-api:3000/rpc/builder_rename_job', {method:'POST', signal:AbortSignal.timeout(5000), headers:{'content-type':'application/json',accept:'application/vnd.pgrst.object+json'},",
      `      body:JSON.stringify({p_job_id:'11111111-1111-4111-8111-111111111111',p_organization_id:'${orgA}',p_actor_user_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',p_expected_title:expected,p_title:title})});`,
      "    return {status:r.status, body:await r.json()};",
      "  };",
      "  const renamed = await rpc('Old 100% literal_rate * dot', 'Meaningful name');",
      "  const retried = await rpc('Old 100% literal_rate * dot', 'Meaningful name');",
      "  const conflict = await rpc('Old 100% literal_rate * dot', 'Stale name');",
      "  const audit = await (await fetch('http://fixture-api:3000/audit_log?select=action,target_id,metadata')).json();",
      "  console.log(JSON.stringify({ first, second, nameResult, regexResult, renamed, retried, conflict, audit }));",
      "}",
      "main().catch(error => { console.error(error); process.exit(1); });",
    ].join('\n');
    const output = execFileSync('docker', ['run', '--rm', '--interactive', '--network', network,
      'node:22-alpine', 'node', '-'], {
      input: clientProgram, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90000,
    });
    const { first, second, nameResult, regexResult, renamed, retried, conflict, audit } = JSON.parse(output.trim());
    assert.equal(first.length, 101);
    const last = first[99];
    assert.match(last.created_at, /\.123456/);
    assert.equal(second.length, 6);
    assert.equal(new Set([...first.slice(0, 100), ...second].map(row => row.id)).size, 106);
    assert.equal(second.at(-1).human_reference, 'BB-106');
    assert.deepEqual(nameResult.map(row => row.human_reference), ['BB-106']);
    assert.deepEqual(regexResult, []);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.title, 'Meaningful name');
    assert.equal(renamed.body.human_reference, 'BB-106');
    assert.equal(retried.status, 200);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'PT409');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'builder_job_renamed');
  } finally {
    if (hasApi) docker(['rm', '-f', api]);
    if (hasDatabase) docker(['rm', '-f', database]);
    if (hasNetwork) docker(['network', 'rm', network]);
  }
});
