'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  keepModelsFromEnv,
  planOllamaRemovals,
  staleTempEntries,
  dockerPruneCommands,
  parseWorktreeList,
  worktreeFindings,
} = require('../scripts/laptop-storage-clean');

test('worktree porcelain output is parsed into path, branch and detached state', () => {
  const text = [
    'worktree C:/repo', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree C:/wt-a', 'HEAD bbb', 'detached', '',
  ].join('\n');
  assert.deepEqual(parseWorktreeList(text), [
    { path: 'C:/repo', branch: 'main', detached: false },
    { path: 'C:/wt-a', branch: null, detached: true },
  ]);
});

test('a main checkout off main or behind origin/main is reported', () => {
  const findings = worktreeFindings([
    { path: 'C:/repo', isMain: true, branch: null, detached: true, behind: 55, dirty: 3, merged: true },
  ]);
  assert.deepEqual(findings.map(f => f.issue), ['main checkout is not on main', 'main checkout is 55 commits behind origin/main']);
});

test('merged clean worktrees are flagged removable; uncommitted work is only flagged for review', () => {
  const findings = worktreeFindings([
    { path: 'C:/repo', isMain: true, branch: 'main', behind: 0, dirty: 0, merged: true },
    { path: 'C:/wt-done', branch: 'fix/a', behind: 200, dirty: 0, merged: true },
    { path: 'C:/wt-wip', branch: 'feat/b', behind: 40, dirty: 5, merged: true },
    { path: 'C:/wt-new', branch: 'fix/c', behind: 2, dirty: 1, merged: false },
    { path: 'C:/wt-fresh', branch: 'fix/d', behind: 0, dirty: 0, merged: true },
  ], { behindLimit: 30 });
  assert.deepEqual(findings, [
    { path: 'C:/wt-done', issue: 'merged and clean: safe to remove (git worktree remove)' },
    { path: 'C:/wt-wip', issue: '40 commits behind with 5 uncommitted changes: review before removing' },
  ]);
});

test('keep-list comes from the worker env, with the shipped defaults when unset', () => {
  const keep = keepModelsFromEnv({});
  for (const model of ['qwen2.5:7b', 'qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'qwen3:8b', 'qwen3-vl:4b']) {
    assert.ok(keep.has(model), `${model} must be kept by default`);
  }
  const custom = keepModelsFromEnv({ BOB_GPU_MODELS: 'llama3.1:8b, qwen3:8b', CCTV_VLM_MODEL: 'qwen3-vl:8b', GPU_WORKSTATION_MODEL: 'qwen2.5:7b' });
  assert.deepEqual([...custom].sort(), ['llama3.1:8b', 'qwen2.5:7b', 'qwen3-vl:8b', 'qwen3:8b']);
});

test('only installed models outside the keep-list are planned for removal', () => {
  const installed = ['qwen3-vl:4b', 'gpt-oss:20b', 'qwen3:8b', 'moondream:latest'];
  const keep = new Set(['qwen3-vl:4b', 'qwen3:8b']);
  assert.deepEqual(planOllamaRemovals(installed, keep), ['gpt-oss:20b', 'moondream:latest']);
});

test('a keep entry without a tag protects the :latest install', () => {
  assert.deepEqual(planOllamaRemovals(['moondream:latest'], new Set(['moondream'])), []);
});

test('temp entries are stale only when older than the cut-off', () => {
  const now = Date.parse('2026-11-14T00:00:00Z');
  const day = 86_400_000;
  const entries = [
    { path: 'a', mtimeMs: now - 8 * day },
    { path: 'b', mtimeMs: now - 2 * day },
    { path: 'c', mtimeMs: now - 7 * day - 1 },
  ];
  assert.deepEqual(staleTempEntries(entries, now, 7).map(e => e.path), ['a', 'c']);
});

test('a freshly extracted copy is not stale even when it keeps an old modified time', () => {
  const now = Date.parse('2026-11-14T00:00:00Z');
  const day = 86_400_000;
  const entries = [{ path: 'copied', mtimeMs: now - 30 * day, birthtimeMs: now - 3_600_000 }];
  assert.deepEqual(staleTempEntries(entries, now, 7), []);
});

test('orphaned native-module copies expire after one day, other temp after the default', () => {
  const now = Date.parse('2026-11-14T00:00:00Z');
  const day = 86_400_000;
  const entries = [
    { path: 'C:\\Temp\\.70a1b2c3d4e5f6a7-0000000000000000.node', mtimeMs: now - 2 * day },
    { path: 'C:\\Temp\\report.log', mtimeMs: now - 2 * day },
  ];
  assert.deepEqual(staleTempEntries(entries, now, 7).map(e => e.path), ['C:\\Temp\\.70a1b2c3d4e5f6a7-0000000000000000.node']);
});

test('docker prune never touches named volumes or images used in the last week', () => {
  const commands = dockerPruneCommands({ imageAgeHours: 168 });
  const joined = commands.map(c => c.join(' '));
  assert.ok(joined.includes('docker builder prune --all --force'));
  assert.ok(joined.includes('docker image prune --all --force --filter until=168h'));
  assert.ok(joined.includes('docker volume prune --force'), 'anonymous volumes only');
  assert.ok(!joined.some(c => /volume prune.*--all|system prune/.test(c)), 'named volumes and system prune are off-limits');
});
