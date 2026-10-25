const test = require('node:test');
const assert = require('node:assert/strict');

const PROVIDER = '10000000-0000-4000-8000-000000000001';
const CLIENT = '10000000-0000-4000-8000-000000000002';
const ACTOR = '10000000-0000-4000-8000-000000000003';
const RECORD = '10000000-0000-4000-8000-000000000004';
const BATCH = '10000000-0000-4000-8000-000000000005';
const HASH = 'a'.repeat(64);

const load = () => import('../services/document-source-worker/reconcile-plan.mjs');

function sourceRow(job, overrides = {}) {
  return {
    external_ref: `rm_patrol_import:TEST:${job}`, occurred_at: '2026-10-19T12:00:00+12:00', zone_id: 'zone-1',
    event_type: 'patrol_visit', status: 'completed', distance_km: 4,
    payload: { job_number: String(job), source_file: 'source.xlsx', source_sheet: 'DATA', source_sha256: HASH, comments: 'original' },
    ...overrides,
  };
}

function sourcePlan(events, proposals = []) {
  return {
    mode: 'plan', source_file: 'source.xlsx', source_sheet: 'DATA', source_sha256: HASH,
    provider_organization_id: PROVIDER,
    manifest: { target_client_organization_id: CLIENT, source_profile: 'rm_patrol_log', idempotency_key: 'import-key' },
    batch: {
      provider_organization_id: PROVIDER, client_organization_id: CLIENT, batch_name: 'TEST field-evidence enrichment',
      source_file: 'source.xlsx', source_sha256: HASH, parser: 'csv',
      manifest: { idempotency_key: 'import-key', source_profile: 'rm_patrol_log', expected_proposal_count: proposals.length },
      schema: { headers: [] }, row_count: events.length, duplicate_count: 0, unresolved_count: 0,
    },
    observations: [], events, proposals,
  };
}

function liveEvent(row, id = RECORD) {
  return {
    id, organization_id: CLIENT, external_ref: row.external_ref, occurred_at: row.occurred_at, zone_id: row.zone_id,
    client_site_id: null, observed_entity_id: null, observed_entity_type: null, event_type: row.event_type,
    status: row.status, distance_km: row.distance_km, payload: row.payload,
  };
}

test('unchanged records without source history are flagged for a baseline; edits carry the prior source version', async () => {
  const { buildReconciliationPlan, recordFingerprint } = await load();
  const row = sourceRow(1);
  const plan = sourcePlan([row]);
  const desired = buildReconciliationPlan({ sourcePlan: plan, existing: [] }).actions[0].desired;
  const existing = [{ external_ref: row.external_ref, id: RECORD, kind: 'event', source_file: 'source.xlsx', source_sheet: 'DATA', record: desired }];
  const unbaselined = buildReconciliationPlan({ sourcePlan: plan, existing });
  assert.equal(unbaselined.actions[0].baseline_required, true);
  assert.equal(unbaselined.summary.baseline_required, 1);

  const prior = recordFingerprint(desired);
  const checkpoints = [{ external_ref: row.external_ref, record_id: RECORD, kind: 'event', source_file: 'source.xlsx',
    source_sheet: 'DATA', record_fingerprint: prior, source_fingerprint: prior }];
  assert.equal(buildReconciliationPlan({ sourcePlan: plan, existing, checkpoints }).actions[0].baseline_required, undefined);
  row.status = 'completed - gate damaged';
  const edited = buildReconciliationPlan({ sourcePlan: plan, existing, checkpoints });
  assert.equal(edited.actions[0].operation, 'update');
  assert.equal(edited.actions[0].prior_source_fingerprint, prior);
});

test('linked baselines load current source versions as checkpoints only when sync history exists', async () => {
  const { loadLinkedBaseline } = await load();
  const plan = sourcePlan([sourceRow(1)]);
  const queries = [];
  const baseline = await loadLinkedBaseline(plan, PROVIDER, async sql => {
    queries.push(sql);
    if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }];
    return [{ activity: { observations: [], events: [], checkpoints: [{ external_ref: plan.events[0].external_ref,
      record_id: RECORD, kind: 'event', source_file: 'source.xlsx', source_sheet: 'DATA', source_fingerprint: 'f'.repeat(64) }] } }];
  });
  assert.ok(queries[1].includes('patrol_import_record_versions') && queries[1].includes('v.is_current'));
  assert.ok(queries[1].includes(PROVIDER) && queries[1].includes(CLIENT));
  assert.equal(baseline.checkpoints[0].record_fingerprint, 'f'.repeat(64));
  assert.equal(baseline.sync_history, true);

  const legacy = [];
  await loadLinkedBaseline(plan, PROVIDER, async sql => {
    legacy.push(sql);
    return sql.includes('AS scope') ? [{ scope: { authorized: true, eligible_officer_ids: [] } }]
      : [{ activity: { observations: [], events: [] } }];
  });
  assert.ok(!legacy[1].includes('patrol_import_record_versions'));
  await assert.rejects(loadLinkedBaseline(plan, PROVIDER, async sql => sql.includes('AS scope')
    ? [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }]
    : [{ activity: { observations: [], events: [] } }]), /Incomplete linked activity/);
});

