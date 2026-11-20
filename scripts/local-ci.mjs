#!/usr/bin/env node
// Local CI: runs the jobs defined in .github/workflows/verify-pr.yml on this machine
// against an exact commit, then reports each job to GitHub as a commit status
// ("local-ci / <job name>"). It exists because hosted GitHub Actions can be
// unavailable (e.g. an account spending-limit lock); the workflow file stays the
// single source of truth for what "verified" means, so nothing here duplicates its steps.
//
// Usage:
//   node scripts/local-ci.mjs --pr 554                 # verify a PR's head commit
//   node scripts/local-ci.mjs --ref feat/x             # verify a branch/commit
//   node scripts/local-ci.mjs --pr 554 --jobs runtime,web --no-status --keep
//
// Each run uses a fresh detached worktree at the commit (removed afterwards unless
// --keep). Logs go to .local/ci/<sha>/<job>.log (git-ignored).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Minimal YAML subset parser: block maps, block lists, scalars, quoted strings,
// block scalars (| and >), flow lists kept as raw strings. Sufficient for the
// GitHub workflow files in this repository; anything unsupported throws.
// ---------------------------------------------------------------------------

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function scalar(raw) {
  const v = raw.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1);
  return v;
}

function splitKey(text) {
  const m = /^([^:'"]+?|'[^']*'|"[^"]*"):(?:\s+(.*)|)$/.exec(text);
  return m ? { key: scalar(m[1]), rest: m[2] === undefined ? '' : m[2] } : null;
}

export function parseYaml(text) {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (let i = 0; i < raw.length; i += 1) lines.push({ indent: raw[i].search(/\S|$/), text: raw[i], n: i + 1 });
  let pos = 0;

  const significant = () => {
    while (pos < lines.length) {
      const t = stripComment(lines[pos].text).trim();
      if (t) return lines[pos];
      pos += 1;
    }
    return null;
  };

  function blockScalar(style, parentIndent) {
    const out = [];
    let indent = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.text.trim() === '') { out.push(''); pos += 1; continue; }
      if (l.indent <= parentIndent) break;
      if (indent === null) indent = l.indent;
      out.push(l.text.slice(indent));
      pos += 1;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return style.startsWith('>') ? out.join(' ').replace(/ {2,}/g, ' ') + '\n' : out.join('\n') + '\n';
  }

  function value(rest, ownerIndent) {
    const r = rest.trim();
    if (r === '') {
      const next = significant();
      if (!next || next.indent <= ownerIndent) return null;
      return node(next.indent);
    }
    if (r === '|' || r === '|-' || r === '>' || r === '>-') return blockScalar(r, ownerIndent);
    return scalar(r);
  }

  function node(indent) {
    const first = significant();
    if (first.indent !== indent) throw new Error(`YAML line ${first.n}: unexpected indentation`);
    return stripComment(first.text).trim().startsWith('- ') || stripComment(first.text).trim() === '-'
      ? list(indent) : map(indent);
  }

  function mapEntries(target, indent, firstText) {
    // firstText: entry text already on the current line (list item dash case)
    let text = firstText;
    for (;;) {
      if (text === undefined) {
        const l = significant();
        if (!l || l.indent < indent) return target;
        if (l.indent > indent) throw new Error(`YAML line ${l.n}: unexpected indentation`);
        text = stripComment(l.text).trim();
        if (text.startsWith('- ')) return target;
        pos += 1;
      }
      const kv = splitKey(text);
      if (!kv) throw new Error(`YAML: cannot parse "${text}"`);
      target[kv.key] = value(kv.rest, indent);
      text = undefined;
    }
  }

  function map(indent) { return mapEntries({}, indent); }

  function list(indent) {
    const out = [];
    for (;;) {
      const l = significant();
      if (!l || l.indent < indent) return out;
      const text = stripComment(l.text).trim();
      if (l.indent !== indent || !(text.startsWith('- ') || text === '-')) return out;
      pos += 1;
      const item = text === '-' ? '' : text.slice(2).trim();
      if (item === '') { out.push(value('', indent)); continue; }
      if (splitKey(item)) out.push(mapEntries({}, indent + 2, item));
      else out.push(scalar(item));
    }
  }

  const first = significant();
  return first ? node(first.indent) : null;
}

// ---------------------------------------------------------------------------
// Workflow → runnable jobs
// ---------------------------------------------------------------------------

const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function workflowJobs(yamlText) {
  const doc = parseYaml(yamlText);
  if (!doc || typeof doc.jobs !== 'object') throw new Error('Workflow has no jobs');
  return Object.entries(doc.jobs).map(([id, job]) => ({
    id,
    name: job.name || id,
    timeoutMinutes: Number(job['timeout-minutes']) || 30,
    env: { ...asMap(doc.env), ...asMap(job.env) },
    workingDirectory: job.defaults?.run?.['working-directory'] || '.',
    steps: (job.steps || []).map((step, index) => ({
      name: step.name || (step.run ? step.run.split('\n')[0] : step.uses) || `step ${index + 1}`,
      run: step.run || null,
      uses: step.uses || null,
      env: asMap(step.env),
      workingDirectory: step['working-directory'] || null,
      always: typeof step.if === 'string' && /always\(\)/.test(step.if),
    })),
  }));
}

// Hosted-runner commands that do not apply on a developer machine.
export function localCommand(command, platform = process.platform) {
  if (platform !== 'linux') return command.replace(/(npx playwright install)\s+--with-deps\b/g, '$1');
  return command;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { status: true, keep: false, jobs: null, ref: null, pr: null, workflow: '.github/workflows/verify-pr.yml' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pr') args.pr = argv[++i];
    else if (a === '--ref') args.ref = argv[++i];
    else if (a === '--jobs') args.jobs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--workflow') args.workflow = argv[++i];
    else if (a === '--no-status') args.status = false;
    else if (a === '--keep') args.keep = true;
    else if (a === '-h' || a === '--help') { args.help = true; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout.trim();
}

function findBash() {
  if (process.env.LOCAL_CI_SHELL) return process.env.LOCAL_CI_SHELL;
  if (process.platform !== 'win32') return 'bash';
  // Never fall through to System32\bash.exe (WSL): use the Git for Windows bash.
  const gitExec = sh('git', ['--exec-path']).replace(/\//g, '\\');
  const root = gitExec.replace(/\\(mingw64|mingw32|ucrt64|clang64|clangarm64|usr)\\.*$/i, '');
  for (const candidate of [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Git Bash not found; set LOCAL_CI_SHELL to a bash executable');
}

function postStatus(repo, sha, context, state, description) {
  const r = spawnSync('gh', ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description.slice(0, 139)}`],
  { encoding: 'utf8' });
  if (r.status !== 0) console.warn(`  (could not post status "${context}": ${(r.stderr || '').trim()})`);
}

function runStep(bash, command, cwd, env, log, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bash, ['-eo', 'pipefail', '-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { log.write('\n[local-ci] step timed out\n'); child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => log.write(d));
    child.stderr.on('data', (d) => log.write(d));
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', (err) => { clearTimeout(timer); log.write(`\n[local-ci] ${err.message}\n`); resolve(false); });
  });
}

function tail(file, lines = 25) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

async function runJob(job, ctx) {
  const logFile = path.join(ctx.logDir, `${job.id}.log`);
  const log = fs.createWriteStream(logFile);
  const context = `local-ci / ${job.name}`;
  if (ctx.status) postStatus(ctx.repo, ctx.sha, context, 'pending', `Running on ${os.hostname()}`);
  const started = Date.now();
  // Local machines are slower than hosted runners; allow three times the job budget.
  const deadline = started + job.timeoutMinutes * 3 * 60_000;
  let failed = null;
  for (const step of job.steps) {
    if (!step.run) {
      log.write(`\n[local-ci] skip "${step.name}" (${step.uses}) — handled by the local runner\n`);
      continue;
    }
    if (failed && !step.always) continue;
    const cwd = path.join(ctx.worktree, step.workingDirectory || job.workingDirectory);
    const env = { ...process.env, CI: 'true', ...job.env, ...step.env };
    const command = localCommand(step.run);
    log.write(`\n[local-ci] ▶ ${step.name}\n$ ${command}\n`);
    console.log(`  [${job.id}] ${step.name}`);
    const ok = await runStep(ctx.bash, command, cwd, env, log, Math.max(deadline - Date.now(), 1000));
    if (!ok && !failed) failed = step.name;
  }
  await new Promise((r) => log.end(r));
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  const state = failed ? 'failure' : 'success';
  if (ctx.status) postStatus(ctx.repo, ctx.sha, context, state, failed ? `Failed: ${failed} (${minutes} min)` : `Passed in ${minutes} min`);
  return { job, state, failed, minutes, logFile };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/local-ci.mjs [--pr N | --ref REF] [--jobs a,b] [--workflow path] [--no-status] [--keep]');
    return 0;
  }
  const repoRoot = sh('git', ['rev-parse', '--show-toplevel']);
  const repo = sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: repoRoot });
  let sha;
  if (args.pr) {
    sha = sh('gh', ['pr', 'view', String(args.pr), '--json', 'headRefOid', '--jq', '.headRefOid'], { cwd: repoRoot });
    sh('git', ['fetch', '--quiet', 'origin', `pull/${args.pr}/head`], { cwd: repoRoot });
  } else {
    sha = sh('git', ['rev-parse', args.ref || 'HEAD'], { cwd: repoRoot });
  }
  const short = sha.slice(0, 8);
  const worktree = path.join(os.tmpdir(), 'fcm-local-ci', `${short}-${Date.now()}`);
  const logDir = path.join(repoRoot, '.local', 'ci', short);
  fs.mkdirSync(logDir, { recursive: true });
  sh('git', ['worktree', 'add', '--detach', '--quiet', worktree, sha], { cwd: repoRoot });

  let results = [];
  try {
    const workflowText = fs.readFileSync(path.join(worktree, args.workflow), 'utf8');
    let jobs = workflowJobs(workflowText);
    if (args.jobs) {
      const unknown = args.jobs.filter((j) => !jobs.some((job) => job.id === j));
      if (unknown.length) throw new Error(`Unknown job(s): ${unknown.join(', ')}; available: ${jobs.map((j) => j.id).join(', ')}`);
      jobs = jobs.filter((job) => args.jobs.includes(job.id));
    }
    const ctx = { repo, sha, worktree, logDir, status: args.status, bash: findBash() };
    console.log(`local-ci: ${repo}@${short} (${args.pr ? `PR #${args.pr}` : args.ref || 'HEAD'}) — ${jobs.map((j) => j.id).join(', ')}`);
    if (ctx.status) for (const job of jobs) postStatus(repo, sha, `local-ci / ${job.name}`, 'pending', 'Queued');
    // Jobs share npm caches and Docker; run them one at a time for reliable results.
    for (const job of jobs) results.push(await runJob(job, ctx));
  } finally {
    if (!args.keep) spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot });
    else console.log(`worktree kept: ${worktree}`);
  }

  console.log('\nlocal-ci results');
  for (const r of results) {
    console.log(`  ${r.state === 'success' ? 'PASS' : 'FAIL'}  ${r.job.name}  (${r.minutes} min)  ${r.logFile}`);
    if (r.failed) console.log(`        failed step: ${r.failed}\n${tail(r.logFile).replace(/^/gm, '        | ')}`);
  }
  return results.every((r) => r.state === 'success') ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(`local-ci: ${err.message}`); process.exitCode = 2; });
}
