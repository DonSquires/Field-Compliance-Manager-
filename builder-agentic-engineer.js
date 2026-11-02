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
 * may only be added, no arbitrary binary or dependency changes, every tool call is logged
 * into a build_logs artifact, and nothing here merges, deploys, or writes live
 * data — the output is a draft PR for a human.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createBranchWorkspace, redactGitError } = require('./builder-branch-workspace');
const { isProtectedPath, laneAllows, laneFor, protectedReason, isMigrationPath, normalizeRepoPath } = require('./builder-path-policy');
const { buildModelRunRequest, callModelGateway, persistModelArtifact, fetchModelHealth, selectProviders, providerRequest } = require('./supabase/functions/_shared/builder-model-adapter');
const { collectRepositoryContext, fitRepositoryContext } = require('./supabase/functions/_shared/builder-repository-context');
const { engineerCheckpoint } = require('./builder-engineer-checkpoint');
const { validatePatchText } = require('./frontend-worker');
const { generateVisualBaselines } = require('./builder-visual-baseline-tool');
const { crossLaneNoChange, reopenedRequiredLane } = require('./builder-generation-failure');
const { baselineInfo, pngEvidence } = require('./builder-visual-baseline');
const { TEST_SOURCE, droppedPinnedTests, droppedTestsMessage, patchTouchedPaths } = require('./builder-test-preservation');

const PROMPT_VERSION = 'agentic-engineer-v18';
// Consecutive refused identical calls (with nothing edited) before the author escalates or stops early.
const STUCK_REFUSALS = 4;
// Turns granted once per run when the pre-handoff compile gate refuses a finish near the end of the budget.
const COMPILE_REPAIR_TURNS = 6;
const DEFAULT_LIMITS = Object.freeze({
  maxTurns: Math.max(4, Number(process.env.BOB_BUILDER_AGENT_TURNS || 60)),
  wallBudgetMs: Math.max(5 * 60_000, Number(process.env.BOB_BUILDER_AGENT_BUDGET_MS || 45 * 60_000)),
  // A 60 kB read is ~15k tokens: half a small local model's window. Operators shrink it for in-house authors.
  readCapChars: Math.max(8_000, Number(process.env.BOB_BUILDER_READ_CAP_CHARS || 60_000)),
  searchCapLines: 200,
  listCapEntries: 400,
  runCapChars: 20_000,
  runTimeoutMs: 10 * 60_000,
  turnTimeoutMs: Math.max(60_000, Number(process.env.BOB_BUILDER_TURN_TIMEOUT_MS || 620_000)),
  maxPatchBytes: 2 * 1024 * 1024,
});

