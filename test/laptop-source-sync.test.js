import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadSyncState, saveSyncState, scanSourceChanges, pendingSourceVersions,
  acknowledgeSourceVersion, patrolSourcePaths,
  photoSourcePaths, runSourceScan,
} from '../services/document-source-worker/source-sync.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-source-sync-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state', 'sync.json');
  const state = await loadSyncState(statePath);
  await writeFile(path.join(root, 'log.xlsx'), 'first source version');
  const scan = current => scanSourceChanges({ root, relativePaths: ['log.xlsx'], state: current, settleMs: 0 });
  return { root, statePath, state, scan };
}

test('startup scan and persisted restart retain an unacknowledged source version', async context => {
  const { statePath, state, scan } = await fixture(context);
  const first = await scan(state);
  assert.equal(first.counts.changed, 1);
  await saveSyncState(statePath, first.state);
  const restarted = await scan(await loadSyncState(statePath));
  assert.equal(restarted.counts.unchanged, 1);
  assert.equal(pendingSourceVersions(restarted.state).length, 1);
});

test('receipt acknowledges only its version and offline edits become pending on restart', async context => {
  const { root, statePath, state, scan } = await fixture(context);
  const first = await scan(state);
  const version = pendingSourceVersions(first.state)[0];
  const acknowledged = acknowledgeSourceVersion(first.state, 'log.xlsx', {
    status: 'applied', receipt_id: 'receipt-1', source_sha256: version.sha256, source_relative_path: 'log.xlsx',
  });
  await saveSyncState(statePath, acknowledged);
  assert.equal(pendingSourceVersions((await scan(acknowledged)).state).length, 0);
  await writeFile(path.join(root, 'log.xlsx'), 'changed while worker was offline');
  const restarted = await scan(await loadSyncState(statePath));
  assert.equal(restarted.counts.changed, 1);
  assert.notEqual(pendingSourceVersions(restarted.state)[0].sha256, version.sha256);
  assert.equal(restarted.state.files['log.xlsx'].receipt_id, 'receipt-1');
  assert.throws(() => acknowledgeSourceVersion(restarted.state, 'log.xlsx', {
    status: 'applied', receipt_id: 'stale', source_sha256: version.sha256, source_relative_path: 'log.xlsx',
  }), /matching applied import receipt/);
});

test('failed or review-only receipts cannot mark a source imported', async context => {
  const { state, scan } = await fixture(context);
  const current = (await scan(state)).state;
  for (const status of ['failed', 'needs_review', 'staged']) {
    assert.throws(() => acknowledgeSourceVersion(current, 'log.xlsx', {
      status, receipt_id: 'not-applied', source_sha256: current.files['log.xlsx'].observed.sha256, source_relative_path: 'log.xlsx',
    }), /matching applied import receipt/);
  }
  assert.throws(() => acknowledgeSourceVersion(current, 'log.xlsx', {
    status: 'applied', receipt_id: 'different-file', source_sha256: current.files['log.xlsx'].observed.sha256,
    source_relative_path: 'another-log.xlsx',
  }), /matching applied import receipt/);
  assert.equal(pendingSourceVersions(current).length, 1);
});

test('missing sources preserve history without submitting stale content or deletion', async context => {
  const { root, state, scan } = await fixture(context);
  const first = await scan(state);
  await rm(path.join(root, 'log.xlsx'));
  const missing = await scan(first.state);
  assert.equal(missing.counts.unavailable, 1);
  assert.equal(missing.state.files['log.xlsx'].pending, true);
  assert.equal(pendingSourceVersions(missing.state).length, 0);
  await writeFile(path.join(root, 'log.xlsx'), 'returned source version');
  assert.equal(pendingSourceVersions((await scan(missing.state)).state).length, 1);
});

test('recent saves settle before becoming import candidates', async context => {
  const { root, state } = await fixture(context);
  const recent = await scanSourceChanges({ root, relativePaths: ['log.xlsx'], state, now: 0 });
  assert.equal(recent.counts.settling, 1);
  assert.deepEqual(pendingSourceVersions(recent.state), []);
});

test('a matching receipt cannot acknowledge a source that became unavailable or is still saving', async context => {
  const { state, scan } = await fixture(context);
  const current = (await scan(state)).state;
  const receipt = {
    status: 'applied', receipt_id: 'receipt-1',
    source_sha256: current.files['log.xlsx'].observed.sha256, source_relative_path: 'log.xlsx',
  };
  for (const availability of ['unavailable', 'settling']) {
    current.files['log.xlsx'].availability = availability;
    assert.throws(() => acknowledgeSourceVersion(current, 'log.xlsx', receipt), /matching applied import receipt/);
    assert.equal(current.files['log.xlsx'].pending, true);
  }
});

