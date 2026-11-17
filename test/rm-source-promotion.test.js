import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireSourceLock, promotePhotos, promoteWorkbookVersion, recordOutcomes, runPromotion, serverRefusal, validateSourceMap, importActorRpc,
} from '../services/document-source-worker/source-promote.mjs';
import { loadSyncState, runSourceScan } from '../services/document-source-worker/source-sync.mjs';

test('a source lock left by a dead run is reclaimed; a live or fresh lock still blocks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fcm-lock-'));
  const lockPath = path.join(dir, 'state.json.lock');
  try {
    await writeFile(lockPath, '424242');
    await assert.rejects(acquireSourceLock(lockPath, { isAlive: () => true }), /holds the source lock/);
    const reclaimed = await acquireSourceLock(lockPath, { isAlive: () => false });
    await reclaimed.close();
    assert.equal(await readFile(lockPath, 'utf8'), String(process.pid));
    await writeFile(lockPath, '');
    await assert.rejects(acquireSourceLock(lockPath), /holds the source lock/, 'an empty lock may be a run still starting');
    const later = await acquireSourceLock(lockPath, { now: () => Date.now() + 11 * 60 * 1000 });
    await later.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent stale-lock recovery never gives two runs the source lock', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fcm-lock-race-'));
  const lockPath = path.join(dir, 'state.json.lock');
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await writeFile(lockPath, '2147483647');
      const results = await Promise.allSettled(Array.from({ length: 32 }, () =>
        acquireSourceLock(lockPath, { isAlive: pid => pid === process.pid })));
      const acquired = results.filter(result => result.status === 'fulfilled').map(result => result.value);
      await Promise.all(acquired.map(lock => lock.close()));
      await rm(lockPath, { force: true });
      assert.equal(acquired.length, 1, `attempt ${attempt + 1} allowed ${acquired.length} concurrent owners`);
      for (const result of results.filter(result => result.status === 'rejected')) {
        assert.match(result.reason.message, /holds the source lock/);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted stale-lock recovery remains held for manual review', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fcm-lock-recovery-'));
  const lockPath = path.join(dir, 'state.json.lock');
  try {
    await writeFile(lockPath, '2147483647');
    await writeFile(`${lockPath}.recovery`, '2147483647');
    await assert.rejects(acquireSourceLock(lockPath, { isAlive: () => false }), /recovery.*review/i);
    assert.equal(await readFile(lockPath, 'utf8'), '2147483647');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test('daily source promotion scans all mapped clients and imports records and photos', async () => {
  const runner = await readFile(new URL('../scripts/run-rm-source-promotion.ps1', import.meta.url), 'utf8');
  assert.match(runner, /\[ValidateRange\(1,\s*5000\)\]\[int\]\$PhotoLimit\s*=\s*5000/);
  assert.match(runner, /--commit --photos --photo-limit \$PhotoLimit/);
  assert.doesNotMatch(runner, /--only/);
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

test('source place conflicts hold the workbook without syncing safe rows', async () => {
  const calls = [];
  const result = await promoteWorkbookVersion({
    version, map: sourceMap(), commit: true,
    exportPlan: async () => ({ ...plan(), unresolved_places: [
      { name: null, reason: 'conflicting_place_fields', source_rows: [7, 9] },
    ] }),
    namespaceEventCount: async () => 1,
    registerPlaces: async () => { throw new Error('conflicting places must not be registered'); },
    syncPlan: async ({ commit }) => {
      calls.push(commit);
      return { status: 'partial_source_place_holds', batch_id: commit ? 'batch-1' : null,
        requested: { inserts: 1, updates: 0 }, plan_summary: { hold: 2 },
        plan_hold_reasons: { conflicting_place_fields: 2 }, summary: {} };
    },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_conflicting_place_fields');
  assert.equal(result.sheets[0].conflicting_rows, 2);
  assert.deepEqual(result.sheets[0].source_rows, [7, 9]);
  assert.equal(result.sheets[0].batch_id, undefined);
  assert.deepEqual(calls, [false]);
  const state = { version: 1, files: { [RELATIVE]: { pending: true, availability: 'available', observed: { sha256: SHA } } } };
  const recorded = recordOutcomes(state, [result]);
  assert.equal(recorded.files[RELATIVE].pending, true);
  assert.equal(recorded.files[RELATIVE].hold.reason, 'sheet_conflicting_place_fields');
});

test('a conflicting sheet previews unknown-place registration without creating places', async () => {
  const registrations = [];
  const calls = [];
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps({ calls }),
    exportPlan: async () => ({ ...plan(), unresolved_places: [
      { name: null, reason: 'conflicting_place_fields', source_rows: [7] },
      { name: 'Unmapped place', reserve_codes: [], locations: ['Unmapped place'], source_rows: [8] },
    ] }),
    registerPlaces: async ({ commit }) => {
      registrations.push(commit);
      return [{ name: 'Unmapped place', status: 'created', zone_id: 'zone-new', agreement_linked: true }];
    },
  });
  assert.equal(result.status, 'held');
  assert.deepEqual(registrations, [false]);
  assert.equal(result.sheets[0].place_registration, 'preview');
  assert.deepEqual(calls, [false]);
});

test('existing-place review holds stop the sheet whether safe rows are present or not', async () => {
  for (const inserts of [0, 1]) {
    const calls = [];
    const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true,
      exportPlan: async () => plan(), namespaceEventCount: async () => 1,
      syncPlan: async ({ commit }) => {
        calls.push(commit);
        return { status: inserts ? 'partial_source_place_holds' : 'source_rows_held',
          batch_id: commit ? 'batch-1' : null, requested: { inserts, updates: 0 },
          plan_summary: { hold: 1 }, plan_hold_reasons: { source_place_difference_requires_review: 1 },
          summary: { hold_reasons: {} } };
      },
    });
    assert.equal(result.status, 'held');
    assert.equal(result.reason, 'sheet_source_place_difference_requires_review');
    assert.deepEqual(calls, [false]);
    const state = { version: 1, files: { [RELATIVE]: { pending: true, availability: 'available', observed: { sha256: SHA } } } };
    assert.equal(recordOutcomes(state, [result]).files[RELATIVE].pending, true);
  }
});

test('financial review holds stop promotion and stay visible without an applied receipt', async () => {
  const calls = [];
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true,
    exportPlan: async () => plan(), namespaceEventCount: async () => 1,
    syncPlan: async ({ commit }) => {
      calls.push(commit);
      return { status: 'source_rows_held', requested: { inserts: 1, updates: 0 },
        plan_summary: { hold: 1 }, plan_hold_reasons: { source_financial_values_require_review: 1 } };
    },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_source_financial_values_require_review');
  assert.equal(result.sheets[0].batch_id, undefined);
  assert.deepEqual(calls, [false]);
  const state = { version: 1, files: { [RELATIVE]: { pending: true, availability: 'available', observed: { sha256: SHA } } } };
  assert.equal(recordOutcomes(state, [result]).files[RELATIVE].pending, true);
});

test('a financial hold is found before even a rolled-back place registration', async () => {
  for (const financial of [
    { events: [{ external_ref: 'row-1', payload: { job_cost: 8675309.42 } }] },
    { financial_source_present: true, events: [] },
  ]) {
    const calls = [];
    const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true,
      exportPlan: async () => ({ ...plan(), ...financial, unresolved_places: unresolved(1) }),
      namespaceEventCount: async () => 1,
      registerPlaces: async () => { calls.push('registration'); throw new Error('Unexpected database write'); },
      syncPlan: async () => { calls.push('sync'); throw new Error('Unexpected database write'); },
    });
    assert.equal(result.status, 'held');
    assert.equal(result.reason, 'sheet_source_financial_values_require_review');
    assert.deepEqual(calls, []);
    assert.doesNotMatch(JSON.stringify(result), /8675309\.42/);
  }
});

