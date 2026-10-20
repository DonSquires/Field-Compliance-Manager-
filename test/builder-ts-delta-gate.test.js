'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyDelta, gateTypeScriptDelta, loadTypeScript, newDiagnostics } = require('../builder-ts-delta-gate');
const { executeBackendPatch } = require('../backend-worker');

const TS_DIR = [process.env.BOB_TYPESCRIPT_DIR, path.resolve(__dirname, '../apps/web/node_modules/typescript')].filter(Boolean).find((dir) => fs.existsSync(dir));

// Live 2026-09-27 (job 7d19a5f9, Gitea PR #9): a revision referenced `r.role` inside loadHistory where
// no `r` exists — a ReferenceError on the confirmation turn — and passed the syntax gate, the regex
// tests, the security scan and the strongest reviewer. The edge function already carries hundreds of
// diagnostics (no Deno globals, npm: imports), so only what the patch ADDS can be the gate.
const DENO_FILE_BEFORE = [
  "import { serve } from 'https://deno.land/std/http/server.ts';",
  'const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "");',
  'async function loadHistory(rows: any[]) {',
  '  for (let i = rows.length - 1; i >= 0; i--) {',
  '    const md = rows[i]?.metadata;',
  '    if (!md) continue;',
  '    if (md.tool === "laptop_shell") return { pending: md };',
  '  }',
  '  return { pending: null };',
  '}',
  'serve(async (req: Request) => new Response(JSON.stringify(await loadHistory([]))));',
  '',
].join('\n');

test('the semantic delta reports only diagnostics the patch introduced, not the file\'s pre-existing ones', { skip: !TS_DIR && 'TypeScript is not installed here' }, () => {
  const ts = loadTypeScript(TS_DIR);
  const after = DENO_FILE_BEFORE.replace(
    '    if (md.tool === "laptop_shell") return { pending: md };',
    '    if (md.tool === "cancel_builder_job") {\n      if (r.role === "assistant") return { pending: md };\n    }\n    if (md.tool === "laptop_shell") return { pending: md };\n    const again = Deno.env.get("X");',
  );
  const fresh = newDiagnostics(ts, 'supabase/functions/chat/index.ts', DENO_FILE_BEFORE, after);
  assert.deepEqual(fresh.map((d) => `TS${d.code} ${d.message}`), ["TS2304 Cannot find name 'r'."], JSON.stringify(fresh));
  assert.equal(fresh[0].line, 8);
  const { blocking, warnings } = classifyDelta(fresh);
  assert.equal(blocking.length, 1);
  assert.equal(warnings.length, 0);
  // The unchanged file has no delta against itself, and a second Deno reference is not a regression.
  assert.deepEqual(newDiagnostics(ts, 'supabase/functions/chat/index.ts', DENO_FILE_BEFORE, DENO_FILE_BEFORE), []);
  // A new file is judged on its own: an undefined name in it is new by definition.
  assert.equal(newDiagnostics(ts, 'supabase/functions/x/index.ts', null, 'export const a = missing + 1;\n').length, 1);
  // A type nit (property missing on a typed value) blocks too; a soft diagnostic is only a warning.
  const nit = newDiagnostics(ts, 'a.ts', 'const o = { a: 1 };\nexport const v = o.a;\n', 'const o = { a: 1 };\nexport const v = o.b;\nexport const w: number = "s";\n');
  const split = classifyDelta(nit);
  assert.deepEqual(split.blocking.map((d) => d.code), [2339]);
  assert.deepEqual(split.warnings.map((d) => d.code), [2322]);
});

