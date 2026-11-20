#!/usr/bin/env node
// GitHub → Gitea CI bridge (runs on the VPS from a systemd timer).
//
// GitHub stays the source of truth for code, pull requests and Vercel deploys. Hosted GitHub
// Actions is unavailable, so verification runs on the self-hosted Gitea Actions runner:
//   1. mirror GitHub main and the head branch of every open same-repository PR into Gitea
//      (fork PRs are never mirrored: the runner has the host Docker socket);
//   2. copy Gitea's "PR verification" job results back to GitHub as commit statuses
//      ("gitea-ci / <job>" plus an aggregate "gitea-ci");
//   3. optionally refresh the live Atlas on the host once main's verification passes
//      (the service-role key never enters a workflow, which any branch could rewrite).
//
// Tokens are systemd credentials (root-only files loaded with LoadCredential=), never inherited
// by git or docker child processes, passed to git only via an http.extraheader (never a URL or
// argv), and scrubbed from every log line.
//
// Credentials: github-token, gitea-token (or GITHUB_TOKEN / GITEA_TOKEN for a manual run).
// Env: GITHUB_REPOSITORY, GITEA_URL, GITEA_REPOSITORY, STATE_DIR (default /var/lib/fcm-gitea-ci),
//      ATLAS_REFRESH=1 + ATLAS_ENV_FILE (optional).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW_NAME = 'PR verification';
export const STATUS_PREFIX = 'gitea-ci';

// ---------------------------------------------------------------------------
// Pure logic (unit tested)
// ---------------------------------------------------------------------------

/** Branches to mirror: main plus heads of open PRs from this repository (never forks). */
export function desiredBranches(pulls, repoFullName, mainSha) {
  const branches = new Map([['main', { sha: mainSha, pr: null }]]);
  for (const pr of pulls) {
    if (!pr.head?.repo || pr.head.repo.full_name !== repoFullName) continue;
    if (!/^[A-Za-z0-9._\/-]+$/.test(pr.head.ref) || pr.head.ref.includes('..') || pr.head.ref === 'main') continue;
    branches.set(pr.head.ref, { sha: pr.head.sha, pr: pr.number });
  }
  return branches;
}

const GITEA_TO_GITHUB = { success: 'success', pending: 'pending', running: 'pending', failure: 'failure', error: 'error' };

/** Gitea Actions status contexts look like "PR verification / <job name> (push)". */
export function jobStatuses(giteaStatuses) {
  const latest = new Map();
  for (const s of giteaStatuses) {
    const m = /^(.+?) \/ (.+?)(?: \(([a-z_]+)\))?$/.exec(s.context || '');
    if (!m || m[1] !== WORKFLOW_NAME) continue;
    const job = m[2];
    const prev = latest.get(job);
    if (!prev || Date.parse(s.updated_at || s.created_at) > Date.parse(prev.updated_at || prev.created_at)) latest.set(job, s);
  }
  return [...latest.entries()].map(([job, s]) => ({
    context: `${STATUS_PREFIX} / ${job}`,
    state: GITEA_TO_GITHUB[s.status ?? s.state] || 'error',
    description: String(s.description || s.status || s.state || '').slice(0, 139),
    target_url: s.target_url || undefined,
  }));
}

/** One summary status: failure beats pending beats success; nothing yet means queued. */
export function aggregateStatus(jobs, expectedJobCount) {
  if (jobs.some((j) => j.state === 'failure' || j.state === 'error')) {
    const failed = jobs.filter((j) => j.state === 'failure' || j.state === 'error').map((j) => j.context.slice(STATUS_PREFIX.length + 3));
    return { context: STATUS_PREFIX, state: 'failure', description: `Failed: ${failed.join(', ')}`.slice(0, 139) };
  }
  if (jobs.length < expectedJobCount || jobs.some((j) => j.state === 'pending')) {
    const done = jobs.filter((j) => j.state === 'success').length;
    return { context: STATUS_PREFIX, state: 'pending', description: `Gitea CI running (${done}/${expectedJobCount} jobs passed)` };
  }
  return { context: STATUS_PREFIX, state: 'success', description: `All ${expectedJobCount} Gitea CI jobs passed` };
}

