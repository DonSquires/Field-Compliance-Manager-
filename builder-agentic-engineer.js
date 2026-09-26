'use strict';

/**
 * Bob's agentic engineer — the implementation step of the self-heal / build
 * lane, working the way a coding agent works: explore the repository, read the
 * canon and its own notes, make the smallest correct change in an isolated
 * worktree pinned to the job's commit, run the tests, iterate on failures, and
 * hand a verified unified diff to the independent worker + reviewers. It runs
 * at maximum reasoning effort on the control plane (no edge timeout).
 *
 * Cage that stays: protected paths are refused (builder-path-policy), migrations
 * may only be added, no binary or dependency changes, every tool call is logged
 * into a build_logs artifact, and nothing here merges, deploys, or writes live
 * data — the output is a draft PR for a human.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createBranchWorkspace, redactGitError } = require('./builder-branch-workspace');
const { isProtectedPath, laneAllows, protectedReason, isMigrationPath, normalizeRepoPath } = require('./builder-path-policy');
const { buildModelRunRequest, callModelGateway, persistModelArtifact, fetchModelHealth, selectProviders, providerRequest } = require('./supabase/functions/_shared/builder-model-adapter');
const { collectRepositoryContext } = require('./supabase/functions/_shared/builder-repository-context');

const PROMPT_VERSION = 'agentic-engineer-v2';
const DEFAULT_LIMITS = Object.freeze({
  maxTurns: Math.max(4, Number(process.env.BOB_BUILDER_AGENT_TURNS || 60)),
  wallBudgetMs: Math.max(5 * 60_000, Number(process.env.BOB_BUILDER_AGENT_BUDGET_MS || 45 * 60_000)),
  readCapChars: 60_000,
  searchCapLines: 200,
  listCapEntries: 400,
  runCapChars: 20_000,
  runTimeoutMs: 10 * 60_000,
  turnTimeoutMs: 620_000,
  maxPatchBytes: 2 * 1024 * 1024,
});

// Commands Bob may run inside his worktree. Verification the worker image owns
// (web build/tests) is not duplicated here; the handoff runs it independently.
const RUN_ALLOWLIST = [
  /^node --test( test\/[A-Za-z0-9_.\-*]+\.test\.js)*$/,
  /^node --check [A-Za-z0-9_./-]+\.(?:js|mjs|cjs)$/,
  /^node -e "require\('\.\/[A-Za-z0-9_./-]+'\)"$/,
  /^git (?:status|diff|log|show|blame)(?: [A-Za-z0-9_./=@^~:*-]+)*$/,
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', 'coverage']);

function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options }).trim();
  } catch (error) {
    throw new Error(redactGitError(error && (error.stderr || error.message)));
  }
}

function clip(text, cap, label = 'output') {
  const value = String(text ?? '');
  if (value.length <= cap) return value;
  return `${value.slice(0, cap)}\n[TRUNCATED: ${label} was ${value.length} chars; showing the first ${cap}. Narrow the request to see the rest.]`;
}

function parseToolCall(content) {
  const raw = String(content ?? '').trim();
  const attempt = (text) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(raw);
  if (direct) return direct;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = attempt(fence[1].trim());
    if (fenced) return fenced;
  }
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return attempt(raw.slice(start, i + 1));
    }
  }
  return null;
}

function resolveInside(root, relativePath) {
  const normalized = normalizeRepoPath(relativePath);
  if (!normalized) throw new Error(`unsafe path: ${relativePath}`);
  const absolute = path.resolve(root, normalized);
  if (absolute !== path.resolve(root) && !absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`path escapes the workspace: ${relativePath}`);
  return { normalized, absolute };
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

function systemPrompt({ lane, limits }) {
  return [
    'You are Bob Builder, the engineering half of Bob — the Field Compliance Manager platform\'s own agent. You work the way a senior coding agent works, at full effort:',
    '1. UNDERSTAND before editing: read AGENTS.md / the canon (read_canon), your own notes (read_notes), and the code paths involved (search, read_file, list_dir, git_log). Trace the whole seam before changing part of it.',
    '2. PLAN the smallest correct change that fixes the root cause. Prefer editing existing files over adding new ones. Do not add features, refactors, comments, or "improvements" beyond the task.',
    '3. IMPLEMENT inside your worktree: replace_in_file for edits to existing files (exact old text -> new text; no line counting), write_file for new files or full rewrites, apply_patch only if you already hold a correct unified diff. Keep existing conventions. Never invent schema, tables, or behaviour absent from the evidence — verify with search/read_file.',
    '4. VERIFY: run the relevant tests (run "node --test test/<file>.test.js"), node --check on changed files, and read git diff. If a test fails, read the failure, fix the cause, and run again. Add or update a test when the change is testable at this layer.',
    '5. FINISH with a truthful summary. Truth Protocol: state what you verified, what you inferred, and what you could not check. Never claim a merge, deployment, migration application, or live write — none happen here; a human reviews the draft PR.',
    '',
    `LANE: ${lane}. ${lane === 'frontend' ? 'You may only change files under apps/web/. Web build/tests are run afterwards by the independent worker; keep changes type-safe and covered by the existing vitest suite where possible.' : 'You may change anything outside apps/web/ that is not protected (edge functions, services, scripts, root modules, tests, docs, ADDITIVE migrations).'}`,
    'PROTECTED (refused, human-only): CI workflows, deploy/, Dockerfiles and compose files, dependency manifests and lockfiles, .env and secret material, supabase/schema.sql (regenerated), auth/identity code (AuthContext, lib/supabase.ts, routing, SafetyGate, access components, _shared/auth.ts). Migrations must be NEW additive files; no destructive SQL. No binary files. Never print, store, or move secrets.',
    '',
    'TOOLS (one call per turn; reply with ONLY a JSON object {"thought": string, "tool": string, "args": object}):',
    '- list_dir {path}                        list a directory (node_modules/.git skipped)',
    `- read_file {path, start_line?, end_line?}   read a text file (max ${limits.readCapChars} chars per call)`,
    '- search {query, path?, regex?}          git grep across the worktree (path = pathspec, e.g. "supabase/functions"); regex defaults to false',
    '- git_log {path?, limit?}               recent commits (optionally for a path)',
    '- git_diff {}                            your uncommitted changes so far',
    '- write_file {path, content}             create or overwrite a file (full content)',
    '- replace_in_file {path, old_text, new_text, all?}   PREFERRED EDIT: replace one exact occurrence of old_text (copy it verbatim from read_file, several lines is fine) with new_text; all=true replaces every occurrence. Fails safely when the text is missing or ambiguous.',
    '- apply_patch {diff}                     apply a unified diff (git apply); hunk counts must be exact — use replace_in_file instead when unsure',
    '- delete_file {path}                     delete a file',
    `- run {command}                          allowed: node --test [test files], node --check <file>, git status/diff/log/show/blame (timeout ${Math.round(limits.runTimeoutMs / 60000)} min)`,
    '- read_canon {}                          AGENTS.md + docs/canon/README.md + docs/canon/BOB_DOCTRINE.md (bounded)',
    '- read_notes {limit?}                    your persistent builder notes (lessons from earlier jobs)',
    '- write_note {text}                      leave a durable lesson for future jobs (short, factual, no secrets)',
    '- finish {summary, tests, rollback_notes, follow_ups?, tests_not_run_reason?}   hand over: your worktree diff becomes the reviewed patch. A change that touches tests is refused unless a `node --test` run passed in this session (or tests_not_run_reason says plainly why none could).',
    '',
    `Budget: ${limits.maxTurns} tool turns / ${Math.round(limits.wallBudgetMs / 60000)} minutes. Pace it: spend at most about a third of the turns reading before you start editing; you will be told when the budget is running low. Do not repeat identical calls. If the task is impossible, unsafe, or requires a protected path, finish with an empty change set and explain plainly in the summary what a human must do.`,
  ].join('\n');
}

function taskPacket(input) {
  const { job, lane, specification, uxPlan, repositoryContext, liveContext, notes, previousFailure, hints } = input;
  return JSON.stringify({
    job: { title: job.title, task_description: job.task_description, description: job.description ?? null, target_sha: job.target_sha, requested_action: job.requested_action ?? null, target_environment: job.target_environment ?? null },
    lane,
    approved_product_specification: specification ?? null,
    ui_design_plan: lane === 'frontend' ? uxPlan ?? null : undefined,
    repository_build_map: repositoryContext ?? null,
    live_context: liveContext ?? null,
    file_hints: Array.isArray(hints) && hints.length ? hints : undefined,
    your_recent_notes: notes,
    previous_attempt_failed_verification: previousFailure ?? undefined,
    how_to_start: 'Call read_canon and read_notes once, then explore the code paths named in the task with search/read_file before editing. Finish only after your own test run passes or you can explain exactly why it cannot run here.',
  }, null, 0);
}

function summariseUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    if (typeof usage[key] === 'number') total[key] = (total[key] || 0) + usage[key];
  }
  return total;
}

// Every turn re-sends the whole conversation, so a 25-turn job with a few 60k-char file reads
// costs ~1.6M prompt tokens. Recent turns stay verbatim; older bulky tool results and full-file
// write payloads are collapsed to a head + a pointer (the model can re-read a file if it needs it).
function compactMessages(messages, { keepRecent = 6, stubChars = 600, threshold = 1500 } = {}) {
  const [system, task, ...turns] = messages;
  const cutoff = Math.max(0, turns.length - keepRecent * 2);
  const compacted = turns.map((message, index) => {
    if (index >= cutoff || typeof message.content !== 'string' || message.content.length <= threshold) return message;
    if (message.role === 'assistant') {
      try {
        const call = JSON.parse(message.content);
        if (call.tool === 'write_file' && call.args) return { ...message, content: JSON.stringify({ thought: call.thought, tool: 'write_file', args: { path: call.args.path, bytes: Buffer.byteLength(String(call.args.content ?? '')), content: '[compacted: full file was written; read_file to see it]' } }) };
        if (call.tool === 'apply_patch' && call.args) return { ...message, content: JSON.stringify({ thought: call.thought, tool: 'apply_patch', args: { bytes: Buffer.byteLength(String(call.args.diff ?? '')), diff: '[compacted: patch applied earlier; git_diff shows the current state]' } }) };
      } catch { /* leave as is */ }
      return message;
    }
    return { ...message, content: `${message.content.slice(0, stubChars)}…[compacted ${message.content.length - stubChars} chars: re-run the tool if you need this again]` };
  });
  return [system, task, ...compacted];
}

