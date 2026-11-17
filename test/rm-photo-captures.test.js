import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCaptureGroups, captureCsv, chunkCaptureGroups, photoDescription, resolveCaptureClient,
} from '../services/document-source-worker/source-captures.mjs';
import { promoteCaptures, runPromotion, validateSourceMap } from '../services/document-source-worker/source-promote.mjs';
import { loadSyncState } from '../services/document-source-worker/source-sync.mjs';
import { parsePhotoName } from '../scripts/rm-photo-matcher.mjs';

const PROVIDER = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const TPFL = '74d7fcf1-106a-481f-a770-1589c8a0db6b';
const OFO = 'c48c1aaf-236b-417c-bbce-938c151662d6';

const captures = (overrides = {}) => ({
  enabled: true,
  max_rows_per_batch: 2,
  max_batches_per_run: 5,
  source_label_prefix: 'Photos camera captures',
  columns: { job: 'Log No', patroller: 'Patroller', date: 'Date', time: '24hr Time', location: 'Location', source: 'Source',
    subject: 'Subject', issue: 'Issue', comments: 'Description/Comments', registration: 'Reg' },
  values: { patroller: 'Camera', source: 'SECURITY', subject: 'Camera', issue: 'Card review', comment_prefix: 'Camera Activation.' },
  hold_label_tokens: ['public', 'private'],
  clients: [
    { capture_code: 'TPFLCAM', profile_code: 'TPFL2026', label_tokens: ['tpfl'] },
    { capture_code: 'OFOCAM', profile_code: 'OFO2026', label_tokens: ['ofo'] },
  ],
  ...overrides,
});

const sourceMap = (overrides = {}) => ({
  version: 1, provider_organization_id: PROVIDER, classification_profile: 'rm_patrol_log', max_new_rows_per_sheet: 250,
  max_new_places_per_sheet: 40,
  workbooks: {
    'TPFL.xlsx': { sheets: [{ sheet: '2026', header_row: 1, client_code: 'TPFL2026', client_organization_id: TPFL,
      zone_map: 'tpfl-zone-map.json', place_name_suffix: 'TPFL' }] },
    'OFO.xlsx': { sheets: [{ sheet: '2026', header_row: 1, client_code: 'OFO2026', client_organization_id: OFO,
      zone_map: 'ofo-zone-map.json' }] },
  },
  photo_captures: captures(),
  ...overrides,
});

const photo = relativePath => ({ relative_path: relativePath, parsed: parsePhotoName(relativePath) });
const withOrgs = config => ({ ...config, clients: config.clients.map(client => ({ ...client,
  client_organization_id: client.capture_code === 'TPFLCAM' ? TPFL : OFO })) });

test('a folder names its client only when exactly one client label token is present', () => {
  const config = captures();
  assert.deepEqual(resolveCaptureClient('Photos/Central Rd - Hira - TPFL/241024 1523 stag.jpg', config),
    { client: config.clients[0], location: 'Central Rd' });
  assert.equal(resolveCaptureClient('Photos/Gordons Rd - Hira -TPFL/x.jpg', config).location, 'Gordons Rd');
  assert.equal(resolveCaptureClient('Photos/Gordons Rd - Hira - Hira -TPFL/x.jpg', config).client.capture_code, 'TPFLCAM');
  assert.equal(resolveCaptureClient('Photos/Rai - Gate - OFO and TPFL/x.jpg', config).held, 'client_label_multiple');
  assert.equal(resolveCaptureClient('Photos/Rai - Gate - TPFL & Public/x.jpg', config).held, 'client_label_review');
  assert.equal(resolveCaptureClient('Photos/Bike Tunnel/x.jpg', config).held, 'client_label_missing');
  assert.equal(resolveCaptureClient('Photos/Dunedin - Gate - Somebody/x.jpg', config).held, 'client_label_unmapped');
  assert.equal(resolveCaptureClient('Photos/x.jpg', config).held, 'client_label_missing');
  assert.equal(resolveCaptureClient('Photos/Spooners Gate -OFO/x.jpg', config).location, 'Spooners Gate');
  assert.equal(resolveCaptureClient('Photos/Spooners - OFO - leads to Olivers/x.jpg', config).client.capture_code, 'OFOCAM');
  assert.equal(resolveCaptureClient('Photos/Kaka-Valley - TPFL/x.jpg', config).location, 'Kaka-Valley');
  assert.equal(resolveCaptureClient('Photos/Bisley - OFO & Wrattens - Private/x.jpg', config).held, 'client_label_review');
});