test('sync chunks pair each row with its own proposals and never send unchanged or held rows', async () => {
  const { buildReconciliationPlan, buildSyncChunks } = await load();
  const rows = [sourceRow(1), sourceRow(2), sourceRow(3), sourceRow(4)];
  const proposals = [
    { source_record_key: rows[0].external_ref, target_type: 'finance_service_cost' },
    { source_record_key: rows[2].external_ref, target_type: 'finance_service_cost' },
  ];
  const plan = sourcePlan(rows, proposals);
  const reconciliation = {
    source_sha256: HASH,
    actions: [
      { external_ref: rows[0].external_ref, kind: 'event', operation: 'insert', source_fingerprint: 'f1' },
      { external_ref: rows[1].external_ref, kind: 'event', operation: 'unchanged', record_id: RECORD, baseline_required: true, source_fingerprint: 'f2' },
      { external_ref: rows[2].external_ref, kind: 'event', operation: 'update', record_id: RECORD, prior_source_fingerprint: 'p3', source_fingerprint: 'f3' },
      { external_ref: rows[3].external_ref, kind: 'event', operation: 'hold', reason: 'ambiguous_record_key', source_fingerprint: 'f4' },
    ],
  };
  const result = buildSyncChunks(plan, reconciliation, { chunkSize: 2 });
  assert.equal(result.chunks.length, 2);
  assert.deepEqual(result.counts, { inserts: 1, baselines: 2, updates: 1, proposals: 2 });
  assert.equal(result.chunks[0].events[0], rows[0]);
  assert.equal(result.chunks[0].baselines[0].record_id, null);
  assert.equal(result.chunks[0].baselines[1].record_id, RECORD);
  assert.deepEqual(result.chunks[0].proposals, [proposals[0]]);
  assert.equal(result.chunks[1].updates[0].prior_source_fingerprint, 'p3');
  assert.deepEqual(result.chunks[1].proposals, [proposals[1]]);
  assert.ok(!JSON.stringify(result.chunks).includes(rows[3].external_ref));
  assert.throws(() => buildSyncChunks(plan, { ...reconciliation, source_sha256: 'b'.repeat(64) }), /this source version/);
  assert.throws(() => buildSyncChunks(plan, reconciliation, { chunkSize: 501 }), /1-500/);
  assert.equal(buildReconciliationPlan({ sourcePlan: plan, existing: [] }).summary.insert, 4);
});

test('sync SQL runs as the import identity, rolls back unless committed, and keeps preview DDL out of commits', async () => {
  const { buildSyncChunkSql } = await load();
  const chunk = { observations: [], events: [sourceRow(1)], proposals: [], baselines: [], updates: [] };
  const base = { actorId: ACTOR, providerOrganizationId: PROVIDER, clientOrganizationId: CLIENT,
    batch: sourcePlan([sourceRow(1)]).batch, chunk };
  const dryRun = buildSyncChunkSql({ ...base, commit: false });
  assert.match(dryRun, /set local request\.jwt\.claim\.sub = '10000000-0000-4000-8000-000000000003'/);
  assert.match(dryRun, /ROLLBACK;$/);
  assert.ok(dryRun.includes('public.adopt_patrol_source_baseline') && dryRun.includes('public.apply_patrol_source_updates'));
  assert.match(buildSyncChunkSql({ ...base, commit: true }), /COMMIT;$/);
  assert.throws(() => buildSyncChunkSql({ ...base, commit: true, previewMigrationSql: 'create table x();' }), /dry run/);
  assert.throws(() => buildSyncChunkSql({ ...base, actorId: 'nope', commit: false }), /identities/);
  const hostile = { ...chunk, events: [sourceRow(1, { status: 'x$sync$y' })] };
  assert.throws(() => buildSyncChunkSql({ ...base, chunk: hostile, commit: false }), /delimiter/);
});

