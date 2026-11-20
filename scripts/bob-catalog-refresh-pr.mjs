#!/usr/bin/env node
// Release-lane catalog refresh: after merged migrations are applied live, commit the regenerated
// supabase/schema.sql and src/types/database.ts on a bob/catalog-<sha8> branch, open a pull request
// and rebase-merge it to preserve the verified commit author. The owner's merge of the migration is
// the approval (owner ruling
// 2026-10-21); this change is mechanical, so it may contain only those two generated files.
//
//   node scripts/bob-catalog-refresh-pr.mjs --repo <git dir> --base <sha> --schema <live schema.sql>
// Gitea is the source of truth (owner ruling 2026-11-21), so by default the PR is opened in Gitea and
// merged with "merge when checks succeed" (Gitea main requires PR verification); GitHub only mirrors.
// Env (gitea, default): SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, GITEA_BASE_URL, GITEA_OWNER,
//      GITEA_REPO, GITEA_TOKEN (write:repository).
// Env (BOB_CATALOG_FORGE=github, legacy): BOB_GITHUB_ACCESS_TOKEN, GITHUB_OWNER, GITHUB_REPO,
//      GIT_SSH_COMMAND (deploy key) and BOB_CATALOG_REMOTE (git@github.com:owner/repo.git).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CATALOG_FILES = Object.freeze(['supabase/schema.sql', 'src/types/database.ts']);
const VERIFIED_AUTHOR_NAME = 'DonSquires';
const VERIFIED_AUTHOR_EMAIL = 'squires.don@gmail.com';
const VERIFIED_COMMITTER_NAME = VERIFIED_AUTHOR_NAME;
const VERIFIED_COMMITTER_EMAIL = VERIFIED_AUTHOR_EMAIL;

export function onlyCatalogFiles(files) {
  return files.length > 0 && files.every(file => CATALOG_FILES.includes(file));
}

async function fetchTypes({ projectRef, token, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/types/typescript?included_schemas=public`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`type generation failed: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body?.types !== 'string' || !body.types.includes('export type Database')) throw new Error('type generation returned no Database type');
  return body.types;
}