function createTools({ workspacePath, repoRoot, lane, supabase, limits, log }) {
  // First-hand evidence of what Bob actually executed (not what he says he ran).
  const runs = [];
  const run = (command) => {
    const text = String(command ?? '').trim();
    if (!RUN_ALLOWLIST.some((pattern) => pattern.test(text))) return { error: 'command not allowed; allowed forms: node --test [test/<file>.test.js …], node --check <file>, git status|diff|log|show|blame' };
    const argv = text.match(/"[^"]*"|\S+/g).map((part) => part.replace(/^"|"$/g, ''));
    const started = Date.now();
    // A nested `node --test` inherits the parent test-runner context and misreports; give the child a clean runner env.
    // The child never sees the control plane's own secrets or port.
    const { NODE_TEST_CONTEXT: _testContext, NODE_OPTIONS: _nodeOptions, PORT: _port, BOB_ADMIN_TOKEN: _admin, BOB_RUNNER_TOKEN: _runner, BOB_MODEL_GATEWAY_TOKEN: _gw, SUPABASE_SERVICE_ROLE_KEY: _srk, OPENAI_API_KEY: _oai, GITEA_TOKEN: _gitea, GITHUB_TOKEN: _gh, ...childEnv } = process.env;
    // Asynchronous: a full test suite can run for a minute, and a blocked event loop would stall
    // the control plane's own HTTP server (health, model gateway) for that long.
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: workspacePath, env: { ...childEnv, CI: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const cap = 64 * 1024 * 1024;
      child.stdout.on('data', (chunk) => { if (stdout.length < cap) stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { if (stderr.length < cap) stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, limits.runTimeoutMs);
      const finish = (status, spawnError) => {
        clearTimeout(timer);
        runs.push({ command: text, exit_code: status, at: new Date(started).toISOString(), duration_ms: Date.now() - started });
        resolve({
          command: text,
          exit_code: status,
          timed_out: timedOut,
          duration_ms: Date.now() - started,
          stdout: clip(stdout, limits.runCapChars, 'stdout'),
          stderr: clip(redactGitError(spawnError ? `${stderr}\n${spawnError.message}` : stderr), limits.runCapChars, 'stderr'),
        });
      };
      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    });
  };

  const policyCheck = (file) => {
    if (isProtectedPath(file)) return `${file}: ${protectedReason(file)}`;
    if (!laneAllows(lane, file)) return `${file}: outside the ${lane} lane`;
    return null;
  };

  // Untrimmed, NUL-separated: git()'s trim() would eat the leading space of an unstaged
  // " M path" entry and turn the first changed path into "ath" — which then fed the policy check.
  const changedFiles = () => {
    const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const entries = raw.split('\0').filter(Boolean);
    const files = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const status = entry.slice(0, 2);
      files.push(entry.slice(3));
      if (status[0] === 'R' || status[0] === 'C') index += 1; // renames/copies carry the source path in the next NUL field
    }
    return files;
  };

  const revertPath = (file) => {
    try { git(workspacePath, ['checkout', '--', file]); } catch { /* untracked */ }
    try { fs.rmSync(path.resolve(workspacePath, file), { force: true }); } catch { /* already gone */ }
  };

  return {
    list_dir({ path: dir = '.' }) {
      const { normalized, absolute } = resolveInside(workspacePath, dir || '.');
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) return { error: `not a directory: ${normalized}` };
      const entries = fs.readdirSync(absolute, { withFileTypes: true }).filter((entry) => !SKIP_DIRS.has(entry.name)).slice(0, limits.listCapEntries)
        .map((entry) => `${entry.isDirectory() ? entry.name + '/' : entry.name}`).sort();
      return { path: normalized, entries };
    },
    read_file({ path: file, start_line, end_line }) {
      const { normalized, absolute } = resolveInside(workspacePath, file);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return { error: `not a file: ${normalized}` };
      const buffer = fs.readFileSync(absolute);
      if (looksBinary(buffer)) return { error: `binary file: ${normalized}` };
      const lines = buffer.toString('utf8').split('\n');
      const start = Math.max(1, Number(start_line) || 1);
      const end = Math.min(lines.length, Number(end_line) || lines.length);
      const slice = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
      return { path: normalized, total_lines: lines.length, start_line: start, end_line: end, content: clip(slice, limits.readCapChars, `${normalized} lines ${start}-${end}`) };
    },
    search({ query, path: pathspec, regex }) {
      if (!query || typeof query !== 'string') return { error: 'query is required' };
      // Models pass several pathspecs at once ("services/fcm-api/src/bob test"); honour each one.
      const pathspecs = (Array.isArray(pathspec) ? pathspec : String(pathspec ?? '').split(/[\s,]+/))
        .map((value) => normalizeRepoPath(value)).filter(Boolean);
      const args = ['grep', '-n', '-I', regex ? '-E' : '-F', '-e', query, '--', ...(pathspecs.length ? pathspecs : ['.'])];
      const result = spawnSync('git', args, { cwd: workspacePath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      // git grep: 0 = matches, 1 = no matches, anything else is a real error.
      if (result.status !== 0 && result.status !== 1) return { error: clip(redactGitError(result.stderr || result.error?.message || `git grep exited ${result.status}`), 500) };
      const lines = String(result.stdout || '').split('\n').filter(Boolean);
      return { query, paths: pathspecs, matches: lines.length, results: lines.slice(0, limits.searchCapLines), truncated: lines.length > limits.searchCapLines };
    },
    git_log({ path: file, limit } = {}) {
      const args = ['log', '--no-color', `-n${Math.min(50, Math.max(1, Number(limit) || 20))}`, '--format=%h %ad %s', '--date=short'];
      if (file) args.push('--', normalizeRepoPath(file) || '.');
      return { log: clip(git(workspacePath, args), 8000, 'git log') };
    },
    git_diff() {
      const diff = git(workspacePath, ['diff', '--no-color']);
      const untracked = git(workspacePath, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
      return { changed_files: changedFiles(), untracked_files: untracked, diff: clip(diff, limits.readCapChars, 'diff') };
    },
    write_file({ path: file, content }) {
      const { normalized, absolute } = resolveInside(workspacePath, file);
      const violation = policyCheck(normalized);
      if (violation) return { error: `refused: ${violation}` };
      if (typeof content !== 'string') return { error: 'content must be a string' };
      if (isMigrationPath(normalized) && fs.existsSync(absolute)) return { error: `refused: ${normalized} exists; migrations may only be added as new files` };
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return { path: normalized, bytes: Buffer.byteLength(content) };
    },
    // Exact-text replacement: the edit models get right far more often than unified-diff hunks
    // (job 1021dbaa burned 3 x 40 turns on "corrupt patch" / "does not apply").
    replace_in_file({ path: file, old_text, new_text, all = false }) {
      const { normalized, absolute } = resolveInside(workspacePath, file);
      const violation = policyCheck(normalized);
      if (violation) return { error: `refused: ${violation}` };
      if (typeof old_text !== 'string' || !old_text.length) return { error: 'old_text is required (copy it verbatim from read_file)' };
      if (typeof new_text !== 'string') return { error: 'new_text must be a string (use "" to delete the text)' };
      if (isMigrationPath(normalized)) return { error: `refused: ${normalized} is a migration; migrations may only be added as new files` };
      if (!fs.existsSync(absolute)) return { error: `not found: ${normalized}` };
      const current = fs.readFileSync(absolute, 'utf8');
      const occurrences = current.split(old_text).length - 1;
      if (occurrences === 0) {
        // A near miss is almost always whitespace; say so instead of making the model guess.
        const collapsed = (s) => s.replace(/\s+/g, ' ').trim();
        const hint = collapsed(current).includes(collapsed(old_text)) ? ' (the text exists with different whitespace/indentation - copy it exactly as read_file shows it)' : '';
        return { error: `old_text not found in ${normalized}${hint}` };
      }
      if (occurrences > 1 && !all) return { error: `old_text occurs ${occurrences} times in ${normalized}; include more surrounding lines to make it unique, or pass all=true` };
      const updated = all ? current.split(old_text).join(new_text) : current.replace(old_text, () => new_text);
      fs.writeFileSync(absolute, updated);
      return { path: normalized, replaced: all ? occurrences : 1, bytes: Buffer.byteLength(updated) };
    },
    apply_patch({ diff }) {
      if (typeof diff !== 'string' || !diff.trim()) return { error: 'diff is required' };
      const before = new Set(changedFiles());
      const patchPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bob-agent-patch-')), 'patch.diff');
      // Models wrap diffs in fences and miscount hunk lengths; tolerate both before asking for a rewrite.
      const text = diff.replace(/^\s*```(?:diff|patch)?\s*\n/, '').replace(/\n```\s*$/, '');
      const strategies = [[], ['--recount'], ['--recount', '--ignore-whitespace']];
      let failure = '';
      try {
        fs.writeFileSync(patchPath, text.endsWith('\n') ? text : `${text}\n`);
        let applied = false;
        for (const flags of strategies) {
          try {
            git(workspacePath, ['apply', '--check', '--whitespace=nowarn', ...flags, patchPath]);
            git(workspacePath, ['apply', '--whitespace=nowarn', ...flags, patchPath]);
            applied = true;
            break;
          } catch (error) {
            failure = failure || String(error.message);
          }
        }
        if (!applied) return { error: `patch did not apply: ${clip(failure, 1500)}. Read the current file (exact lines) and either send a corrected hunk or use write_file with the full content.` };
      } finally {
        fs.rmSync(path.dirname(patchPath), { recursive: true, force: true });
      }
      const violations = changedFiles().filter((file) => !before.has(file)).map((file) => policyCheck(file)).filter(Boolean);
      for (const violation of violations) revertPath(violation.split(':')[0]);
      return violations.length ? { error: `patch touched refused paths (reverted): ${violations.join('; ')}` } : { applied: true, changed_files: changedFiles() };
    },
    delete_file({ path: file }) {
      const { normalized, absolute } = resolveInside(workspacePath, file);
      const violation = policyCheck(normalized);
      if (violation) return { error: `refused: ${violation}` };
      if (!fs.existsSync(absolute)) return { error: `not found: ${normalized}` };
      fs.rmSync(absolute, { force: true });
      return { deleted: normalized };
    },
    run({ command }) {
      return run(command);
    },
    read_canon() {
      const read = (file) => {
        try { return clip(fs.readFileSync(path.join(repoRoot, file), 'utf8'), 14_000, file); } catch { return null; }
      };
      return { 'AGENTS.md': read('AGENTS.md'), 'docs/canon/README.md': read('docs/canon/README.md'), 'docs/canon/BOB_DOCTRINE.md': read('docs/canon/BOB_DOCTRINE.md') };
    },
    async read_notes({ limit } = {}) {
      if (!supabase) return { notes: [] };
      const { data, error } = await supabase.from('bob_self_memory').select('memory_text, created_at').eq('memory_kind', 'builder_note').order('created_at', { ascending: false }).limit(Math.min(50, Math.max(1, Number(limit) || 20)));
      return error ? { error: 'notes unavailable' } : { notes: (data || []).map((row) => ({ at: row.created_at, text: row.memory_text })) };
    },
    async write_note({ text }) {
      const value = String(text ?? '').trim().slice(0, 2000);
      if (!value) return { error: 'text is required' };
      if (/(sk-|ghp_|github_pat_|ghu_|eyJ[A-Za-z0-9_-]{20,}|password|secret)/i.test(value)) return { error: 'refused: notes must not contain secrets' };
      if (!supabase) return { saved: false };
      const { error } = await supabase.from('bob_self_memory').insert({ memory_text: value, memory_kind: 'builder_note', content: value });
      return error ? { error: 'note could not be saved' } : { saved: true };
    },
    __changedFiles: changedFiles,
    __policyCheck: policyCheck,
    __runs: () => runs.slice(),
    __log: log,
  };
}

function buildProposal({ workspacePath, lane, tools, args }) {
  git(workspacePath, ['add', '-A', '--', '.']);
  const files = git(workspacePath, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).sort();
  if (!files.length) return { error: 'finish refused: no changes in the worktree. Implement the change first, or finish with an explanation only by setting args.no_change_reason.' };
  const violations = files.map((file) => tools.__policyCheck(file)).filter(Boolean);
  if (violations.length) return { error: `finish refused: ${violations.join('; ')}. Revert those files (git checkout -- <path>) and finish again.` };
  const modified = git(workspacePath, ['diff', '--cached', '--name-only', '--diff-filter=MD']).split('\n').filter(Boolean);
  const badMigrations = modified.filter((file) => isMigrationPath(file));
  if (badMigrations.length) return { error: `finish refused: migrations may only be added, never modified or deleted: ${badMigrations.join(', ')}` };
  // Raw, untrimmed: git()'s trim() also eats a trailing blank context line (" \n"), which
  // shortens the last hunk and makes git apply reject the patch as corrupt.
  const patch = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (Buffer.byteLength(patch) > DEFAULT_LIMITS.maxPatchBytes) return { error: 'finish refused: patch exceeds 2 MB' };
  if (/GIT binary patch|Binary files .* differ/m.test(patch)) return { error: 'finish refused: binary changes are not allowed' };
  const summary = String(args.summary ?? '').trim();
  if (summary.length < 20) return { error: 'finish refused: summary must explain the change (what, why, how verified)' };
  // Truth Protocol at the gate: a change that touches tests (or that the brief asked to test) must come with a
  // passing `node --test` run from THIS session, or an explicit reason why none could run. Claims are not evidence.
  const sessionRuns = typeof tools.__runs === 'function' ? tools.__runs() : [];
  const passingTestRuns = sessionRuns.filter((r) => /^node --test\b/.test(r.command) && r.exit_code === 0);
  const touchesTests = files.some((file) => /^test\/|\.test\.(?:[cm]?js|tsx?)$/.test(file));
  const testsNotRunReason = String(args.tests_not_run_reason ?? '').trim();
  if (touchesTests && !passingTestRuns.length && !testsNotRunReason) {
    return { error: 'finish refused: this change touches tests but no `node --test …` run passed in this session. Run the relevant test file (run {"command":"node --test test/<file>.test.js"}) and finish again, or set args.tests_not_run_reason to say plainly why it cannot run here.' };
  }
  const tests = (Array.isArray(args.tests) ? args.tests : typeof args.tests === 'string' ? args.tests.split(/\r?\n/) : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  const proposal = {
    summary,
    patch,
    changed_files: files,
    database_migrations: files.filter((file) => file.startsWith('supabase/migrations/')),
    edge_functions: [...new Set(files.filter((file) => /^supabase\/functions\/(?!_shared\/)[^/]+\//.test(file)).map((file) => file.split('/')[2]))].sort(),
    tests,
    // What actually ran, from the tool log (command + exit code), so reviewers need not trust the summary.
    verified_runs: sessionRuns.filter((r) => /^node --(test|check)\b/.test(r.command)).slice(-20),
    tests_not_run_reason: testsNotRunReason || undefined,
    rollback_notes: Array.isArray(args.rollback_notes) && args.rollback_notes.length ? args.rollback_notes.map(String).slice(0, 10) : ['Revert the pull request; no live data, migrations, or deployments are applied by this change.'],
    follow_ups: Array.isArray(args.follow_ups) ? args.follow_ups.map(String).slice(0, 10) : [],
    lane,
    prompt_version: PROMPT_VERSION,
  };
  // The lane validators are the same ones the independent handoff applies; fail here, not there.
  if (lane === 'backend') {
    const { parseBackendProposal } = require('./supabase/functions/_shared/builder-backend-engineer');
    parseBackendProposal(JSON.stringify(proposal));
  } else {
    const { validatePatchText } = require('./frontend-worker');
    validatePatchText(patch);
  }
  return { proposal };
}

async function recordRun({ supabase, modelRequest, content, model, usage, artifactType, error = null }) {
  if (!supabase) return { artifact: null };
  const startedAt = new Date().toISOString();
  const { data: modelRun, error: insertError } = await supabase.from('builder_model_runs').upsert({
    organization_id: modelRequest.organization_id,
    job_id: modelRequest.job_id,
    step_id: modelRequest.step_id,
    provider: modelRequest.provider,
    model_name: model || modelRequest.model_name || 'provider_default',
    prompt_version: modelRequest.prompt_version,
    idempotency_key: modelRequest.idempotency_key,
    input_artifact_ids: modelRequest.input_artifact_ids,
    status: 'running',
    started_at: startedAt,
  }, { onConflict: 'idempotency_key' }).select('id').single();
  if (insertError || !modelRun?.id) return { artifact: null, error: 'model run provenance could not be recorded' };
  if (error) {
    await supabase.from('builder_model_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error: String(error).slice(0, 500), usage_metadata: usage || {} }).eq('id', modelRun.id);
    return { artifact: null, model_run_id: modelRun.id };
  }
  const persisted = await persistModelArtifact({ supabase, modelRunId: modelRun.id, modelRequest, gatewayData: { content, model, usage }, artifactType });
  if (!persisted.success) {
    await supabase.from('builder_model_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error: persisted.error }).eq('id', modelRun.id);
    return { artifact: null, model_run_id: modelRun.id, error: persisted.error };
  }
  return { artifact: persisted.artifact, model_run_id: modelRun.id };
}

/**
 * Run the agentic engineer for one implementation step. Returns the same shape
 * the one-shot engineers return ({ ok, patch_artifact, proposal }) so the
 * existing handoffs, repair loop, and reviewers stay in charge of verification.
 */
async function runAgenticEngineer({
  supabase,
  gateway,
  job,
  step,
  lane,
  sourceDir,
  workspaceRoot,
  repoRoot = process.env.BOB_ASSESSMENT_ROOT || '/app',
  specification = null,
  uxPlan = null,
  liveContext = null,
  hints = [],
  previousFailure = null,
  inputArtifactIds = [],
  limits = DEFAULT_LIMITS,
  // null = the outsourced tier serves its strongest available allowlisted model (BOB_OPENAI_MODELS, best first).
  modelName = process.env.BOB_BUILDER_MODEL || null,
  callModel = callModelGateway,
  // In-house first: resume the chain past a provider whose earlier attempt failed verification.
  startAfterProvider = null,
  providerHealth = null,
  now = Date.now,
  logger = console,
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!step?.id) throw new Error('implementation step is required');
  if (!['frontend', 'backend'].includes(lane)) throw new Error('lane must be frontend or backend');
  const started = now();
  const workspace = createBranchWorkspace({ sourceDir, workspaceRoot, jobId: job.id, targetSha: job.target_sha });
  const workspacePath = workspace.workspacePath;
  // Start every attempt from the pinned commit; a previous attempt may have left edits behind.
  git(workspacePath, ['reset', '-q', '--hard', job.target_sha]);
  git(workspacePath, ['clean', '-fdq']);

  const transcript = [];
  const log = (entry) => transcript.push({ at: new Date().toISOString(), ...entry });
  const tools = createTools({ workspacePath, repoRoot, lane, supabase, limits, log });
  const notes = supabase ? (await tools.read_notes({ limit: 10 })).notes ?? [] : [];
  const repositoryContext = (() => {
    try { return collectRepositoryContext({ sourceDir: workspacePath, targetSha: job.target_sha }); } catch { return null; }
  })();

  const messages = [
    { role: 'system', content: systemPrompt({ lane, limits }) },
    { role: 'user', content: taskPacket({ job, lane, specification, uxPlan, repositoryContext, liveContext, notes, previousFailure, hints }) },
  ];
  const builderMode = lane === 'frontend' ? 'frontend_engineer' : 'backend_engineer';
  const baseRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode,
    workloadKind: `${lane}_implementation`,
    promptVersion: PROMPT_VERSION,
    systemPrompt: messages[0].content,
    userPrompt: messages[1].content,
    inputArtifactIds,
    outputSchema: { type: 'object', required: ['tool', 'args'] },
    modelName,
  });

  const usage = {};
  const signatures = new Map();
  let parseFailures = 0;
  let outcome = null;
  let turns = 0;

  const health = providerHealth || await fetchModelHealth(gateway || {});
  const candidates = selectProviders(baseRequest, { health, startAfter: startAfterProvider });
  if (!candidates.length) {
    return { ok: false, error: 'no model provider is available for the author', turns: 0, usage, duration_ms: now() - started, routing: { provider: null, reason: baseRequest.routing_reason, prompt_version: PROMPT_VERSION, model: null, chain: baseRequest.chain } };
  }
  let active = 0;
  const activeRequest = () => providerRequest(baseRequest, candidates[active], null);
  const escalate = (reason) => {
    if (active + 1 >= candidates.length) return false;
    active += 1;
    parseFailures = 0;
    log({ turn: turns, escalated_to: candidates[active].provider, model: candidates[active].model, reason });
    return true;
  };
  // Local providers reject prompts that outgrow their window (413) or go away (5xx/timeouts); OpenAI errors end the run.
  const ESCALATE_STATUSES = new Set([408, 413, 429, 500, 502, 503, 504]);
  let unavailableStreak = 0;

  while (turns < limits.maxTurns && now() - started < limits.wallBudgetMs) {
    turns++;
    const base = activeRequest();
    const isOpenAI = candidates[active].provider === 'openai';
    const request = { ...base, idempotency_key: `${base.idempotency_key}::turn-${turns}`, request: { ...base.request, messages: compactMessages(messages), ...(isOpenAI ? { reasoning_effort: process.env.BOB_BUILDER_REASONING_EFFORT || 'high' } : {}), max_output_tokens: Number(process.env.BOB_BUILDER_MAX_OUTPUT_TOKENS || 32000) } };
    const response = await callModel({ ...gateway, modelRequest: request, timeoutMs: limits.turnTimeoutMs });
    if (!response.ok) {
      unavailableStreak++;
      log({ turn: turns, provider: candidates[active].provider, error: `model unavailable: ${response.error}`, streak: unavailableStreak });
      if ((ESCALATE_STATUSES.has(Number(response.status)) || response.timeout) && escalate(`provider ${response.status ?? 'timeout'}: ${String(response.error).slice(0, 120)}`)) { unavailableStreak = 0; continue; }
      // One dropped connection at turn 42 used to discard 41 turns of work (job 1021dbaa); give the
      // same provider three consecutive chances with a short backoff before calling it unavailable.
      if (unavailableStreak >= 3) { outcome = { ok: false, error: `model unavailable: ${response.error}` }; break; }
      turns--; // the turn did not happen
      await new Promise((resolve) => setTimeout(resolve, 2000 * unavailableStreak));
      continue;
    }
    unavailableStreak = 0;
    summariseUsage(usage, response.data?.usage);
    const content = String(response.data?.content ?? '');
    const call = parseToolCall(content);
    if (!call || typeof call.tool !== 'string') {
      parseFailures++;
      log({ turn: turns, provider: candidates[active].provider, error: 'unparseable tool call', preview: content.slice(0, 300) });
      messages.push({ role: 'assistant', content: content.slice(0, 4000) }, { role: 'user', content: JSON.stringify({ error: 'Reply with ONLY one JSON object: {"thought": string, "tool": string, "args": object}.' }) });
      if (parseFailures >= 3 && escalate('three unparseable tool calls in a row')) continue;
      if (parseFailures >= 3) { outcome = { ok: false, error: 'model did not produce tool calls' }; break; }
      continue;
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    messages.push({ role: 'assistant', content: JSON.stringify({ thought: String(call.thought ?? '').slice(0, 2000), tool: call.tool, args }) });
    log({ turn: turns, thought: String(call.thought ?? '').slice(0, 600), tool: call.tool, args: call.tool === 'write_file' ? { path: args.path, bytes: Buffer.byteLength(String(args.content ?? '')) } : call.tool === 'apply_patch' ? { bytes: Buffer.byteLength(String(args.diff ?? '')) } : args });

    if (call.tool === 'finish') {
      if (args.no_change_reason && !tools.__changedFiles().length) {
        outcome = { ok: false, no_change: true, error: String(args.no_change_reason).slice(0, 2000), summary: String(args.summary ?? '') };
        break;
      }
      const built = buildProposal({ workspacePath, lane, tools, args });
      if (built.error) {
        log({ turn: turns, finish_refused: built.error });
        messages.push({ role: 'user', content: JSON.stringify({ tool_result: { error: built.error } }) });
        continue;
      }
      outcome = { ok: true, proposal: built.proposal, model: response.data?.model };
      break;
    }

    const signature = `${call.tool}::${JSON.stringify(args)}`;
    const seen = (signatures.get(signature) || 0) + 1;
    signatures.set(signature, seen);
    let result;
    if (seen > 2 && !['run', 'git_diff'].includes(call.tool)) {
      result = { error: 'identical call already made twice; use the earlier result or take a different step' };
    } else if (typeof tools[call.tool] === 'function' && !call.tool.startsWith('__')) {
      try {
        result = await tools[call.tool](args);
      } catch (error) {
        result = { error: clip(redactGitError(error && error.message), 1500) };
      }
    } else {
      result = { error: `unknown tool ${call.tool}` };
    }
    log({ turn: turns, result: typeof result?.error === 'string' ? { error: result.error.slice(0, 500) } : { ok: true } });
    const remaining = limits.maxTurns - turns;
    const budgetNote = remaining === Math.floor(limits.maxTurns / 2)
      ? `BUDGET: half your turns are used (${remaining} left). If you have not started editing, start now.`
      : remaining > 0 && remaining <= 6
        ? `BUDGET: ${remaining} turn${remaining === 1 ? '' : 's'} left. Run your test and call finish before they run out; an unfinished worktree is discarded.`
        : null;
    messages.push({ role: 'user', content: JSON.stringify(budgetNote ? { tool_result: result, budget: budgetNote } : { tool_result: result }) });
  }

  // Grace turn: edits exist but the budget ran out mid-flight. One more call, finish only.
  if (!outcome && turns >= limits.maxTurns && tools.__changedFiles().length) {
    const base = activeRequest();
    const isOpenAI = candidates[active].provider === 'openai';
    messages.push({ role: 'user', content: JSON.stringify({ budget: 'FINAL TURN: the turn budget is used up. Reply with finish now (summary, tests actually run, rollback_notes; tests_not_run_reason if none ran) or this attempt is discarded.' }) });
    const request = { ...base, idempotency_key: `${base.idempotency_key}::turn-final`, request: { ...base.request, messages: compactMessages(messages), ...(isOpenAI ? { reasoning_effort: 'low' } : {}), max_output_tokens: 4000 } };
    const response = await callModel({ ...gateway, modelRequest: request, timeoutMs: limits.turnTimeoutMs });
    const call = response.ok ? parseToolCall(String(response.data?.content ?? '')) : null;
    if (call && call.tool === 'finish') {
      const args = call.args && typeof call.args === 'object' ? call.args : {};
      log({ turn: turns + 1, grace_finish: true, tool: 'finish' });
      const built = buildProposal({ workspacePath, lane, tools, args });
      if (built.error) log({ turn: turns + 1, finish_refused: built.error });
      else outcome = { ok: true, proposal: built.proposal, model: response.data?.model };
    } else {
      log({ turn: turns + 1, grace_finish: false, error: response.ok ? 'no finish call' : `model unavailable: ${response.error}` });
    }
  }

  if (!outcome) outcome = { ok: false, error: now() - started >= limits.wallBudgetMs ? 'time budget exhausted' : 'turn budget exhausted' };

  // Persist under the provider/model that actually did the work (provenance for the reviewer-independence rule).
  const authored = activeRequest();
  const authorModel = candidates[active].model || modelName;
  const transcriptRequest = { ...authored, idempotency_key: `${baseRequest.idempotency_key}::transcript` };
  const transcriptArtifact = await recordRun({ supabase, modelRequest: transcriptRequest, content: JSON.stringify({ lane, turns, outcome: outcome.ok ? 'proposal' : outcome.error, usage, provider: candidates[active].provider, model: authorModel, transcript }, null, 0), model: authorModel, usage, artifactType: 'build_logs' }).catch(() => ({ artifact: null }));

  let patchArtifact = null;
  if (outcome.ok) {
    const recorded = await recordRun({ supabase, modelRequest: { ...authored, idempotency_key: `${baseRequest.idempotency_key}::proposal` }, content: JSON.stringify(outcome.proposal), model: outcome.model || authorModel, usage, artifactType: 'code_implementation' });
    if (supabase && !recorded.artifact) outcome = { ok: false, error: recorded.error || 'proposal artifact could not be recorded' };
    patchArtifact = recorded.artifact;
  }
  // Leave the worktree clean at the pinned commit for the handoff's own apply.
  try { git(workspacePath, ['reset', '-q', '--hard', job.target_sha]); git(workspacePath, ['clean', '-fdq']); } catch (error) { if (logger?.warn) logger.warn(`[agentic-engineer] worktree reset failed: ${error.message}`); }

  return {
    ok: outcome.ok,
    error: outcome.ok ? undefined : outcome.error,
    no_change: Boolean(outcome.no_change),
    proposal: outcome.proposal || null,
    patch_artifact: patchArtifact,
    transcript_artifact: transcriptArtifact.artifact || null,
    turns,
    usage,
    duration_ms: now() - started,
    routing: { provider: candidates[active].provider, model: authorModel, chain: baseRequest.chain, escalated: active > 0, reason: baseRequest.routing_reason, prompt_version: PROMPT_VERSION, reasoning_effort: process.env.BOB_BUILDER_REASONING_EFFORT || 'high' },
  };
}

module.exports = { DEFAULT_LIMITS, PROMPT_VERSION, RUN_ALLOWLIST, buildProposal, compactMessages, createTools, parseToolCall, runAgenticEngineer, systemPrompt, taskPacket };
