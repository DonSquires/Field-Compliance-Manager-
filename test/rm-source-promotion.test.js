import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  promotePhotos, promoteWorkbookVersion, recordOutcomes, runPromotion, serverRefusal, validateSourceMap, importActorRpc,
} from '../services/document-source-worker/source-promote.mjs';
import { loadSyncState } from '../services/document-source-worker/source-sync.mjs';

const PROVIDER = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const CLIENT = 'ff87e028-9b8e-4138-baf2-7aef54386442';
const WORKBOOK = 'ACTIVE ThomasBros camera and patrol log.xlsx';
const RELATIVE = `Patrol Log Entries/All Log Spreadsheets/${WORKBOOK}`;
const SHA = 'a'.repeat(64);

function sourceMap(overrides = {}) {
  return {
    version: 1,
    provider_organization_id: PROVIDER,
    classification_profile: 'rm_patrol_log',
    max_new_rows_per_sheet: 10,
    workbooks: {
      [WORKBOOK]: { sheets: [{ sheet: '2025', header_row: 1, client_code: 'THOMASBROS',
        client_organization_id: CLIENT, zone_map: 'thomasbros-zone-map.json' }] },
      'ACTIVE DIGGER log.xlsx': { hold: 'maintenance_workflow' },
    },
    ...overrides,
  };
}

const plan = (sha = SHA) => ({ mode: 'plan', source_sha256: sha,
  manifest: { client_code: 'THOMASBROS', target_client_organization_id: CLIENT } });

function deps({ planSha = SHA, namespace = 47, inserts = 2, status = 'ready', calls = [] } = {}) {
  return {
    exportPlan: async () => plan(planSha),
    namespaceEventCount: async () => namespace,
    syncPlan: async ({ commit }) => {
      calls.push(commit);
      return { status: commit ? 'committed' : status, batch_id: commit ? 'batch-1' : null,
        requested: { inserts, updates: 0, corrections: 0 }, plan_summary: {}, plan_hold_reasons: {} };
    },
  };
}

const version = { relative_path: RELATIVE, sha256: SHA };

test('the source map rejects shared namespaces and incomplete sheets', () => {
  assert.doesNotThrow(() => validateSourceMap(sourceMap()));
  const duplicate = sourceMap();
  duplicate.workbooks.other = { sheets: [{ ...duplicate.workbooks[WORKBOOK].sheets[0] }] };
  assert.throws(() => validateSourceMap(duplicate), /mapped twice/);
  const incomplete = sourceMap();
  incomplete.workbooks[WORKBOOK].sheets[0].client_organization_id = 'nope';
  assert.throws(() => validateSourceMap(incomplete), /incomplete/);
});

test('the reviewed R&M source map is valid', async () => {
  const map = JSON.parse(await readFile(new URL('../services/document-source-worker/rm-patrol-source-map.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateSourceMap(map));
});

test('unmapped and held workbooks never reach the writer', async () => {
  const calls = [];
  const held = await promoteWorkbookVersion({ version: { relative_path: 'Patrol Log Entries/All Log Spreadsheets/ACTIVE DIGGER log.xlsx', sha256: SHA },
    map: sourceMap(), commit: true, ...deps({ calls }) });
  assert.deepEqual([held.status, held.reason], ['held', 'maintenance_workflow']);
  const unmapped = await promoteWorkbookVersion({ version: { relative_path: 'Patrol Log Entries/All Log Spreadsheets/new.xlsx', sha256: SHA },
    map: sourceMap(), commit: true, ...deps({ calls }) });
  assert.deepEqual([unmapped.status, unmapped.reason], ['held', 'workbook_not_mapped']);
  assert.deepEqual(calls, []);
});

test('an unproven namespace or large change set is held before any commit', async () => {
  const calls = [];
  const namespace = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps({ namespace: 0, calls }) });
  assert.deepEqual([namespace.status, namespace.reason], ['held', 'sheet_namespace_unproven']);
  const volume = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps({ inserts: 11, calls }) });
  assert.deepEqual([volume.status, volume.reason], ['held', 'sheet_change_volume_review']);
  assert.deepEqual(calls, [false]);
});

