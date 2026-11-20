#!/usr/bin/env node
// Gitea → GitHub release mirror (runs on the VPS from a systemd timer).
//
// Gitea is the source of truth: pull requests, review and CI (.gitea/workflows/verify.yml on the
// self-hosted runner) happen there, and Gitea main only moves through merged PRs. GitHub is a
// deploy mirror so Vercel keeps building production from GitHub main. Each tick:
//   1. fast-forwards GitHub main to Gitea main (never force; a divergence stops and is logged);
//   2. optionally refreshes the live Atlas on the host once Gitea CI passes on main (the
//      service-role key never enters a workflow, which any branch could rewrite).
//
// Tokens are systemd credentials (root-only files loaded with LoadCredential=), never inherited
// by git or docker child processes, passed to git only via an http.extraheader (never a URL or
// argv), and scrubbed from every log line.
//
// Credentials: github-token (contents write on GITHUB_REPOSITORY), gitea-token (read on
//              GITEA_REPOSITORY) — or GITHUB_TOKEN / GITEA_TOKEN for a manual run.
// Env: GITHUB_REPOSITORY, GITEA_URL, GITEA_REPOSITORY, STATE_DIR (default /var/lib/fcm-gitea-ci),
//      ATLAS_REFRESH=1 + ATLAS_ENV_FILE (optional).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW_NAME = 'PR verification';
export const EXPECTED_JOBS = ['Runtime and migration inventory', 'Web types, build and unit tests', 'Offline browser workflows'];

// ---------------------------------------------------------------------------
// Pure logic (unit tested)
// ---------------------------------------------------------------------------

/** Latest Gitea Actions state per job; contexts look like "PR verification / <job> (push)". */
export function jobStates(giteaStatuses) {
  const latest = new Map();
  for (const s of giteaStatuses) {
    const m = /^(.+?) \/ (.+?)(?: \(([a-z_]+)\))?$/.exec(s.context || '');
    if (!m || m[1] !== WORKFLOW_NAME) continue;
    const prev = latest.get(m[2]);
    if (!prev || Date.parse(s.updated_at || s.created_at) > Date.parse(prev.updated_at || prev.created_at)) latest.set(m[2], s);
  }
  return new Map([...latest].map(([job, s]) => [job, s.status ?? s.state]));
}

/** main has passed only when every expected job's latest state is success. */
export function mainPassed(states, expected = EXPECTED_JOBS) {
  return expected.every((job) => states.get(job) === 'success');
}

/** Decide what to do with GitHub main given both heads and their ancestry. */
export function mirrorAction({ giteaSha, githubSha, githubIsAncestor }) {
  if (!giteaSha) return { action: 'skip', reason: 'Gitea main not found' };
  if (giteaSha === githubSha) return { action: 'none' };
  if (!githubIsAncestor) return { action: 'stop', reason: `GitHub main ${String(githubSha).slice(0, 8)} is not an ancestor of Gitea main ${giteaSha.slice(0, 8)}; a person must reconcile` };
  return { action: 'fast-forward' };
}