/** Child processes (git, docker) never inherit the bridge's tokens. */
export function childEnv(environment = process.env) {
  const { GITHUB_TOKEN, GITEA_TOKEN, CREDENTIALS_DIRECTORY, ...rest } = environment;
  return rest;
}

export function scrub(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('<token>');
  return out;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
}

/** Secrets come from systemd credentials (LoadCredential=), falling back to the environment for manual runs. */
export function readSecret(credentialName, envName, environment = process.env) {
  const dir = environment.CREDENTIALS_DIRECTORY;
  const file = dir ? path.join(dir, credentialName) : '';
  const value = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : environment[envName];
  if (!value) throw new Error(`credential ${credentialName} (or ${envName}) is required`);
  return value;
}

async function main() {
  const cfg = {
    githubRepo: env('GITHUB_REPOSITORY'),
    githubToken: readSecret('github-token', 'GITHUB_TOKEN'),
    giteaUrl: env('GITEA_URL').replace(/\/$/, ''),
    giteaRepo: env('GITEA_REPOSITORY'),
    giteaToken: readSecret('gitea-token', 'GITEA_TOKEN'),
    stateDir: env('STATE_DIR', '/var/lib/fcm-gitea-ci'),
    expectedJobs: Number(process.env.EXPECTED_JOBS || 3),
    atlas: process.env.ATLAS_REFRESH === '1',
    atlasEnvFile: process.env.ATLAS_ENV_FILE || '',
  };
  const secrets = [cfg.githubToken, cfg.giteaToken, Buffer.from(`x-access-token:${cfg.githubToken}`).toString('base64')];
  const log = (msg) => console.log(`${new Date().toISOString()} ${scrub(msg, secrets)}`);
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(cfg.stateDir, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { posted: {}, atlasSha: null };

  const api = async (base, token, scheme, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { Authorization: `${scheme} ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'fcm-gitea-ci-bridge' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
  const gh = (method, url, body) => api('https://api.github.com', cfg.githubToken, 'Bearer', method, url, body);
  const gt = (method, url, body) => api(`${cfg.giteaUrl}/api/v1`, cfg.giteaToken, 'token', method, url, body);

  const mirror = path.join(cfg.stateDir, 'mirror.git');
  const git = (args, extraHeader) => {
    const pre = extraHeader ? ['-c', `http.extraheader=${extraHeader}`] : [];
    const r = spawnSync('git', [...pre, ...args], { encoding: 'utf8', env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0' } });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${scrub((r.stderr || r.stdout || '').trim(), secrets)}`);
    return r.stdout.trim();
  };
  if (!fs.existsSync(mirror)) git(['init', '--bare', '--quiet', mirror]);
  const githubAuth = `Authorization: Basic ${Buffer.from(`x-access-token:${cfg.githubToken}`).toString('base64')}`;
  const giteaAuth = `Authorization: token ${cfg.giteaToken}`;

  // 1. What should be in Gitea.
  const pulls = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await gh('GET', `/repos/${cfg.githubRepo}/pulls?state=open&per_page=100&page=${page}`);
    pulls.push(...(batch || []));
    if (!batch || batch.length < 100) break;
  }
  const mainSha = (await gh('GET', `/repos/${cfg.githubRepo}/commits/main`)).sha;
  const branches = desiredBranches(pulls, cfg.githubRepo, mainSha);

  // 2. Fetch exactly those commits from GitHub and push any that Gitea lacks.
  const refspecs = ['+refs/heads/main:refs/heads/main',
    ...[...branches.values()].filter((b) => b.pr).map((b) => `+refs/pull/${b.pr}/head:refs/pr/${b.pr}`)];
  git(['--git-dir', mirror, 'fetch', '--quiet', '--no-tags', `https://github.com/${cfg.githubRepo}.git`, ...refspecs], githubAuth);
  const giteaPush = `${cfg.giteaUrl}/${cfg.giteaRepo}.git`;
  for (const [branch, { sha, pr }] of branches) {
    const current = await gt('GET', `/repos/${cfg.giteaRepo}/branches/${encodeURIComponent(branch)}`);
    if (current?.commit?.id === sha) continue;
    // main only ever fast-forwards; PR branches follow force-pushes on GitHub.
    const spec = `${branch === 'main' ? '' : '+'}${sha}:refs/heads/${branch}`;
    try {
      git(['--git-dir', mirror, 'push', '--quiet', giteaPush, spec], giteaAuth);
      log(`pushed ${branch}${pr ? ` (PR #${pr})` : ''} ${sha.slice(0, 8)} to Gitea`);
    } catch (err) {
      log(`push ${branch} failed: ${err.message}`);
    }
  }

  // 3. Report Gitea results on GitHub (only when something changed).
  const live = new Set();
  for (const [branch, { sha }] of branches) {
    live.add(sha);
    const giteaStatuses = [];
    for (let page = 1; page <= 5; page += 1) {
      const batch = await gt('GET', `/repos/${cfg.giteaRepo}/commits/${sha}/statuses?limit=50&page=${page}`);
      giteaStatuses.push(...(batch || []));
      if (!batch || batch.length < 50) break;
    }
    const jobs = jobStatuses(giteaStatuses);
    for (const status of [...jobs, aggregateStatus(jobs, cfg.expectedJobs)]) {
      const key = `${sha}|${status.context}`;
      const fingerprint = `${status.state}|${status.description}`;
      if (state.posted[key] === fingerprint) continue;
      await gh('POST', `/repos/${cfg.githubRepo}/statuses/${sha}`, status);
      state.posted[key] = fingerprint;
      log(`${branch} ${sha.slice(0, 8)} ${status.context} → ${status.state}`);
    }
  }
  for (const key of Object.keys(state.posted)) if (!live.has(key.split('|')[0])) delete state.posted[key];

  // 4. Atlas refresh on the host after main passes (replaces the GitHub workflow_run job).
  if (cfg.atlas && state.atlasSha !== mainSha && state.posted[`${mainSha}|${STATUS_PREFIX}`]?.startsWith('success|')) {
    state.atlasSha = await refreshAtlas(cfg, mainSha, mirror, log) ? mainSha : state.atlasSha;
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function refreshAtlas(cfg, sha, mirror, log) {
  const vars = Object.fromEntries(fs.readFileSync(cfg.atlasEnvFile, 'utf8').split('\n')
    .map((l) => /^\s*(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*"?([^"\r]*)"?\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  if (!vars.SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) { log('atlas refresh skipped: Supabase variables missing'); return false; }
  const src = path.join(cfg.stateDir, 'atlas-src');
  fs.rmSync(src, { recursive: true, force: true });
  let r = spawnSync('git', ['clone', '--quiet', '--no-checkout', mirror, src], { encoding: 'utf8' });
  if (r.status === 0) r = spawnSync('git', ['-C', src, 'checkout', '--quiet', '--detach', sha], { encoding: 'utf8' });
  if (r.status !== 0) { log(`atlas refresh checkout failed: ${r.stderr}`); return false; }
  r = spawnSync('docker', ['run', '--rm', '-v', `${src}:/w`, '-w', '/w',
    '-e', 'SUPABASE_URL', '-e', 'SUPABASE_SERVICE_ROLE_KEY',
    '-e', 'ATLAS_REFRESH_SOURCE_BRANCH=main', '-e', `ATLAS_REFRESH_SOURCE_COMMIT=${sha}`, '-e', 'ATLAS_REFRESH_OUTPUT_DIR=/tmp/atlas',
    'node:22', 'sh', '-c', 'npm ci --no-audit --no-fund --loglevel=error && node scripts/atlas-refresh.js --apply'],
  { encoding: 'utf8', env: { ...childEnv(), ...vars }, timeout: 15 * 60_000 });
  fs.rmSync(src, { recursive: true, force: true });
  const ok = r.status === 0;
  const tail = (r.stdout + r.stderr).split('\n').slice(-5).join(' | ');
  log(`atlas refresh for main ${sha.slice(0, 8)} ${ok ? 'succeeded' : 'FAILED'}: ${tail.replaceAll(vars.SUPABASE_SERVICE_ROLE_KEY, '<token>')}`);
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const secrets = [process.env.GITHUB_TOKEN, process.env.GITEA_TOKEN];
    console.error(`${new Date().toISOString()} bridge failed: ${scrub(err.stack || err.message, secrets)}`);
    process.exitCode = 1;
  });
}