test('photos in one client minute and place become one capture row with every plate and a stable log number', () => {
  const config = withOrgs(captures());
  const photos = [
    photo('Photos/Central Rd - Hira - TPFL/241024 1523 GPT23 white ute.jpg'),
    photo('Photos/Central Rd - Hira - TPFL/241024 152340 two cyclists (1).jpg'),
    photo('Photos/Central Rd - Hira - TPFL/Sub/241024 1523 NMD671.jpg'),
    photo('Photos/Lucy Creek - Hira - TPFL/241024 1523 boar.jpg'),
  ];
  const { groups, holds } = buildCaptureGroups(photos, config);
  assert.deepEqual(holds, []);
  assert.equal(groups.length, 2);
  const central = groups.find(group => group.location === 'Central Rd');
  assert.deepEqual(central.plates, ['GPT23', 'NMD671']);
  assert.deepEqual(central.descriptions, ['GPT23 white ute', 'two cyclists', 'NMD671']);
  assert.equal(central.photos.length, 3);
  assert.match(central.log_number, /^CAM-2410241523-[0-9a-f]{8}$/);
  const alone = buildCaptureGroups(photos.slice(1, 2), config).groups[0];
  assert.equal(alone.log_number, central.log_number, 'the log number depends on client, place and minute only');
  const csv = captureCsv([central], config).split('\n');
  assert.equal(csv[0], 'Log No,Patroller,Date,24hr Time,Location,Source,Subject,Issue,Description/Comments,Reg');
  assert.equal(csv[1], `${central.log_number},Camera,24/10/2024,15:23,Central Rd,SECURITY,Camera,Card review,`
    + 'Camera Activation. GPT23 white ute; two cyclists; NMD671,"GPT23, NMD671"');
});

test('captures are held when the client already logged that minute or the folder names no single client', () => {
  const config = withOrgs(captures());
  const photos = [
    photo('Photos/Central Rd - Hira - TPFL/241024 1523 stag.jpg'),
    photo('Photos/Rai - Gate - OFO and TPFL/241024 1600 ute.jpg'),
    photo('Photos/Rai - Gate - OFO/241024 1523 ute.jpg'),
  ];
  const { groups, holds } = buildCaptureGroups(photos, config,
    { minuteOrganizations: key => new Set(key === '2024-10-24 15:23' ? [TPFL] : []) });
  assert.deepEqual(holds.map(hold => hold.reason), ['minute_has_record_review', 'client_label_multiple']);
  assert.deepEqual(groups.map(group => group.capture_code), ['OFOCAM'], 'another client in that minute does not block a capture');
});

test('photos stamped before the configured floor are ignored, not captured or held', () => {
  const config = withOrgs(captures({ earliest_capture_date: '2019-01-01' }));
  const photos = [
    photo('Photos/Central Rd - Hira - TPFL/000724 1523 stag.jpg'),
    photo('Photos/Central Rd - Hira - TPFL/181231 2359 ute.jpg'),
    photo('Photos/Central Rd - Hira - TPFL/190101 0000 ute.jpg'),
  ];
  const { groups, holds, ignored } = buildCaptureGroups(photos, config);
  assert.equal(ignored, 2);
  assert.deepEqual(holds, []);
  assert.deepEqual(groups.map(group => group.minute_key), ['2019-01-01 00:00']);
  assert.throws(() => validateSourceMap(sourceMap({ photo_captures: captures({ earliest_capture_date: '2019-13-01' }) })),
    /earliest_capture_date/);
});

test('filename descriptions drop only the date and time stamp', () => {
  assert.equal(photoDescription('Photos/A - B - TPFL/241024 1523 GPT23 white ute.JPG'), 'GPT23 white ute');
  assert.equal(photoDescription('Photos/A - B - TPFL/RMM899 241024 152301 spotlighting.jpg'), 'RMM899 spotlighting');
  assert.equal(photoDescription('Photos/A - B - TPFL/241024_1523.jpg'), '');
});

test('capture batches stay inside the row and new-place limits', () => {
  const groups = ['A', 'A', 'A', 'B', 'C', 'C'].map((location, index) => ({ location, log_number: String(index) }));
  assert.deepEqual(chunkCaptureGroups(groups, { maxRows: 2, maxPlaces: 40 }).map(chunk => chunk.length), [2, 2, 2]);
  assert.deepEqual(chunkCaptureGroups(groups, { maxRows: 10, maxPlaces: 2 }).map(chunk => chunk.map(group => group.location).join('')),
    ['AAAB', 'CC']);
});