test('backend worker fails a TypeScript patch that introduces an undefined name and records the delta as evidence', { skip: !TS_DIR && 'TypeScript is not installed here' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-delta-gate-'));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(sourceDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, 'supabase/functions/chat'), { recursive: true });
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(path.join(sourceDir, 'scripts/atlas-refresh.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(sourceDir, 'supabase/functions/chat/index.ts'), DENO_FILE_BEFORE);
  const patch = [
    'diff --git a/supabase/functions/chat/index.ts b/supabase/functions/chat/index.ts',
    '--- a/supabase/functions/chat/index.ts',
    '+++ b/supabase/functions/chat/index.ts',
    '@@ -4,6 +4,9 @@ async function loadHistory(rows: any[]) {',
    '   for (let i = rows.length - 1; i >= 0; i--) {',
    '     const md = rows[i]?.metadata;',
    '     if (!md) continue;',
    '+    if (md.tool === "cancel_builder_job") {',
    '+      if (r.role === "assistant") return { pending: md };',
    '+    }',
    '     if (md.tool === "laptop_shell") return { pending: md };',
    '   }',
    '   return { pending: null };',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(artifactDir, 'input.patch'), patch);
  const originalTsDir = process.env.BOB_TYPESCRIPT_DIR;
  process.env.BOB_TYPESCRIPT_DIR = TS_DIR;
  try {
    const result = executeBackendPatch({ sourceDir, patchPath: path.join(artifactDir, 'input.patch'), artifactDir, workDir: path.join(root, 'work') });
    assert.equal(result.succeeded, false);
    const gate = result.checks.find((check) => /typescript semantic delta/.test(check.command));
    assert.ok(gate, JSON.stringify(result.checks.map((c) => c.command)));
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /supabase\/functions\/chat\/index\.ts:8: TS2304 Cannot find name 'r'\. \(this diagnostic did not exist before the patch\)/);
    assert.deepEqual(result.type_delta.checked, ['supabase/functions/chat/index.ts']);
    const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir, 'backend-verification.json'), 'utf8'));
    assert.equal(evidence.type_delta.checked.length, 1);

    // The same patch without the stray identifier passes the gate.
    fs.writeFileSync(path.join(artifactDir, 'input.patch'), patch.replace('if (r.role === "assistant")', 'if (rows[i]?.role === "assistant")'));
    const ok = executeBackendPatch({ sourceDir, patchPath: path.join(artifactDir, 'input.patch'), artifactDir, workDir: path.join(root, 'work2') });
    assert.equal(ok.succeeded, true, JSON.stringify(ok.checks.filter((c) => c.status !== 0)));
    assert.equal(ok.checks.find((check) => /typescript semantic delta/.test(check.command)).status, 0);
  } finally {
    if (originalTsDir === undefined) delete process.env.BOB_TYPESCRIPT_DIR; else process.env.BOB_TYPESCRIPT_DIR = originalTsDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new edge function using the Deno runtime passes; a same-file redeclaration blocks', { skip: !TS_DIR && 'TypeScript is not installed here' }, () => {
  const ts = loadTypeScript(TS_DIR);
  const fresh = [
    "import { createClient } from 'npm:@supabase/supabase-js@2';",
    'const url = Deno.env.get("SUPABASE_URL") ?? "";',
    'const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");',
    'Deno.serve(async (_req: Request) => new Response(JSON.stringify({ ok: !!admin, rt: typeof EdgeRuntime })));',
    '',
  ].join('\n');
  // Live 2026-10-21 (jobs #89–#93): every attempt to add a function failed on TS2304 'Deno'.
  assert.deepEqual(newDiagnostics(ts, 'supabase/functions/bob-new/index.ts', null, fresh), []);
  // Outside supabase/functions the ambient is not supplied, so a stray Deno reference in web code is caught.
  assert.equal(classifyDelta(newDiagnostics(ts, 'apps/web/src/x.ts', null, 'export const v = Deno.env.get("X");\n')).blocking.length, 1);
  // A model that appends a second `const url` instead of revising the first ships a load-time crash.
  const duplicated = `${fresh}const url = "again";\n`;
  const split = classifyDelta(newDiagnostics(ts, 'supabase/functions/bob-new/index.ts', null, duplicated));
  assert.ok(split.blocking.some((d) => d.code === 2451 && d.sameFile), JSON.stringify(split));
  // A lib.dom collision in a script-scope file stays a warning (other declaration is not in the file).
  const domOnly = classifyDelta(newDiagnostics(ts, 'scripts/thing.ts', null, 'const name = "x";\nconsole.log(name);\n'));
  assert.equal(domOnly.blocking.length, 0, JSON.stringify(domOnly));
});