async function github({ token, method = 'GET', url, body, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

async function gitea({ baseUrl, token, method = 'GET', url, body, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/v1${url}`, {
    method,
    headers: { Authorization: `token ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, data };
}

export async function refreshCatalog({ repo, base, schema, env = process.env, fetchImpl = fetch, log = console.error }) {
  const forge = env.BOB_CATALOG_FORGE || 'gitea';
  if (forge !== 'gitea' && forge !== 'github') throw new Error(`unknown BOB_CATALOG_FORGE ${forge}`);
  const supabaseToken = env.SUPABASE_ACCESS_TOKEN;
  const githubToken = env.BOB_GITHUB_ACCESS_TOKEN;
  const owner = forge === 'gitea' ? env.GITEA_OWNER : env.GITHUB_OWNER;
  const name = forge === 'gitea' ? env.GITEA_REPO : env.GITHUB_REPO;
  const giteaBase = env.GITEA_BASE_URL;
  const giteaToken = env.GITEA_TOKEN;
  // Gitea pushes authenticate with a header, never a token in the URL; BOB_CATALOG_GITEA_REMOTE is a test seam.
  const remote = forge === 'gitea' ? (env.BOB_CATALOG_GITEA_REMOTE || (giteaBase && `${giteaBase.replace(/\/$/, '')}/${owner}/${name}.git`)) : env.BOB_CATALOG_REMOTE;
  const pushAuth = forge === 'gitea' && giteaToken ? ['-c', `http.extraheader=Authorization: token ${giteaToken}`] : [];
  const projectRef = env.SUPABASE_PROJECT_REF || 'dotczcyyzgabmtmnglqj';
  if (forge === 'gitea' && (!supabaseToken || !giteaBase || !giteaToken || !owner || !name)) throw new Error('catalog refresh needs SUPABASE_ACCESS_TOKEN, GITEA_BASE_URL, GITEA_OWNER, GITEA_REPO and GITEA_TOKEN');
  if (forge === 'github' && (!supabaseToken || !githubToken || !owner || !name || !remote)) throw new Error('catalog refresh needs SUPABASE_ACCESS_TOKEN, BOB_GITHUB_ACCESS_TOKEN, GITHUB_OWNER, GITHUB_REPO and BOB_CATALOG_REMOTE');
  const configuredIdentity = [
    env.GIT_AUTHOR_NAME ?? VERIFIED_AUTHOR_NAME,
    env.GIT_AUTHOR_EMAIL ?? VERIFIED_AUTHOR_EMAIL,
    env.GIT_COMMITTER_NAME ?? VERIFIED_COMMITTER_NAME,
    env.GIT_COMMITTER_EMAIL ?? VERIFIED_COMMITTER_EMAIL,
  ];
  if (configuredIdentity[0] !== VERIFIED_AUTHOR_NAME || configuredIdentity[1] !== VERIFIED_AUTHOR_EMAIL
    || configuredIdentity[2] !== VERIFIED_COMMITTER_NAME || configuredIdentity[3] !== VERIFIED_COMMITTER_EMAIL) {
    throw new Error('catalog refresh refused: configured Git identity is not the verified GitHub identity');
  }
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('base must be a full commit sha');
  const branch = `bob/catalog-${base.slice(0, 8)}`;
  const types = await fetchTypes({ projectRef, token: supabaseToken, fetchImpl });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-catalog-'));
  const git = (args, opts = {}) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', work, base], { stdio: 'pipe' });
    fs.copyFileSync(schema, path.join(work, 'supabase/schema.sql'));
    fs.writeFileSync(path.join(work, 'src/types/database.ts'), types);
    const changed = git(['diff', '--name-only']).split('\n').filter(Boolean).sort();
    if (!changed.length) return { outcome: 'unchanged', branch };
    if (!onlyCatalogFiles(changed)) throw new Error(`catalog refresh touched unexpected files: ${changed.join(', ')}`);
    // -B: a scheduled (not yet merged) refresh is retried on the next tick with the same branch name.
    git(['checkout', '-q', '-B', branch]);
    git(['add', '--', ...changed]);
    git(['-c', `user.name=${VERIFIED_AUTHOR_NAME}`, '-c', `user.email=${VERIFIED_AUTHOR_EMAIL}`, 'commit', '-q', '-m', `Refresh live catalog after release ${base.slice(0, 8)}`,
      '-m', 'Regenerated by the release lane from the live database after applying merged migrations: supabase/schema.sql (live catalog snapshot) and src/types/database.ts (Supabase type generator). No hand edits.'], {
      env: { ...process.env, GIT_AUTHOR_NAME: VERIFIED_AUTHOR_NAME, GIT_AUTHOR_EMAIL: VERIFIED_AUTHOR_EMAIL, GIT_COMMITTER_NAME: VERIFIED_COMMITTER_NAME, GIT_COMMITTER_EMAIL: VERIFIED_COMMITTER_EMAIL },
    });
    const head = git(['rev-parse', 'HEAD']);
    const identity = git(['show', '-s', '--format=%an <%ae>%n%cn <%ce>', head]).split('\n');
    const verifiedIdentity = [`${VERIFIED_AUTHOR_NAME} <${VERIFIED_AUTHOR_EMAIL}>`, `${VERIFIED_COMMITTER_NAME} <${VERIFIED_COMMITTER_EMAIL}>`];
    if (identity.length !== 2 || identity.some((value, index) => value !== verifiedIdentity[index])) {
      throw new Error('catalog refresh refused: generated commit identity is not the verified GitHub identity');
    }
    git([...pushAuth, 'push', '-q', '--force', remote, `HEAD:refs/heads/${branch}`]);
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    if (forge === 'gitea') return await openAndMergeOnGitea({ baseUrl: giteaBase, token: giteaToken, repoPath, branch, base, head, changed, fetchImpl, log });
    const existing = await github({ token: githubToken, url: `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, fetchImpl });
    let pull = existing.ok && Array.isArray(existing.data) ? existing.data[0] : null;
    if (!pull) {
      const created = await github({ token: githubToken, method: 'POST', url: `${repoPath}/pulls`, fetchImpl, body: {
        base: 'main', head: branch, title: `Bob: refresh live catalog after release ${base.slice(0, 8)}`,
        body: `The release lane applied merged migrations and the live catalog no longer matched the committed snapshot. This PR contains only the regenerated ${CATALOG_FILES.map(f => `\`${f}\``).join(' and ')}; the migration's merge was the approval, so Bob merges it.`,
      } });
      if (!created.ok) throw new Error(`pull request creation failed: HTTP ${created.status}`);
      pull = created.data;
    }
    const files = await github({ token: githubToken, url: `${repoPath}/pulls/${pull.number}/files`, fetchImpl });
    if (!files.ok || !onlyCatalogFiles(files.data.map(f => f.filename))) throw new Error(`pull request #${pull.number} is not catalog-only; left for a person`);
    const merged = await github({ token: githubToken, method: 'PUT', url: `${repoPath}/pulls/${pull.number}/merge`, fetchImpl, body: { sha: head, merge_method: 'rebase' } });
    if (!merged.ok || merged.data?.merged !== true) throw new Error(`pull request #${pull.number} did not merge: HTTP ${merged.status}`);
    log(`catalog refresh #${pull.number} merged as ${merged.data.sha}`);
    return { outcome: 'merged', branch, number: pull.number, sha: merged.data.sha, files: changed };
  } finally {
    try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', work], { stdio: 'pipe' }); } catch { fs.rmSync(work, { recursive: true, force: true }); }
  }
}