test('server-held preview rows do not start a committed sync', async () => {
  const calls = [];
  const externalRef = 'rm_patrol_import:THOMASBROS:42';
  const recordId = '10000000-0000-4000-8000-000000000004';
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true,
    exportPlan: async () => ({ ...plan(), events: [{ external_ref: externalRef, payload: { source_row: 7 } }],
      observations: [] }), namespaceEventCount: async () => 1,
    syncPlan: async ({ commit }) => {
      calls.push(commit);
      return { status: 'completed', batch_id: commit ? 'batch-1' : null,
        requested: { inserts: 1, updates: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {},
        plan_hold_samples: [],
        results: [{ phase: 'update', external_ref: externalRef, record_id: recordId, outcome: 'held',
          detail: 'place_outside_contracted_patrol_coverage' }],
        summary: { hold_reasons: { 'update:place_outside_contracted_patrol_coverage': 1 } } };
    },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_source_rows_need_review');
  assert.deepEqual(result.sheets[0].held_rows, [{ phase: 'update', external_ref: externalRef,
    record_id: recordId, source_row: 7, reason: 'place_outside_contracted_patrol_coverage' }]);
  assert.equal(result.sheets[0].batch_id, undefined);
  assert.deepEqual(calls, [false]);
});

test('a later held sheet prevents earlier sheet sync and place registration', async () => {
  const map = sourceMap();
  map.workbooks[WORKBOOK].sheets.push({ ...map.workbooks[WORKBOOK].sheets[0], sheet: '2026', client_code: 'THOMAS2026' });
  const calls = [];
  const registrations = [];
  const result = await promoteWorkbookVersion({ version, map, commit: true, ...deps(),
    exportPlan: async ({ sheet, placeOverlay: overlay }) => ({
      ...plan(), manifest: { client_code: sheet.client_code, target_client_organization_id: CLIENT },
      unresolved_places: sheet.client_code === 'THOMASBROS' && !overlay ? unresolved(1) : [],
    }),
    registerPlaces: async ({ commit }) => {
      registrations.push(commit);
      return [{ name: 'New Place 0', status: 'created', zone_id: 'zone-new', agreement_linked: true }];
    },
    syncPlan: async ({ sourcePlan, commit }) => {
      calls.push([sourcePlan.manifest.client_code, commit]);
      return { status: 'ready', requested: { inserts: 1, updates: 0 },
        plan_summary: { hold: sourcePlan.manifest.client_code === 'THOMAS2026' ? 1 : 0 },
        plan_hold_reasons: sourcePlan.manifest.client_code === 'THOMAS2026' ? { source_place_difference_requires_review: 1 } : {},
        summary: { hold_reasons: {} } };
    },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_new_places_require_review');
  assert.equal(result.sheets[1].reason, 'source_place_difference_requires_review');
  assert.ok(calls.every(([, commit]) => !commit));
  assert.deepEqual(registrations, [false]);
});

test('a later sheet failure holds recovery evidence across source versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-promote-partial-'));
  try {
    const folder = path.join(root, 'Patrol Log Entries', 'All Log Spreadsheets');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, WORKBOOK), 'workbook bytes');
    const statePath = path.join(root, 'state', 'sync.json');
    const map = sourceMap();
    map.workbooks[WORKBOOK].sheets.push({ ...map.workbooks[WORKBOOK].sheets[0], sheet: '2026', client_code: 'THOMAS2026' });
    let syncCalls = 0;
    const promotionDeps = {
      exportPlan: async ({ version: scanned, sheet }) => ({
        ...plan(scanned.sha256), manifest: { client_code: sheet.client_code, target_client_organization_id: CLIENT },
      }),
      namespaceEventCount: async () => 1,
      syncPlan: async ({ sourcePlan, commit }) => {
        syncCalls += 1;
        if (commit && sourcePlan.manifest.client_code === 'THOMAS2026') throw new Error('connection reset');
        return { status: commit ? 'completed' : 'ready', batch_id: commit ? 'batch-1' : null,
          requested: { inserts: 1, updates: 0 }, plan_summary: { hold: 0 }, plan_hold_reasons: {}, summary: {} };
      },
    };
    const report = await runPromotion({ root, statePath, map, commit: true, settleMs: 0, deps: promotionDeps });
    assert.equal(report.workbooks[0].status, 'held');
    assert.equal(report.workbooks[0].reason, 'partial_commit_review');
    assert.equal(report.workbooks[0].partial_commit, true);
    assert.deepEqual(report.workbooks[0].completed_sheets, ['THOMASBROS']);
    let state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].pending, true);
    assert.equal(state.files[RELATIVE].acknowledged_sha256, undefined);
    assert.equal(state.files[RELATIVE].hold.recovery.partial_commit, true);
    assert.deepEqual(state.files[RELATIVE].hold.recovery.completed_sheets, ['THOMASBROS']);
    const originalHash = state.files[RELATIVE].hold.sha256;
    const callsBefore = syncCalls;
    await writeFile(path.join(folder, WORKBOOK), 'new workbook bytes');
    const next = await runPromotion({ root, statePath, map, commit: true, settleMs: 0, deps: promotionDeps });
    assert.deepEqual(next.workbooks, []);
    assert.equal(syncCalls, callsBefore);
    const genericRecheck = await runPromotion({ root, statePath, map, commit: true, settleMs: 0,
      recheckHolds: true, deps: promotionDeps });
    assert.deepEqual(genericRecheck.workbooks, []);
    assert.equal(syncCalls, callsBefore);
    state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].pending, true);
    assert.equal(state.files[RELATIVE].hold.recovery.partial_commit, true);
    const dryRecheck = await runPromotion({ root, statePath, map, commit: false, settleMs: 0,
      recheckHolds: true, deps: promotionDeps });
    assert.equal(dryRecheck.workbooks[0].status, 'previewed');
    state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].hold.recovery.partial_commit, true);
    const stillHeld = await runPromotion({ root, statePath, map, commit: true, settleMs: 0,
      only: WORKBOOK, recheckHolds: true, confirmPartialReviewed: true, deps: {
        ...promotionDeps,
        syncPlan: async ({ sourcePlan }) => sourcePlan.manifest.client_code === 'THOMAS2026'
          ? { status: 'source_rows_held', requested: { inserts: 0 }, plan_summary: { hold: 1 },
            plan_hold_reasons: { unresolved_source_place: 1 } }
          : { status: 'ready', requested: { inserts: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {} },
      } });
    assert.equal(stillHeld.workbooks[0].status, 'held');
    state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].hold.recovery.partial_commit, true);
    assert.deepEqual(state.files[RELATIVE].hold.recovery.batch_ids, ['batch-1']);
    assert.ok(state.files[RELATIVE].hold.recovery.source_versions.includes(originalHash));
    await assert.rejects(runPromotion({ root, statePath, map, commit: true, settleMs: 0,
      recheckHolds: true, confirmPartialReviewed: true, deps: promotionDeps }), /select exactly one mapped workbook/);
    const recovered = await runPromotion({ root, statePath, map, commit: true, settleMs: 0,
      only: WORKBOOK, recheckHolds: true, confirmPartialReviewed: true, deps: {
        ...promotionDeps,
        syncPlan: async ({ commit }) => ({ status: commit ? 'completed' : 'ready', batch_id: commit ? 'batch-2' : null,
          requested: { inserts: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {}, summary: {} }),
      } });
    assert.equal(recovered.workbooks[0].status, 'applied');
    state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].pending, false);
    assert.equal(state.files[RELATIVE].hold, undefined);
    assert.deepEqual(state.files[RELATIVE].recovery_history[0].batch_ids, ['batch-1', 'batch-2']);
    assert.ok(state.files[RELATIVE].recovery_history[0].source_versions.includes(originalHash));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a recovery hold remains pending and reviewable when the workbook reverts to its acknowledged version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-promote-reverted-'));
  const folder = path.join(root, 'Patrol Log Entries', 'All Log Spreadsheets');
  const statePath = path.join(root, 'state.json');
  let failWrite = false;
  let committedWrites = 0;
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, WORKBOOK), 'original workbook');
    const promotionDeps = {
      exportPlan: async ({ version: scanned }) => plan(scanned.sha256),
      namespaceEventCount: async () => 1,
      syncPlan: async ({ commit }) => {
        if (commit) {
          committedWrites += 1;
          if (failWrite) {
            const error = new Error('connection reset after request');
            error.sourceSyncWriteAttempted = true;
            throw error;
          }
        }
        return { status: commit ? 'completed' : 'ready', batch_id: commit ? 'batch-1' : null,
          requested: { inserts: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {}, summary: {} };
      },
    };
    const first = await runPromotion({ root, statePath, map: sourceMap(), commit: true, settleMs: 0, deps: promotionDeps });
    assert.equal(first.workbooks[0].status, 'applied');
    const acknowledged = (await loadSyncState(statePath)).files[RELATIVE].acknowledged_sha256;

    await writeFile(path.join(folder, WORKBOOK), 'changed workbook');
    failWrite = true;
    const interrupted = await runPromotion({ root, statePath, map: sourceMap(), commit: true, settleMs: 0, deps: promotionDeps });
    assert.equal(interrupted.workbooks[0].reason, 'possible_partial_commit_review');
    const writesBeforeReversion = committedWrites;

    await writeFile(path.join(folder, WORKBOOK), 'original workbook');
    failWrite = false;
    const reverted = await runPromotion({ root, statePath, map: sourceMap(), commit: true, settleMs: 0, deps: promotionDeps });
    assert.equal(reverted.remaining_pending, 1);
    assert.equal(committedWrites, writesBeforeReversion);
    let state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].pending, true);
    assert.equal(state.files[RELATIVE].observed.sha256, acknowledged);
    assert.equal(state.files[RELATIVE].hold.recovery.partial_commit_possible, true);

    const review = await runPromotion({ root, statePath, map: sourceMap(), commit: false, settleMs: 0,
      recheckHolds: true, deps: promotionDeps });
    assert.equal(review.workbooks[0].status, 'previewed');
    const recovered = await runPromotion({ root, statePath, map: sourceMap(), commit: true, settleMs: 0,
      only: WORKBOOK, recheckHolds: true, confirmPartialReviewed: true, deps: promotionDeps });
    assert.equal(recovered.workbooks[0].status, 'applied');
    state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].pending, false);
    assert.equal(state.files[RELATIVE].hold, undefined);
    assert.equal(state.files[RELATIVE].recovery_history.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a first-sheet transport failure after a possible write requires review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-source-possible-'));
  const folder = path.join(root, 'Patrol Log Entries', 'All Log Spreadsheets');
  const statePath = path.join(root, 'state.json');
  let stateAtWrite;
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, WORKBOOK), 'workbook bytes');
    const report = await runPromotion({ root, statePath, map: sourceMap(), commit: true, settleMs: 0, deps: {
      exportPlan: async ({ version: scanned }) => plan(scanned.sha256),
      namespaceEventCount: async () => 1,
      syncPlan: async ({ commit }) => {
        if (commit) {
          stateAtWrite = await loadSyncState(statePath);
          const error = new Error('connection reset after request');
          error.sourceSyncWriteAttempted = true;
          throw error;
        }
        return { status: 'ready', requested: { inserts: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {} };
      },
    } });
    assert.equal(report.workbooks[0].status, 'held');
    assert.equal(report.workbooks[0].reason, 'possible_partial_commit_review');
    assert.equal(stateAtWrite.files[RELATIVE].hold.recovery.partial_commit_possible, true);
    const state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].hold.recovery.partial_commit_possible, true);
    assert.equal(state.files[RELATIVE].hold.recovery.current_sheet, 'THOMASBROS');
    assert.equal(state.files[RELATIVE].pending, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a normal successful promotion does not create recovery history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-source-clean-'));
  const folder = path.join(root, 'Patrol Log Entries', 'All Log Spreadsheets');
  const statePath = path.join(root, 'state.json');
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, WORKBOOK), 'workbook bytes');
    const report = await runPromotion({ root, statePath, map: sourceMap(), commit: true, settleMs: 0, deps: {
      exportPlan: async ({ version: scanned }) => plan(scanned.sha256),
      namespaceEventCount: async () => 1,
      syncPlan: async ({ commit }) => ({ status: commit ? 'completed' : 'ready', batch_id: commit ? 'batch-1' : null,
        requested: { inserts: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {} }),
    } });
    assert.equal(report.workbooks[0].status, 'applied');
    const state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].recovery_history, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a process crash during a write leaves a recovery hold for the next run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-source-crash-'));
  const folder = path.join(root, 'Patrol Log Entries', 'All Log Spreadsheets');
  const statePath = path.join(root, 'state.json');
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, WORKBOOK), 'workbook bytes');
    const script = `
      import { runPromotion } from ${JSON.stringify(new URL('../services/document-source-worker/source-promote.mjs', import.meta.url).href)};
      await runPromotion({
        root: ${JSON.stringify(root)}, statePath: ${JSON.stringify(statePath)}, map: ${JSON.stringify(sourceMap())},
        commit: true, settleMs: 0, deps: {
          exportPlan: async ({ version }) => ({ mode: 'plan', source_sha256: version.sha256,
            manifest: { client_code: 'THOMASBROS', target_client_organization_id: ${JSON.stringify(CLIENT)} } }),
          namespaceEventCount: async () => 1,
          syncPlan: async ({ commit }) => {
            if (commit) process.exit(71);
            return { status: 'ready', requested: { inserts: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {} };
          },
        },
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 71);
    let state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].hold.recovery.partial_commit_possible, true);
    await writeFile(path.join(folder, WORKBOOK), 'new workbook bytes');
    const next = await runPromotion({ root, statePath, map: sourceMap(), commit: true, settleMs: 0, deps: {
      exportPlan: async () => { throw new Error('an interrupted write must not be retried'); },
    } });
    assert.deepEqual(next.workbooks, []);
    state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].pending, true);
    assert.equal(state.files[RELATIVE].hold.recovery.current_sheet, 'THOMASBROS');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a source change after an earlier sheet commits leaves a persistent recovery hold', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-source-stale-'));
  const folder = path.join(root, 'Patrol Log Entries', 'All Log Spreadsheets');
  const statePath = path.join(root, 'state.json');
  const map = sourceMap();
  map.workbooks[WORKBOOK].sheets.push({
    sheet: '2026', header_row: 1, client_code: 'THOMAS2026', client_organization_id: CLIENT, zone_map: 'thomasbros-zone-map.json',
  });
  let committed = false;
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, WORKBOOK), 'workbook bytes');
    const report = await runPromotion({ root, statePath, map, commit: true, settleMs: 0, deps: {
      exportPlan: async ({ version: scanned, sheet }) => ({
        ...plan(committed ? 'b'.repeat(64) : scanned.sha256),
        manifest: { client_code: sheet.client_code, target_client_organization_id: CLIENT },
      }),
      namespaceEventCount: async () => 1,
      syncPlan: async ({ commit }) => {
        if (commit) committed = true;
        return { status: commit ? 'completed' : 'ready', batch_id: commit ? 'batch-1' : null,
          requested: { inserts: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {} };
      },
    } });
    assert.equal(report.workbooks[0].status, 'held');
    assert.equal(report.workbooks[0].reason, 'partial_commit_review');
    assert.equal(report.workbooks[0].interruption, 'source_changed_during_promotion');
    const state = await loadSyncState(statePath);
    assert.equal(state.files[RELATIVE].hold.recovery.partial_commit, true);
    assert.deepEqual(state.files[RELATIVE].hold.recovery.batch_ids, ['batch-1']);
    assert.equal(state.files[RELATIVE].pending, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a closed partial batch preserves source-place conflict details', async () => {
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true,
    exportPlan: async () => ({ ...plan(), unresolved_places: [
      { name: null, reason: 'conflicting_place_fields', source_rows: [7] },
    ] }),
    namespaceEventCount: async () => 1,
    syncPlan: async () => { throw new Error('ERROR: P0001: This source and import configuration already has a closed review batch'); },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_conflicting_place_fields');
  assert.deepEqual(result.sheets[0].source_rows, [7]);
  assert.equal(result.sheets[0].already_batched, true);
});

test('a closed batch cannot acknowledge a pre-existing place review hold', async () => {
  const error = new Error('ERROR: P0001: This source and import configuration already has a closed review batch');
  error.sourceSyncReport = { plan_summary: { hold: 1 },
    plan_hold_reasons: { source_place_difference_requires_review: 1 } };
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true,
    exportPlan: async () => plan(), namespaceEventCount: async () => 1,
    syncPlan: async () => { throw error; },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_source_place_difference_requires_review');
  assert.equal(result.sheets[0].already_batched, true);
});

test('a retryable sync failure reports known place conflicts without acknowledging the workbook', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-promote-conflict-'));
  try {
    const folder = path.join(root, 'Patrol Log Entries', 'All Log Spreadsheets');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, WORKBOOK), 'workbook bytes');
    const statePath = path.join(root, 'state', 'sync.json');
    const report = await runPromotion({ root, statePath, map: sourceMap(), commit: true, settleMs: 0, deps: {
      exportPlan: async ({ version: scanned }) => ({ ...plan(scanned.sha256), unresolved_places: [
        { name: null, reason: 'conflicting_place_fields', source_rows: [7] },
      ] }),
      namespaceEventCount: async () => 1,
      syncPlan: async () => { throw new Error('connect ETIMEDOUT'); },
    } });
    assert.equal(report.workbooks[0].status, 'error');
    assert.equal(report.workbooks[0].place_conflicts.reason, 'conflicting_place_fields');
    assert.deepEqual(report.workbooks[0].place_conflicts.source_rows, [7]);
    const file = (await loadSyncState(statePath)).files[RELATIVE];
    assert.equal(file.pending, true);
    assert.equal(file.acknowledged_sha256, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('privileged NZTA screenshots are ignored and never attached, even when committing', async () => {
  const entries = [{ relative_path: 'Photos/ABC123 NZTA 240817 112216.png', size_bytes: 10, modified_at: 't1' }];
  const attached = [];
  const { results, receipts } = await promotePhotos({ entries, classify: async () => ({ status: 'privileged' }),
    attach: async row => { attached.push(row); return { sha256: SHA, storage_path: 'x' }; }, commit: true, limit: 5 });
  assert.deepEqual([results[0].status, results[0].reason], ['ignored', 'privileged_nzta_record']);
  assert.deepEqual(receipts, {});
  assert.equal(attached.length, 0);
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
  const hashed = await importActorRpc(text => { sql = text; return [{ result: 'evidence-id' }]; }, actor,
    'attach_external_photo_to_record', { p_sha256: 'a'.repeat(64) });
  assert.equal(hashed.error, null);
  assert.match(sql, /p_sha256 => \(SELECT \(a->>'p_sha256'\)::text FROM args\)/);
  await assert.rejects(() => importActorRpc(() => [], actor, 'f', { 'p_x;drop': 1 }), /Invalid RPC argument/);
});

test('a photo the attach step holds gets a visible hold, not an applied receipt', async () => {
  const { results, receipts } = await promotePhotos({
    entries: [{ relative_path: 'Photos/a.jpg', size_bytes: 1, modified_at: '2026-01-01T00:00:00.000Z' }],
    classify: async () => ({ status: 'matched', row: { matchType: 'event_minute' } }),
    attach: async () => ({ held: 'photo_already_attached_to_other_record', sha256: 'a'.repeat(64), no_write: true }),
    commit: true, limit: 10,
  });
  assert.deepEqual(results, [{ source_relative_path: 'Photos/a.jpg', status: 'held',
    reason: 'photo_already_attached_to_other_record' }]);
  assert.deepEqual(receipts, {});
});

test('a lost photo-attachment response remains held and earlier receipts survive a restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-recovery-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    const entries = ['a', 'b'].map(name => ({
      relative_path: `Photos/${name}.jpg`, size_bytes: 10, modified_at: 't1',
    }));
    const writes = [];
    const intentsAtWrite = [];
    const photoDeps = async () => ({
      classify: async relativePath => ({
        status: 'matched',
        row: { matchType: 'event_minute', organizationId: CLIENT, observationId: relativePath, recordKind: 'location_event' },
      }),
      attach: async row => {
        const source = row.fileInfo.relative_path;
        intentsAtWrite.push(Boolean((await loadSyncState(statePath)).photo_attachment_intents?.[source]));
        writes.push(source);
        if (source.endsWith('b.jpg')) throw new Error('simulated lost response');
        return { sha256: SHA, storage_path: 'org/photo-a.jpg' };
      },
    });
    const run = currentEntries => runPromotion({
      root, statePath, map: sourceMap(), deps: { photoDeps }, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => currentEntries,
    });

    const first = await run(entries);
    assert.deepEqual(intentsAtWrite, [true, true]);
    assert.equal(first.photos.counts.applied, 1);
    assert.equal(first.photos.counts['held:possible_partial_photo_attachment_review'], 1);
    const state = await loadSyncState(statePath);
    assert.equal(state.photo_receipts['Photos/a.jpg'].key, '10:t1');
    assert.equal(state.photo_attachment_intents['Photos/a.jpg'], undefined);
    assert.equal(state.photo_attachment_intents['Photos/b.jpg'].key, '10:t1');

    const second = await run([entries[0], { ...entries[1], modified_at: 't2' }]);
    assert.equal(second.photos.counts.unchanged, 1);
    assert.equal(second.photos.counts['held:possible_partial_photo_attachment_review'], 1);
    assert.deepEqual(writes, ['Photos/a.jpg', 'Photos/b.jpg']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('photo recovery retains the prepared digest and destination before an uncertain upload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-intent-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    const entry = { relative_path: 'Photos/a.jpg', size_bytes: 10, modified_at: 't1' };
    let preparedBeforeWrite = false;
    const photoDeps = async () => ({
      classify: async () => ({ status: 'matched',
        row: { matchType: 'event_minute', organizationId: CLIENT, observationId: 'event-1', recordKind: 'location_event' } }),
      attach: async row => {
        await row.onPrepared({ sha256: SHA, storage_path: 'org/photo-a.jpg' });
        const intent = (await loadSyncState(statePath)).photo_attachment_intents[entry.relative_path];
        preparedBeforeWrite = intent.sha256 === SHA && intent.storage_path === 'org/photo-a.jpg';
        throw new Error('simulated lost upload response');
      },
    });
    const report = await runPromotion({
      root, statePath, map: sourceMap(), deps: { photoDeps }, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => [entry],
    });
    assert.equal(preparedBeforeWrite, true);
    assert.equal(report.photos.counts['held:possible_partial_photo_attachment_review'], 1);
    const intent = (await loadSyncState(statePath)).photo_attachment_intents[entry.relative_path];
    assert.deepEqual([intent.sha256, intent.storage_path], [SHA, 'org/photo-a.jpg']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a process crash during photo upload leaves a hold for the next run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-crash-'));
  const statePath = path.join(root, 'state.json');
  const entry = { relative_path: 'Photos/a.jpg', size_bytes: 10, modified_at: 't1' };
  try {
    const script = `
      import { runPromotion } from ${JSON.stringify(new URL('../services/document-source-worker/source-promote.mjs', import.meta.url).href)};
      await runPromotion({
        root: ${JSON.stringify(root)}, statePath: ${JSON.stringify(statePath)}, map: ${JSON.stringify(sourceMap())},
        commit: true, includePhotos: true, settleMs: 0, listPhotos: async () => [${JSON.stringify(entry)}],
        deps: { photoDeps: async () => ({
          classify: async () => ({ status: 'matched', row: { matchType: 'event_minute',
            organizationId: ${JSON.stringify(CLIENT)}, observationId: 'event-1' } }),
          attach: async row => {
            await row.onPrepared({ sha256: ${JSON.stringify(SHA)}, storage_path: 'org/photo-a.jpg' });
            process.exit(71);
          },
        }) },
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 71);
    const intent = (await loadSyncState(statePath)).photo_attachment_intents[entry.relative_path];
    assert.deepEqual([intent.sha256, intent.storage_path], [SHA, 'org/photo-a.jpg']);
    const report = await runPromotion({
      root, statePath, map: sourceMap(), commit: true, includePhotos: true, settleMs: 0, listPhotos: async () => [entry],
      deps: { photoDeps: async () => ({
        classify: async () => { throw new Error('an interrupted photo must not be reclassified'); },
        attach: async () => { throw new Error('an interrupted photo must not be retried'); },
      }) },
    });
    assert.equal(report.photos.counts['held:possible_partial_photo_attachment_review'], 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a renamed copy of a photo with an unresolved attachment cannot start another write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-hash-recovery-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    let writes = 0;
    const photoDeps = async () => ({
      classify: async relativePath => ({ status: 'matched',
        row: { matchType: 'event_minute', organizationId: relativePath.endsWith('a.jpg') ? CLIENT : PROVIDER,
          observationId: relativePath, recordKind: 'location_event' } }),
      attach: async row => {
        await row.onPrepared({ sha256: SHA, storage_path: `org/${row.fileInfo.relative_path}` });
        writes += 1;
        if (writes === 1) throw new Error('simulated lost upload response');
        return { sha256: SHA, storage_path: 'org/new.jpg' };
      },
    });
    const run = relativePath => runPromotion({
      root, statePath, map: sourceMap(), deps: { photoDeps }, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => [{ relative_path: relativePath, size_bytes: 10, modified_at: 't1' }],
    });
    await run('Photos/a.jpg');
    const second = await run('Photos/renamed.jpg');
    assert.equal(second.photos.counts['held:possible_partial_photo_attachment_review'], 1);
    assert.equal(writes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a photo hold remains visible when its source file disappears', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-missing-hold-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    const entry = { relative_path: 'Photos/a.jpg', size_bytes: 10, modified_at: 't1' };
    const photoDeps = async () => ({
      classify: async () => ({ status: 'matched', row: { matchType: 'event_minute' } }),
      attach: async () => { throw new Error('simulated lost response'); },
    });
    const run = entries => runPromotion({
      root, statePath, map: sourceMap(), deps: { photoDeps }, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => entries,
    });
    await run([entry]);
    const report = await run([]);
    assert.ok(report.photos.review_required.some(item => item.source_relative_path === entry.relative_path
      && item.reason === 'possible_partial_photo_attachment_review'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a standalone scanner cannot overwrite an active photo write intent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-scan-lock-'));
  const statePath = path.join(root, 'state.json');
  const entry = { relative_path: 'Photos/a.jpg', size_bytes: 10, modified_at: 't1' };
  let release;
  const proceed = new Promise(resolve => { release = resolve; });
  let started;
  const writing = new Promise(resolve => { started = resolve; });
  let promotion;
  try {
    promotion = runPromotion({
      root, statePath, map: sourceMap(), commit: true, includePhotos: true, settleMs: 0, listPhotos: async () => [entry],
      deps: { photoDeps: async () => ({
        classify: async () => ({ status: 'matched', row: { matchType: 'event_minute' } }),
        attach: async () => { started(); await proceed; throw new Error('simulated lost response'); },
      }) },
    });
    await writing;
    await assert.rejects(runSourceScan({ root, statePath, settleMs: 0 }), /holds the source lock/);
    assert.ok((await loadSyncState(statePath)).photo_attachment_intents[entry.relative_path]);
    release();
    await promotion;
  } finally {
    release();
    if (promotion) await promotion;
    await rm(root, { recursive: true, force: true });
  }
});

test('retained duplicate uploads remain reviewable even after the source photo changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-retained-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    const entry = { relative_path: 'Photos/a.jpg', size_bytes: 10, modified_at: 't1' };
    let writes = 0;
    const photoDeps = async () => ({
      classify: async () => ({ status: 'matched', row: { matchType: 'event_minute' } }),
      attach: async () => {
        writes += 1;
        return writes === 1
          ? { sha256: SHA, storage_path: 'org/canonical.jpg', retained_duplicate_upload: true,
            retained_storage_path: 'org/extra.jpg' }
          : { sha256: 'b'.repeat(64), storage_path: 'org/new.jpg' };
      },
    });
    const run = item => runPromotion({
      root, statePath, map: sourceMap(), deps: { photoDeps }, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => [item],
    });
    await run(entry);
    const second = await run({ ...entry, modified_at: 't2' });
    assert.equal(second.photos.retained_uploads_for_review, 1);
    assert.deepEqual((await loadSyncState(statePath)).photo_receipts[entry.relative_path].retained_uploads,
      [{ sha256: SHA, storage_path: 'org/extra.jpg' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const unresolved = (count) => Array.from({ length: count }, (_, index) => ({ name: `New Place ${index}`, reserve_codes: [],
  locations: [`New Place ${index}`], source_rows: [index] }));

test('commit holds unresolved places even when registration preview proposes a match', async () => {
  for (const receipt of [
    { name: 'New Place 0', status: 'created', zone_id: 'zone-new', agreement_linked: true },
    { name: 'New Place 0', status: 'existing', zone_id: 'zone-existing', agreement_linked: true, coverage_added: false },
  ]) {
    const registrations = [];
    const writes = [];
    const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps(),
      exportPlan: async ({ placeOverlay }) => ({ ...plan(), unresolved_places: placeOverlay ? [] : unresolved(1) }),
      registerPlaces: async ({ commit }) => { registrations.push(commit); return [receipt]; },
      syncPlan: async ({ commit }) => { if (commit) writes.push('sync'); return {
        status: commit ? 'committed' : 'ready', requested: { inserts: 1 }, plan_summary: { hold: 0 },
        plan_hold_reasons: {}, summary: {},
      }; },
      beforeWrite: async () => writes.push('intent'),
    });
    assert.equal(result.status, 'held');
    assert.equal(result.reason, 'sheet_new_places_require_review');
    assert.ok(registrations.every(commit => !commit));
    assert.deepEqual(writes, []);
  }
});

test('a later sheet with an unresolved place prevents earlier sheet writes', async () => {
  const map = sourceMap();
  map.workbooks[WORKBOOK].sheets.push({ ...map.workbooks[WORKBOOK].sheets[0], sheet: '2026', client_code: 'THOMAS2026' });
  const writes = [];
  const result = await promoteWorkbookVersion({ version, map, commit: true, ...deps(),
    exportPlan: async ({ sheet, placeOverlay }) => ({ ...plan(),
      manifest: { client_code: sheet.client_code, target_client_organization_id: CLIENT },
      unresolved_places: sheet.client_code === 'THOMAS2026' && !placeOverlay ? unresolved(1) : [],
    }),
    registerPlaces: async ({ commit }) => {
      if (commit) writes.push('registration');
      return [{ name: 'New Place 0', status: 'created', zone_id: 'zone-new', agreement_linked: true }];
    },
    syncPlan: async ({ commit }) => {
      if (commit) writes.push('sync');
      return { status: commit ? 'committed' : 'ready', requested: { inserts: 1 },
        plan_summary: { hold: 0 }, plan_hold_reasons: {}, summary: {} };
    },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_new_places_require_review');
  assert.equal(result.partial_commit, undefined);
  assert.deepEqual(writes, []);
});

test('an already-batched preview cannot acknowledge an unresolved place', async () => {
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps(),
    exportPlan: async ({ placeOverlay }) => ({ ...plan(), unresolved_places: placeOverlay ? [] : unresolved(1) }),
    registerPlaces: async () => [{ name: 'New Place 0', status: 'created', zone_id: 'zone-new', agreement_linked: true }],
    syncPlan: async () => { throw new Error('ERROR: P0001: This source and import configuration already has a closed review batch'); },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_new_places_require_review');
  assert.equal(result.receipt_id, undefined);
});

test('unknown places are previewed without being created and held on commit', async () => {
  const exports = [];
  const registrations = [];
  const validations = [];
  const base = deps();
  const run = (commit) => promoteWorkbookVersion({ version, map: sourceMap(), commit, ...base,
    exportPlan: async ({ placeOverlay }) => {
      exports.push(placeOverlay ?? null);
      return { ...plan(), unresolved_places: placeOverlay ? [] : unresolved(1) };
    },
    registerPlaces: async ({ places, commit: registering }) => { registrations.push(registering);
      return places.map((place) => ({ name: place.name, status: 'created', zone_id: 'zone-new', agreement_linked: true })); },
    syncPlan: async ({ commit: syncing, planningOnly }) => {
      validations.push({ commit: syncing, planningOnly });
      return { status: syncing ? 'committed' : planningOnly ? 'planning_only' : 'ready',
        ...(planningOnly ? { server_validation: 'not_run' } : {}), batch_id: syncing ? 'batch-1' : null,
        requested: { inserts: 1, updates: 0 }, plan_summary: { hold: 0 }, plan_hold_reasons: {}, summary: {} };
    } });
  const preview = await run(false);
  assert.equal(preview.status, 'held');
  assert.equal(preview.reason, 'sheet_new_places_require_review');
  assert.deepEqual(preview.sheets[0].places, [{ name: 'New Place 0', status: 'created', zone_id: 'zone-new', agreement_linked: true }]);
  assert.equal(preview.sheets[0].server_validation, 'not_run');
  assert.deepEqual(exports, [null, { 'New Place 0': 'zone-new' }]);
  const applied = await run(true);
  assert.equal(applied.status, 'held');
  assert.equal(applied.reason, 'sheet_new_places_require_review');
  assert.deepEqual(registrations, [false, false]);
  assert.deepEqual(validations.map(item => [item.commit, Boolean(item.planningOnly)]),
    [[false, true], [false, true]]);
  assert.deepEqual(exports.at(-1), { 'New Place 0': 'zone-new' });
});

test('prospective place registration never reaches a post-write batch check', async () => {
  const registrations = [];
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps(),
    exportPlan: async ({ placeOverlay }) => ({ ...plan(), unresolved_places: placeOverlay ? [] : unresolved(1) }),
    registerPlaces: async ({ commit }) => {
      registrations.push(commit);
      return [{ name: 'New Place 0', status: 'created', zone_id: 'zone-new', agreement_linked: true }];
    },
    syncPlan: async ({ planningOnly }) => {
      if (!planningOnly) throw new Error('ERROR: P0001: This source and import configuration already has a closed review batch');
      return { status: 'planning_only', server_validation: 'not_run',
        requested: { inserts: 1 }, plan_summary: { hold: 0 }, plan_hold_reasons: {}, summary: {} };
    },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_new_places_require_review');
  assert.equal(result.partial_commit, undefined);
  assert.equal(result.receipt_id, undefined);
  assert.deepEqual(registrations, [false]);
});

test('a conflict revealed by the prospective place overlay prevents registration and sync', async () => {
  const calls = [];
  const registrations = [];
  const receipt = { name: 'New Place 0', status: 'created', zone_id: 'zone-new', agreement_linked: true };
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps({ calls }),
    exportPlan: async ({ placeOverlay }) => ({ ...plan(), unresolved_places: placeOverlay
      ? [{ name: null, reason: 'conflicting_place_fields', source_rows: [7] }]
      : unresolved(1) }),
    registerPlaces: async ({ commit }) => { registrations.push(commit); return [receipt]; },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_conflicting_place_fields');
  assert.deepEqual(result.sheets[0].source_rows, [7]);
  assert.deepEqual(result.sheets[0].places, [receipt]);
  assert.equal(result.sheets[0].batch_id, undefined);
  assert.deepEqual(registrations, [false]);
  assert.deepEqual(calls, [false]);
});

test('a prospective overlay cannot erase an original source conflict', async () => {
  const registrations = [];
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps(),
    exportPlan: async ({ placeOverlay }) => ({ ...plan(), unresolved_places: placeOverlay ? [] : [
      { name: null, reason: 'conflicting_place_fields', source_rows: [7] },
      ...unresolved(1),
    ] }),
    registerPlaces: async ({ commit }) => {
      registrations.push(commit);
      return [{ name: 'New Place 0', status: 'created', zone_id: 'zone-new', agreement_linked: true }];
    },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_conflicting_place_fields');
  assert.deepEqual(result.sheets[0].source_rows, [7]);
  assert.deepEqual(registrations, [false]);
});

test('ambiguous place registration receipts hold the workbook before writes', async () => {
  const registrations = [];
  const result = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps(),
    exportPlan: async () => ({ ...plan(), unresolved_places: unresolved(1) }),
    registerPlaces: async ({ commit }) => {
      registrations.push(commit);
      return [{ name: 'New Place 0', status: 'registry_match_review', zone_id: null, agreement_linked: false }];
    },
  });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'sheet_place_registration_review');
  assert.deepEqual(registrations, [false]);
});

test('preview checks prospective places without claiming server validation', async () => {
  const exports = [];
  const receipts = [
    { name: 'New Place 0', status: 'existing', zone_id: 'zone-covered', agreement_linked: true, coverage_added: false },
    { name: 'New Place 1', status: 'existing', zone_id: 'zone-linked-now', agreement_linked: true, coverage_added: true },
    { name: 'New Place 2', status: 'created', zone_id: 'zone-new', agreement_linked: true, coverage_added: true },
  ];
  const planningCalls = [];
  const preview = await promoteWorkbookVersion({ version, map: sourceMap(), commit: false, ...deps(),
    exportPlan: async ({ placeOverlay }) => { exports.push(placeOverlay ?? null); return { ...plan(), unresolved_places: unresolved(3) }; },
    registerPlaces: async () => receipts,
    syncPlan: async ({ planningOnly }) => {
      planningCalls.push(planningOnly);
      return { status: 'planning_only', server_validation: 'not_run', requested: { inserts: 1 },
        plan_summary: { hold: 0 }, plan_hold_reasons: {}, summary: {} };
    } });
  assert.equal(preview.status, 'held');
  assert.equal(preview.reason, 'sheet_new_places_require_review');
  assert.deepEqual(exports, [null, { 'New Place 0': 'zone-covered', 'New Place 1': 'zone-linked-now', 'New Place 2': 'zone-new' }]);
  assert.deepEqual(planningCalls, [true]);
  assert.equal(preview.sheets[0].server_validation, 'not_run');
});

test('too many unknown places in one sheet are held for a person before anything is created', async () => {
  const calls = [];
  let registered = false;
  const held = await promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps({ calls }),
    exportPlan: async () => ({ ...plan(), unresolved_places: unresolved(11) }),
    registerPlaces: async () => { registered = true; return []; } });
  assert.deepEqual([held.status, held.reason], ['held', 'sheet_new_place_volume_review']);
  assert.equal(registered, false);
  assert.deepEqual(calls, []);
});

test('a reviewed map may raise the new-place limit and name a new namespace', async () => {
  const calls = [];
  const raised = sourceMap({ max_new_places_per_sheet: 20 });
  let registered = 0;
  const applied = await promoteWorkbookVersion({ version, map: raised, commit: true, ...deps({ calls }),
    exportPlan: async () => ({ ...plan(), unresolved_places: unresolved(11) }),
    registerPlaces: async ({ places }) => { registered = places.length; return []; } });
  assert.notEqual(applied.reason, 'sheet_new_place_volume_review');
  assert.equal(registered, 11);
  const fresh = sourceMap();
  fresh.workbooks[WORKBOOK].sheets[0].new_namespace = true;
  const first = await promoteWorkbookVersion({ version, map: fresh, commit: false, ...deps({ namespace: 0 }) });
  assert.notEqual(first.reason, 'sheet_namespace_unproven');
  for (const bad of [{ max_new_places_per_sheet: 51 }, { max_new_places_per_sheet: -1 }, { non_place_terms: ['x'.repeat(40)] }]) {
    assert.throws(() => validateSourceMap(sourceMap(bad)));
  }
  const badNamespace = sourceMap();
  badNamespace.workbooks[WORKBOOK].sheets[0].new_namespace = 'yes';
  assert.throws(() => validateSourceMap(badNamespace));
  const badAlias = sourceMap();
  badAlias.workbooks[WORKBOOK].sheets[0].place_aliases = { ALLF: 'x' };
  assert.throws(() => validateSourceMap(badAlias));
});

test('a sheet already batched for this exact version is unchanged while its held sibling proceeds', async () => {
  const map = sourceMap();
  map.workbooks[WORKBOOK].sheets.push({ ...map.workbooks[WORKBOOK].sheets[0], sheet: '2026', client_code: 'THOMAS2026' });
  const calls = [];
  const result = await promoteWorkbookVersion({ version, map, commit: true, ...deps({ calls }),
    exportPlan: async ({ sheet }) => ({ ...plan(), manifest: { client_code: sheet.client_code, target_client_organization_id: CLIENT } }),
    syncPlan: async ({ sourcePlan, commit }) => {
      if (sourcePlan.manifest.client_code === 'THOMASBROS') throw new Error('ERROR:  P0001: This source and import configuration already has a closed review batch');
      calls.push(commit);
      return { status: commit ? 'committed' : 'ready', batch_id: commit ? 'batch-2' : null,
        requested: { inserts: 1, updates: 0, corrections: 0 }, plan_summary: {}, plan_hold_reasons: {} };
    } });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.sheets.map(sheet => [sheet.client_code, sheet.status]), [['THOMASBROS', 'unchanged'], ['THOMAS2026', 'applied']]);
  assert.equal(result.receipt_id, 'batches:batch-2');
  await assert.rejects(promoteWorkbookVersion({ version, map: sourceMap(), commit: true, ...deps(),
    syncPlan: async () => { throw new Error('connection reset'); } }), /connection reset/);
});

test('the source map names new places with each client suffix', async () => {
  const map = JSON.parse(await readFile(new URL('../services/document-source-worker/rm-patrol-source-map.json', import.meta.url), 'utf8'));
  const suffixes = Object.values(map.workbooks).flatMap((entry) => entry.sheets ?? []).map((sheet) => sheet.place_name_suffix);
  assert.ok(suffixes.includes('OneFortyOne'));
  assert.ok(suffixes.includes('TPFL'));
  const bad = sourceMap();
  bad.workbooks[WORKBOOK].sheets[0].place_name_suffix = '';
  assert.throws(() => validateSourceMap(bad));
});