/** Secrets come from systemd credentials (LoadCredential=), falling back to the environment for manual runs. */
export function readSecret(credentialName, envName, environment = process.env) {
  const dir = environment.CREDENTIALS_DIRECTORY;
  const file = dir ? path.join(dir, credentialName) : '';
  const value = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : environment[envName];
  if (!value) throw new Error(`credential ${credentialName} (or ${envName}) is required`);
  return value;
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

async function main() {
  const cfg = {
    githubRepo: env('GITHUB_REPOSITORY'),
    githubToken: readSecret('github-token', 'GITHUB_TOKEN'),
    giteaUrl: env('GITEA_URL').replace(/\/$/, ''),
    giteaRepo: env('GITEA_REPOSITORY'),
    giteaToken: readSecret('gitea-token', 'GITEA_TOKEN'),
    stateDir: env('STATE_DIR', '/var/lib/fcm-gitea-ci'),
    atlas: process.env.ATLAS_REFRESH === '1',
    atlasEnvFile: process.env.ATLAS_ENV_FILE || '',
  };
  const githubBasic = Buffer.from(`x-access-token:${cfg.githubToken}`).toString('base64');
  const secrets = [cfg.githubToken, cfg.giteaToken, githubBasic];
  const log = (msg) => console.log(`${new Date().toISOString()} ${scrub(msg, secrets)}`);
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(cfg.stateDir, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};

  const gitea = async (url) => {
    const res = await fetch(`${cfg.giteaUrl}/api/v1${url}`, { headers: { Authorization: `token ${cfg.giteaToken}`, Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Gitea GET ${url} → ${res.status}`);
    return res.json();
  };

  const mirror = path.join(cfg.stateDir, 'mirror.git');
  const git = (args, extraHeader, { check = true } = {}) => {
    const pre = extraHeader ? ['-c', `http.extraheader=${extraHeader}`] : [];
    const r = spawnSync('git', [...pre, ...args], { encoding: 'utf8', env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0' } });
    if (check && r.status !== 0) throw new Error(`git ${args[2] || args[0]} failed: ${scrub((r.stderr || r.stdout || '').trim(), secrets)}`);
    return r;
  };
  if (!fs.existsSync(mirror)) git(['init', '--bare', '--quiet', mirror]);
  const githubAuth = `Authorization: Basic ${githubBasic}`;
  const giteaAuth = `Authorization: token ${cfg.giteaToken}`;
  const githubUrl = `https://github.com/${cfg.githubRepo}.git`;

  // 1. Fast-forward GitHub main to Gitea main.
  git(['--git-dir', mirror, 'fetch', '--quiet', '--no-tags', `${cfg.giteaUrl}/${cfg.giteaRepo}.git`, '+refs/heads/main:refs/remotes/gitea/main'], giteaAuth);
  git(['--git-dir', mirror, 'fetch', '--quiet', '--no-tags', githubUrl, '+refs/heads/main:refs/remotes/github/main'], githubAuth);
  const rev = (ref) => git(['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', ref], null, { check: false }).stdout.trim() || null;
  const giteaSha = rev('refs/remotes/gitea/main');
  const githubSha = rev('refs/remotes/github/main');
  const githubIsAncestor = !githubSha || git(['--git-dir', mirror, 'merge-base', '--is-ancestor', githubSha, giteaSha || 'HEAD'], null, { check: false }).status === 0;
  const plan = mirrorAction({ giteaSha, githubSha, githubIsAncestor });
  if (plan.action === 'fast-forward') {
    git(['--git-dir', mirror, 'push', '--quiet', githubUrl, `${giteaSha}:refs/heads/main`], githubAuth);
    log(`GitHub main fast-forwarded ${String(githubSha).slice(0, 8)} → ${giteaSha.slice(0, 8)}`);
  } else if (plan.action !== 'none' && state.lastProblem !== plan.reason) {
    log(`mirror ${plan.action}: ${plan.reason}`);
  }
  state.lastProblem = plan.reason || null;

  // 2. Atlas refresh on the host after Gitea CI passes on main.
  if (cfg.atlas && giteaSha && state.atlasSha !== giteaSha) {
    const statuses = await gitea(`/repos/${cfg.giteaRepo}/commits/${giteaSha}/statuses?limit=50`) || [];
    if (mainPassed(jobStates(statuses)) && await refreshAtlas(cfg, giteaSha, mirror, log)) state.atlasSha = giteaSha;
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function refreshAtlas(cfg, sha, mirror, log) {
  const vars = Object.fromEntries(fs.readFileSync(cfg.atlasEnvFile, 'utf8').split('\n')
    .map((l) => /^\s*(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*"?([^"\r]*)"?\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  if (!vars.SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) { log('atlas refresh skipped: Supabase variables missing'); return false; }
  const src = path.join(cfg.stateDir, 'atlas-src');
  fs.rmSync(src, { recursive: true, force: true });
  let r = spawnSync('git', ['clone', '--quiet', '--no-checkout', mirror, src], { encoding: 'utf8', env: childEnv() });
  if (r.status === 0) r = spawnSync('git', ['-C', src, 'checkout', '--quiet', '--detach', sha], { encoding: 'utf8', env: childEnv() });
  if (r.status !== 0) { log(`atlas refresh checkout failed: ${r.stderr}`); return false; }
  r = spawnSync('docker', ['run', '--rm', '-v', `${src}:/w`, '-w', '/w',
    '-e', 'SUPABASE_URL', '-e', 'SUPABASE_SERVICE_ROLE_KEY',
    '-e', 'ATLAS_REFRESH_SOURCE_BRANCH=main', '-e', `ATLAS_REFRESH_SOURCE_COMMIT=${sha}`, '-e', 'ATLAS_REFRESH_OUTPUT_DIR=/tmp/atlas',
    'node:22', 'sh', '-c', 'npm ci --no-audit --no-fund --loglevel=error && node scripts/atlas-refresh.js --apply'],
  { encoding: 'utf8', env: { ...childEnv(), ...vars }, timeout: 15 * 60_000 });
  fs.rmSync(src, { recursive: true, force: true });
  const ok = r.status === 0;
  const tail = `${r.stdout}${r.stderr}`.split('\n').slice(-5).join(' | ');
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