test('the source map validates capture clients against reviewed sheets and namespaces', async () => {
  assert.doesNotThrow(() => validateSourceMap(sourceMap()));
  assert.throws(() => validateSourceMap(sourceMap({ photo_captures: captures({ clients: [
    { capture_code: 'TPFL2026', profile_code: 'TPFL2026', label_tokens: ['tpfl'] }] }) })), /mapped twice/);
  assert.throws(() => validateSourceMap(sourceMap({ photo_captures: captures({ clients: [
    { capture_code: 'XCAM', profile_code: 'NOPE', label_tokens: ['x'] }] }) })), /not a mapped sheet/);
  assert.throws(() => validateSourceMap(sourceMap({ photo_captures: captures({ clients: [
    { capture_code: 'ACAM', profile_code: 'TPFL2026', label_tokens: ['tpfl'] },
    { capture_code: 'BCAM', profile_code: 'OFO2026', label_tokens: ['tpfl'] }] }) })), /names two clients/);
  const reviewed = JSON.parse(await readFile(new URL('../services/document-source-worker/rm-patrol-source-map.json', import.meta.url), 'utf8'));
  assert.equal(reviewed.photo_captures.enabled, true);
  assert.doesNotThrow(() => validateSourceMap(reviewed));
});

function captureDeps({ calls = [], exported = [] } = {}) {
  return {
    exportPlan: async ({ version, sheet }) => {
      exported.push({ version, sheet });
      return { mode: 'plan', source_sha256: version.sha256,
        manifest: { client_code: sheet.client_code, target_client_organization_id: sheet.client_organization_id } };
    },
    namespaceEventCount: async () => 0,
    syncPlan: async ({ commit }) => {
      calls.push(commit);
      return { status: commit ? 'committed' : 'ready', batch_id: commit ? `batch-${calls.length}` : null,
        requested: { inserts: 1, updates: 0 }, plan_summary: {}, plan_hold_reasons: {} };
    },
  };
}

test('capture batches run through the governed sheet path under their own namespace and stop at the batch limit', async () => {
  const exported = [];
  const photos = ['1500', '1501', '1502'].map(time => photo(`Photos/Central Rd - Hira - TPFL/241024 ${time} stag.jpg`));
  const outcome = await promoteCaptures({ photos, map: sourceMap({ photo_captures: captures({ max_rows_per_batch: 2 }) }),
    deps: captureDeps({ exported }), commit: true, maxBatches: 1, minuteOrganizations: () => new Set() });
  assert.deepEqual(outcome.batches.map(batch => [batch.status, batch.rows]), [['applied', 2], ['deferred', 1]]);
  assert.equal(outcome.captured.length, 2);
  const [{ version, sheet }] = exported;
  assert.equal(version.relative_path, 'Photos camera captures TPFLCAM.csv');
  assert.match(version.csv, /^Log No,Patroller,/);
  assert.deepEqual([sheet.client_code, sheet.client_organization_id, sheet.zone_map, sheet.place_name_suffix, sheet.new_namespace],
    ['TPFLCAM', TPFL, 'tpfl-zone-map.json', 'TPFL', true]);
});