test('a source that changed during export is stale and never committed', async () => {
  const calls = [];
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps({ planSha: 'b'.repeat(64), calls }) });
  assert.equal(result.status, 'stale');
  assert.deepEqual(calls, []);
});

test('dry runs preview only; commits produce a receipt bound to the scanned hash', async () => {
  const calls = [];
  const preview = await promoteWorkbookVersion({ version, map: sourceMap(), commit: false, ...deps({ calls }) });
  assert.equal(preview.status, 'previewed');
  assert.deepEqual(calls, [false]);
  const applied = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps({ calls }) });
  assert.deepEqual([applied.status, applied.receipt_id, applied.source_sha256, applied.inserted],
    ['applied', 'batches:batch-1', SHA, 2]);
  const unchanged = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true,
    ...deps({ status: 'no_source_changes', inserts: 0 }) });
  assert.deepEqual([unchanged.status, unchanged.receipt_id], ['applied', `unchanged:${SHA}`]);
});

test('photos attach only on a unique match, only when committing, and are never re-read once receipted', async () => {
  const entries = ['a', 'b', 'c'].map(name => ({ relative_path: `Photos/${name}.jpg`, size_bytes: 10, modified_at: 't1' }));
  const classified = [];
  const classify = async relativePath => {
    classified.push(relativePath);
    return relativePath.endsWith('a.jpg')
      ? { status: 'matched', row: { matchType: 'plate_time' } }
      : { status: relativePath.endsWith('b.jpg') ? 'ambiguous' : 'unnamed' };
  };
  const attached = [];
  const attach = async row => { attached.push(row); return { sha256: SHA, storage_path: 'org/x/photo.jpg' }; };
  const preview = await promotePhotos({ entries, classify, attach, commit: false, limit: 5 });
  assert.deepEqual(preview.results.map(item => item.status), ['previewed', 'held', 'ignored']);
  assert.deepEqual(preview.results.slice(1).map(item => item.reason), ['ambiguous_record_match', 'filename_not_structured']);
  assert.deepEqual(preview.receipts, {});
  assert.equal(attached.length, 0);
  const applied = await promotePhotos({ entries, classify, attach, commit: true, limit: 5 });
  assert.equal(applied.results[0].status, 'applied');
  assert.deepEqual(attached[0].fileInfo, entries[0]);
  assert.deepEqual(applied.receipts['Photos/a.jpg'], { key: '10:t1', sha256: SHA, receipt_id: 'evidence:org/x/photo.jpg' });
  classified.length = 0;
  const again = await promotePhotos({ entries: entries.slice(0, 1), receipts: applied.receipts, classify, attach, commit: true, limit: 5 });
  assert.equal(again.results[0].status, 'unchanged');
  assert.deepEqual(classified, []);
  const edited = await promotePhotos({ entries: [{ ...entries[0], modified_at: 't2' }], receipts: applied.receipts,
    classify, attach, commit: true, limit: 0 });
  assert.deepEqual([edited.results[0].status, edited.results[0].reason], ['deferred', 'photo_limit_reached']);
});

test('governed RPC refusals become holds; transport failures stay retryable', () => {
  const stdout = JSON.stringify({ _tag: 'Error', error: { message: 'unexpected status 400: {"message":"Failed to run sql query: ERROR:  P0001: Duplicate source headers require manual correction\nCONTEXT: x"}' } });
  assert.equal(serverRefusal({ stdout }), 'server_refused:duplicate_source_headers_require_manual_correction');
  assert.equal(serverRefusal({ stdout: '', message: 'connect ETIMEDOUT' }), null);
});