test('source traversal and symlink escape are refused', async context => {
  const { root, state } = await fixture(context);
  const outside = await mkdtemp(path.join(tmpdir(), 'fcm-source-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'anything.xlsx'), 'outside source');
  await mkdir(path.join(root, 'nested'));
  await symlink(outside, path.join(root, 'nested', 'outside'));
  for (const relativePath of ['../outside.xlsx', '/outside.xlsx', 'nested/../log.xlsx', 'nested/outside/anything.xlsx']) {
    await assert.rejects(scanSourceChanges({ root, relativePaths: [relativePath], state }), /Invalid relative|escaped its root|ENOENT/);
  }
});

test('corrupt checkpoint fails closed instead of reimporting every source', async context => {
  const { statePath, state } = await fixture(context);
  await saveSyncState(statePath, state);
  await writeFile(statePath, '{broken');
  await assert.rejects(loadSyncState(statePath), SyntaxError);
});

test('patrol allowlist is every reviewed source-map workbook and no inferred folder', async () => {
  const map = JSON.parse(await readFile(new URL('../services/document-source-worker/rm-patrol-source-map.json', import.meta.url), 'utf8'));
  const paths = patrolSourcePaths();
  assert.equal(paths.length, Object.keys(map.workbooks).length);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.includes('Patrol Log Entries/All Log Spreadsheets/ACTIVE Gibbons Property GIB.xlsx'));
  assert.ok(paths.includes('Patrol Log Entries/All Log Spreadsheets/ACTIVE MPC log.xlsx'));
  assert.ok(paths.includes('Patrol Log Entries/All Log Spreadsheets/ACTIVE CommunityCameras install and maintenance log CCL.xlsx'));
});

test('photo scan is recursive and excludes symlinks, lock files, and other document kinds', async context => {
  const { root } = await fixture(context);
  await mkdir(path.join(root, 'Photos', 'nested'), { recursive: true });
  await writeFile(path.join(root, 'Photos', 'nested', 'evidence.JPG'), 'photo');
  await writeFile(path.join(root, 'Photos', '~$lock.jpg'), 'lock');
  await writeFile(path.join(root, 'Photos', 'private.txt'), 'not a photo');
  await symlink(path.join(root, 'log.xlsx'), path.join(root, 'Photos', 'link.jpg'));
  assert.deepEqual(await photoSourcePaths(root), ['Photos/nested/evidence.JPG']);
});

test('complete scan queues requested workbooks and photos without claiming promotion', async context => {
  const { root, statePath } = await fixture(context);
  const workbook = patrolSourcePaths()[0];
  await mkdir(path.dirname(path.join(root, workbook)), { recursive: true });
  await writeFile(path.join(root, workbook), 'workbook version');
  await mkdir(path.join(root, 'Photos'));
  await writeFile(path.join(root, 'Photos', 'evidence.jpg'), 'photo version');
  const summary = await runSourceScan({ root, statePath, includePhotos: true, settleMs: 0 });
  assert.equal(summary.workbooks.changed, 1);
  assert.equal(summary.workbooks.unavailable, patrolSourcePaths().length - 1);
  assert.equal(summary.photos.changed, 1);
  assert.equal(summary.pending, 2);
  assert.equal(summary.promotion, 'not_connected');
  const restarted = await runSourceScan({ root, statePath, includePhotos: true, settleMs: 0 });
  assert.equal(restarted.pending, 2);
  assert.equal(restarted.workbooks.changed, 0);
  assert.equal(restarted.photos.changed, 0);
});

test('unavailable photo root does not lose pending workbook changes', async context => {
  const { root, statePath } = await fixture(context);
  const workbook = patrolSourcePaths()[0];
  await mkdir(path.dirname(path.join(root, workbook)), { recursive: true });
  await writeFile(path.join(root, workbook), 'workbook version');
  const summary = await runSourceScan({ root, statePath, includePhotos: true, settleMs: 0 });
  assert.equal(summary.pending, 1);
  assert.equal(summary.photos.unavailable, true);
  assert.equal(pendingSourceVersions(await loadSyncState(statePath)).length, 1);
});

test('removed photo files and offline photo roots retain history but cannot submit stale versions', async context => {
  const { root, statePath } = await fixture(context);
  await mkdir(path.join(root, 'Photos'));
  const photoPath = path.join(root, 'Photos', 'evidence.jpg');
  await writeFile(photoPath, 'photo');
  await runSourceScan({ root, statePath, includePhotos: true, settleMs: 0 });
  await rm(photoPath);
  const missingFile = await runSourceScan({ root, statePath, includePhotos: true, settleMs: 0 });
  assert.equal(missingFile.pending, 0);
  assert.equal((await loadSyncState(statePath)).files['Photos/evidence.jpg'].pending, true);
  await writeFile(photoPath, 'photo');
  assert.equal((await runSourceScan({ root, statePath, includePhotos: true, settleMs: 0 })).pending, 1);
  await rm(path.join(root, 'Photos'), { recursive: true });
  const offline = await runSourceScan({ root, statePath, includePhotos: true, settleMs: 0 });
  assert.equal(offline.photos.unavailable, true);
  assert.equal(offline.pending, 0);
  assert.equal((await loadSyncState(statePath)).files['Photos/evidence.jpg'].availability, 'unavailable');
});