'use strict';

/**
 * Semantic delta gate for TypeScript files the patch touches: the diagnostics TypeScript reports
 * for the file AFTER the patch minus the ones it reported BEFORE. The edge functions are untyped
 * Deno code with hundreds of pre-existing diagnostics (no Deno globals, `npm:` imports), so a full
 * type check cannot be a gate — but a diagnostic that did not exist before the patch is the patch's.
 *
 * Live 2026-09-27 (job 7d19a5f9, Gitea PR #9): the cancel_builder_job revision referenced `r.role`
 * inside loadHistory where no `r` exists — a ReferenceError on the confirmation turn. Syntax gate,
 * regex tests, security scan and the strongest reviewer all passed it. "Cannot find name 'r'" is
 * exactly what this gate returns.
 */

const path = require('node:path');

function loadTypeScript(typescriptDir) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(typescriptDir);
}

function scriptKind(ts, file) {
  return file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

// Edge functions run on Deno/Supabase Edge Runtime. Without these ambients a NEW edge function has no
// "before" baseline, so `Cannot find name 'Deno'` became a blocking delta and every Builder job that
// created a function failed backend-verify (live 2026-10-21, jobs #89–#93, 6/6 attempts each).
const EDGE_AMBIENT_FILE = '__builder_edge_runtime_ambient.d.ts';
const EDGE_AMBIENT_TEXT = 'declare const Deno: any;\ndeclare const EdgeRuntime: any;\n';

function isEdgeFunctionFile(file) {
  return /(^|[\\/])supabase[\\/]functions[\\/]/.test(file);
}

/** Semantic diagnostics for one file, checked in isolation (imports unresolved → `any`, never a gate failure). */
function fileDiagnostics(ts, file, text) {
  const options = {
    noEmit: true,
    noResolve: true,
    skipLibCheck: true,
    allowJs: false,
    strict: false,
    noImplicitAny: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs,
    types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    jsx: file.endsWith('x') ? ts.JsxEmit.Preserve : undefined,
  };
  const host = ts.createCompilerHost(options, true);
  const normalized = path.resolve(file);
  const source = ts.createSourceFile(normalized, text, options.target, true, scriptKind(ts, file));
  const virtual = new Map([[normalized, { text, source }]]);
  if (isEdgeFunctionFile(file)) {
    const ambientPath = path.resolve(path.dirname(normalized), EDGE_AMBIENT_FILE);
    virtual.set(ambientPath, { text: EDGE_AMBIENT_TEXT, source: ts.createSourceFile(ambientPath, EDGE_AMBIENT_TEXT, options.target, true, ts.ScriptKind.TS) });
  }
  const originalGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => virtual.get(path.resolve(name))?.source ?? originalGet(name, languageVersion, onError, shouldCreate);
  host.fileExists = (name) => virtual.has(path.resolve(name)) || ts.sys.fileExists(name);
  host.readFile = (name) => virtual.get(path.resolve(name))?.text ?? ts.sys.readFile(name);
  host.writeFile = () => {};
  const program = ts.createProgram([...virtual.keys()], options, host);
  const diagnostics = program.getSemanticDiagnostics(source).map((diagnostic) => {
    const { line } = diagnostic.file && typeof diagnostic.start === 'number' ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : { line: -1 };
    return { code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '), line: line + 1 };
  });
  // TypeScript reports a redeclaration once per declaration. Two reports in this file mean both
  // declarations are here (a module-load crash); one means it collides with a lib.dom global and
  // only exists because the file is checked as a script.
  const counts = new Map();
  for (const diagnostic of diagnostics) counts.set(key(diagnostic), (counts.get(key(diagnostic)) ?? 0) + 1);
  return diagnostics.map((diagnostic) => ({ ...diagnostic, sameFile: counts.get(key(diagnostic)) > 1 }));
}

// Unresolved-import noise is identical before and after and is dropped anyway; these codes are
// never about the patch's own identifiers and would only mask a real regression behind volume.
const IGNORED_CODES = new Set([2307, 2792, 7016, 1479, 2580, 2584]);

const key = (diagnostic) => `${diagnostic.code}::${diagnostic.message}`;

// Diagnostics that are runtime bugs in disguise: an undefined name, a property that is not there,
// a call with the wrong shape. Other new diagnostics are reported as warnings, not failures.
const BLOCKING_CODES = new Set([2304, 2552, 2551, 2339, 2349, 2350, 2448, 2454, 2540, 2554, 2556, 2693, 2367, 1345]);

// "Cannot redeclare block-scoped variable" (2451) and "Duplicate identifier" (2300) block only when
// both declarations are in the patched file: a model that appends a second `const x` instead of
// revising the first ships a SyntaxError at module load.
const SAME_FILE_BLOCKING_CODES = new Set([2451, 2300]);

function isBlocking(diagnostic) {
  return BLOCKING_CODES.has(diagnostic.code) || (SAME_FILE_BLOCKING_CODES.has(diagnostic.code) && diagnostic.sameFile === true);
}

/** Split new diagnostics into what fails the patch and what is only reported. */
function classifyDelta(diagnostics) {
  const blocking = diagnostics.filter(isBlocking);
  const warnings = diagnostics.filter((diagnostic) => !isBlocking(diagnostic));
  return { blocking, warnings };
}

/**
 * Gate every changed TypeScript file: returns { failures: [text], warnings: [text], checked: [file] }.
 * `readBefore(file)` returns the pre-patch text or null (new file); `readAfter(file)` the patched text.
 */
function gateTypeScriptDelta({ ts, files, readBefore, readAfter }) {
  const failures = [];
  const warnings = [];
  const checked = [];
  for (const file of files) {
    const after = readAfter(file);
    if (typeof after !== 'string') continue;
    checked.push(file);
    const { blocking, warnings: soft } = classifyDelta(newDiagnostics(ts, file, readBefore(file), after));
    for (const diagnostic of blocking) failures.push(`${file}:${diagnostic.line}: TS${diagnostic.code} ${diagnostic.message} (this diagnostic did not exist before the patch)`);
    for (const diagnostic of soft) warnings.push(`${file}:${diagnostic.line}: TS${diagnostic.code} ${diagnostic.message}`);
  }
  return { failures, warnings, checked };
}

/**
 * New semantic diagnostics the patch introduced in one file: kinds (code + message) the file did
 * not report before. Set semantics on purpose — one more `Cannot find name 'Deno'` in a Deno file
 * is not a regression, a first `Cannot find name 'r'` is. `before` may be null for a new file.
 */
function newDiagnostics(ts, file, beforeText, afterText) {
  const before = new Set(typeof beforeText === 'string' ? fileDiagnostics(ts, file, beforeText).map(key) : []);
  const seen = new Set();
  const fresh = [];
  for (const diagnostic of fileDiagnostics(ts, file, afterText)) {
    if (IGNORED_CODES.has(diagnostic.code) || before.has(key(diagnostic)) || seen.has(key(diagnostic))) continue;
    seen.add(key(diagnostic));
    fresh.push(diagnostic);
  }
  return fresh;
}

module.exports = { BLOCKING_CODES, IGNORED_CODES, SAME_FILE_BLOCKING_CODES, classifyDelta, isEdgeFunctionFile, fileDiagnostics, gateTypeScriptDelta, loadTypeScript, newDiagnostics };