// The independent worker repeats web verification; bounded checks here let Bob
// repair failures before handing the patch to that verifier.
const RUN_ALLOWLIST = [
  /^node --test( test\/[A-Za-z0-9_.\-*]+\.test\.js)*$/,
  /^node --check [A-Za-z0-9_./-]+\.(?:js|mjs|cjs)$/,
  /^node -e "require\('\.\/[A-Za-z0-9_./-]+'\)"$/,
  /^npm run (?:lint|build) --prefix apps\/web$/,
  /^npm run test --prefix apps\/web -- [A-Za-z0-9_./*=\- ]+$/,
  /^npm test --prefix apps\/web -- [A-Za-z0-9_./*=\- ]+$/,
  /^git (?:status|diff|log|show|blame)(?: [A-Za-z0-9_./=@^~:*-]+)*$/,
];
const RUN_FORMS = 'node --test test/<file>.test.js … | node --check <file> | npm test --prefix apps/web -- src/<path>.test.tsx (Vitest; paths relative to apps/web) | npm run lint --prefix apps/web | npm run build --prefix apps/web | git status|diff|log|show|blame [args]';
const RUN_REFUSED = `command not allowed; use exactly one of: ${RUN_FORMS}. No cd, npx, pipes or redirects; chain allowed commands with &&. apps/web/e2e/*.spec.ts are Playwright specs that only the independent verifier runs.`;
const WEB_TEST_ARG = /^[A-Za-z0-9_./*=-]+$/;

function isWebTestPath(workspacePath, arg) {
  if (/^(?:\.\/)?apps\/web\//.test(arg)) return true;
  if (!workspacePath || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg)) return false;
  return !fs.existsSync(path.join(workspacePath, arg)) && fs.existsSync(path.join(workspacePath, 'apps/web', arg));
}

function normalizeRunPart(part, inWeb, workspacePath) {
  if (RUN_ALLOWLIST.some((pattern) => pattern.test(part))) return part;
  // node cannot syntax-check TypeScript; the web type check is the equivalent (job 34382d60 handed off a duplicate identifier).
  if (/^node --check (?:\.\/)?(?:apps\/web\/)?[A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts)$/.test(part)
    && (inWeb || /^node --check (?:\.\/)?apps\/web\//.test(part))) return 'npm run lint --prefix apps/web';
  const check = part.match(/^(?:npm run (lint|build)|npx tsc --noEmit)( --prefix apps\/web)?$/);
  if (check && (inWeb || check[2])) return `npm run ${check[1] || 'lint'} --prefix apps/web`;
  const runner = part.match(/^(?:npm (?:run )?test|npx vitest(?: run)?|node --test)( --prefix apps\/web)?(?: --)?(?: (.+))?$/);
  if (!runner) return part;
  const args = String(runner[2] ?? '').split(' ').filter((arg) => arg && !['--', '--run', 'run'].includes(arg));
  const files = args.filter((arg) => !arg.startsWith('-'));
  const web = inWeb || Boolean(runner[1]) || (files.length > 0 && files.every((arg) => isWebTestPath(workspacePath, arg)));
  if (!web || !files.length) return part;
  const relative = args.map((arg) => arg.replace(/^(?:\.\/)?apps\/web\//, ''));
  return relative.every((arg) => WEB_TEST_ARG.test(arg)) ? `npm test --prefix apps/web -- ${relative.join(' ')}` : part;
}

// Models reach for familiar shell idioms. Job 402bfd7e spent its last four turns on
// "cd apps/web && npm test -- --run src/…" and handed off without running a test. Unambiguous
// Vitest/lint/build forms are rewritten to the allowlisted form; everything else is still refused.
function normalizeRunCommand(command, workspacePath = null) {
  const text = String(command ?? '').trim().replace(/\s+/g, ' ');
  const cd = text.match(/^cd (?:\.\/)?apps\/web\/?(?: &&|;) (.+)$/);
  const parts = (cd ? cd[1] : text).split(/ && /).map((part) => normalizeRunPart(part.trim(), Boolean(cd), workspacePath));
  // Dropping the cd changes what relative git paths mean, so only fully allowlisted web commands are rewritten.
  if (cd && !parts.every((part) => /--prefix apps\/web\b/.test(part) && RUN_ALLOWLIST.some((pattern) => pattern.test(part)))) return text;
  return parts.join(' && ');
}

const PRESERVE_TESTS = 'Existing tests are the repository\'s evidence and must keep passing: keep every existing test and its title, and add new tests alongside them (replace_in_file to insert; never write_file over an existing test file). If the approved behavior changes what an existing test asserts, edit that assertion in place under the same title. run {"command":"git show HEAD:<file>"} shows the pinned version.';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', 'coverage']);

function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options }).trim();
  } catch (error) {
    throw new Error(redactGitError(error && (error.stderr || error.message)));
  }
}

// A guessed path that does not exist gets the closest tracked paths back, so the model can
// recover in one step instead of cycling through extensions and directories.
function similarPaths(workspacePath, requested, cap = 8) {
  const stem = path.basename(String(requested || '')).replace(/\.[^.]+$/, '').toLowerCase();
  if (stem.length < 3) return [];
  let tracked;
  try { tracked = git(workspacePath, ['ls-files']).split('\n'); } catch { return []; }
  const wantedDir = path.dirname(String(requested || '')).toLowerCase();
  return tracked
    .filter((file) => file && path.basename(file).toLowerCase().includes(stem))
    .sort((a, b) => Number(path.dirname(b).toLowerCase() === wantedDir) - Number(path.dirname(a).toLowerCase() === wantedDir) || a.length - b.length)
    .slice(0, cap);
}

function missingPath(workspacePath, kind, normalized) {
  const suggestions = similarPaths(workspacePath, normalized);
  return suggestions.length
    ? { error: `not a ${kind}: ${normalized}`, did_you_mean: suggestions }
    : { error: `not a ${kind}: ${normalized}`, hint: 'do not guess paths; use search or list_dir to find the real one' };
}

function clip(text, cap, label = 'output') {
  const value = String(text ?? '');
  if (value.length <= cap) return value;
  return `${value.slice(0, cap)}\n[TRUNCATED: ${label} was ${value.length} chars; showing the first ${cap}. Narrow the request to see the rest.]`;
}

function boundedNumberedLines(lines, start, end, cap, label) {
  const numbered = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`);
  const full = numbered.join('\n');
  if (full.length <= cap) return { content: full, omitted_range: null };

  const headBudget = Math.floor(cap * 0.55);
  const tailBudget = Math.floor(cap * 0.35);
  const head = [];
  const tail = [];
  let headChars = 0;
  let tailChars = 0;
  let headCount = 0;
  let tailCount = 0;

  for (const line of numbered) {
    if (headChars + line.length + 1 > headBudget) break;
    head.push(line);
    headChars += line.length + 1;
    headCount++;
  }
  for (let index = numbered.length - 1; index >= headCount; index--) {
    const line = numbered[index];
    if (tailChars + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    tailChars += line.length + 1;
    tailCount++;
  }

  const omittedStart = start + headCount;
  const omittedEnd = end - tailCount;
  const marker = `[OMITTED: ${label} lines ${omittedStart}-${omittedEnd}. The real head and tail are shown; use search or read_file with that narrower range for the omitted body.]`;
  return {
    content: [...head, marker, ...tail].join('\n'),
    omitted_range: { start_line: omittedStart, end_line: omittedEnd },
  };
}

function parseToolCall(content) {
  const call = parseToolCallShape(content);
  if (call && typeof call.tool !== 'string' && typeof call.name === 'string' && (call.arguments || call.parameters)) {
    const args = typeof call.arguments === 'string' ? (() => { try { return JSON.parse(call.arguments); } catch { return null; } })() : (call.arguments || call.parameters);
    if (args && typeof args === 'object') return { thought: call.thought || '', tool: call.name, args };
  }
  return call;
}

function parseToolCallShape(content) {
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
  // Some hosted models (e.g. DeepSeek) emit their native XML call markup even when asked for JSON:
  // <tool_call name="read_file"><parameter name="path" string="true">x</parameter>…. Take only the first call.
  const xmlCall = raw.match(/<(?:tool_call|invoke|function)\s+name="([a-z][a-z0-9_]{0,63})"\s*>([\s\S]*?)(?:<\/(?:invoke|tool_call|function)>|$)/i);
  if (xmlCall) {
    const args = {};
    for (const parameter of xmlCall[2].matchAll(/<parameter\s+name="([A-Za-z_][\w]*)"([^>]*)>([\s\S]*?)<\/parameter>/g)) {
      const [, name, attributes, value] = parameter;
      if (/string="true"/.test(attributes) && !(['all', 'regex'].includes(name) && /^(true|false)$/.test(value.trim()))) { args[name] = value; continue; }
      const parsed = attempt(`{"v":${value.trim()}}`);
      args[name] = parsed ? parsed.v : value;
    }
    return { thought: '', tool: xmlCall[1], args };
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

// Declaration index for a file: where functions, exported consts, classes, types, switch cases and SQL
// objects start. Live job 118731bd spent 42 read_file turns walking a 10k-line edge function in
// 100-500 line windows and never reached an edit; one outline call is the map that walk was building.
const OUTLINE_PATTERNS = [
  /^\s{0,4}(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*/,
  /^\s{0,2}(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*/,
  /^\s{0,4}(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+[A-Za-z_$][\w$]*/,
  /^\s{0,4}(?:export\s+)?(?:default\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^()]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^\s{2,8}(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^()]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^\s*case\s+['"`][^'"`]+['"`]\s*:/,
  /^\s*(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:table|function|policy|trigger|view|index|type)\b/i,
  /^\s*(?:def|class)\s+[A-Za-z_][\w]*/,
  /^Deno\.serve|^serve\(/,
];
const OUTLINE_NOISE = /^\s*(?:if|else|for|while|switch|return|await|catch|try|do|typeof|new|throw)\b/;
// When a file has more declarations than the cap, indented variables go first, then top-level
// variables; functions, classes, types, cases and SQL objects are the skeleton and stay.
const outlinePriority = (line) => (/^\s*(?:export\s+)?(?:const|let|var)\s/.test(line) ? (/^\S/.test(line) ? 1 : 2) : 0);

function outlineLines(text, { pattern = null, cap = 400 } = {}) {
  const filter = pattern ? new RegExp(pattern, 'i') : null;
  const lines = String(text ?? '').split('\n');
  let candidates = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || OUTLINE_NOISE.test(line)) continue;
    if (!OUTLINE_PATTERNS.some((rule) => rule.test(line))) continue;
    if (filter && !filter.test(line)) continue;
    candidates.push({ index, line, priority: outlinePriority(line) });
  }
  const found = candidates.length;
  if (candidates.length > cap) {
    // Keep the whole skeleton; fill what is left of the cap with variables in file order.
    candidates = candidates.map((entry, order) => ({ ...entry, order })).sort((a, b) => a.priority - b.priority || a.order - b.order).slice(0, cap).sort((a, b) => a.index - b.index);
  }
  return { entries: candidates.map(({ index, line }) => `${index + 1}: ${line.trim().slice(0, 140)}`), total_lines: lines.length, omitted: found - candidates.length };
}

const ATLAS_RESEARCH_GUIDANCE = [
  'ATLAS IS A MAP, NOT EVIDENCE: it tells you where to go and look, not what is fact. Use it to choose research locations; then investigate those areas to establish facts. Never cite an Atlas edge, flag or reach result alone as proof of behavior, a cause, safety or completion.',
  'For an implementation question, start from the affected surface/entity in the current request. Discover exact type/name with capability_map, then inspect terrain_edges and its source_file values to locate callers, writers, access controls and downstream consumers. Confirm those paths in the current checkout; do not guess filenames or read an unrelated subsystem.',
  'Use blast_radius with the discovered name/type. Directions follow stored edges: downstream traverses source to target; upstream traverses target to source. For a component that reads a table, the table is downstream and its reader is upstream of the table. Inspect both directions as needed to find dependencies and affected consumers; do not infer impact from a direction label alone. The butterfly effect concerns potentially affected workflows, not permission to expand the task. Follow reads/writes/calls/invokes, inspect secured_by controls, and keep weak references and structural fk_reach separate from flow_reach.',
  'Atlas can lag or under-report; wired is not exercised. At each relevant mapped location, read the current owning source and schema function/trigger/policy bodies, then use authorized runtime observations or focused tests for claims about execution. Report map leads, independently verified facts and unknowns separately. Source establishes implementation, not successful live execution; a fixture test is not production evidence. If a mapped area cannot be investigated, leave its behavior unverified. An empty map is a discovery gap, not proof of absence. Record contradictions and choose the smallest check that could disconfirm your hypothesis.',
  'Before a change, identify expected behavior, dependencies and permissions; during, trace requests/writes/audit and errors; after, verify persisted and downstream outcomes. Use the affected paths to select focused regression tests. Do not walk the entire graph or every FK. Guidance-only questions may be answered from relevant cards/receipts without Atlas or source inspection.',
].join('\n');

function systemPrompt({ lane, limits, firewall = false }) {
  return [
    'You are Bob Builder, the engineering half of Bob — the Field Compliance Manager platform\'s own agent. You work the way a senior coding agent works, at full effort:',
    '1. UNDERSTAND before editing: read AGENTS.md / the canon (read_canon), your own notes (read_notes), and the code paths involved (search, read_file, list_dir, git_log), then the live terrain (atlas, live_count) for any shared table, RPC, or edge function. Trace the whole seam before changing part of it.',
    '2. PLAN the smallest correct change that fixes the root cause. Prefer editing existing files over adding new ones. Do not add features, refactors, comments, or "improvements" beyond the task.',
    '3. IMPLEMENT inside your worktree: replace_in_file for edits to existing files (exact old text -> new text; no line counting), write_file for new files or full rewrites, apply_patch only if you already hold a correct unified diff. Keep existing conventions. Never invent schema, tables, or behaviour absent from the evidence — verify with search/read_file.',
    '4. VERIFY: run the relevant tests with these exact commands: backend/root "node --test test/<file>.test.js"; web unit (Vitest) "npm test --prefix apps/web -- src/<path>.test.tsx"; web lint/types "npm run lint --prefix apps/web". Then node --check on changed JS files and read git diff. If a test fails, read the failure, fix the cause, and run again. Add or update a test when the change is testable at this layer. finish runs a compile gate on the final tree (npm run lint --prefix apps/web for apps/web TypeScript, node --check for changed JS) unless that exact check already passed after your last edit; its errors refuse the finish, so re-run the check after your last edit.',
    '4a. TESTS ARE EVIDENCE: never delete, rename, weaken or replace an existing test, and never rewrite a whole test file with write_file — add new tests next to the existing ones with replace_in_file (the tools refuse edits that drop a pinned test). apps/web/e2e/*.spec.ts are Playwright specs that only the independent verifier runs; prefer a Vitest test under apps/web/src that you can run yourself. Before adding a Playwright spec, inspect apps/web/e2e/fixtures.ts and a passing authenticated spec, reuse their setup/navigation, and use only selectors (roles, labels, text, data-testid) that exist in the component source you read — never invent a data-testid or use a bare unauthenticated page for a protected route.',
    '5. FINISH with a truthful summary. Truth Protocol: state what you verified, what you inferred, and what you could not check. Never claim a merge, deployment, migration application, or live write — none happen in this run. After the pull request merges, the release lane applies new migrations live (refusing destructive SQL), deploys changed edge functions and refreshes the catalog and Atlas; report those only from their receipts.',
    '6. PRECEDENT PARITY: when the task says "like X" or "the way X does", X is the accepted pattern. First run search {query: "X"} over the WHOLE repo: every file that wires X (tool catalogue, allowlists/gates, the pending-marker loader, the planner prompt under services/fcm-api/src/bob, tests) is a seam the new thing must be wired into as well — wire each one or list it under follow_ups by name. Copy X\'s authorization, confirmation and persistence behaviour exactly; a risk X already carries is not a reason to stop — build to parity and record the residual concern under follow_ups. You are the only engineer on this job: nobody picks up a task you decline. Decline (empty change set, no_change_reason) ONLY for a protected path, destructive SQL, secret material, or evidence that the change would break something. A design worry is a follow_up, not a refusal.',
    '7. DATA PATHS ARE CHECKED: a caller-scoped client (callerClient/userClient) reading a table whose row-level security admits only the service role returns no rows for a real user — the verifier fails such a patch. Before reading a table with the caller\'s client, search supabase/schema.sql for `CREATE POLICY ... ON "public"."<table>"`; if only service_role can see it, go through the path that verifies the caller and then reads with the service role (for Builder tables: callFn(\'bob-builder-control-room\', authHeader, { action: \'list\' }) as create_builder_job does).',
    '8. CONTINUATION: completed tool steps and edits are checkpointed outside your disposable worktree. When resumed, inspect git_diff and the recorded context; do not restart the investigation or undo prior work without evidence. A repair starts from its exact failed patch. Checkpointed work is not verified work: re-run checks before finish. Runner/resource failures are not instructions to rewrite product code; unmatched baseline failures remain unresolved, never proof that the patch is innocent.',
    '9. CODE REVIEW CORRECTIONS: confirmed_code_review_corrections is owner-confirmed feedback on THIS job, not a new specification or independently verified diagnosis. Inspect the seeded implementation and actual affected readers/writers. Correct within the approved scope, preserve unrelated behavior, and test the reported before/during/after outcome with real integration where mocks could assume away the finding. Return the complete replacement change against the pinned target. Never claim the previous verification or approval covers your revised patch.',
    ATLAS_RESEARCH_GUIDANCE,
    '',
    `LANE: ${lane}. ${lane === 'frontend' ? 'You may only change files under apps/web/. Web build/tests are run afterwards by the independent worker; keep changes type-safe and covered by the existing vitest suite where possible.' : 'You may change anything outside apps/web/ that is not protected (edge functions, services, scripts, root modules, tests, docs, ADDITIVE migrations).'}`,
    'LANE AND PATH GUARDS ARE SAFETY CONTROLS, NOT DEFECTS: if the correct fix lives outside your lane or under a protected path, finish with an empty change set and a no_change_reason that names the exact file and the lane that owns it. If an ordinary unprotected file belongs to the sibling implementation lane, also set no_change_lane:"frontend" or "backend" and no_change_file to its exact repository path to route there. Do not set no_change_lane for protected paths, unsafe tasks, missing evidence or exhausted budgets. Do not make cosmetic edits to satisfy this lane. Never edit builder-path-policy.js or any guard to get around it.',
    'PROTECTED (refused, human-only): CI workflows, deploy/, Dockerfiles and compose files, dependency manifests and lockfiles, .env and secret material, supabase/schema.sql (regenerated), auth/identity code (AuthContext, lib/supabase.ts, routing, SafetyGate, access components, _shared/auth.ts). Migrations must be NEW additive files; no destructive SQL. No arbitrary binary files: only generate_visual_baselines may replace/add Playwright PNGs. Never print, store, or move secrets.',
    '',
    'TOOLS (one call per turn; reply with ONLY a JSON object {"thought": string, "tool": string, "args": object}):',
    '- list_dir {path}                        list a directory (node_modules/.git skipped)',
    `- read_file {path, start_line?, end_line?}   read a text file (max ${limits.readCapChars} chars per call). An oversized range returns the real head AND tail with the omitted line range named; never invent the omitted body — search it or request that range.`,
    '- outline {path, pattern?}              declaration index of one file: every function/const/class/type/case/SQL object with its line number (pattern narrows it). USE THIS FIRST on any file over ~800 lines, then read_file only the ranges you need — never walk a big file window by window.',
    '- search {query, path?, regex?, context?}   git grep across the worktree (path = pathspec, e.g. "supabase/functions"); regex defaults to false; context = lines of surrounding code per hit (0-8) so a hit often needs no follow-up read',
    '- git_log {path?, limit?}               recent commits (optionally for a path)',
    '- git_diff {}                            your uncommitted changes so far',
    '- write_file {path, content}             create or overwrite a file (full content)',
    '- replace_in_file {path, old_text, new_text, all?}   PREFERRED EDIT: replace one exact occurrence of old_text (copy it verbatim from read_file, several lines is fine) with new_text; all=true replaces every occurrence. Fails safely when the text is missing or ambiguous.',
    '- apply_patch {diff}                     apply a git unified diff or a "*** Begin Patch"/"*** Update File: <path>" envelope; use replace_in_file instead when unsure',
    '- delete_file {path}                     delete a file',
    '- generate_visual_baselines {paths, reason}  frontend only: 1-6 exact apps/web/e2e/<name>.spec.ts-snapshots/<name>-desktop-chromium-linux.png (or mobile) paths. Explain intentional before/during/after behavior, not just a mismatch. Runs offline fixture tests, generates PNGs, rerenders and compares, retains private before/after images and hashes. Never use it to bless an unexplained regression or weaken assertions/tolerances. Independent verification repeats rendering. Existing release holds and HUMAN merge approval remain; no auto-merge.',
    `- run {command}                          allowed exactly: node --test test/<file>.test.js, node --check <file>, npm test --prefix apps/web -- src/<path>.test.tsx, npm run lint --prefix apps/web, npm run build --prefix apps/web, git status/diff/log/show/blame (no cd/npx/pipes) (timeout ${Math.round(limits.runTimeoutMs / 60000)} min); chain allowed commands with && (stops at the first failure). Never run npm install/ci.`,
    '- atlas {action, name?, type?, direction?, depth?, limit?}   live Atlas: capability_map (name fragment) | terrain_edges (exact name) | gap_report | blast_radius (name + type, returns flow_reach and fk_reach separately). Query it before touching shared terrain and to pick a real gap; never edit a UI fallback seed to "close" a gap.',
    '- live_count {table, column?, equals?}  aggregate live check: total rows, rows where column is set, or rows where column = equals. Counts only, never row bodies. Use it to prove a column has a writer before wiring UI to it.',
    '- read_canon {}                          AGENTS.md + docs/canon/README.md + docs/canon/BOB_DOCTRINE.md (bounded)',
    '- read_notes {limit?}                    your persistent builder notes (lessons from earlier jobs); the 10 most recent are already in your task packet',
    '- write_note {text}                      leave a durable lesson for future jobs (short, factual, no secrets)',
    ...(firewall ? [
      '- firewall_status {}                     the VPS firewall: Bob chains, ufw, Tailscale peers, worker network (bob-workers 172.31.250.0/24; your test runs have network incl. the tailnet)',
      '- firewall_change {op: add|remove, rule: {chain: input|worker_egress, action: allow|deny, protocol?, port?, source? (input), destination? (worker_egress), comment}, purpose}   applies LIVE immediately, outside the patch, and is audited (owner ruling 2026-10-21). Use it only when the task needs it (a test or service must reach / must not reach a host); name every change in your finish summary. SSH/80/443/Tailscale lockouts are refused.',
      ...(firewall.tailnet ? ['- tailnet_status {} | tailnet_acl {op: get|set, policy?, if_match?, purpose?}   Tailscale devices and ACL policy (strict JSON string). set validates first, needs the etag from get as if_match, is LIVE and audited, requires an explicit unrestricted grant to the configured owner, and preserves existing Tailscale SSH rules.'] : []),
    ] : []),
    '- finish {summary, tests, rollback_notes, acceptance_evidence, follow_ups?, tests_not_run_reason?, lessons?}   hand over: your worktree diff becomes the reviewed patch. acceptance_evidence must contain one {requirement_id, status:"completed", evidence} entry for every approved delivery requirement with source_scope in YOUR lane; evidence must name the full path of a changed file in the approved scope AND a changed regression test proving that outcome. When the evidence places the root cause in a same-lane file outside that requirement\'s source_scope (for example a shared component or hook every reported page uses), fix it there and add scope_amendment {file, reason} to that entry: file is the full changed path (also named in evidence), reason states the evidence that puts the root cause there. Amendments are shown to reviewers and the owner; never edit an unrelated scope file just to satisfy the gate. Requirements spanning both lanes need an implementation in each lane; never claim the sibling lane is complete. Whole-job reconciliation blocks review/release for ANY missing requirement, even after a lane skip. Scope conflicts require explicit specification correction, not invented requirement IDs or silently waived outcomes. A complete replacement patch must retain all required behavior from earlier corrections; retained seeds are not acceptance proof. Passing narrow tests does not prove the full workflow: exercise the actual before/during/after path and failure controls. A change that touches tests is refused unless a `node --test` (or `npm test --prefix apps/web -- <file>`) run passed in this session (or tests_not_run_reason says plainly why none could; that reason cannot satisfy whole-job acceptance). lessons: up to 3 short, generalisable facts about this codebase or these tools that would save a future job time (or omit).',
    '',
    `Budget: ${limits.maxTurns} tool turns / ${Math.round(limits.wallBudgetMs / 60000)} minutes. Pace it: spend at most about a third of the turns reading before you start editing; you will be told when the budget is running low. Do not repeat identical calls. Large files: outline first, then targeted reads — a task that names a 10,000-line file is still a 60-turn task. Requirements labelled must, required, or acceptance may not be deferred to follow_ups: complete and verify them before finish. follow_ups are only for optional improvements outside the approved acceptance contract. Running out of turns with an admitted partial change is a failure, not a successful handoff. If the task is impossible, unsafe, or requires a protected path, finish with an empty change set and explain plainly in the summary what a human must do.`,
  ].join('\n');
}

function taskPacket(input) {
  const { job, lane, specification, uxPlan, repositoryContext, liveContext, notes, previousFailure, hints, previousAttempt, seeded, startingMap } = input;
  return JSON.stringify({
    job: { title: job.title, task_description: job.task_description, description: job.description ?? null, target_sha: job.target_sha, requested_action: job.requested_action ?? null, target_environment: job.target_environment ?? null },
    lane,
    approved_product_specification: specification ?? null,
    confirmed_code_review_corrections: job.code_review_revision ?? undefined,
    reopened_required_lane: !seeded && reopenedRequiredLane(job, { step_id: `${lane}_implementation` })
      ? 'The owner\'s confirmed correction reopened this required lane after an earlier attempt skipped it as another lane\'s work. There is no previous change in this lane: build this lane\'s share of the approved delivery requirements from the pinned target, with tests. Answering that the work belongs to another lane or that nothing needs to change is not accepted and parks the job for the owner.'
      : undefined,
    ui_design_plan: lane === 'frontend' ? uxPlan ?? null : undefined,
    repository_build_map: repositoryContext ?? null,
    live_context: liveContext ?? null,
    file_hints: Array.isArray(hints) && hints.length ? hints : undefined,
    starting_map: startingMap ?? undefined,
    your_recent_notes: notes,
    previous_attempt_failed_verification: previousFailure ?? undefined,
    previous_attempt_applied: seeded ? (seeded.failed
      ? { from_job: seeded.from_job, applied: false, reason: seeded.failed, instruction: 'The previous attempt\'s change could not be applied to the current main, so you start from main. Rebuild the whole change and resolve the review findings.' }
      : { from_job: seeded.from_job, applied: true, files: seeded.files, instruction: 'The previous attempt\'s verified change is ALREADY in your worktree (these files; git_diff shows the full diff). This is a REVISION: read the review findings in the task, read the changed code, and fix the findings in place. Do not rebuild it from scratch, do not remove it, and keep the tests it added passing.' }) : undefined,
    previous_attempt_ran_out_of_turns: previousAttempt ? {
      ...previousAttempt,
      instruction: 'The previous attempt spent its whole budget reading and edited nothing. Its reading map is above: the files and line ranges it read, the searches it ran, and what it concluded. Do not repeat that walk. Use outline on the big files, read only the ranges you need for the FIRST edit, and make that edit by turn 12. Land the smallest correct, tested slice; list what is left under follow_ups. If the previous attempt stopped over a design or security worry, build to the precedent the task names and put the worry under follow_ups — declining again leaves the owner with nothing.',
    } : undefined,
    how_to_start: seeded && !seeded.failed
      ? 'Call read_notes once, then git_diff to see the previous attempt\'s change, then go straight to the review findings: outline/read only what each finding touches, fix it, run the tests, finish.'
      : previousAttempt
      ? 'Skip read_canon. Call read_notes once, outline the main file named in the reading map, then edit.'
      : 'Call read_canon and read_notes once. Start from starting_map: outline its confirmed, Atlas and discovered files (never a named_but_missing path), check the Atlas data edges for the tables/RPCs they touch, then read only what the first edit needs. Finish only after your own test run passes or you can explain exactly why it cannot run here.',
  }, null, 0);
}

// The opening packet must fit the smallest local window on turn 1, when there is no transcript to compact:
// the unfitted build map alone (2000 paths, every schema name) blew past the 40k-token VPS window and every
// in-house provider was skipped on a 413 (job c00059ca, 2026-09-27). Fit the build map to the task, cap the
// live context, and shrink until system prompt plus packet fits the laptop's 24k window as well.
function buildOpeningPacket({ job, lane, specification, uxPlan, rawRepositoryContext, liveContext, notes, previousFailure, hints, previousAttempt, seeded, startingMap = null, budgetChars = Number(process.env.BOB_BUILDER_PACKET_MAX_CHARS || 28_000) }) {
  const taskText = `${job.title ?? ''} ${job.task_description ?? ''} ${JSON.stringify(specification ?? '')}`;
  const liveText = liveContext ? JSON.stringify(liveContext) : '';
  const boundedLiveContext = !liveContext ? null : liveText.length <= 12_000 ? liveContext : { truncated_live_context: `${liveText.slice(0, 12_000)}…`, note: 'live context trimmed to fit the model window' };
  let repositoryContext = null;
  let packet = '';
  for (const budget of [40_000, 20_000, 10_000, 4_000]) {
    repositoryContext = rawRepositoryContext ? fitRepositoryContext(JSON.parse(JSON.stringify(rawRepositoryContext)), taskText, budget) : null;
    packet = taskPacket({ job, lane, specification, uxPlan, repositoryContext, liveContext: boundedLiveContext, notes, previousFailure, hints, previousAttempt, seeded, startingMap });
    if (packet.length <= budgetChars) break;
  }
  return { packet, repositoryContext, liveContext: boundedLiveContext };
}

// What an attempt that ran out of turns learned, in a shape the next attempt can start from.
function readingMap(transcript) {
  const files = new Map();
  const searches = [];
  const outlines = [];
  for (const entry of transcript) {
    if (!entry.tool || !entry.args) continue;
    if (entry.tool === 'read_file' && entry.args.path) {
      const ranges = files.get(entry.args.path) || [];
      ranges.push(entry.args.start_line || entry.args.end_line ? `${entry.args.start_line ?? 1}-${entry.args.end_line ?? 'end'}` : 'all');
      files.set(entry.args.path, ranges);
    } else if (entry.tool === 'outline' && entry.args.path) {
      outlines.push(entry.args.path);
    } else if (entry.tool === 'search' && entry.args.query) {
      searches.push(`${String(entry.args.query).slice(0, 120)}${entry.args.path ? ` in ${entry.args.path}` : ''}`);
    }
  }
  return {
    files_read: [...files.entries()].slice(0, 40).map(([file, ranges]) => ({ path: file, ranges: ranges.slice(0, 30) })),
    files_outlined: outlines.slice(0, 20),
    searches: [...new Set(searches)].slice(0, 40),
  };
}

// A no_change that arrives after most of the budget went on reading is not an answer ("nothing to
// do"); it is the budget failing. Live job 118731bd: 42 reads, 11 searches, 60 turns, zero edits,
// then "cannot complete within the remaining budget" — parked as if the task were impossible.
function classifyNoChange({ reason, turns, transcript, limits }) {
  const exploring = transcript.filter((entry) => ['read_file', 'search', 'outline', 'list_dir', 'git_log', 'atlas', 'live_count'].includes(entry.tool)).length;
  const lateFinish = turns >= Math.ceil(limits.maxTurns * 0.5);
  const mentionsBudget = /\b(budget|turns?|remaining|ran out|could not (?:complete|finish)|cannot be completed)\b/i.test(String(reason || ''));
  return exploring >= 8 && (lateFinish || mentionsBudget);
}

function summariseUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    if (typeof usage[key] === 'number') total[key] = (total[key] || 0) + usage[key];
  }
  return total;
}

/** One factual line per run for bob_self_memory: what happened, where the tools fought back, what the model learned. */
function composeRunNote({ job, lane, outcome, transcript, turns, provider, model, lessons = [] }) {
  const friction = {};
  let finishRefused = null;
  let lastTool = null;
  for (const entry of transcript) {
    if (entry.tool) lastTool = entry.tool;
    if (entry.result?.error && lastTool && lastTool !== 'finish') friction[lastTool] = (friction[lastTool] || 0) + 1;
    if (entry.finish_refused && !finishRefused) finishRefused = String(entry.finish_refused).slice(0, 160);
  }
  const frictionText = Object.entries(friction).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([tool, count]) => `${tool} failed x${count}`).join(', ');
  const files = outcome.ok ? (outcome.proposal?.changed_files || []).slice(0, 8).join(', ') : '';
  const result = outcome.ok ? 'proposal handed over' : outcome.no_change ? `${outcome.budget_exhausted ? 'ran out of turns reading, no edits' : 'no change'}: ${String(outcome.error).slice(0, 200)}` : `failed: ${String(outcome.error).slice(0, 200)}`;
  const cleanLessons = lessons.map((l) => String(l).trim()).filter(Boolean).slice(0, 3).map((l) => l.slice(0, 300));
  const parts = [
    `[job ${String(job.id).slice(0, 8)} ${lane}] "${String(job.title || '').slice(0, 100)}" -> ${result}.`,
    `${turns} turns on ${provider}/${model}.`,
    frictionText ? `Friction: ${frictionText}.` : null,
    finishRefused ? `Finish refused once: ${finishRefused}.` : null,
    files ? `Files: ${files}.` : null,
    cleanLessons.length ? `Lessons: ${cleanLessons.join(' | ')}` : null,
  ].filter(Boolean);
  return parts.join(' ').slice(0, 1800);
}

// Every turn re-sends the whole conversation, so a 25-turn job with a few 60k-char file reads
// costs ~1.6M prompt tokens. Recent turns stay verbatim; older bulky tool results and full-file
// write payloads are collapsed to a head + a pointer (the model can re-read a file if it needs it).
function compactExcerpt(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const marker = `...[compacted ${text.length - maxChars} chars]...`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.65);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

function compactValue(value, stringChars, depth = 0) {
  if (typeof value === 'string') return compactExcerpt(value, stringChars);
  if (depth >= 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((entry) => compactValue(entry, stringChars, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 48).map(([key, entry]) => [key, compactValue(entry, stringChars, depth + 1)]));
}

function compactMessageContent(message, maxChars) {
  try {
    const parsed = JSON.parse(message.content);
    let stringChars = Math.max(64, Math.floor(maxChars / 5));
    for (let attempt = 0; attempt < 6; attempt++) {
      const content = JSON.stringify(compactValue(parsed, stringChars));
      if (content.length <= maxChars) return content;
      stringChars = Math.max(32, Math.floor(stringChars / 2));
    }
  } catch { /* compact plain text below */ }
  return compactExcerpt(message.content, maxChars);
}

function compactMessages(messages, { keepRecent = 6, stubChars = 600, threshold = 1500, maxChars = Infinity } = {}) {
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
  const fitted = [system, task, ...compacted];
  const size = () => fitted.reduce((total, message) => total + String(message.content ?? '').length, 0);
  let attempts = 0;
  while (size() > maxChars && attempts++ < 128) {
    const candidates = fitted.map((message, index) => ({ message, index, length: String(message.content ?? '').length }))
      .filter((entry) => entry.index >= 2 && entry.length > 128)
      .sort((a, b) => b.length - a.length || a.index - b.index);
    const largest = candidates[0];
    if (largest) {
      const excess = size() - maxChars;
      const target = Math.max(128, largest.length - excess - 64);
      const content = compactMessageContent(largest.message, target);
      if (content.length < largest.length) {
        fitted[largest.index] = { ...largest.message, content };
        continue;
      }
    }
    if (fitted.length > 4) fitted.splice(2, 2);
    else break;
  }
  return fitted;
}

// Codex/gpt-oss models emit the "*** Begin Patch / *** Update File:" envelope, which git apply
// rejects as "No valid patches in input" (Vibe session cb3630ca lost its last turn to exactly that).
function isEnvelopePatch(text) {
  return /^\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/m.test(text);
}

const ENVELOPE_EOF = Symbol('end-of-file');
// When old_text misses, show the model the real text where its first recognisable line sits, so the
// retry copies verbatim instead of guessing again (Vibe 11f20384: four guessed misses in a row).
function closestSourceSpan(current, needle, maxLines = 30, maxChars = 4000) {
  const fileLines = current.split('\n');
  const trimmedFile = fileLines.map((line) => line.trim());
  const needleLines = needle.split('\n');
  for (let index = 0; index < needleLines.length; index++) {
    const probe = needleLines[index].trim();
    if (probe.length < 8) continue;
    const hits = [];
    for (let line = 0; line < trimmedFile.length && hits.length < 2; line++) if (trimmedFile[line] === probe) hits.push(line);
    if (hits.length !== 1) continue;
    const anchor = hits[0];
    // The window always contains the anchor line, even when it sits deep inside a long old_text.
    const start = Math.max(0, anchor - index, anchor - (maxLines - 1));
    const end = Math.min(fileLines.length, start + Math.min(maxLines, needleLines.length + 4), anchor + maxLines);
    const numbered = fileLines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`);
    let content = numbered.join('\n');
    if (content.length > maxChars) {
      // Keep whole lines up to and including the anchor; without the anchor the hint would mislead.
      const upToAnchor = numbered.slice(0, anchor - start + 1).join('\n');
      if (upToAnchor.length > maxChars) return null;
      let kept = anchor - start + 1;
      while (kept < numbered.length && numbered.slice(0, kept + 1).join('\n').length <= maxChars) kept++;
      content = numbered.slice(0, kept).join('\n');
    }
    return { start_line: start + 1, matched_line: anchor + 1, end_line: start + content.split('\n').length, content };
  }
  return null;
}

const NO_OP_EDIT = 'no-op edit refused: new_text produces exactly the current file, so nothing changed. read_file the exact lines you need to change and send the real new text.';

function parseEnvelopePatch(text) {
  const ops = [];
  let op = null;
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    let match;
    if (/^\*\*\* (?:Begin|End) Patch\s*$/.test(line)) { op = null; continue; }
    if ((match = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/))) {
      op = { kind: match[1].toLowerCase(), path: match[2], moveTo: null, lines: [] };
      ops.push(op);
      continue;
    }
    if (op && (match = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/))) { op.moveTo = match[1]; continue; }
    if (/^\*\*\* End of File\s*$/.test(line)) { if (op) op.lines.push(ENVELOPE_EOF); continue; }
    if (op) op.lines.push(line);
  }
  return ops;
}