async function openAndMergeOnGitea({ baseUrl, token, repoPath, branch, base, head, changed, fetchImpl, log }) {
  const api = (method, url, body) => gitea({ baseUrl, token, method, url, body, fetchImpl });
  const open = await api('GET', `${repoPath}/pulls?state=open&limit=50`);
  let pull = open.ok && Array.isArray(open.data) ? open.data.find(p => p.head?.ref === branch && p.base?.ref === 'main') : null;
  if (!pull) {
    const created = await api('POST', `${repoPath}/pulls`, {
      base: 'main', head: branch, title: `Bob: refresh live catalog after release ${base.slice(0, 8)}`,
      body: `The release lane applied merged migrations and the live catalog no longer matched the committed snapshot. This PR contains only the regenerated ${CATALOG_FILES.map(f => `\`${f}\``).join(' and ')}; the migration's merge was the approval, so Bob merges it once PR verification passes.`,
    });
    if (!created.ok) throw new Error(`pull request creation failed: HTTP ${created.status}`);
    pull = created.data;
  }
  const files = await api('GET', `${repoPath}/pulls/${pull.number}/files?limit=50`);
  if (!files.ok || !Array.isArray(files.data) || !onlyCatalogFiles(files.data.map(f => f.filename))) throw new Error(`pull request #${pull.number} is not catalog-only; left for a person`);
  // Gitea main requires PR verification: merge now if it already passed, otherwise schedule the merge.
  const merge = await api('POST', `${repoPath}/pulls/${pull.number}/merge`, { Do: 'rebase', head_commit_id: head, merge_when_checks_succeed: true });
  const after = await api('GET', `${repoPath}/pulls/${pull.number}`);
  if (after.ok && after.data?.merged) {
    log(`catalog refresh #${pull.number} merged as ${after.data.merge_commit_sha}`);
    return { outcome: 'merged', branch, number: pull.number, sha: after.data.merge_commit_sha, files: changed };
  }
  // 409: a merge is already scheduled for this head (a previous tick); anything else is a failure.
  if (!merge.ok && merge.status !== 409) throw new Error(`pull request #${pull.number} could not be merged or scheduled: HTTP ${merge.status}`);
  log(`catalog refresh #${pull.number} scheduled to merge when PR verification passes`);
  return { outcome: 'scheduled', branch, number: pull.number, files: changed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  refreshCatalog({ repo: arg('--repo'), base: arg('--base'), schema: arg('--schema') })
    .then(result => { console.log(JSON.stringify(result)); })
    .catch(error => {
      let message = String(error?.message || error).replace(/(sbp_|gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***');
      if (process.env.GITEA_TOKEN) message = message.split(process.env.GITEA_TOKEN).join('***');
      console.error(message);
      process.exit(1);
    });
}
