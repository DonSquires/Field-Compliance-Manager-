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
  const originalGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => (path.resolve(name) === normalized ? source : originalGet(name, languageVersion, onError, shouldCreate));
  host.fileExists = (name) => path.resolve(name) === normalized || ts.sys.fileExists(name);
  host.readFile = (name) => (path.resolve(name) === normalized ? text : ts.sys.readFile(name));
  host.writeFile = () => {};
  const program = ts.createProgram([normalized], options, host);
  return program.getSemanticDiagnostics(source).map((diagnostic) => {
    const { line } = diagnostic.file && typeof diagnostic.start === 'number' ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : { line: -1 };
    return { code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '), line: line + 1 };
  });
}

// Unresolved-import noise is identical before and after and is dropped anyway; these codes are
// never about the patch's own identifiers and would only mask a real regression behind volume.
const IGNORED_CODES = new Set([2307, 2792, 7016, 1479, 2580, 2584]);

const key = (diagnostic) => `${diagnostic.code}::${diagnostic.message}`;

// Diagnostics that are runtime bugs in disguise: an undefined name, a property that is not there,
// a call with the wrong shape. Other new diagnostics are reported as warnings, not failures.
const BLOCKING_CODES = new Set([2304, 2552, 2551, 2339, 2349, 2350, 2448, 2454, 2540, 2554, 2556, 2693, 2367, 1345]);

/** Split new diagnostics into what fails the patch and what is only reported. */
function classifyDelta(diagnostics) {
  const blocking = diagnostics.filter((diagnostic) => BLOCKING_CODES.has(diagnostic.code));
  const warnings = diagnostics.filter((diagnostic) => !BLOCKING_CODES.has(diagnostic.code));
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

module.exports = { BLOCKING_CODES, IGNORED_CODES, classifyDelta, fileDiagnostics, gateTypeScriptDelta, loadTypeScript, newDiagnostics };
