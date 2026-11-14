#!/usr/bin/env node
'use strict';

// Laptop worker disk hygiene. Dry run by default; pass --apply to delete.
// Usage: node scripts/laptop-storage-clean.js [--apply] [--remove-unused-models] [--env <file>] [--temp-days N] [--repo <dir>]
// Git worktrees are only reported (stale main checkout, merged clean worktrees), never removed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DAY_MS = 86_400_000;
const NATIVE_COPY_DAYS = 1;
const NATIVE_COPY = /^\.[0-9a-f]{8,}-[0-9a-f]{8,}\.node$/i;
const DEFAULT_GPU_MODELS = 'qwen2.5:7b,qwen2.5-coder:7b,qwen2.5-coder:14b,qwen3:8b';
const DEFAULT_VISION_MODEL = 'qwen3-vl:4b';

function splitModels(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function keepModelsFromEnv(env) {
  return new Set([
    ...splitModels(env.BOB_GPU_MODELS || DEFAULT_GPU_MODELS),
    ...splitModels(env.CCTV_VLM_MODEL || DEFAULT_VISION_MODEL),
    ...splitModels(env.GPU_WORKSTATION_MODEL),
    ...splitModels(env.GPU_WORKSTATION_PLAN_MODEL),
    ...splitModels(env.BOB_KEEP_OLLAMA_MODELS),
  ]);
}

function normaliseModel(name) {
  return name.includes(':') ? name : `${name}:latest`;
}

function planOllamaRemovals(installed, keep) {
  const kept = new Set([...keep].map(normaliseModel));
  return installed.filter(model => !kept.has(normaliseModel(model)));
}

function staleTempEntries(entries, now, days) {
  return entries.filter(entry => {
    const limit = NATIVE_COPY.test(path.win32.basename(entry.path)) ? NATIVE_COPY_DAYS : days;
    const newest = Math.max(entry.mtimeMs || 0, entry.birthtimeMs || 0);
    return now - newest > limit * DAY_MS;
  });
}

function dockerPruneCommands({ imageAgeHours }) {
  return [
    ['docker', 'builder', 'prune', '--all', '--force'],
    ['docker', 'image', 'prune', '--all', '--force', '--filter', `until=${imageAgeHours}h`],
    ['docker', 'volume', 'prune', '--force'],
  ];
}

function parseWorktreeList(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) rows.push({ path: line.slice(9), branch: null, detached: false });
    else if (line.startsWith('branch ') && rows.length) rows[rows.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached' && rows.length) rows[rows.length - 1].detached = true;
  }
  return rows;
}

// Report only: worktrees hold uncommitted work, so this never removes anything.
function worktreeFindings(rows, { behindLimit = 30 } = {}) {
  const findings = [];
  for (const row of rows) {
    if (row.isMain) {
      if (row.branch !== 'main') findings.push({ path: row.path, issue: 'main checkout is not on main' });
      if (row.behind > 0) findings.push({ path: row.path, issue: `main checkout is ${row.behind} commits behind origin/main` });
    } else if (!row.dirty && row.merged && row.behind > 0) {
      findings.push({ path: row.path, issue: 'merged and clean: safe to remove (git worktree remove)' });
    } else if (row.dirty && row.behind > behindLimit) {
      findings.push({ path: row.path, issue: `${row.behind} commits behind with ${row.dirty} uncommitted changes: review before removing` });
    }
  }
  return findings;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: result.status === 0, out: String(result.stdout || '').trim() };
}

function reportWorktrees(repo) {
  if (!repo || !git(repo, ['rev-parse', '--git-dir']).ok) return console.log('worktrees: no repository given (--repo <dir>), skipped');
  git(repo, ['fetch', 'origin', '--prune', '--quiet']);
  const mainPath = path.resolve(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out, '..');
  const rows = parseWorktreeList(git(repo, ['worktree', 'list', '--porcelain']).out)
    .filter(row => fs.existsSync(row.path))
    .map(row => ({
      ...row,
      isMain: path.resolve(row.path) === mainPath,
      behind: Number(git(row.path, ['rev-list', '--count', 'HEAD..origin/main']).out) || 0,
      dirty: git(row.path, ['status', '--porcelain']).out.split(/\r?\n/).filter(Boolean).length,
      merged: git(row.path, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).ok,
    }));
  const findings = worktreeFindings(rows);
  console.log(`worktrees: ${rows.length} checked, ${findings.length} need attention`);
  for (const finding of findings) console.log(`worktree: ${finding.path} -> ${finding.issue}`);
}