test('a committed run captures unmatched photos and attaches them to the new rows straight away', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-captures-'));
  try {
    const relative = 'Photos/Central Rd - Hira - TPFL/241024 1523 stag.jpg';
    const entries = [{ relative_path: relative, size_bytes: 5, modified_at: 't1' }];
    let loads = 0;
    const attached = [];
    const photoDeps = async () => {
      loads += 1;
      const captured = loads > 1;
      return {
        classify: async () => (captured ? { status: 'matched', row: { matchType: 'place' } }
          : { status: 'unmatched', parsed: parsePhotoName(relative) }),
        attach: async row => { attached.push(row); return { sha256: 'a'.repeat(64), storage_path: 'org/p.jpg' }; },
        minuteOrganizations: () => new Set(),
      };
    };
    const report = await runPromotion({ root, statePath: path.join(root, 'state', 'sync.json'), map: sourceMap(),
      deps: { ...captureDeps(), photoDeps }, commit: true, includePhotos: true, settleMs: 0, listPhotos: async () => entries });
    assert.equal(report.captures.captured_photos, 1);
    assert.equal(report.photos.counts.applied, 1);
    assert.equal(attached.length, 1);
    const dry = await runPromotion({ root, statePath: path.join(root, 'state', 'dry.json'), map: sourceMap(),
      deps: { ...captureDeps(), photoDeps: async () => ({ ...(await photoDeps()), classify: async () =>
        ({ status: 'unmatched', parsed: parsePhotoName(relative) }) }) }, includePhotos: true, settleMs: 0, listPhotos: async () => entries });
    assert.equal(dry.captures.batches[0].status, 'previewed');
    assert.equal(dry.photos.counts['held:no_exact_record_match'], 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a lost capture-batch response holds its photos across subsequent runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-capture-recovery-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    const relative = 'Photos/Central Rd - Hira - TPFL/241024 1523 stag.jpg';
    const entries = [{ relative_path: relative, size_bytes: 5, modified_at: 't1' }];
    let writes = 0;
    let intentAtWrite = false;
    const deps = {
      ...captureDeps(),
      syncPlan: async ({ commit }) => {
        if (!commit) return { status: 'ready', requested: { inserts: 1, updates: 0 }, plan_summary: {}, plan_hold_reasons: {} };
        intentAtWrite = Boolean((await loadSyncState(statePath)).photo_capture_intents?.[relative]);
        writes += 1;
        throw new Error('simulated lost response');
      },
      photoDeps: async () => ({
        classify: async () => ({ status: 'unmatched', parsed: parsePhotoName(relative) }),
        attach: async () => { throw new Error('unmatched photo must not be attached'); },
        minuteOrganizations: () => new Set(),
      }),
    };
    const run = currentEntries => runPromotion({
      root, statePath, map: sourceMap(), deps, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => currentEntries,
    });

    const first = await run(entries);
    assert.equal(intentAtWrite, true);
    assert.equal(first.captures.batches[0].status, 'held');
    assert.equal(first.captures.batches[0].reason, 'possible_partial_photo_capture_review');
    assert.ok((await loadSyncState(statePath)).photo_capture_intents[relative]);

    const second = await run([{ ...entries[0], modified_at: 't2' }]);
    assert.equal(second.photos.counts['held:possible_partial_photo_capture_review'], 1);
    assert.equal(writes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a completed capture is not recreated while its photo target is still absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-capture-receipt-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    const relative = 'Photos/Central Rd - Hira - TPFL/241024 1523 stag.jpg';
    const entries = [{ relative_path: relative, size_bytes: 5, modified_at: 't1' }];
    let writes = 0;
    const deps = {
      ...captureDeps(),
      syncPlan: async ({ commit }) => {
        if (commit) writes += 1;
        return { status: commit ? 'committed' : 'ready', batch_id: commit ? 'batch-1' : null,
          requested: { inserts: 1, updates: 0 }, plan_summary: {}, plan_hold_reasons: {} };
      },
      photoDeps: async () => ({
        classify: async () => ({ status: 'unmatched', parsed: parsePhotoName(relative) }),
        attach: async () => { throw new Error('unmatched photo must not be attached'); },
        minuteOrganizations: () => new Set(),
      }),
    };
    const run = () => runPromotion({
      root, statePath, map: sourceMap(), deps, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => entries,
    });

    await run();
    const laterPhoto = { ...entries[0], relative_path: 'Photos/Other Gate - Hira - TPFL/241024 1523 cyclist.jpg' };
    const second = await runPromotion({
      root, statePath, map: sourceMap(), deps: {
        ...deps,
        photoDeps: async () => ({
          classify: async () => ({ status: 'unmatched', parsed: parsePhotoName(laterPhoto.relative_path) }),
          attach: async () => { throw new Error('unmatched photo must not be attached'); },
          minuteOrganizations: () => new Set(),
        }),
      },
      commit: true, includePhotos: true, settleMs: 0, listPhotos: async () => [laterPhoto],
    });
    assert.equal(second.photos.counts['held:captured_photo_record_not_found_review'], 1);
    assert.equal(writes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a later photo in an uncertain capture group cannot attach to an unreviewed record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-capture-group-recovery-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    const first = { relative_path: 'Photos/Central Rd - Hira - TPFL/241024 1523 stag.jpg', size_bytes: 5, modified_at: 't1' };
    const later = { ...first, relative_path: 'Photos/Unlabelled/241024 1523 cyclist.jpg' };
    let writes = 0;
    let attachments = 0;
    let matched = false;
    const deps = {
      ...captureDeps(),
      syncPlan: async ({ commit }) => {
        if (!commit) return { status: 'ready', requested: { inserts: 1, updates: 0 }, plan_summary: {}, plan_hold_reasons: {} };
        writes += 1;
        throw new Error('simulated lost response');
      },
      photoDeps: async () => ({
        classify: async relativePath => matched
          ? { status: 'matched', row: { matchType: 'place', organizationId: TPFL, parsed: parsePhotoName(relativePath) } }
          : { status: 'unmatched', parsed: parsePhotoName(relativePath) },
        attach: async () => { attachments += 1; return { sha256: 'a'.repeat(64), storage_path: 'org/p.jpg' }; },
        minuteOrganizations: () => new Set(),
      }),
    };
    const run = entry => runPromotion({
      root, statePath, map: sourceMap(), deps, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => [entry],
    });
    await run(first);
    matched = true;
    const second = await runPromotion({
      root, statePath, map: sourceMap({ photo_captures: captures({ enabled: false }) }), deps,
      commit: true, includePhotos: true, settleMs: 0, listPhotos: async () => [later],
    });
    assert.equal(second.photos.counts['held:possible_partial_photo_capture_review'], 1);
    assert.equal(writes, 1);
    assert.equal(attachments, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a renamed unmatched photo cannot create a capture while any attachment is unresolved', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-capture-attachment-hold-'));
  try {
    const statePath = path.join(root, 'state', 'sync.json');
    const first = { relative_path: 'Photos/Central Rd - Hira - TPFL/241024 1523 stag.jpg', size_bytes: 5, modified_at: 't1' };
    const renamed = { ...first, relative_path: 'Photos/Other Gate - Hira - TPFL/241024 1600 stag.jpg' };
    let matched = true;
    let capturesWritten = 0;
    const deps = {
      ...captureDeps(),
      syncPlan: async ({ commit }) => {
        if (commit) capturesWritten += 1;
        return { status: commit ? 'committed' : 'ready', batch_id: commit ? 'batch-1' : null,
          requested: { inserts: 1, updates: 0 }, plan_summary: {}, plan_hold_reasons: {} };
      },
      photoDeps: async () => ({
        classify: async relativePath => matched
          ? { status: 'matched', row: { matchType: 'place', organizationId: TPFL, parsed: parsePhotoName(relativePath) } }
          : { status: 'unmatched', parsed: parsePhotoName(relativePath) },
        attach: async row => {
          await row.onPrepared({ sha256: 'a'.repeat(64), storage_path: 'org/original.jpg' });
          throw new Error('simulated lost response');
        },
        minuteOrganizations: () => new Set(),
      }),
    };
    const run = entry => runPromotion({
      root, statePath, map: sourceMap(), deps, commit: true, includePhotos: true, settleMs: 0,
      listPhotos: async () => [entry],
    });
    await run(first);
    matched = false;
    const report = await run(renamed);
    assert.equal(report.photos.counts['held:unresolved_attachment_blocks_capture_review'], 1);
    assert.equal(capturesWritten, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unavailable private staging blocks photo attachments and capture writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-private-staging-'));
  try {
    const entries = [
      { relative_path: 'Photos/Central Rd - Hira - TPFL/241024 1523 stag.jpg', size_bytes: 5, modified_at: 't1' },
      { relative_path: 'Photos/Central Rd - Hira - TPFL/241024 1600 stag.jpg', size_bytes: 5, modified_at: 't1' },
    ];
    let writes = 0;
    const deps = {
      ...captureDeps(),
      syncPlan: async ({ commit }) => {
        if (commit) writes += 1;
        return { status: 'ready', requested: { inserts: 1, updates: 0 }, plan_summary: {}, plan_hold_reasons: {} };
      },
      photoDeps: async () => ({
        writeDisabledReason: 'photo_import_requires_private_staging',
        classify: async relativePath => relativePath.includes('1523')
          ? { status: 'matched', row: { matchType: 'place', parsed: parsePhotoName(relativePath) } }
          : { status: 'unmatched', parsed: parsePhotoName(relativePath) },
        attach: async () => { writes += 1; throw new Error('photo writes must be blocked'); },
        minuteOrganizations: () => new Set(),
      }),
    };
    const report = await runPromotion({
      root, statePath: path.join(root, 'state.json'), map: sourceMap(), deps,
      commit: true, includePhotos: true, settleMs: 0, listPhotos: async () => entries,
    });
    assert.equal(report.photos.counts['held:photo_import_requires_private_staging'], 2);
    assert.equal(writes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