function envelopeChunks(lines) {
  const chunks = [];
  let chunk = null;
  for (const line of lines) {
    if (line === ENVELOPE_EOF) { if (chunk) chunk.eof = true; continue; }
    if (line.startsWith('@@')) {
      chunk = { anchor: line.replace(/^@@+\s?/, '').replace(/\s?@@+$/, '').trim(), old: [], next: [], eof: false };
      chunks.push(chunk);
      continue;
    }
    if (!chunk) { chunk = { anchor: '', old: [], next: [], eof: false }; chunks.push(chunk); }
    if (line.startsWith('-')) chunk.old.push(line.slice(1));
    else if (line.startsWith('+')) chunk.next.push(line.slice(1));
    else {
      const context = line.startsWith(' ') ? line.slice(1) : line;
      chunk.old.push(context);
      chunk.next.push(context);
    }
  }
  // A trailing blank line is usually the patch's own terminator, not source context.
  for (const item of chunks) {
    while (item.old.length && item.next.length && item.old.at(-1) === '' && item.next.at(-1) === '') { item.old.pop(); item.next.pop(); }
  }
  return chunks.filter((item) => item.old.length || item.next.length);
}

// Matches only at or after `from`: hunks are ordered, so jumping back would edit the wrong block.
function findLineBlock(source, block, from, atEof = false) {
  const end = source.at(-1) === '' ? source.length - 1 : source.length;
  const comparators = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim()];
  for (const same of comparators) {
    const first = atEof ? Math.max(from, end - block.length) : from;
    for (let index = first; index + block.length <= end; index++) {
      if (block.every((line, offset) => same(source[index + offset], line))) return index;
    }
  }
  return -1;
}

function applyEnvelopeUpdate(content, lines, file) {
  const source = content.split('\n');
  let cursor = 0;
  for (const [number, chunk] of envelopeChunks(lines).entries()) {
    if (chunk.anchor) {
      const anchorAt = source.findIndex((line, index) => index >= cursor && line.includes(chunk.anchor));
      if (anchorAt < 0) return { error: `hunk ${number + 1} for ${file}: anchor ${JSON.stringify(chunk.anchor)} was not found after the previous hunk` };
      cursor = chunk.old.length ? anchorAt : anchorAt + 1;
    }
    if (!chunk.old.length) {
      const end = source.at(-1) === '' ? source.length - 1 : source.length;
      const at = chunk.anchor && !chunk.eof ? cursor : end;
      source.splice(at, 0, ...chunk.next);
      cursor = at + chunk.next.length;
      continue;
    }
    const at = findLineBlock(source, chunk.old, cursor, chunk.eof);
    if (at < 0) return { error: `hunk ${number + 1} for ${file} did not match${chunk.eof ? ' at end of file' : ''}; first expected line: ${JSON.stringify(chunk.old.find((line) => line.trim()) ?? '')}` };
    source.splice(at, chunk.old.length, ...chunk.next);
    cursor = at + chunk.next.length;
  }
  return { content: source.join('\n') };
}

