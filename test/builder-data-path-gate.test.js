'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { addedLinesByFile, callerCanRead, checkCallerReads, tableAccessFromSchema } = require('../builder-data-path-gate');
const { executeBackendPatch } = require('../backend-worker');

const LIVE_SCHEMA = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');

// Live 2026-09-27, job 79b4c08f / Gitea PR #8: the chat cancel tool looked Builder jobs up with the
// caller's client; builder_jobs admits only the service role, so every lookup would have said
// "no job found". Syntax gate, regex tests, 7B reviewer and static security scan all passed it.
const PR8_SHAPE = [
  'diff --git a/supabase/functions/onspace-ai-chat/index.ts b/supabase/functions/onspace-ai-chat/index.ts',
  '--- a/supabase/functions/onspace-ai-chat/index.ts',
  '+++ b/supabase/functions/onspace-ai-chat/index.ts',
  '@@ -8466,6 +8468,12 @@ serve(async (req)=>{',
  "         case 'cancel_builder_job':",
  '+          {',
  "+            const { data: last } = await callerClient.from('bob_messages')",
  "+              .select('role, metadata').eq('conversation_id', conversationId).limit(1).maybeSingle();",
  "+            const jobsQuery = callerClient.from('builder_jobs').select('id,title,status').limit(2);",
  "+            const rows = await admin.from('builder_jobs').select('id');",
  '+          }',
  "         case 'laptop_shell':",
  '',
].join('\n');

test('schema facts: builder_jobs is service-role-only, bob_messages has caller paths, unknown tables are unknown', () => {
  const access = tableAccessFromSchema(LIVE_SCHEMA);
  const jobs = callerCanRead(access, 'builder_jobs');
  assert.equal(jobs.known, true);
  assert.equal(jobs.readable, false, jobs.reason);
  assert.match(jobs.reason, /service_role-only \(builder_jobs_service_role\)/);
  const messages = callerCanRead(access, 'bob_messages');
  assert.equal(messages.readable, true, messages.reason);
  assert.equal(callerCanRead(access, 'no_such_table_xyz').known, false);

  const synthetic = tableAccessFromSchema([
    'CREATE TABLE IF NOT EXISTS "public"."open_table" ("id" uuid);',
    'CREATE TABLE IF NOT EXISTS "public"."locked_table" ("id" uuid);',
    'ALTER TABLE ONLY "public"."locked_table" ENABLE ROW LEVEL SECURITY;',
    'CREATE TABLE IF NOT EXISTS "public"."mixed_table" ("id" uuid);',
    'ALTER TABLE "public"."mixed_table" ENABLE ROW LEVEL SECURITY;',
    'CREATE POLICY "svc" ON "public"."mixed_table" USING ((auth.role() = \'service_role\'::text));',
    'CREATE POLICY "own" ON "public"."mixed_table" FOR SELECT TO "authenticated" USING ((auth.uid() = owner_id));',
  ].join('\n'));
  assert.equal(callerCanRead(synthetic, 'open_table').readable, true, 'no RLS = readable');
  assert.match(callerCanRead(synthetic, 'locked_table').reason, /no policies/);
  assert.equal(callerCanRead(synthetic, 'locked_table').readable, false);
  assert.equal(callerCanRead(synthetic, 'mixed_table').readable, true, 'one caller-facing policy is enough');
});

test('the gate flags caller-scoped reads of invisible tables on added lines only, and names the fix', () => {
  const added = addedLinesByFile(PR8_SHAPE);
  assert.deepEqual([...added.keys()], ['supabase/functions/onspace-ai-chat/index.ts']);
  assert.equal(added.get('supabase/functions/onspace-ai-chat/index.ts').length, 6);

  const findings = checkCallerReads(PR8_SHAPE, LIVE_SCHEMA);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].table, 'builder_jobs');
  assert.match(findings[0].message, /will always return no rows for a real user/);
  assert.match(findings[0].message, /bob-builder-control-room/);
  assert.match(findings[0].message, /NEW migration/);

  // Context lines and test files are not findings; no schema means no verdict.
  const contextOnly = PR8_SHAPE.split('\n').map((line) => (line.startsWith('+') && !line.startsWith('+++') ? ` ${line.slice(1)}` : line)).join('\n');
  assert.deepEqual(checkCallerReads(contextOnly, LIVE_SCHEMA), []);
  assert.deepEqual(checkCallerReads(PR8_SHAPE.replace(/onspace-ai-chat\/index\.ts/g, '../../../test/x.test.js').replace(/supabase\/functions\/\.\.\/\.\.\/\.\.\//g, ''), LIVE_SCHEMA), []);
  assert.deepEqual(checkCallerReads(PR8_SHAPE, null), []);
});

test('backend worker fails the patch on a data-path finding and carries it as evidence for the repair turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-path-gate-'));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(sourceDir, 'supabase/functions/chat'), { recursive: true });
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(path.join(sourceDir, 'supabase/functions/chat/index.ts'), "export const a = 1;\n");
  fs.writeFileSync(path.join(sourceDir, 'supabase/schema.sql'), [
    'CREATE TABLE IF NOT EXISTS "public"."builder_jobs" ("id" uuid);',
    'ALTER TABLE "public"."builder_jobs" ENABLE ROW LEVEL SECURITY;',
    'CREATE POLICY "builder_jobs_service_role" ON "public"."builder_jobs" USING ((auth.role() = \'service_role\'::text)) WITH CHECK ((auth.role() = \'service_role\'::text));',
    '',
  ].join('\n'));
  const patch = [
    'diff --git a/supabase/functions/chat/index.ts b/supabase/functions/chat/index.ts',
    '--- a/supabase/functions/chat/index.ts',
    '+++ b/supabase/functions/chat/index.ts',
    '@@ -1 +1,2 @@',
    ' export const a = 1;',
    "+export const jobs = (callerClient) => callerClient.from('builder_jobs').select('id');",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(artifactDir, 'input.patch'), patch);
  try {
    const result = executeBackendPatch({ sourceDir, patchPath: path.join(artifactDir, 'input.patch'), artifactDir, workDir: path.join(root, 'work') });
    assert.equal(result.succeeded, false);
    assert.equal(result.data_path.checked, true);
    assert.equal(result.data_path.findings.length, 1);
    const gate = result.checks.find((check) => /data-path gate/.test(check.command));
    assert.ok(gate, 'the gate is a named check in the evidence');
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /caller-scoped read of "builder_jobs"/);
    const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir, 'backend-verification.json'), 'utf8'));
    assert.equal(evidence.data_path.findings[0].table, 'builder_jobs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