test('scanner state acknowledges applied receipts and records holds without acknowledging', () => {
  const state = { version: 1, files: {
    [RELATIVE]: { observed: { sha256: SHA }, availability: 'available', pending: true, hold: { sha256: SHA, reason: 'old' } },
    'Photos/a.jpg': { observed: { sha256: SHA }, availability: 'available', pending: true },
    'Photos/b.jpg': { observed: { sha256: SHA }, availability: 'available', pending: true },
  } };
  const next = recordOutcomes(state, [
    { status: 'applied', receipt_id: 'batches:1', source_relative_path: RELATIVE, source_sha256: SHA },
    { status: 'held', reason: 'no_exact_record_match', source_relative_path: 'Photos/a.jpg', source_sha256: SHA },
    { status: 'previewed', source_relative_path: 'Photos/b.jpg', source_sha256: SHA },
  ]);
  assert.equal(next.files[RELATIVE].pending, false);
  assert.equal(next.files[RELATIVE].hold, undefined);
  assert.deepEqual([next.files['Photos/a.jpg'].pending, next.files['Photos/a.jpg'].hold.reason], [true, 'no_exact_record_match']);
  assert.deepEqual(next.files['Photos/b.jpg'], state.files['Photos/b.jpg']);
});

test('a dry run end to end leaves every source version pending', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-promote-'));
  try {
    const folder = path.join(root, 'Patrol Log Entries', 'All Log Spreadsheets');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, WORKBOOK), 'workbook bytes');
    const statePath = path.join(root, 'state', 'sync.json');
    const calls = [];
    const promotionDeps = { ...deps({ calls }), exportPlan: async ({ version: scanned }) => plan(scanned.sha256) };
    const report = await runPromotion({ root, statePath, map: sourceMap(), deps: promotionDeps, settleMs: 0 });
    assert.equal(report.mode, 'dry_run');
    assert.equal(report.workbooks[0].status, 'previewed');
    assert.deepEqual(calls, [false]);
    const state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].pending, true);
    assert.equal(state.files[RELATIVE].acknowledged_sha256, undefined);
    const applied = await runPromotion({ root, statePath, map: sourceMap(), deps: promotionDeps, commit: true, settleMs: 0 });
    assert.equal(applied.workbooks[0].status, 'applied');
    assert.equal((await loadSyncState(statePath)).files[RELATIVE].pending, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('governed photo RPCs run as the import identity with typed, delimiter-safe arguments', async () => {
  const actor = 'f1c00000-0000-4000-8000-000000000001';
  let sql = '';
  const ok = await importActorRpc(text => { sql = text; return [{ result: 'evidence-id' }]; }, actor,
    'attach_external_photo_to_record', { p_record_kind: 'location_event', p_record_id: actor, p_captured_at: '2026-01-01T00:00:00Z' });
  assert.deepEqual(ok, { data: 'evidence-id', error: null });
  assert.match(sql, /set local request\.jwt\.claim\.sub = 'f1c00000-0000-4000-8000-000000000001'/);
  assert.match(sql, /p_record_id => \(SELECT \(a->>'p_record_id'\)::uuid FROM args\)/);
  assert.match(sql, /p_captured_at => \(SELECT \(a->>'p_captured_at'\)::timestamptz FROM args\)/);
  assert.match(sql, /p_record_kind => \(SELECT \(a->>'p_record_kind'\)::text FROM args\)/);
  const refused = await importActorRpc(() => { throw new Error('ERROR:  P0001: Record not found'); }, actor,
    'attach_external_photo_to_record', { p_record_kind: 'observation' });
  assert.equal(refused.data, null);
  assert.match(refused.error.message, /Record not found/);
  await assert.rejects(() => importActorRpc(() => [], actor, 'x; drop table y', {}), /Invalid governed RPC call/);
  await assert.rejects(() => importActorRpc(() => [], actor, 'f', { p_note: '$rpc_args$' }), /delimiter/);
});