function createTools({ workspacePath, repoRoot, lane, supabase, limits, log, generateBaselines = generateVisualBaselines }) {
  const generatedBaselines = new Map();
  // First-hand evidence of what Bob actually executed (not what he says he ran).
  const runs = [];
  // Content hash of every changed file, so a passing check is only trusted for the exact tree it ran on.
  const worktreeFingerprint = () => {
    const hash = crypto.createHash('sha256');
    let files = [];
    try { files = changedFiles().sort(); } catch { return null; }
    for (const file of files) {
      hash.update(`${file}\0`);
      try { hash.update(fs.readFileSync(path.join(workspacePath, file))); } catch { hash.update('<absent>'); }
      hash.update('\0');
    }
    return hash.digest('hex');
  };
  const run = (command) => {
    const text = String(command ?? '').trim();
    if (/^npm (?:run test|test) --prefix apps\/web -- /.test(text) && /(?:^|[\s/])e2e\//.test(text)) {
      return { error: 'Wrong test runner: e2e/ specs use Playwright, not Vitest. Use human_test in Vibe or the browser verification worker. Do not rewrite Playwright imports or assertions to make Vitest load them.' };
    }
    if (/^npm (?:i|install)\b/.test(text)) {
      return { error: 'command not allowed in this lane: dependency installation is blocked; use the allowlisted npm run/npm test commands and report missing tooling as a workspace issue' };
    }
    if (!RUN_ALLOWLIST.some((pattern) => pattern.test(text))) return { error: RUN_REFUSED };
    const argv = text.match(/"[^"]*"|\S+/g).map((part) => part.replace(/^"|"$/g, ''));
    const started = Date.now();
    const fingerprint = worktreeFingerprint();
    // A nested `node --test` inherits the parent test-runner context and misreports; give the child a clean runner env.
    // The child never sees the control plane's own secrets or port.
    const { NODE_TEST_CONTEXT: _testContext, NODE_OPTIONS: _nodeOptions, PORT: _port, BOB_ADMIN_TOKEN: _admin, BOB_RUNNER_TOKEN: _runner, BOB_MODEL_GATEWAY_TOKEN: _gw, SUPABASE_SERVICE_ROLE_KEY: _srk, OPENAI_API_KEY: _oai, GITEA_TOKEN: _gitea, GITHUB_TOKEN: _gh, ...childEnv } = process.env;
    // Asynchronous: a full test suite can run for a minute, and a blocked event loop would stall
    // the control plane's own HTTP server (health, model gateway) for that long.
    return new Promise((resolve) => {
      const webTest = /^npm (?:run test|test) --prefix apps\/web -- /.test(text);
      // `tsc --noEmit` on apps/web needs more than V8's ~1 GB container default (frontend-worker NODE_OPTIONS).
      const webTypecheck = /^npm run (?:lint|build) --prefix apps\/web$/.test(text);
      const child = spawn(argv[0], argv.slice(1), {
        cwd: workspacePath,
        env: { ...childEnv, ...(webTest ? { NODE_ENV: 'test' } : {}), ...(webTypecheck ? { NODE_OPTIONS: '--max-old-space-size=2048' } : {}), CI: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const cap = 64 * 1024 * 1024;
      child.stdout.on('data', (chunk) => { if (stdout.length < cap) stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { if (stderr.length < cap) stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, limits.runTimeoutMs);
      const finish = (status, spawnError) => {
        clearTimeout(timer);
        runs.push({ command: text, exit_code: status, at: new Date(started).toISOString(), duration_ms: Date.now() - started, fingerprint, timed_out: timedOut });
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
    if (baselineInfo(file)) {
      const receipt = generatedBaselines.get(file);
      let evidence;
      try { evidence = pngEvidence(workspacePath, file, { optional: true }); }
      catch (error) { return `${file}: ${error.message}; regenerate with generate_visual_baselines`; }
      if (!receipt || evidence?.sha256 !== receipt.sha256) {
        return `${file}: use generate_visual_baselines to generate or reverify this exact PNG before handoff`;
      }
    }
    return null;
  };

  // Pre-handoff compile gate: Bob may not hand the independent verifier a patch that does not type-check
  // or parse. A check that passed on this exact tree is reused; otherwise it runs here, and its errors go
  // back to the author as a refused finish (job 34382d60 handed off a duplicate identifier that failed the
  // verifier). A check that could not run (missing toolchain, timeout, OOM) is reported, not treated as a
  // code defect; the independent verifier still repeats every check.
  const compileGate = async (files) => {
    const current = worktreeFingerprint();
    const passedOnThisTree = (pattern) => current !== null && runs.some((entry) => entry.exit_code === 0 && entry.fingerprint === current && pattern.test(entry.command));
    const checks = [];
    const webTypeScript = files.filter((file) => /^apps\/web\/.+\.(?:tsx?|mts|cts)$/.test(file));
    // `build` (tsc -b) covers only apps/web/src; `lint` also checks the e2e project. A build pass stands in
    // for lint only when every changed TypeScript file is under src.
    const typeCheckPassed = passedOnThisTree(/^npm run lint --prefix apps\/web$/)
      || (webTypeScript.every((file) => file.startsWith('apps/web/src/')) && passedOnThisTree(/^npm run build --prefix apps\/web$/));
    if (webTypeScript.length && !typeCheckPassed) {
      checks.push('npm run lint --prefix apps/web');
    }
    // Every changed JavaScript file is syntax-checked, whichever lane owns it (apps/web/scripts/*.cjs too).
    for (const file of files) {
      if (!/^[A-Za-z0-9_./-]+\.(?:js|mjs|cjs)$/.test(file)) continue;
      if (!fs.existsSync(path.join(workspacePath, file))) continue;
      const command = `node --check ${file}`;
      if (!passedOnThisTree(new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))) checks.push(command);
    }
    const failures = [];
    const unavailable = [];
    for (const command of checks.slice(0, 25)) {
      const result = await run(command);
      if (result.exit_code === 0) continue;
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      const typeErrors = output.split('\n').filter((line) => /error TS\d+/.test(line));
      const syntaxError = /^node --check /.test(command) && /SyntaxError/.test(output);
      // Only recognisable compiler output is the author's to fix; a missing toolchain, timeout or OOM is not.
      if (!typeErrors.length && !syntaxError) {
        unavailable.push({ command, reason: clip(redactGitError(result.error || (result.timed_out ? 'timed out' : output.trim().split('\n').slice(-3).join(' ') || `exit ${result.exit_code}`)), 300) });
        continue;
      }
      failures.push({ command, exit_code: result.exit_code, errors: clip(typeErrors.length ? typeErrors.slice(0, 40).join('\n') : output.trim(), 6000) });
    }
    return { ran: checks.slice(0, 25), failures, unavailable };
  };
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

  const snapshotPath = (file) => {
    const absolute = path.resolve(workspacePath, file);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return { file, absolute, link: fs.readlinkSync(absolute), content: null, mode: null };
    return { file, absolute, content: stat?.isFile() ? fs.readFileSync(absolute) : null, mode: stat?.isFile() ? stat.mode : null };
  };
  const restorePath = ({ absolute, link, content, mode }) => {
    fs.rmSync(absolute, { force: true });
    if (link !== undefined) { fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.symlinkSync(link, absolute); return; }
    if (content === null) return;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    fs.chmodSync(absolute, mode);
  };
  const pinnedTestSource = (file) => {
    if (!TEST_SOURCE.test(file)) return null;
    try { return git(workspacePath, ['show', `HEAD:${file}`]); } catch { return null; }
  };
  // Refuses an edit that drops a test present at the pinned commit and still present in the worktree.
  const testPreservation = (file, next, current = undefined) => {
    const pinned = pinnedTestSource(file);
    if (pinned == null) return null;
    const absolute = path.resolve(workspacePath, file);
    const now = current !== undefined ? current : fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
    const dropped = droppedPinnedTests({ pinned, current: now ?? '', next: next ?? '' });
    return dropped.length ? `refused: ${droppedTestsMessage(file, dropped)}. ${PRESERVE_TESTS}` : null;
  };

  return {
    async generate_visual_baselines({ paths, reason }) {
      if (lane === 'backend') return { error: 'Visual baselines belong to the frontend lane' };
      const result = await generateBaselines({ workspacePath, paths, reason });
      for (const item of result.receipt.after) generatedBaselines.set(item.path, item);
      log({ visual_baselines: result });
      return result;
    },
    list_dir({ path: dir = '.' }) {
      const { normalized, absolute } = !dir || dir === '.' || dir === './'
        ? { normalized: '.', absolute: path.resolve(workspacePath) }
        : resolveInside(workspacePath, dir);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) return missingPath(workspacePath, 'directory', normalized);
      const entries = fs.readdirSync(absolute, { withFileTypes: true }).filter((entry) => !SKIP_DIRS.has(entry.name)).slice(0, limits.listCapEntries)
        .map((entry) => `${entry.isDirectory() ? entry.name + '/' : entry.name}`).sort();
      return { path: normalized, entries };
    },
    read_file({ path: file, start_line, end_line }) {
      const { normalized, absolute } = resolveInside(workspacePath, file);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return missingPath(workspacePath, 'file', normalized);
      const buffer = fs.readFileSync(absolute);
      if (looksBinary(buffer)) return { error: `binary file: ${normalized}` };
      const lines = buffer.toString('utf8').split('\n');
      const start = Math.max(1, Number(start_line) || 1);
      const end = Math.min(lines.length, Number(end_line) || lines.length);
      const bounded = boundedNumberedLines(lines, start, end, limits.readCapChars, normalized);
      return { path: normalized, total_lines: lines.length, start_line: start, end_line: end, content: bounded.content, omitted_range: bounded.omitted_range ?? undefined };
    },
    outline({ path: file, pattern }) {
      const { normalized, absolute } = resolveInside(workspacePath, file);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return missingPath(workspacePath, 'file', normalized);
      const buffer = fs.readFileSync(absolute);
      if (looksBinary(buffer)) return { error: `binary file: ${normalized}` };
      let filter = null;
      if (pattern) {
        try { filter = String(pattern); new RegExp(filter, 'i'); } catch { return { error: `pattern is not a valid regular expression: ${String(pattern).slice(0, 100)}` }; }
      }
      const { entries, total_lines, omitted } = outlineLines(buffer.toString('utf8'), { pattern: filter, cap: limits.listCapEntries });
      return { path: normalized, total_lines, entries, omitted: omitted || undefined, hint: omitted ? `${omitted} variable declarations were left out to fit; pass pattern to narrow. read_file the line ranges you need; search with context for call sites` : 'read_file the line ranges you need; search with context for call sites' };
    },
    search({ query, path: pathspec, regex, context }) {
      if (!query || typeof query !== 'string') return { error: 'query is required' };
      // Models pass several pathspecs at once ("services/fcm-api/src/bob test"); honour each one.
      const pathspecs = (Array.isArray(pathspec) ? pathspec : String(pathspec ?? '').split(/[\s,]+/))
        .map((value) => normalizeRepoPath(value)).filter(Boolean);
      const around = Math.min(8, Math.max(0, Number(context) || 0));
      const args = ['grep', '-n', '-I', regex ? '-E' : '-F', ...(around ? [`-C${around}`] : []), '-e', query, '--', ...(pathspecs.length ? pathspecs : ['.'])];
      const result = spawnSync('git', args, { cwd: workspacePath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      // git grep: 0 = matches, 1 = no matches, anything else is a real error.
      if (result.status !== 0 && result.status !== 1) return { error: clip(redactGitError(result.stderr || result.error?.message || `git grep exited ${result.status}`), 500) };
      const lines = String(result.stdout || '').split('\n').filter(Boolean);
      const cap = around ? limits.searchCapLines * 2 : limits.searchCapLines;
      return { query, paths: pathspecs, context: around || undefined, matches: lines.length, results: lines.slice(0, cap), truncated: lines.length > cap };
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
      if (baselineInfo(normalized)) return { error: 'Use generate_visual_baselines, not text writes, for PNG baselines' };
      const violation = policyCheck(normalized);
      if (violation) return { error: `refused: ${violation}` };
      if (typeof content !== 'string') return { error: 'content must be a string' };
      if (isMigrationPath(normalized) && fs.existsSync(absolute)) return { error: `refused: ${normalized} exists; migrations may only be added as new files` };
      const droppedTests = testPreservation(normalized, content);
      if (droppedTests) return { error: droppedTests };
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return { path: normalized, bytes: Buffer.byteLength(content) };
    },
    // Exact-text replacement: the edit models get right far more often than unified-diff hunks
    // (job 1021dbaa burned 3 x 40 turns on "corrupt patch" / "does not apply").
    replace_in_file({ path: file, old_text, new_text, all = false }) {
      const { normalized, absolute } = resolveInside(workspacePath, file);
      if (baselineInfo(normalized)) return { error: 'Use generate_visual_baselines, not text edits, for PNG baselines' };
      const violation = policyCheck(normalized);
      if (violation) return { error: `refused: ${violation}` };
      if (typeof old_text !== 'string' || !old_text.length) return { error: 'old_text is required (copy it verbatim from read_file)' };
      if (typeof new_text !== 'string') return { error: 'new_text must be a string (use "" to delete the text)' };
      if (isMigrationPath(normalized)) return { error: `refused: ${normalized} is a migration; migrations may only be added as new files` };
      if (!fs.existsSync(absolute)) return { error: `not found: ${normalized}` };
      const current = fs.readFileSync(absolute, 'utf8');
      const occurrences = current.split(old_text).length - 1;
      if (occurrences === 0) {
        // Small local models copy read_file's "12: " prefixes or reflow long one-line rules. Accept
        // that only when the whitespace-insensitive text identifies exactly one source span (or all=true).
        const numbered = /^\s*\d+: /;
        const lines = old_text.split('\n');
        const unnumber = (text) => text.split('\n').map((line) => line.replace(numbered, '')).join('\n');
        const prefixed = lines.filter((line) => line.trim()).every((line) => numbered.test(line));
        const needle = prefixed ? unnumber(old_text) : old_text;
        const replacement = prefixed && new_text.split('\n').filter((line) => line.trim()).every((line) => numbered.test(line)) ? unnumber(new_text) : new_text;
        const tokens = needle.trim().split(/\s+/).filter(Boolean);
        const spans = tokens.length ? [...current.matchAll(new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g'))] : [];
        if (spans.length === 1 || (spans.length > 1 && all)) {
          let updated = '';
          let cursor = 0;
          for (const span of spans) {
            updated += current.slice(cursor, span.index) + replacement;
            cursor = span.index + span[0].length;
          }
          updated += current.slice(cursor);
          if (updated === current) return { error: NO_OP_EDIT };
          const droppedNormalized = testPreservation(normalized, updated, current);
          if (droppedNormalized) return { error: droppedNormalized };
          fs.writeFileSync(absolute, updated);
          return { path: normalized, replaced: spans.length, bytes: Buffer.byteLength(updated), matched: prefixed ? 'line_numbers_and_whitespace_normalized' : 'whitespace_normalized' };
        }
        if (spans.length > 1) return { error: `old_text matches ${spans.length} places in ${normalized} after whitespace normalization; include more surrounding text to make it unique, or pass all=true` };
        const closest = closestSourceSpan(current, needle);
        if (closest) {
          return {
            error: `old_text not found in ${normalized}, but one of its lines matches source line ${closest.matched_line}. closest_match holds the real text of lines ${closest.start_line}-${closest.end_line} (line numbers are not part of the file): copy old_text verbatim from it.`,
            closest_match: closest,
          };
        }
        return {
          error: `old_text not found in ${normalized}. Do not retry guessed source text: use search for a real nearby symbol/class, then read_file that exact line range and copy old_text verbatim.`,
        };
      }
      if (occurrences > 1 && !all) return { error: `old_text occurs ${occurrences} times in ${normalized}; include more surrounding lines to make it unique, or pass all=true` };
      const updated = all ? current.split(old_text).join(new_text) : current.replace(old_text, () => new_text);
      if (updated === current) return { error: NO_OP_EDIT };
      const droppedTests = testPreservation(normalized, updated, current);
      if (droppedTests) return { error: droppedTests };
      fs.writeFileSync(absolute, updated);
      return { path: normalized, replaced: all ? occurrences : 1, bytes: Buffer.byteLength(updated) };
    },
    apply_patch({ diff }) {
      if (typeof diff !== 'string' || !diff.trim()) return { error: 'diff is required' };
      if (/GIT binary patch|Binary files .* differ/m.test(diff)) return { error: 'Use generate_visual_baselines; model-authored binary patches are refused' };
      const before = new Set(changedFiles());
      // Models wrap diffs in fences and miscount hunk lengths; tolerate both before asking for a rewrite.
      const text = diff.replace(/^\s*```(?:diff|patch)?\s*\n/, '').replace(/\n```\s*$/, '');
      if (isEnvelopePatch(text)) {
        const ops = parseEnvelopePatch(text);
        if (!ops.length) return { error: 'patch did not apply: the *** Begin Patch envelope names no file. Use "*** Update File: <path>" sections, or replace_in_file.' };
        // Plan every op against a virtual tree so later ops see earlier ones and a bad hunk touches nothing.
        const virtual = new Map();
        const exists = (file) => (virtual.has(file) ? virtual.get(file).content !== null : fs.existsSync(path.join(workspacePath, file)));
        const read = (file) => (virtual.has(file) ? virtual.get(file).content : fs.readFileSync(path.join(workspacePath, file), 'utf8'));
        const blocker = (file) => {
          const absolute = path.join(workspacePath, file);
          if (fs.existsSync(absolute) && !fs.statSync(absolute).isFile()) return `${file} is not a regular file`;
          for (let dir = path.dirname(absolute); dir.startsWith(workspacePath) && dir !== workspacePath; dir = path.dirname(dir)) {
            if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) return `${path.relative(workspacePath, dir)} is a file, so ${file} cannot be created`;
          }
          return null;
        };
        for (const op of ops) {
          const { normalized, absolute } = resolveInside(workspacePath, op.path);
          const target = op.moveTo ? resolveInside(workspacePath, op.moveTo) : null;
          for (const file of [normalized, target?.normalized].filter(Boolean)) {
            if (baselineInfo(file)) return { error: 'Use generate_visual_baselines; model-authored binary patches are refused' };
            const violation = policyCheck(file);
            if (violation) return { error: `refused: ${violation}` };
            if (isMigrationPath(file) && (op.kind !== 'add' || fs.existsSync(path.join(workspacePath, file)))) return { error: `refused: ${file} is a migration; migrations may only be added as new files` };
            const problem = blocker(file);
            if (problem) return { error: `patch did not apply: ${problem}` };
          }
          if (op.kind === 'add') {
            if (exists(normalized)) return { error: `patch did not apply: ${normalized} already exists; use "*** Update File:" or write_file` };
            virtual.set(normalized, { absolute, content: `${op.lines.filter((line) => line !== ENVELOPE_EOF).map((line) => line.replace(/^\+/, '')).join('\n').replace(/\n*$/, '')}\n` });
            continue;
          }
          if (!exists(normalized)) return { error: `patch did not apply: not found: ${normalized}` };
          if (op.kind === 'delete') { virtual.set(normalized, { absolute, content: null }); continue; }
          const updated = applyEnvelopeUpdate(read(normalized), op.lines, normalized);
          if (updated.error) return { error: `patch did not apply: ${updated.error}. Read the current file (exact lines) and send replace_in_file with verbatim old_text, or write_file with the full content.` };
          if (target && target.normalized !== normalized) {
            if (exists(target.normalized)) return { error: `patch did not apply: move destination ${target.normalized} already exists` };
            virtual.set(normalized, { absolute, content: null });
            virtual.set(target.normalized, { absolute: target.absolute, content: updated.content });
          } else virtual.set(normalized, { absolute, content: updated.content });
        }
        for (const [file, { content }] of virtual) {
          const droppedTests = testPreservation(file, content ?? '');
          if (droppedTests) return { error: `patch ${droppedTests}` };
        }
        const originals = [...virtual.values()].map(({ absolute }) => ({ absolute, content: fs.existsSync(absolute) ? fs.readFileSync(absolute) : null }));
        try {
          for (const { absolute, content } of virtual.values()) {
            if (content === null) fs.rmSync(absolute, { force: true });
            else { fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content); }
          }
        } catch (error) {
          for (const { absolute, content } of originals) {
            try {
              if (content === null) fs.rmSync(absolute, { force: true });
              else { fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content); }
            } catch { /* best-effort restore; the original error is reported below */ }
          }
          return { error: `patch did not apply: ${error.message}; the worktree was restored` };
        }
        return { applied: true, format: 'envelope', changed_files: changedFiles() };
      }
      const patchPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bob-agent-patch-')), 'patch.diff');
      const strategies = [[], ['--recount'], ['--recount', '--ignore-whitespace']];
      // Touched paths come from git's own parse (any a/ b/ i/ w/ prefix, renames, mode-only changes),
      // so a refused patch is restored in full rather than only where its header text matched a regex.
      let touched = [];
      let failure = '';
      try {
        fs.writeFileSync(patchPath, text.endsWith('\n') ? text : `${text}\n`);
        let applied = false;
        for (const flags of strategies) {
          try {
            git(workspacePath, ['apply', '--check', '--whitespace=nowarn', ...flags, patchPath]);
            touched = patchTouchedPaths(workspacePath, flags, patchPath).map(snapshotPath);
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
      const droppedTests = touched.filter(({ file }) => TEST_SOURCE.test(file))
        .map(({ file, absolute, content }) => testPreservation(file, fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '', content === null ? '' : content.toString('utf8'))).filter(Boolean);
      if (droppedTests.length) {
        touched.forEach(restorePath);
        return { error: `patch ${droppedTests[0]} (the whole patch was reverted)` };
      }
      const violations = changedFiles().filter((file) => !before.has(file)).map((file) => policyCheck(file)).filter(Boolean);
      for (const violation of violations) revertPath(violation.split(':')[0]);
      return violations.length ? { error: `patch touched refused paths (reverted): ${violations.join('; ')}` } : { applied: true, changed_files: changedFiles() };
    },
    delete_file({ path: file }) {
      const { normalized, absolute } = resolveInside(workspacePath, file);
      if (baselineInfo(normalized)) return { error: 'Baseline deletion is not supported by the generation lane' };
      const violation = policyCheck(normalized);
      if (violation) return { error: `refused: ${violation}` };
      if (!fs.existsSync(absolute)) return { error: `not found: ${normalized}` };
      const droppedTests = testPreservation(normalized, '');
      if (droppedTests) return { error: droppedTests };
      fs.rmSync(absolute, { force: true });
      return { deleted: normalized };
    },
    async run({ command }) {
      // `a && b` of allowlisted commands runs them in order, stopping at the first failure (job 79b4c08f
      // lost a turn to "command not allowed" on exactly that). Each part is checked on its own.
      const requested = String(command ?? '').trim().replace(/\s+/g, ' ');
      const normalized = normalizeRunCommand(requested, workspacePath);
      const rewritten = normalized !== requested ? { normalized_from: requested } : {};
      const parts = normalized.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean);
      if (parts.length <= 1) return { ...(await run(normalized)), ...rewritten };
      const results = [];
      for (const part of parts) {
        const result = await run(part);
        results.push(result);
        if (result.error || result.exit_code !== 0) break;
      }
      const last = results.at(-1);
      const failed = Boolean(last.error) || last.exit_code !== 0;
      return { command: parts.join(' && '), ...rewritten, steps: results, exit_code: last.error ? null : last.exit_code, error: last.error, stopped_at: failed ? parts[results.length - 1] : undefined };
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
      if (error) {
        // Found live: a CHECK constraint rejected every builder_note for days and nobody saw it
        // because the reason was dropped here. Keep the reason in the log and in the tool result.
        if (logger?.warn) logger.warn(`[agentic-engineer] bob_self_memory insert failed: ${error.message}`);
        return { error: `note could not be saved: ${error.message}` };
      }
      return { saved: true };
    },
    // Live Atlas: metadata about the build (entity names and edges), never tenant rows.
    async atlas({ action, name, type, direction, depth, limit } = {}) {
      if (!supabase) return { error: 'Atlas is unavailable in this run' };
      const cap = Math.min(200, Math.max(1, Number(limit) || 50));
      const term = String(name ?? '').trim().slice(0, 200);
      const call = async (query) => {
        const { data, error } = await withTimeout(query, ATLAS_TIMEOUT_MS);
        return error ? { error: `Atlas ${action} failed: ${String(error.message).slice(0, 200)}` } : { rows: data ?? [] };
      };
      if (action === 'gap_report') {
        return call(supabase.rpc('bob_atlas_gap_report', { p_limit: cap, p_offset: 0, p_include_columns: false, p_include_unknown_exercise: false }));
      }
      if (!term) return { error: 'name is required (exact entity name, or a fragment for capability_map)' };
      if (action === 'capability_map') {
        let query = supabase.from('bob_capability_map').select('entity_type,entity_name,present,wired,exercised,retirement_status,notes').ilike('entity_name', `%${term.replace(/[%_]/g, '\\$&')}%`).limit(cap);
        if (type) query = query.eq('entity_type', String(type));
        const result = await call(query);
        return result.rows ? { ...result, note: 'Atlas is a map, not evidence. Verify presence/wiring in current source/schema and exercise with actual invocation receipts; flags alone do not establish facts.' } : result;
      }
      if (action === 'terrain_edges') {
        const result = await call(supabase.from('bob_app_map_edges').select('source_file,source_type,source_name,target_type,target_name,edge_kind').eq('retirement_status', 'live').or(`source_name.eq.${term.replace(/[,()]/g, '')},target_name.eq.${term.replace(/[,()]/g, '')}`).limit(cap));
        return result.rows ? { ...result, note: 'references is weak evidence; confirm reads/writes against supabase/schema.sql.' } : result;
      }
      if (action === 'blast_radius') {
        const fromType = String(type || 'table');
        const maxDepth = Math.min(6, Math.max(1, Number(depth) || 3));
        const flow = await call(supabase.rpc('bob_atlas_flow_reach', { p_from_type: fromType, p_from_name: term, p_direction: direction === 'upstream' ? 'upstream' : 'downstream', p_max_depth: maxDepth }));
        const fk = await call(supabase.rpc('bob_atlas_fk_reach', { p_from_type: fromType, p_from_name: term, p_max_depth: maxDepth }));
        return {
          flow_reach: flow.rows ? flow.rows.slice(0, cap) : flow,
          fk_reach: fk.rows ? fk.rows.slice(0, cap) : fk,
          note: 'Atlas is a map, not evidence. flow_reach maps registered reads/writes/calls/invokes; fk_reach maps structural relations only. Investigate the mapped source/schema and verify execution separately before claiming facts or impact.'
        };
      }
      return { error: 'action must be capability_map, terrain_edges, gap_report, or blast_radius' };
    },
    // Live data checks are aggregate only: a service-role read must never put tenant rows into a prompt.
    async live_count({ table, column, equals } = {}) {
      if (!supabase) return { error: 'live data is unavailable in this run' };
      const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
      if (!identifier.test(String(table ?? ''))) return { error: 'table must be a plain public table name' };
      if (column != null && !identifier.test(String(column))) return { error: 'column must be a plain column name' };
      const head = () => supabase.from(table).select('*', { count: 'exact', head: true });
      const total = await withTimeout(head(), ATLAS_TIMEOUT_MS);
      if (total.error) return { error: `count failed: ${String(total.error.message).slice(0, 200)}` };
      const result = { table, rows: total.count ?? 0 };
      if (column) {
        const filled = await withTimeout(equals === undefined ? head().not(column, 'is', null) : head().eq(column, equals), ATLAS_TIMEOUT_MS);
        if (filled.error) return { ...result, error: `column count failed: ${String(filled.error.message).slice(0, 200)}` };
        result[equals === undefined ? 'rows_with_value' : 'rows_matching'] = filled.count ?? 0;
      }
      return { ...result, note: 'Aggregate count only. A column with zero rows_with_value has no live writer yet: report it as a gap, do not wire UI to it as live data.' };
    },
    __changedFiles: changedFiles,
    __compileGate: compileGate,
    __policyCheck: policyCheck,
    __runs: () => runs.slice(),
    __visualBaselines: () => [...generatedBaselines.values()],
    __log: log,
  };
}

function requiredChangedFilesFromTask(taskDescription, lane) {
  const line = String(taskDescription ?? '').match(/required source scope:\s*([^\n]+)/i)?.[1] ?? '';
  const paths = [...new Set(line.match(/\b(?:apps|supabase|services|scripts|test|docs|deploy)\/[\w./-]+/g) ?? [])];
  return paths.filter((file) => laneAllows(lane, file)).sort();
}

const STARTING_FILE_LIMIT = 8;
const SEARCH_STOPWORDS = new Set(['about', 'above', 'after', 'again', 'being', 'below', 'between', 'build', 'change', 'could', 'during', 'every', 'existing', 'feature', 'first', 'follow', 'frontend', 'backend', 'improve', 'inspiration', 'issue', 'needs', 'other', 'page', 'pages', 'please', 'professional', 'should', 'something', 'their', 'there', 'these', 'thing', 'those', 'through', 'under', 'update', 'using', 'where', 'which', 'while', 'workflow', 'would', 'consideration', 'working', 'seems', 'error', 'calmer', 'enterprise']);

function searchTermsFromTask(job) {
  const text = `${job?.title ?? ''}\n${job?.task_description ?? ''}`;
  const counts = new Map();
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9_-]{4,}/g) ?? []) {
    const term = raw.toLowerCase().replace(/-/g, '');
    if (term.length < 5 || SEARCH_STOPWORDS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 8).map(([term]) => term);
}

function filesAtPin(workspacePath, files) {
  const unique = [...new Set(files.map(String).filter(Boolean))];
  if (!unique.length) return new Set();
  try {
    return new Set(git(workspacePath, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...unique]).split('\n').filter(Boolean));
  } catch { return new Set(); }
}

// Bob grounds the engineer in real files before turn 1 so neither a human nor the model has to supply
// paths: named paths are checked against the pinned commit (invented ones like ExamplePage.tsx are
// reported, not trusted) and, when too few are real, the repository is searched for the task's own words.
function resolveStartingFiles({ workspacePath, lane, hints = [], specification = null, job = null }) {
  const named = [
    ...(Array.isArray(hints) ? hints : []),
    ...(Array.isArray(specification?.delivery_requirements) ? specification.delivery_requirements.flatMap((requirement) => Array.isArray(requirement?.source_scope) ? requirement.source_scope : []) : []),
  ].map((file) => String(file).trim()).filter(Boolean);
  const tracked = filesAtPin(workspacePath, named);
  const confirmed = [...new Set(named.filter((file) => tracked.has(file) && laneAllows(lane, file)))].slice(0, STARTING_FILE_LIMIT);
  const namedButMissing = [...new Set(named.filter((file) => !tracked.has(file)))].slice(0, STARTING_FILE_LIMIT);
  let discovered = [];
  const terms = searchTermsFromTask(job);
  if (confirmed.length < 2 && terms.length) {
    const scores = new Map();
    for (const term of terms) {
      let matches = [];
      try { matches = git(workspacePath, ['grep', '-l', '-i', '-F', '-e', term, '--', 'apps/web/src', 'supabase/functions', 'services', '*.js']).split('\n').filter(Boolean); } catch { matches = []; }
      if (matches.length > 60) continue;
      for (const file of matches) {
        if (!laneAllows(lane, file) || confirmed.includes(file)) continue;
        const entry = scores.get(file) ?? { file, terms: [] };
        entry.terms.push(term);
        scores.set(file, entry);
      }
    }
    discovered = [...scores.values()]
      .sort((a, b) => b.terms.length - a.terms.length || Number(/\.test\./.test(a.file)) - Number(/\.test\./.test(b.file)) || a.file.localeCompare(b.file))
      .slice(0, STARTING_FILE_LIMIT - confirmed.length)
      .map(({ file, terms: matched }) => ({ file, matched_terms: matched }));
  }
  return { confirmed, discovered, named_but_missing: namedButMissing, search_terms: terms };
}

const ATLAS_FLOW_KINDS = ['reads', 'writes', 'calls', 'invokes'];
const ATLAS_TIMEOUT_MS = Number(process.env.BOB_BUILDER_ATLAS_TIMEOUT_MS || 8000);

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Atlas did not answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}

// Atlas is the terrain map: from the files Bob found, which tables/RPCs/functions they really read,
// write, call or invoke; and from the task's words, which files hold the data flows that touch the
// matching entities. Only flow edges suggest files; `references` and FK structure are not a pathway.
async function atlasMapForFiles({ supabase, workspacePath, lane, startingFiles }) {
  if (!supabase || typeof supabase.from !== 'function') return { available: false, reason: 'no Atlas client in this run' };
  const known = [...startingFiles.confirmed, ...startingFiles.discovered.map((entry) => entry.file)];
  const select = 'source_file,source_type,source_name,target_type,target_name,edge_kind';
  try {
    const byFile = known.length
      ? await withTimeout(supabase.from('bob_app_map_edges').select(select).eq('retirement_status', 'live').in('source_file', known).in('edge_kind', ATLAS_FLOW_KINDS).limit(60), ATLAS_TIMEOUT_MS)
      : { data: [] };
    if (byFile.error) throw new Error(byFile.error.message);
    const byTerm = [];
    for (const term of startingFiles.search_terms.slice(0, 4)) {
      const result = await withTimeout(supabase.from('bob_app_map_edges').select(select).eq('retirement_status', 'live').in('edge_kind', ATLAS_FLOW_KINDS).ilike('target_name', `%${term.replace(/[%_]/g, '')}%`).limit(20), ATLAS_TIMEOUT_MS);
      if (result.error) throw new Error(result.error.message);
      byTerm.push(...(result.data ?? []));
    }
    const candidateFiles = [...new Set(byTerm.map((edge) => edge.source_file).filter((file) => file && !known.includes(file) && laneAllows(lane, file)))];
    const tracked = filesAtPin(workspacePath, candidateFiles);
    const suggested = candidateFiles.filter((file) => tracked.has(file)).slice(0, 6);
    const edge = (row) => `${row.source_name} ${row.edge_kind} ${row.target_type}:${row.target_name}`;
    const touches = {};
    for (const row of [...(byFile.data ?? []), ...byTerm.filter((item) => suggested.includes(item.source_file))]) {
      const list = touches[row.source_file] ?? (touches[row.source_file] = []);
      if (list.length < 8 && !list.includes(edge(row))) list.push(edge(row));
    }
    return { available: true, suggested_files: suggested, flow_edges_by_file: touches, note: 'Atlas is a map, not evidence. These registered flow edges suggest where to research; inspect current source/schema and verify relevant behavior before claiming facts.' };
  } catch (error) {
    return { available: false, reason: String(error && error.message || error).slice(0, 200) };
  }
}

// A repair's approved scope is a planner's guess at where the outcome lives; the root cause can sit in a
// shared same-lane file (jobs d5f65103/c604b921: a Leaflet unmount error reported on two pages lives in
// the shared map component). An evidence-backed amendment lets the author fix it there instead of making
// unrelated page edits to satisfy the gate. Protected and cross-lane files never qualify, and every
// amendment travels in the proposal for code review, acceptance reconciliation and the release report.
function scopeAmendmentsFor(entry, { files, sourceScope, lane, proof }) {
  const raw = Array.isArray(entry?.scope_amendment) ? entry.scope_amendment : entry?.scope_amendment ? [entry.scope_amendment] : [];
  return raw.slice(0, 5)
    .map((item) => ({ file: normalizeRepoPath(String(item?.file || '').trim()) || '', reason: String(item?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 600) }))
    .filter((item) => item.file && files.includes(item.file) && !sourceScope.includes(item.file)
      && (!lane || laneFor(item.file) === lane) && !isProtectedPath(item.file)
      && item.reason.length >= 30 && proof.includes(item.file));
}

function validateAcceptanceEvidence({ args, specification, files, trackedAtPin = null, lane = null, amendments = null }) {
  const requirements = Array.isArray(specification?.delivery_requirements)
    ? specification.delivery_requirements
    : [];
  if (!requirements.length) return null;
  const evidence = Array.isArray(args.acceptance_evidence) ? args.acceptance_evidence : [];
  const byId = new Map(evidence.map(entry => [String(entry?.requirement_id || '').trim(), entry]));
  for (const requirement of requirements) {
    const scope = Array.isArray(requirement.source_scope) ? requirement.source_scope.map(String) : [];
    if (lane && scope.length && !scope.some(file => laneFor(file) === lane)) continue;
    const id = String(requirement?.id || '').trim();
    const entry = byId.get(id);
    if (!entry || entry.status !== 'completed') {
      return `finish refused: delivery requirement ${id || '(missing id)'} has no completed acceptance evidence. Implement and verify every approved delivery requirement before handoff.`;
    }
    const proof = String(entry.evidence || '').trim();
    if (!proof) return `finish refused: delivery requirement ${id} has no evidence. Name the changed source file and the observable proof.`;
    const namedScope = lane ? scope.filter(file => laneFor(file) === lane) : scope;
    // A scope path that neither exists at the pinned commit nor is created by this change was invented
    // by the planner; demanding an edit to it made the step impossible (job a7c916f5, ExamplePage.tsx).
    const sourceScope = trackedAtPin ? namedScope.filter(file => trackedAtPin.has(file) || files.includes(file)) : namedScope;
    if (!sourceScope.length) {
      if (!files.some(file => proof.includes(file) || proof.includes(path.basename(file)))) {
        return `finish refused: delivery requirement ${id} named no real source file (${namedScope.join(', ')}), so its evidence must name the changed file where the outcome was implemented.`;
      }
      continue;
    }
    const implementedFiles = files.filter(file => sourceScope.includes(file));
    if (!implementedFiles.length) {
      const amended = scopeAmendmentsFor(entry, { files, sourceScope, lane, proof });
      if (!amended.length) {
        return `finish refused: delivery requirement ${id} did not change any approved source_scope file (${sourceScope.join(', ')}). Implement the outcome in its approved scope before handoff. If evidence shows the root cause is in another file you changed in this lane (for example a shared component), add scope_amendment {file: "<full changed path>", reason: "<the evidence that places the root cause there>"} to this requirement's acceptance_evidence entry and name that path in its evidence; never edit unrelated scope files just to pass this check.`;
      }
      if (amendments) amendments.push(...amended.map(item => ({ requirement_id: id, ...item })));
      continue;
    }
    const namesImplementedFile = implementedFiles.some(file => proof.includes(file) || proof.includes(path.basename(file)));
    if (!namesImplementedFile) {
      return `finish refused: delivery requirement ${id} evidence does not name its changed source_scope file. Evidence must identify where this outcome was implemented.`;
    }
  }
  return null;
}

function verifiedRuns(sessionRuns) {
  return sessionRuns
    .filter((r) => /^(?:node --(?:test|check)\b|npm (?:test|run (?:test|lint|build)) --prefix apps\/web\b)/.test(r.command))
    .slice(-20)
    .map(({ command, exit_code, at, duration_ms }) => ({ command, exit_code, at, duration_ms }));
}

// Runs the compile gate on a built proposal. Returns a refusal the author can act on, or the proposal with
// the gate's receipt (including checks that could not run, which the independent verifier must cover).
async function gateProposal(tools, proposal) {
  if (typeof tools.__compileGate !== 'function') return { proposal };
  const gate = await tools.__compileGate(proposal.changed_files);
  if (gate.failures.length) {
    const detail = gate.failures.map((failure) => `$ ${failure.command} (exit ${failure.exit_code})\n${failure.errors}`).join('\n\n');
    return { error: `finish refused: the pre-handoff compile gate failed, so the independent verifier would reject this patch. Fix these errors in your change (read the named file and line; do not delete tests or weaken types to silence them), re-run the check, and finish again.\n${detail}` };
  }
  const runsNow = typeof tools.__runs === 'function' ? tools.__runs() : [];
  return { proposal: { ...proposal, verified_runs: verifiedRuns(runsNow), compile_gate: { ran: gate.ran, unavailable: gate.unavailable } } };
}

function buildProposal({ workspacePath, lane, tools, args, requiredFiles = [], specification = null }) {
  git(workspacePath, ['add', '-A', '--', '.']);
  const files = git(workspacePath, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).sort();
  if (!files.length) return { error: 'finish refused: no changes in the worktree. Implement the change first, or finish with an explanation only by setting args.no_change_reason.' };
  const violations = files.map((file) => tools.__policyCheck(file)).filter(Boolean);
  if (violations.length) return { error: `finish refused: ${violations.join('; ')}. Revert those files (git checkout -- <path>) and finish again.` };
  // A seeded repair or earlier edit may already have dropped pinned tests; the handoff must restore them.
  // --no-renames: a renamed or disabled pinned test file must still be checked under its pinned path.
  const touchedTests = git(workspacePath, ['diff', '--cached', '--no-renames', '--name-only']).split('\n').filter((file) => file && TEST_SOURCE.test(file));
  const droppedTests = touchedTests.flatMap((file) => {
    let pinned;
    try { pinned = git(workspacePath, ['show', `HEAD:${file}`]); } catch { return []; }
    const absolute = path.join(workspacePath, file);
    const dropped = droppedPinnedTests({ pinned, next: fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '' });
    return dropped.length ? [droppedTestsMessage(file, dropped)] : [];
  });
  if (droppedTests.length) return { error: `finish refused: ${droppedTests.join('; ')}. ${PRESERVE_TESTS}` };
  const modified = git(workspacePath, ['diff', '--cached', '--name-only', '--diff-filter=MD']).split('\n').filter(Boolean);
  const badMigrations = modified.filter((file) => isMigrationPath(file));
  if (badMigrations.length) return { error: `finish refused: migrations may only be added, never modified or deleted: ${badMigrations.join(', ')}` };
  // Raw, untrimmed: git()'s trim() also eats a trailing blank context line (" \n"), which
  // shortens the last hunk and makes git apply reject the patch as corrupt.
  const patch = execFileSync('git', ['diff', '--cached', '--no-color', '--binary'], { cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (Buffer.byteLength(patch) > DEFAULT_LIMITS.maxPatchBytes) return { error: 'finish refused: patch exceeds 2 MB' };
  if (/GIT binary patch|Binary files .* differ/m.test(patch) && !files.some(baselineInfo)) return { error: 'finish refused: binary changes are not allowed' };
  const summary = String(args.summary ?? '').trim();
  if (summary.length < 20) return { error: 'finish refused: summary must explain the change (what, why, how verified)' };
  if (/\b(?:did not|could not|unable to)\s+(?:fully\s+)?(?:complete|implement)\b|\bfirst (?:structural )?slice\b|\bpartial (?:implementation|slice)\b/i.test(summary)) {
    return { error: 'finish refused: the summary admits the required implementation is incomplete. Complete the acceptance contract before handoff; do not defer required work to follow_ups.' };
  }
  const missingRequiredFiles = requiredFiles.filter((file) => !files.includes(file));
  if (missingRequiredFiles.length) {
    return { error: `finish refused: required source scope was not implemented: ${missingRequiredFiles.join(', ')}. Complete those required files before handoff.` };
  }
  const scopeFiles = Array.isArray(specification?.delivery_requirements)
    ? specification.delivery_requirements.flatMap((requirement) => Array.isArray(requirement?.source_scope) ? requirement.source_scope.map(String) : [])
    : [];
  const scopeAmendments = [];
  const acceptanceError = validateAcceptanceEvidence({ args, specification, files, lane, trackedAtPin: filesAtPin(workspacePath, scopeFiles), amendments: scopeAmendments });
  if (acceptanceError) return { error: acceptanceError };
  // Truth Protocol at the gate: a change that touches tests (or that the brief asked to test) must come with a
  // passing `node --test` run from THIS session, or an explicit reason why none could run. Claims are not evidence.
  const sessionRuns = typeof tools.__runs === 'function' ? tools.__runs() : [];
  const passingTestRuns = sessionRuns.filter((r) => /^(?:node --test\b|npm (?:run )?test --prefix apps\/web -- )/.test(r.command) && r.exit_code === 0);
  const touchesTests = files.some((file) => /^test\/|\.test\.(?:[cm]?js|tsx?)$/.test(file));
  const testsNotRunReason = String(args.tests_not_run_reason ?? '').trim();
  if (touchesTests && !passingTestRuns.length && !testsNotRunReason) {
    return { error: 'finish refused: this change touches tests but no `node --test …` run passed in this session. Run the relevant test file (run {"command":"node --test test/<file>.test.js"} or, for web tests, {"command":"npm test --prefix apps/web -- src/<path>.test.tsx"}) and finish again, or set args.tests_not_run_reason to say plainly why it cannot run here.' };
  }
  const tests = (Array.isArray(args.tests) ? args.tests : typeof args.tests === 'string' ? args.tests.split(/\r?\n/) : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  const proposal = {
    summary,
    patch,
    changed_files: files,
    database_migrations: files.filter((file) => file.startsWith('supabase/migrations/')),
    edge_functions: [...new Set(files.filter((file) => /^supabase\/functions\/(?!_shared\/)[^/]+\//.test(file)).map((file) => file.split('/')[2]))].sort(),
    tests,
    acceptance_evidence: Array.isArray(args.acceptance_evidence)
      ? args.acceptance_evidence.map(entry => ({
        requirement_id: String(entry?.requirement_id || '').trim(),
        status: entry?.status,
        evidence: String(entry?.evidence || '').trim()
      })).slice(0, 100)
      : [],
    // Root-cause files outside a requirement's approved scope, each with the author's evidence (see scopeAmendmentsFor).
    scope_amendments: scopeAmendments,
    // What actually ran, from the tool log (command + exit code), so reviewers need not trust the summary.
    verified_runs: verifiedRuns(sessionRuns),
    visual_baselines: typeof tools.__visualBaselines === 'function' ? tools.__visualBaselines() : [],
    tests_not_run_reason: testsNotRunReason || undefined,
    rollback_notes: Array.isArray(args.rollback_notes) && args.rollback_notes.length ? args.rollback_notes.map(String).slice(0, 10) : [files.some((file) => file.startsWith('supabase/migrations/')) ? 'Before merge: close the pull request; nothing is live. After merge the release lane applies the migration, so undo it with a new forward migration and revert the code.' : 'Revert the pull request; this run applies no live data, migrations, or deployments.'],
    follow_ups: Array.isArray(args.follow_ups) ? args.follow_ups.map(String).slice(0, 10) : [],
    lane,
    prompt_version: PROMPT_VERSION,
  };
  // The lane validators are the same ones the independent handoff applies; fail here, not there.
  // A rejection is a tool result the model can act on (live job 1021dbaa: 'destructive SQL is not
  // allowed' escaped as an exception, crashed the run, and left the step's attempt count untouched).
  try {
    if (lane === 'backend') {
      const { parseBackendProposal } = require('./supabase/functions/_shared/builder-backend-engineer');
      parseBackendProposal(JSON.stringify(proposal));
    } else {
      const { validatePatchText } = require('./frontend-worker');
      validatePatchText(patch);
    }
  } catch (error) {
    return { error: `finish refused by the ${lane} lane validator: ${clip(redactGitError(error && error.message), 800)}. Fix the change (or drop the offending text) and finish again.` };
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

async function startAgenticReceipt(supabase, modelRequest, provider) {
  if (!supabase) return null;
  const startedAt = new Date().toISOString();
  const request = providerRequest(modelRequest, provider, null);
  const { data, error } = await supabase.from('builder_model_runs').upsert({
    organization_id: modelRequest.organization_id,
    job_id: modelRequest.job_id,
    step_id: modelRequest.step_id,
    provider: request.provider,
    model_name: request.model_name || 'provider_default',
    prompt_version: modelRequest.prompt_version,
    idempotency_key: `${modelRequest.idempotency_key}::agentic-session`,
    input_artifact_ids: modelRequest.input_artifact_ids,
    status: 'running',
    started_at: startedAt,
    completed_at: null,
    error: null,
    usage_metadata: { phase: 'authoring', turn: 0, changed_file_count: 0 }
  }, { onConflict: 'idempotency_key' }).select('id').single();
  if (error || !data?.id) throw new Error('agentic run provenance could not be started');
  return data.id;
}

async function heartbeatAgenticReceipt(supabase, receiptId, { provider, model, turn, changedFileCount }) {
  if (!supabase || !receiptId) return;
  const { error } = await supabase.from('builder_model_runs').update({
    provider,
    model_name: model || 'provider_default',
    status: 'running',
    updated_at: new Date().toISOString(),
    usage_metadata: { phase: 'authoring', turn, changed_file_count: changedFileCount }
  }).eq('id', receiptId);
  if (error) throw new Error('agentic run provenance heartbeat failed');
}

async function finishAgenticReceipt(supabase, receiptId, { ok, turns, usage, error }) {
  if (!supabase || !receiptId) return;
  const { error: updateError } = await supabase.from('builder_model_runs').update({
    status: ok ? 'completed' : 'failed',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: ok ? null : String(error || 'agentic author failed').slice(0, 500),
    usage_metadata: { ...usage, phase: ok ? 'authored' : 'failed', turns }
  }).eq('id', receiptId);
  if (updateError) throw new Error('agentic run provenance could not be completed');
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
  previousAttempt = null,
  seedPatch = null,
  inputArtifactIds = [],
  limits = DEFAULT_LIMITS,
  // null = the outsourced tier serves its strongest available allowlisted model (BOB_OPENAI_MODELS, best first).
  modelName = process.env.BOB_BUILDER_MODEL || null,
  callModel = callModelGateway,
  // Host network control for self-heal/autopilot (owner ruling 2026-10-21); null outside the control plane.
  firewall = null,
  // In-house first: resume the chain past a provider whose earlier attempt failed verification.
  startAfterProvider = null,
  providerHealth = null,
  // Installs the lockfile-pinned apps/web dependencies into the worktree (the Vibe dependency cache).
  prepareWorkspace = null,
  now = Date.now,
  logger = console,
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!step?.id) throw new Error('implementation step is required');
  if (!['frontend', 'backend'].includes(lane)) throw new Error('lane must be frontend or backend');
  const started = now();
  const inputKey = crypto.createHash('sha256').update(JSON.stringify({
    task: job.task_description, seed: seedPatch?.artifact_id ?? null, inputArtifactIds,
    code_review_revision: job.code_review_revision?.approval_id ?? null,
    implementation_recovery: job.code_review_revision?.recovery_id ?? null,
  })).digest('hex');
  const checkpoint = engineerCheckpoint({ workspaceRoot, job, step, lane, inputKey });
  const saved = checkpoint.load();
  if (saved?.proposal_result) return { ...saved.proposal_result, resumed: true };
  // A job bound to a workspace (e.g. a rerun child that inherits its parent's branch) works in that
  // worktree, not a fresh one named after its own id. The attempt resets to the pin just below anyway.
  const boundBranch = /^bob\/job-[a-z0-9]+$/.test(String(job.workspace_branch || '')) ? job.workspace_branch : undefined;
  const workspace = createBranchWorkspace({ sourceDir, workspaceRoot, jobId: job.id, targetSha: job.target_sha, branchName: boundBranch, recoverInterrupted: true });
  const workspacePath = workspace.workspacePath;
  // Start every attempt from the pinned commit; a previous attempt may have left edits behind.
  git(workspacePath, ['reset', '-q', '--hard', job.target_sha]);
  git(workspacePath, ['clean', '-fdq']);

  const transcript = saved?.transcript || [];
  const log = (entry) => transcript.push({ at: new Date().toISOString(), ...entry });
  // Without apps/web dependencies the author could not type-check or run Vitest at all and handed the
  // verifier unchecked TypeScript (job 34382d60: "tsc is not installed in the runner").
  if (lane === 'frontend' && typeof prepareWorkspace === 'function') {
    try {
      await prepareWorkspace(workspacePath);
      log({ workspace_dependencies: 'ready' });
    } catch (error) {
      log({ workspace_dependencies: 'unavailable', error: clip(redactGitError(error && error.message), 300) });
    }
    // The dependency install replaces a directory that holds a tracked placeholder; it is never part of a change.
    try { git(workspacePath, ['checkout', '--', 'apps/web/node_modules/.gitkeep']); } catch { /* not tracked at this pin */ }
  }
  const tools = createTools({ workspacePath, repoRoot, lane, supabase, limits, log });
  if (firewall) {
    const purposeOf = args => `job ${String(job.id).slice(0, 8)}: ${String(args.purpose || '').slice(0, 250)}`;
    tools.firewall_status = () => firewall.status();
    tools.firewall_change = args => firewall.change({ op: args.op, rule: args.rule, purpose: purposeOf(args), job_id: job.id });
    if (firewall.tailnet) {
      tools.tailnet_status = () => firewall.tailnet.status();
      tools.tailnet_acl = args => firewall.tailnet.acl({ op: args.op, policy: args.policy, ifMatch: args.if_match, purpose: purposeOf(args), job_id: job.id });
    }
  }
  // A revision after a blocked review starts from the previous attempt's verified change, applied
  // here so the model edits it instead of rebuilding from main (round 2 of job f233ec31 did the latter).
  let seeded = null;
  let seedDiff = null;
  if (saved ? saved.patch : seedPatch?.text) {
    const seedFile = path.join(os.tmpdir(), `bob-seed-${job.id.slice(0, 8)}-${process.pid}.patch`);
    try {
      const text = saved ? saved.patch : seedPatch.text;
      const files = validatePatchText(text, { lane: lane === 'frontend' ? 'frontend' : 'verified' });
      if (files.some(file => !laneAllows(lane, file))) throw new Error('Continuation patch is outside the implementation lane');
      fs.writeFileSync(seedFile, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
      git(workspacePath, ['apply', '--whitespace=nowarn', seedFile]);
      seeded = { from_job: seedPatch?.from_job ?? job.id, files: tools.__changedFiles(), checkpoint: Boolean(saved) };
      seedDiff = execFileSync('git', ['diff', 'HEAD', '--no-color', '--binary'], { cwd: workspacePath, encoding: 'utf8' });
      log({ turn: 0, seed_applied: seeded.files });
    } catch (error) {
      throw new Error(`Engineer continuation could not restore its patch: ${redactGitError(error.message)}`);
    } finally {
      try { fs.rmSync(seedFile, { force: true }); } catch { /* gone */ }
    }
  }
  const notes = supabase ? (await tools.read_notes({ limit: 10 })).notes ?? [] : [];
  const rawRepositoryContext = (() => {
    try { return collectRepositoryContext({ sourceDir: workspacePath, targetSha: job.target_sha }); } catch { return null; }
  })();
  const startingFiles = resolveStartingFiles({ workspacePath, lane, hints, specification, job });
  const atlas = await atlasMapForFiles({ supabase, workspacePath, lane, startingFiles });
  const startingMap = { ...startingFiles, atlas };
  log({ turn: 0, starting_map: { confirmed: startingFiles.confirmed, discovered: startingFiles.discovered.map((entry) => entry.file), named_but_missing: startingFiles.named_but_missing, atlas_files: atlas.suggested_files ?? [], atlas_available: atlas.available } });
  const opening = buildOpeningPacket({ job, lane, specification, uxPlan, rawRepositoryContext, liveContext, notes, previousFailure, hints, previousAttempt, seeded, startingMap });

  const messages = [
    { role: 'system', content: systemPrompt({ lane, limits, firewall: firewall ? { tailnet: Boolean(firewall.tailnet) } : false }) },
    { role: 'user', content: opening.packet },
  ];
  if (saved?.messages) {
    messages.push(...saved.messages.slice(2), { role: 'user', content: JSON.stringify({
      continuation: 'Resumed from a durable checkpoint. Your edits are restored; inspect git_diff and continue, not start over. Re-run checks before claiming success.',
      completed_turns: saved.completed_turns, reading_map: saved.reading_map,
    }) });
    log({ checkpoint_resumed: true, completed_turns: saved.completed_turns });
  }
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
  // Consecutive refused repeat calls. A small model can spend a whole budget re-issuing one refused
  // search (live job 0c388688: qwen2.5-coder:7b, 59 of 60 turns, zero reads or edits, twice).
  let refusedStreak = 0;
  let outcome = null;
  let turns = 0;
  let lessons = [];
  const saveProgress = (proposalResult = null) => {
    const untracked = git(workspacePath, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    if (untracked.length) git(workspacePath, ['add', '-N', '--', ...untracked]);
    const patch = execFileSync('git', ['diff', 'HEAD', '--no-color', '--binary'], {
      cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024
    });
    if (Buffer.byteLength(patch) > limits.maxPatchBytes) throw new Error('Checkpoint patch exceeds size limit');
    checkpoint.save({
      patch, messages: compactMessages(messages, { maxChars: 160000 }),
      transcript: transcript.slice(-80).map(entry => compactValue(entry, 2000)), reading_map: readingMap(transcript),
      completed_turns: (saved?.completed_turns || 0) + turns,
      proposal_result: proposalResult,
    });
  };

  const health = providerHealth || await fetchModelHealth(gateway || {});
  const candidates = selectProviders(baseRequest, { health, startAfter: startAfterProvider });
  if (!candidates.length) {
    return { ok: false, error: 'no model provider is available for the author', turns: 0, usage, duration_ms: now() - started, routing: { provider: null, reason: baseRequest.routing_reason, prompt_version: PROMPT_VERSION, model: null, chain: baseRequest.chain } };
  }
  let active = 0;
  let providerStartedTurn = 0;
  let providerStartedAt = started;
  const uneditedTurnBudget = Math.max(8, Math.floor(limits.maxTurns / (candidates.length + 1)));
  // A slow local provider must not spend the whole wall clock before the stronger tier gets a turn.
  const uneditedTimeBudget = Math.floor(limits.wallBudgetMs / (candidates.length + 1));
  // An escalated provider starts with a fresh allocation, not the remainder: frontend jobs used to hand
  // the strongest model 8-12 turns after weaker ones spent the rest (2026-10: "turn budget exhausted"
  // was the second most common frontend failure). The ceiling keeps one run bounded.
  let turnLimit = limits.maxTurns;
  let compileRepairExtended = false;
  const freshTurns = Math.max(12, Math.ceil(limits.maxTurns * 0.6));
  const turnCeiling = limits.maxTurns * 2;
  const activeRequest = () => providerRequest(baseRequest, candidates[active], null);
  const agenticReceiptId = await startAgenticReceipt(supabase, baseRequest, candidates[active]);
  const escalate = (reason) => {
    if (active + 1 >= candidates.length) return false;
    active += 1;
    providerStartedTurn = turns;
    providerStartedAt = now();
    turnLimit = Math.min(turnCeiling, Math.max(turnLimit, turns + freshTurns));
    parseFailures = 0;
    refusedStreak = 0;
    signatures.clear();
    log({ turn: turns, escalated_to: candidates[active].provider, model: candidates[active].model, reason });
    return true;
  };
  // Local providers reject prompts that outgrow their window (413) or go away (5xx/timeouts); OpenAI errors end the run.
  const ESCALATE_STATUSES = new Set([408, 413, 429, 500, 502, 503, 504]);
  let unavailableStreak = 0;
  // A window overflow first compacts the transcript harder on the same provider; in-house-only runs
  // have nowhere stronger to escalate to, and the recent turns are what the model needs.
  let compaction = {};

  while (now() - started < limits.wallBudgetMs) {
    saveProgress();
    if (turns >= turnLimit) {
      if (!escalate(`turn allocation of ${turnLimit - providerStartedTurn} used${tools.__changedFiles().length ? ' with an unfinished change' : ''}`)) break;
      messages.push({ role: 'user', content: JSON.stringify({
        handoff: tools.__changedFiles().length
          ? 'The previous provider ran out of turns mid-change. Check git_diff, complete the required change, run the test, and finish.'
          : 'The previous provider ran out of turns without an edit. Continue from the recorded evidence; make and verify the required change, or report the concrete blocker.',
        reading_map: readingMap(transcript),
      }) });
    }
    const slowUnedited = now() - providerStartedAt >= uneditedTimeBudget;
    if (!tools.__changedFiles().length && (turns - providerStartedTurn >= uneditedTurnBudget || slowUnedited)
      && escalate(slowUnedited ? `${Math.round(uneditedTimeBudget / 60000)} minutes without an edit; preserving the remaining time for the next allowed provider` : `${uneditedTurnBudget} turns without an edit; preserving the remaining budget for the next allowed provider`)) {
      messages.push({ role: 'user', content: JSON.stringify({
        handoff: 'The previous provider used its exploration allocation without an edit. Continue from the recorded evidence; do not repeat the whole investigation or invent an edit just to show progress. Make and verify the required change, or report the concrete blocker.',
        reading_map: readingMap(transcript),
      }) });
    }
    turns++;
    const base = activeRequest();
    await heartbeatAgenticReceipt(supabase, agenticReceiptId, {
      provider: base.provider,
      model: base.model_name,
      turn: turns,
      changedFileCount: tools.__changedFiles().length
    });
    const isOpenAI = candidates[active].provider === 'openai';
    const activeHealth = health?.[candidates[active].provider] || {};
    const localContext = activeHealth.num_ctx;
    // The provider's own cap, not the raw env: BOB_BUILDER_MAX_OUTPUT_TOKENS=32000 against a 32k window
    // would reserve the whole context and leave the prompt a few hundred characters.
    const localOutputBudget = Math.min(Number(activeHealth.max_output_tokens || process.env.BOB_BUILDER_MAX_OUTPUT_TOKENS || 8192), localContext ? Math.floor(localContext / 2) : 8192);
    const promptBudgetChars = localContext ? Math.floor((localContext - localOutputBudget - 512) * 3.5 * (compaction.maxContextRatio ?? 1)) : Infinity;
    const maxOutputTokens = localContext ? localOutputBudget : Number(process.env.BOB_BUILDER_MAX_OUTPUT_TOKENS || 8192);
    const request = { ...base, idempotency_key: `${base.idempotency_key}::turn-${turns}`, request: { ...base.request, messages: compactMessages(messages, { ...compaction, maxChars: promptBudgetChars }), ...(isOpenAI ? { reasoning_effort: process.env.BOB_BUILDER_REASONING_EFFORT || 'high' } : {}), max_output_tokens: maxOutputTokens } };
    const response = await callModel({ ...gateway, modelRequest: request, timeoutMs: limits.turnTimeoutMs });
    if (!response.ok) {
      unavailableStreak++;
      log({ turn: turns, provider: candidates[active].provider, error: `model unavailable: ${response.error}`, streak: unavailableStreak });
      const status = Number(response.status);
      if (status === 413 && !compaction.keepRecent) {
        compaction = { keepRecent: 1, stubChars: 120, threshold: 250, maxContextRatio: 0.65 };
        log({ turn: turns, provider: candidates[active].provider, compacted_hard: true });
        unavailableStreak = 0; turns--;
        continue;
      }
      // A window overflow or an exhausted quota will not clear on its own; a dropped connection or a
      // 5xx usually does. One dropped connection at turn 42 used to discard 41 turns of work (job
      // 1021dbaa): give the same provider three consecutive chances with a short backoff first. A
      // timeout is different: it already spent a whole turn budget, so escalate at once when possible.
      const timedOut = response.timeout === true || status === 408 || response.code === 'provider_timeout';
      const transient = (ESCALATE_STATUSES.has(status) && status !== 413 && status !== 429) || response.timeout;
      const giveUpHere = status === 413 || status === 429 || timedOut || (transient && unavailableStreak >= 3);
      if (giveUpHere && escalate(`provider ${response.status ?? 'timeout'}: ${String(response.error).slice(0, 120)}`)) { unavailableStreak = 0; continue; }
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
      if (parseFailures >= 2 && escalate('two unparseable tool calls in a row')) continue;
      if (parseFailures >= 3) { outcome = { ok: false, error: 'model did not produce tool calls' }; break; }
      continue;
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    messages.push({ role: 'assistant', content: JSON.stringify({ thought: String(call.thought ?? '').slice(0, 2000), tool: call.tool, args }) });
    log({ turn: turns, thought: String(call.thought ?? '').slice(0, 600), tool: call.tool, args: call.tool === 'write_file' ? { path: args.path, bytes: Buffer.byteLength(String(args.content ?? '')) } : call.tool === 'apply_patch' ? { bytes: Buffer.byteLength(String(args.diff ?? '')) } : args });

    if (call.tool === 'finish') {
      lessons = Array.isArray(args.lessons) ? args.lessons : [];
      // "No changes made" in the summary with no no_change_reason is still a no-change answer (job 79b4c08f
      // put it in summary, was refused on its last turn, and ended as a bare 'turn budget exhausted').
      const noChangeReason = args.no_change_reason || (/\bno changes?\b|\bnot (?:made|implemented)\b|\bunchanged\b/i.test(String(args.summary ?? '')) ? args.summary : null);
      if (noChangeReason && seedDiff && seedPatch?.artifact_id && job.code_review_revision?.recovery_id) {
        const routing = { no_change: true, error: String(noChangeReason),
          no_change_lane: args.no_change_lane, no_change_file: args.no_change_file };
        const currentDiff = execFileSync('git', ['diff', 'HEAD', '--no-color', '--binary'], { cwd: workspacePath, encoding: 'utf8' });
        if (currentDiff === seedDiff && JSON.stringify(tools.__changedFiles().sort()) === JSON.stringify([...seeded.files].sort())
            && crossLaneNoChange(routing, `${lane}_engineer`)) {
          const files = validatePatchText(seedDiff, { lane: lane === 'frontend' ? 'frontend' : 'verified' });
          outcome = { ok: true, model: response.data?.model, proposal: {
            summary: 'Retain the reviewed lane seed unchanged for fresh verification; the reported repair belongs to the sibling lane.',
            patch: seedDiff, changed_files: files, tests: [], acceptance_evidence: [], verified_runs: [],
            database_migrations: files.filter(file => file.startsWith('supabase/migrations/')),
            edge_functions: [],
            retained_seed_artifact_id: seedPatch.artifact_id,
            sibling_lane_request: routing,
            tests_not_run_reason: 'No new edits or verification are claimed. The independent lane worker must freshly verify this retained patch.',
            follow_ups: ['The original repair acceptance remains outstanding; independent whole-job human review is required.'],
            lane, prompt_version: PROMPT_VERSION,
          } };
          break;
        }
      }
      if (noChangeReason && !tools.__changedFiles().length) {
        const reason = String(noChangeReason).slice(0, 2000);
        const budgetExhausted = classifyNoChange({ reason, turns, transcript, limits });
        if (budgetExhausted) log({ turn: turns, budget_no_change: true });
        outcome = { ok: false, no_change: true, budget_exhausted: budgetExhausted, error: reason, summary: String(args.summary ?? ''),
          no_change_lane: ['frontend', 'backend'].includes(args.no_change_lane) ? args.no_change_lane : null,
          no_change_file: typeof args.no_change_file === 'string' ? args.no_change_file : null };
        break;
      }
      const built = buildProposal({
        workspacePath,
        lane,
        tools,
        args,
        requiredFiles: requiredChangedFilesFromTask(job.task_description, lane),
        specification
      });
      const gated = built.error ? built : await gateProposal(tools, built.proposal);
      if (gated.error) {
        log({ turn: turns, finish_refused: gated.error.slice(0, 2000) });
        // A compile failure found at the last turns gets a bounded repair allowance instead of a dead handoff.
        if (!built.error && !compileRepairExtended && turnLimit - turns < COMPILE_REPAIR_TURNS && turnLimit < turnCeiling) {
          compileRepairExtended = true;
          turnLimit = Math.min(turnCeiling, turns + COMPILE_REPAIR_TURNS);
          log({ turn: turns, compile_repair_turns: turnLimit - turns });
        }
        messages.push({ role: 'user', content: JSON.stringify({ tool_result: { error: gated.error } }) });
        continue;
      }
      outcome = { ok: true, proposal: gated.proposal, model: response.data?.model };
      break;
    }

    const signature = `${call.tool}::${JSON.stringify(args)}`;
    const seen = (signatures.get(signature) || 0) + 1;
    signatures.set(signature, seen);
    let result;
    if (seen > 2 && !['run', 'git_diff'].includes(call.tool)) {
      refusedStreak++;
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
    if (!result?.error || !/^identical call already made/.test(result.error)) refusedStreak = 0;
    log({ turn: turns, result: typeof result?.error === 'string' ? { error: result.error.slice(0, 500) } : { ok: true } });
    if (refusedStreak >= STUCK_REFUSALS && !tools.__changedFiles().length) {
      const reason = `stuck: ${refusedStreak} identical ${call.tool} calls refused in a row`;
      if (escalate(reason)) {
        refusedStreak = 0;
        messages.push({ role: 'user', content: JSON.stringify({ tool_result: result, escalated: 'The previous model looped on one refused call. Use the results already above; read the one range you need and make the first edit now.' }) });
        continue;
      }
      // Nowhere stronger in this run: stop now with the reading map so the coordinator's next attempt
      // (and its outsourced escalation) starts after a few wasted turns, not sixty.
      log({ turn: turns, stuck_loop: true, reason });
      outcome = { ok: false, error: `turn budget exhausted: ${reason}`, budget_exhausted: true };
      break;
    }
    const remaining = turnLimit - turns;
    const allocation = turnLimit - providerStartedTurn;
    const edited = tools.__changedFiles().length > 0;
    const budgetNote = turns - providerStartedTurn === Math.ceil(allocation / 3) && !edited
      ? `BUDGET: a third of your turns are used (${remaining} left) and nothing is edited yet. Stop surveying: outline the main file if you have not, read the one range you need, and make the first edit within the next 3 turns.`
      : remaining === Math.floor(allocation / 2)
        ? `BUDGET: half your turns are used (${remaining} left). ${edited ? 'Finish the slice you started, run the test, then finish.' : 'If you have not started editing, start now.'}`
        : remaining > 0 && remaining <= 6
          ? `BUDGET: ${remaining} turn${remaining === 1 ? '' : 's'} left. Run your test and call finish; unfinished work is checkpointed, not verified or released.`
          : null;
    messages.push({ role: 'user', content: JSON.stringify(budgetNote ? { tool_result: result, budget: budgetNote } : { tool_result: result }) });
    saveProgress();
  }

  // Grace turn: edits exist but the budget ran out mid-flight. One more call, finish only.
  if (!outcome && turns >= turnLimit && tools.__changedFiles().length) {
    const base = activeRequest();
    const isOpenAI = candidates[active].provider === 'openai';
    messages.push({ role: 'user', content: JSON.stringify({ budget: 'FINAL TURN: the turn budget is used up. Reply with finish now (summary, tests actually run, rollback_notes; tests_not_run_reason if none ran). Otherwise your unfinished work remains checkpointed, not verified or released.' }) });
    const request = { ...base, idempotency_key: `${base.idempotency_key}::turn-final`, request: { ...base.request, messages: compactMessages(messages), ...(isOpenAI ? { reasoning_effort: 'low' } : {}), max_output_tokens: 4000 } };
    const response = await callModel({ ...gateway, modelRequest: request, timeoutMs: limits.turnTimeoutMs });
    const call = response.ok ? parseToolCall(String(response.data?.content ?? '')) : null;
    if (call && call.tool === 'finish') {
      const args = call.args && typeof call.args === 'object' ? call.args : {};
      lessons = Array.isArray(args.lessons) ? args.lessons : lessons;
      log({ turn: turns + 1, grace_finish: true, tool: 'finish' });
      const built = buildProposal({
        workspacePath,
        lane,
        tools,
        args,
        requiredFiles: requiredChangedFilesFromTask(job.task_description, lane),
        specification
      });
      const gated = built.error ? built : await gateProposal(tools, built.proposal);
      if (gated.error) log({ turn: turns + 1, finish_refused: gated.error.slice(0, 2000) });
      else outcome = { ok: true, proposal: gated.proposal, model: response.data?.model };
    } else {
      log({ turn: turns + 1, grace_finish: false, error: response.ok ? 'no finish call' : `model unavailable: ${response.error}` });
    }
  }

  if (!outcome) outcome = { ok: false, error: now() - started >= limits.wallBudgetMs ? 'time budget exhausted' : 'turn budget exhausted' };
  // The loop ran dry with nothing edited after a real exploration: same budget failure as a late no_change,
  // and the next attempt deserves the same reading map (job 79b4c08f: first edit at turn 24, reverted at 58).
  if (!outcome.ok && !outcome.budget_exhausted && !tools.__changedFiles().length && /budget exhausted/.test(String(outcome.error)) && classifyNoChange({ reason: outcome.error, turns, transcript, limits })) {
    outcome.budget_exhausted = true;
    log({ turn: turns, budget_no_change: true, loop_exhausted: true });
  }

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
  const proposalResult = outcome.ok && patchArtifact ? {
    ok: true, patch_artifact: patchArtifact, proposal: outcome.proposal,
    routing: { provider: candidates[active].provider, model: authorModel }, turns: 0, usage: {},
  } : null;
  saveProgress(proposalResult);
  // Leave the worktree clean at the pinned commit for the handoff's own apply.
  try { git(workspacePath, ['reset', '-q', '--hard', job.target_sha]); git(workspacePath, ['clean', '-fdq']); } catch (error) { if (logger?.warn) logger.warn(`[agentic-engineer] worktree reset failed: ${error.message}`); }

  // Bob's own memory: models never volunteer write_note (0 rows after five live jobs), so every run
  // leaves a factual note itself; the next job reads it in `your_recent_notes`.
  const note = composeRunNote({ job, lane, outcome, transcript, turns, provider: candidates[active].provider, model: authorModel, lessons });
  if (note) await tools.write_note({ text: note }).catch(() => ({}));
  await finishAgenticReceipt(supabase, agenticReceiptId, { ok: outcome.ok, turns, usage, error: outcome.error });

  return {
    ok: outcome.ok,
    error: outcome.ok ? undefined : outcome.error,
    no_change: Boolean(outcome.no_change),
    no_change_lane: outcome.no_change_lane ?? null,
    no_change_file: outcome.no_change_file ?? null,
    // The next attempt starts from this map instead of from nothing (see classifyNoChange).
    budget_exhausted: Boolean(outcome.budget_exhausted),
    resume_hints: outcome.budget_exhausted ? { ...readingMap(transcript), conclusion: String(outcome.summary || outcome.error || '').slice(0, 1500), turns_used: turns, lessons: lessons.slice(0, 3) } : null,
    proposal: outcome.proposal || null,
    patch_artifact: patchArtifact,
    transcript_artifact: transcriptArtifact.artifact || null,
    turns,
    usage,
    duration_ms: now() - started,
    routing: { provider: candidates[active].provider, model: authorModel, chain: baseRequest.chain, escalated: active > 0, reason: baseRequest.routing_reason, prompt_version: PROMPT_VERSION, reasoning_effort: process.env.BOB_BUILDER_REASONING_EFFORT || 'high' },
  };
}

module.exports = { ATLAS_RESEARCH_GUIDANCE, DEFAULT_LIMITS, PROMPT_VERSION, RUN_ALLOWLIST, buildOpeningPacket, droppedPinnedTests, normalizeRunCommand, buildProposal, gateProposal, classifyNoChange, compactMessages, composeRunNote, createTools, finishAgenticReceipt, heartbeatAgenticReceipt, outlineLines, parseToolCall, readingMap, requiredChangedFilesFromTask, resolveStartingFiles, atlasMapForFiles, runAgenticEngineer, startAgenticReceipt, systemPrompt, taskPacket, validateAcceptanceEvidence };