function readEnvFile(file) {
  const env = {};
  if (!file || !fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && /MODEL/.test(match[1])) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function newestTimes(target) {
  const stat = fs.lstatSync(target);
  let mtimeMs = stat.mtimeMs;
  let birthtimeMs = stat.birthtimeMs;
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(target)) {
      try {
        const times = newestTimes(path.join(target, child));
        mtimeMs = Math.max(mtimeMs, times.mtimeMs);
        birthtimeMs = Math.max(birthtimeMs, times.birthtimeMs);
      } catch { /* vanished or locked */ }
    }
  }
  return { mtimeMs, birthtimeMs };
}

function sizeOf(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(target).reduce((sum, child) => sum + sizeOf(path.join(target, child)), 0);
  } catch { return 0; }
}

function run(command, apply) {
  const line = command.join(' ');
  if (!apply) return console.log(`[dry-run] ${line}`);
  // Commands are fixed constants; a single string avoids Node's shell-args deprecation and resolves npm.cmd on Windows.
  const result = spawnSync(line, { encoding: 'utf8', shell: true });
  const tail = String(result.stdout || '').trim().split(/\r?\n/).pop();
  console.log(`${result.status === 0 ? 'ok  ' : 'FAIL'} ${line}${tail ? `  -> ${tail}` : ''}`);
}

function main(argv) {
  const apply = argv.includes('--apply');
  const removeModels = argv.includes('--remove-unused-models');
  const envIndex = argv.indexOf('--env');
  const envFile = envIndex >= 0 ? argv[envIndex + 1] : path.join(__dirname, '..', 'deploy', 'laptop-worker', 'laptop-worker.env');
  const daysIndex = argv.indexOf('--temp-days');
  const tempDays = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 7;

  const tempRoot = os.tmpdir();
  const entries = [];
  for (const name of fs.readdirSync(tempRoot)) {
    const full = path.join(tempRoot, name);
    try { entries.push({ path: full, ...newestTimes(full) }); } catch { /* locked */ }
  }
  let freed = 0;
  let failed = 0;
  const stale = staleTempEntries(entries, Date.now(), tempDays);
  for (const entry of stale) {
    const bytes = sizeOf(entry.path);
    if (apply) {
      try { fs.rmSync(entry.path, { recursive: true, force: true }); freed += bytes; } catch { failed += 1; }
    } else freed += bytes;
  }
  console.log(`${apply ? 'removed' : '[dry-run] would remove'} ${stale.length - failed} temp entries (${(freed / 2 ** 30).toFixed(2)} GB)${failed ? `, ${failed} in use` : ''}`);

  for (const command of dockerPruneCommands({ imageAgeHours: 168 })) run(command, apply);
  run(['npm', 'cache', 'verify'], apply);

  const listed = spawnSync('ollama list', { encoding: 'utf8', shell: true });
  if (listed.status === 0) {
    const installed = listed.stdout.split(/\r?\n/).slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
    const unused = planOllamaRemovals(installed, keepModelsFromEnv(readEnvFile(envFile)));
    if (!unused.length) console.log('ollama: every installed model is in the worker keep-list');
    for (const model of unused) {
      if (removeModels) run(['ollama', 'rm', model], apply);
      else console.log(`ollama: ${model} is not in the worker keep-list (pass --remove-unused-models to remove)`);
    }
  }

  const repoIndex = argv.indexOf('--repo');
  reportWorktrees(repoIndex >= 0 ? argv[repoIndex + 1] : path.join(__dirname, '..'));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { keepModelsFromEnv, planOllamaRemovals, staleTempEntries, dockerPruneCommands, parseWorktreeList, worktreeFindings };