function syncHarness({ existingEvents = [], checkpoints = [], batches = [] } = {}) {
  const reads = [];
  const writes = [];
  return {
    reads, writes,
    readQuery: async sql => {
      reads.push(sql);
      if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }];
      if (sql.includes('AS activity')) return [{ activity: { observations: [], events: existingEvents, checkpoints } }];
      if (sql.includes('import_actor_id')) return [{ import_actor_id: ACTOR }];
      if (sql.includes('file_import_batches')) return batches;
      throw new Error('unexpected read');
    },
    writeQuery: async sql => {
      writes.push(sql);
      if (sql.includes('finalize_patrol_import_batch')) return [{ id: BATCH }];
      return [{ batch_id: BATCH, results: [
        { phase: 'stage', outcome: 'staged', detail: JSON.stringify({ evt_inserted: 1, obs_inserted: 0, proposals_inserted: 0 }) },
        { phase: 'baseline', external_ref: 'r', record_id: RECORD, outcome: 'adopted', detail: null },
        { phase: 'update', external_ref: 'u', record_id: RECORD, outcome: 'held', detail: 'fcm_record_changed_since_last_sync' },
      ] }];
    },
  };
}

test('a dry run sends rolled-back chunks and never finalizes; nothing is written when the source is unchanged', async () => {
  const { runSourceSync } = await load();
  const harness = syncHarness();
  const plan = sourcePlan([sourceRow(1)]);
  const report = await runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: harness.writeQuery });
  assert.equal(report.mode, 'dry_run');
  assert.equal(report.committed, false);
  assert.equal(harness.writes.length, 1);
  assert.match(harness.writes[0], /ROLLBACK;$/);
  assert.ok(harness.writes[0].includes('row_sync:1:import-key'));
  assert.ok(!harness.writes.some(sql => sql.includes('finalize_patrol_import_batch')));
  assert.equal(report.summary.staged.evt_inserted, 1);
  assert.deepEqual(report.summary.hold_reasons, { 'update:fcm_record_changed_since_last_sync': 1 });

  const { recordFingerprint, buildReconciliationPlan } = await load();
  const row = sourceRow(2);
  const unchangedPlan = sourcePlan([row]);
  const fingerprint = buildReconciliationPlan({ sourcePlan: unchangedPlan, existing: [] }).actions[0].source_fingerprint;
  const settled = syncHarness({ existingEvents: [liveEvent(row)], checkpoints: [{ external_ref: row.external_ref,
    record_id: RECORD, kind: 'event', source_file: 'source.xlsx', source_sheet: 'DATA', source_fingerprint: fingerprint }] });
  const idle = await runSourceSync({ sourcePlan: unchangedPlan, providerOrganizationId: PROVIDER,
    readQuery: settled.readQuery, writeQuery: settled.writeQuery, commit: true });
  assert.equal(idle.status, 'no_source_changes');
  assert.equal(settled.writes.length, 0);
  assert.equal(typeof recordFingerprint, 'function');
});

test('a committed sync resumes an open batch, finalizes with a zero-direct-write receipt, and refuses a closed batch', async () => {
  const { runSourceSync } = await load();
  const plan = sourcePlan([sourceRow(1)]);
  const resumed = syncHarness({ batches: [{ id: BATCH, status: 'staging' }] });
  const report = await runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: resumed.readQuery, writeQuery: resumed.writeQuery, commit: true });
  assert.equal(report.committed, true);
  assert.match(resumed.writes[0], /COMMIT;$/);
  assert.ok(resumed.writes[0].includes(`"batch_id":"${BATCH}"`));
  const finalize = resumed.writes.at(-1);
  assert.ok(finalize.includes('finalize_patrol_import_batch') && finalize.includes('"direct_finance_writes":0'));

  const closed = syncHarness({ batches: [{ id: BATCH, status: 'needs_review' }] });
  await assert.rejects(runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: closed.readQuery, writeQuery: closed.writeQuery, commit: true }), /next --attempt/);
  assert.equal(closed.writes.length, 0);
  const next = syncHarness();
  await runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: next.readQuery, writeQuery: next.writeQuery, commit: true, attempt: 2 });
  assert.ok(next.writes[0].includes('row_sync:2:import-key'));
});

test('sync refuses plans without the importer batch definition or an installed sync path', async () => {
  const { runSourceSync } = await load();
  const harness = syncHarness();
  const plan = sourcePlan([sourceRow(1)]);
  delete plan.batch;
  await assert.rejects(runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: harness.writeQuery }), /batch definition/);
  const uninstalled = {
    readQuery: async sql => sql.includes('AS scope') ? [{ scope: { authorized: true, eligible_officer_ids: [] } }]
      : [{ activity: { observations: [], events: [] } }],
    writeQuery: async () => assert.fail('must not write'),
  };
  await assert.rejects(runSourceSync({ sourcePlan: sourcePlan([sourceRow(1)]), providerOrganizationId: PROVIDER,
    ...uninstalled }), /not installed/);
});
