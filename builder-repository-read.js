'use strict';

/**
 * Read-only views of the build's own repository for Bob's chat tools (repo_search / repo_read).
 *
 * Until 2026-09-26 those tools searched the GitLab lineage repository, so Bob gathered evidence
 * from a codebase that is not the one being built (owner ruling: single target build; GitLab is
 * history). These helpers answer from the control plane's own checkout of the target repository,
 * pinned to a commit, using only the git object database (`git grep <sha>`, `git show <sha>:path`)
 * so a concurrent Builder run's worktree is never touched.
 */

const { execFileSync } = require('node:child_process');

const SECRET_PATH = /(^|\/)((.*\.)?env(\..*)?|.*\.pem|.*\.key|.*secret.*|.*credential.*|id_rsa.*|id_ed25519.*)$/i;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_MATCHES = 100;
// Generated output is noise for a code search (a minified bundle matches everything).
const SEARCH_EXCLUDES = [':!**/dist/**', ':!**/node_modules/**', ':!**/*.min.js', ':!**/*.map', ':!**/package-lock.json', ':!**/pnpm-lock.yaml', ':!**/yarn.lock', ':!supabase/schema.sql'];

function git(cwd, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer });
}

/** A repository-relative path that cannot escape the tree or name secret material. */
function safeRepoPath(input) {
  const value = String(input ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || value.includes('\0')) return null;
  if (value.split('/').some((part) => part === '..' || part === '')) return null;
  if (SECRET_PATH.test(value)) return null;
  return value;
}

function safePathspec(input) {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  const value = safeRepoPath(input);
  if (!value) throw new Error('path must be a repository-relative directory or file without ".."');
  return value;
}

/** `git grep` over the tree at `sha`. Fixed-string by default; `regex` enables basic regex. */
function searchRepository({ sourceDir, sha, query, pathspec = null, limit = 30, regex = false }) {
  const term = String(query ?? '').trim();
  if (!term) throw new Error('query is required');
  if (term.length > 200) throw new Error('query is too long');
  const cap = Math.min(Math.max(Number(limit) || 30, 1), MAX_MATCHES);
  const spec = safePathspec(pathspec);
  const args = ['grep', '-n', '-I', '-i', regex ? '-E' : '-F', '-e', term, sha, '--', ...(spec ? [spec] : []), ...SEARCH_EXCLUDES];
  let out = '';
  try {
    out = git(sourceDir, args);
  } catch (error) {
    if (error && error.status === 1) return { matches: [], count: 0, capped: false }; // no matches
    throw new Error('repository search failed');
  }
  const matches = [];
  let total = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    // "<sha>:<path>:<line>:<text>"
    const m = line.match(/^[0-9a-f]{40}:([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    if (SECRET_PATH.test(m[1])) continue;
    total++;
    if (matches.length < cap) matches.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 400) });
  }
  return { matches, count: total, capped: total > matches.length };
}

/** Full text of one file at `sha` (bounded); the caller windows and redacts. */
function readRepositoryFile({ sourceDir, sha, path: filePath }) {
  const value = safeRepoPath(filePath);
  if (!value) throw Object.assign(new Error('path is not readable'), { code: 'FORBIDDEN' });
  let content;
  try {
    content = git(sourceDir, ['show', `${sha}:${value}`], { maxBuffer: MAX_FILE_BYTES * 4 });
  } catch (error) {
    const text = String(error && error.stderr || '');
    if (/does not exist|exists on disk, but not in|invalid object name|bad revision/i.test(text)) throw Object.assign(new Error(`file not found: ${value}`), { code: 'NOT_FOUND' });
    throw new Error('repository read failed');
  }
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) content = `${content.slice(0, MAX_FILE_BYTES)}\n…[truncated at ${MAX_FILE_BYTES} bytes]`;
  if (content.includes('\0')) throw Object.assign(new Error('binary files are not readable'), { code: 'FORBIDDEN' });
  return { path: value, content, bytes: Buffer.byteLength(content) };
}

/** Entries of one directory at `sha`. */
function listRepositoryTree({ sourceDir, sha, path: dirPath = '' }) {
  const value = dirPath ? safeRepoPath(dirPath) : '';
  if (dirPath && !value) throw Object.assign(new Error('path is not readable'), { code: 'FORBIDDEN' });
  let out;
  try {
    out = git(sourceDir, ['ls-tree', '--name-only', '-z', value ? `${sha}:${value}` : sha]);
  } catch {
    throw Object.assign(new Error(`directory not found: ${value || '/'}`), { code: 'NOT_FOUND' });
  }
  const entries = out.split('\0').filter(Boolean).filter((name) => !SECRET_PATH.test(name)).sort().slice(0, 500);
  return { path: value, entries };
}

module.exports = { MAX_FILE_BYTES, MAX_MATCHES, SECRET_PATH, listRepositoryTree, readRepositoryFile, safeRepoPath, searchRepository };
