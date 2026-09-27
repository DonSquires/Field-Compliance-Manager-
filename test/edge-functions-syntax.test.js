const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The release lane deploys edge functions from main; a syntax error there (`a || b ?? c`, 2026-09-27) fails
// the deploy after the merge. Parse every function entry point before it gets that far.
let ts = null;
for (const candidate of ['typescript', '../apps/web/node_modules/typescript']) {
  try { ts = require(candidate); break; } catch { /* try the next location */ }
}

const functionsDir = path.resolve(__dirname, '../supabase/functions');
const entries = fs.readdirSync(functionsDir)
  .map(name => path.join(functionsDir, name, 'index.ts'))
  .filter(file => fs.existsSync(file));

test('every edge function entry point parses as TypeScript with no grammar errors', { skip: ts ? false : 'typescript not installed' }, () => {
  assert.ok(entries.length > 10, 'edge functions found');
  const failures = [];
  // Grammar errors such as mixing ?? with || (TS5076) surface from the checker, not the parser, so run a
  // program per file with imports left unresolved and keep only syntax/grammar codes (type errors are noise here).
  const program = ts.createProgram(entries, { noResolve: true, noLib: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, noEmit: true });
  for (const file of entries) {
    const sourceFile = program.getSourceFile(file);
    const diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile).filter(d => d.code < 2000 || d.code === 5076)];
    for (const diagnostic of diagnostics) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      failures.push(`${path.relative(functionsDir, file)}:${line + 1}:${character + 1} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    }
  }
  assert.deepEqual(failures, []);
});
