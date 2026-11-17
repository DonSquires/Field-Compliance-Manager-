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
  assert.match(queries[1], /'record_matches_state_after',public\.patrol_source_record_state\(v\.record_kind,v\.record_id\)\s+IS NOT DISTINCT FROM v\.state_after/);
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

test('source financial values remain held before an event, observation, or proposal can be written', async () => {
  const { runSourceSync } = await load();
  for (const [kind, field, value] of [
    ['event', 'job_cost', 0],
    ['event', 'travel_cost', 8675309.42],
    ['event', 'source_leg_correction', { total_cost: 31 }],
    ['observation', 'total_cost', 18],
    ['proposal', 'job_cost', 5],
  ]) {
    const row = sourceRow(1);
    row.payload.source_row = 2;
    const plan = sourcePlan(kind === 'observation' ? [] : [row]);
    if (kind === 'observation') {
      plan.observations.push({ ...row, plate: 'ABC123' });
    } else if (kind === 'proposal') {
      plan.proposals.push({ source_record_key: row.external_ref, source_values: { [field]: value } });
    }
    if (kind !== 'proposal') row.payload[field] = value;
    let writeAttempts = 0;
    const readQuery = async sql => {
      if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }];
      if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [], checkpoints: [] } }];
      if (sql.includes('import_actor_id')) return [{ import_actor_id: ACTOR }];
      return [];
    };
    const report = await runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER, readQuery,
      writeQuery: async () => { writeAttempts += 1; throw new Error('Unexpected database write'); }, commit: true });
    assert.equal(report.status, 'source_rows_held', `${kind}:${field}`);
    assert.equal(report.plan_hold_reasons.source_financial_values_require_review, 1, `${kind}:${field}`);
    assert.equal(writeAttempts, 0, `${kind}:${field}`);
    assert.equal(report.plan_hold_samples[0].external_ref, row.external_ref);
    if (value === 8675309.42) assert.doesNotMatch(JSON.stringify(report), /8675309\.42/);
  }
});

test('absent and null financial values do not hold a source row', async () => {
  const { buildReconciliationPlan, buildSyncChunks } = await load();
  const row = sourceRow(1);
  row.payload.job_cost = null;
  row.payload.source_leg_correction = { travel_cost: null };
  const plan = sourcePlan([row], [{ source_record_key: row.external_ref, source_values: { total_cost: null } }]);
  const reconciliation = buildReconciliationPlan({ sourcePlan: plan, existing: [] });
  assert.equal(reconciliation.actions[0].operation, 'insert');
  assert.equal(buildSyncChunks(plan, reconciliation).counts.inserts, 1);
});

test('financial-only source holds name the actual reason when paired matching is requested', async () => {
  const { buildReconciliationPlan } = await load();
  const hold = { external_ref: 'rm_patrol_import:TEST:start', kind: 'source_row', source_row: 4,
    reason: 'source_financial_values_require_review' };
  const current = sourcePlan([sourceRow(1)]);
  current.source_holds = [hold];
  assert.throws(() => buildReconciliationPlan({ sourcePlan: current, existing: [], sheetCopies: [{}] }),
    /financial.*review/i);

  const paired = { ...sourcePlan([]), source_sheet: 'CANON', source_holds: [hold] };
  assert.throws(() => buildReconciliationPlan({ sourcePlan: sourcePlan([sourceRow(1)]), existing: [], canonicalPlan: paired }),
    /financial.*review/i);
});

test('a forged reconciliation action cannot put source financial values in a write chunk', async () => {
  const { buildSyncChunks } = await load();
  for (const kind of ['event', 'proposal']) {
    const row = sourceRow(1);
    if (kind === 'event') row.payload.travel_cost = 0;
    const proposals = kind === 'proposal' ? [{ source_record_key: row.external_ref, source_values: { job_cost: 5 } }] : [];
    const plan = sourcePlan([row], proposals);
    const forged = { source_sha256: HASH, actions: [{ external_ref: row.external_ref, kind: 'event',
      operation: 'insert', source_fingerprint: 'f'.repeat(64) }] };
    assert.throws(() => buildSyncChunks(plan, forged), /financial.*review/i, kind);
  }
});

test('sync SQL refuses manually constructed chunks containing source financial values', async () => {
  const { buildSyncChunkSql } = await load();
  const row = sourceRow(1, { payload: { ...sourceRow(1).payload, job_cost: 0 } });
  for (const [phase, value] of [
    ['events', row], ['observations', row], ['proposals', { source_values: { travel_cost: 3 } }],
    ['baselines', { desired: row }], ['updates', { desired: row }], ['corrections', { desired: row }],
    ['supersedes', { desired: row }], ['dartUpdates', { update_desired: row }],
  ]) {
    const chunk = { observations: [], events: [], proposals: [], baselines: [], updates: [],
      corrections: [], supersedes: [], dartUpdates: [], [phase]: [value] };
    const input = { actorId: ACTOR, providerOrganizationId: PROVIDER, clientOrganizationId: CLIENT,
      batch: sourcePlan([row]).batch, dartUpdateBatch: { manifest: { idempotency_key: 'update-key' } }, chunk };
    for (const commit of [false, true]) {
      assert.throws(() => buildSyncChunkSql({ ...input, commit }), /financial.*review/i, `${phase}:${commit}`);
    }
  }
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

test('a server hold rolls back its entire sync chunk in PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const { execFileSync } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const { buildSyncChunkSql } = await load();
  const name = `fcm-patrol-sync-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = query => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--pull', 'never',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    sql(`CREATE TABLE public.test_stage(id integer);
      CREATE TABLE public.location_events(id uuid, organization_id uuid, external_ref text);
      CREATE TABLE public.observations(id uuid, organization_id uuid, external_refs jsonb);
      CREATE TYPE public.test_batch_result AS (id uuid);
      CREATE FUNCTION public.begin_patrol_import_batch(
        p_provider_organization_id uuid, p_client_organization_id uuid, p_batch_name text,
        p_source_file text, p_source_sha256 text, p_parser text, p_manifest_json jsonb,
        p_schema_json jsonb, p_row_count integer, p_duplicate_count integer, p_unresolved_count integer)
      RETURNS public.test_batch_result LANGUAGE sql AS $$ SELECT ROW('${BATCH}'::uuid)::public.test_batch_result $$;
      CREATE FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb)
      RETURNS TABLE(obs_inserted integer, evt_inserted integer, proposals_inserted integer)
      LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.test_stage VALUES (1); RETURN QUERY SELECT 0,1,0; END $$;
      CREATE FUNCTION public.adopt_patrol_source_baseline(uuid,uuid,uuid,jsonb)
      RETURNS TABLE(external_ref text,record_id uuid,outcome text,detail text)
      LANGUAGE sql AS $$ SELECT 'ref'::text,'${RECORD}'::uuid,
        CASE WHEN current_setting('test.hold',true)='yes' THEN 'held' ELSE 'adopted' END,
        'review_required'::text $$;
      CREATE FUNCTION public.apply_patrol_source_updates(uuid,uuid,uuid,jsonb)
      RETURNS TABLE(external_ref text,record_id uuid,outcome text,detail text)
      LANGUAGE sql AS $$ SELECT NULL::text,NULL::uuid,NULL::text,NULL::text WHERE false $$;
      CREATE FUNCTION public.correct_legacy_patrol_source_records(uuid,uuid,uuid,jsonb)
      RETURNS TABLE(external_ref text,record_id uuid,outcome text,detail text)
      LANGUAGE sql AS $$ SELECT NULL::text,NULL::uuid,NULL::text,NULL::text WHERE false $$;
      CREATE FUNCTION public.supersede_duplicate_patrol_events(uuid,uuid,uuid,jsonb)
      RETURNS TABLE(external_ref text,record_id uuid,outcome text,detail text)
      LANGUAGE sql AS $$ SELECT NULL::text,NULL::uuid,NULL::text,NULL::text WHERE false $$;`);
    const chunk = { observations: [], events: [sourceRow(1)], proposals: [],
      baselines: [{ kind: 'event', external_ref: sourceRow(1).external_ref, record_id: RECORD }],
      updates: [], corrections: [], supersedes: [] };
    const base = { actorId: ACTOR, providerOrganizationId: PROVIDER, clientOrganizationId: CLIENT,
      batch: sourcePlan([sourceRow(1)]).batch, chunk };
    const preview = sql(`SET test.hold='yes'; ${buildSyncChunkSql({ ...base, commit: false })}`);
    assert.match(preview, /"outcome": "held"/);
    assert.equal(sql('SELECT count(*) FROM public.test_stage;'), '0');
    assert.throws(() => sql(`SET test.hold='yes'; ${buildSyncChunkSql({ ...base, commit: true })}`),
      error => /Source rows were held during commit/.test(String(error.stderr))
        && /phase=baseline/.test(String(error.stderr)) && String(error.stderr).includes(RECORD));
    assert.equal(sql('SELECT count(*) FROM public.test_stage;'), '0');
    sql(`SET test.hold='no'; ${buildSyncChunkSql({ ...base, commit: true })}`);
    assert.equal(sql('SELECT count(*) FROM public.test_stage;'), '1');
    sql(`INSERT INTO public.location_events(id, organization_id, external_ref)
      VALUES ('${RECORD}', '${CLIENT}', '${sourceRow(1).external_ref}');`);
    assert.throws(() => sql(`SET test.hold='no'; ${buildSyncChunkSql({ ...base, commit: true })}`),
      error => /Source row appeared after comparison/.test(String(error.stderr)));
    assert.equal(sql('SELECT count(*) FROM public.test_stage;'), '1');
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});

test('a concurrent record edit cannot be overwritten by a committed sync chunk', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const { execFileSync } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const { buildSyncChunkSql } = await load();
  const name = `fcm-patrol-sync-race-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = query => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--pull', 'never',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    sql(`CREATE EXTENSION dblink;
      CREATE TABLE public.location_events(id uuid PRIMARY KEY, organization_id uuid, external_ref text, status text);
      CREATE TABLE public.observations(id uuid, organization_id uuid, external_refs jsonb);
      INSERT INTO public.location_events VALUES ('${RECORD}', '${CLIENT}', '${sourceRow(1).external_ref}', 'original');
      CREATE TYPE public.test_batch_result AS (id uuid);
      CREATE FUNCTION public.begin_patrol_import_batch(
        p_provider_organization_id uuid, p_client_organization_id uuid, p_batch_name text,
        p_source_file text, p_source_sha256 text, p_parser text, p_manifest_json jsonb,
        p_schema_json jsonb, p_row_count integer, p_duplicate_count integer, p_unresolved_count integer)
      RETURNS public.test_batch_result LANGUAGE sql AS $$ SELECT ROW('${BATCH}'::uuid)::public.test_batch_result $$;
      CREATE FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb)
      RETURNS TABLE(obs_inserted integer, evt_inserted integer, proposals_inserted integer)
      LANGUAGE sql AS $$ SELECT 0,0,0 $$;
      CREATE FUNCTION public.adopt_patrol_source_baseline(uuid,uuid,uuid,jsonb)
      RETURNS TABLE(external_ref text,record_id uuid,outcome text,detail text)
      LANGUAGE sql AS $$ SELECT NULL::text,NULL::uuid,NULL::text,NULL::text WHERE false $$;
      CREATE FUNCTION public.apply_patrol_source_updates(uuid,uuid,uuid,jsonb)
      RETURNS TABLE(external_ref text,record_id uuid,outcome text,detail text)
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM event.status FROM public.location_events event WHERE event.id = '${RECORD}';
        PERFORM public.dblink_exec('host=127.0.0.1 user=postgres dbname=postgres',
          'UPDATE public.location_events SET status = ''manual edit'' WHERE id = ''${RECORD}''');
        UPDATE public.location_events event SET status = 'source update' WHERE event.id = '${RECORD}';
        RETURN QUERY SELECT '${sourceRow(1).external_ref}'::text, '${RECORD}'::uuid, 'updated'::text, NULL::text;
      END $$;
      CREATE FUNCTION public.correct_legacy_patrol_source_records(uuid,uuid,uuid,jsonb)
      RETURNS TABLE(external_ref text,record_id uuid,outcome text,detail text)
      LANGUAGE sql AS $$ SELECT NULL::text,NULL::uuid,NULL::text,NULL::text WHERE false $$;
      CREATE FUNCTION public.supersede_duplicate_patrol_events(uuid,uuid,uuid,jsonb)
      RETURNS TABLE(external_ref text,record_id uuid,outcome text,detail text)
      LANGUAGE sql AS $$ SELECT NULL::text,NULL::uuid,NULL::text,NULL::text WHERE false $$;`);
    const chunk = { observations: [], events: [], proposals: [], baselines: [],
      updates: [{ kind: 'event', external_ref: sourceRow(1).external_ref, record_id: RECORD }] };
    const base = { actorId: ACTOR, providerOrganizationId: PROVIDER, clientOrganizationId: CLIENT,
      batch: sourcePlan([sourceRow(1)]).batch, chunk, commit: true };
    const guarded = buildSyncChunkSql(base);
    const unguarded = guarded.replace('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;', '');
    assert.notEqual(unguarded, guarded);
    sql(unguarded);
    assert.equal(sql(`SELECT status FROM public.location_events WHERE id = '${RECORD}';`), 'source update');
    sql(`UPDATE public.location_events SET status = 'original' WHERE id = '${RECORD}';`);
    assert.throws(() => sql(guarded),
      error => /could not serialize access due to concurrent update/.test(String(error.stderr)));
    assert.equal(sql(`SELECT status FROM public.location_events WHERE id = '${RECORD}';`), 'manual edit');
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});

function syncHarness({ existingEvents = [], checkpoints = [], batches = [], serverHold = true } = {}) {
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
        ...(serverHold ? [{ phase: 'update', external_ref: 'u', record_id: RECORD,
          outcome: 'held', detail: 'fcm_record_changed_since_last_sync' }] : []),
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

test('a direct committed sync preflights every chunk and stops on a server hold', async () => {
  const { runSourceSync } = await load();
  const harness = syncHarness();
  let preview = 0;
  const writeQuery = async sql => {
    harness.writes.push(sql);
    if (!sql.endsWith('ROLLBACK;')) assert.fail('a held preview must not reach a committed transaction');
    preview += 1;
    return [{ batch_id: BATCH, results: preview === 2
      ? [{ phase: 'update', outcome: 'held', detail: 'place_outside_contracted_patrol_coverage' }]
      : [{ phase: 'stage', outcome: 'staged', detail: '{"evt_inserted":1}' }] }];
  };
  const report = await runSourceSync({ sourcePlan: sourcePlan([sourceRow(1), sourceRow(2)]),
    providerOrganizationId: PROVIDER, readQuery: harness.readQuery, writeQuery, chunkSize: 1, commit: true });
  assert.equal(report.status, 'source_rows_held');
  assert.equal(report.committed, false);
  assert.equal(harness.writes.length, 2);
  assert.deepEqual(report.summary.hold_reasons, { 'update:place_outside_contracted_patrol_coverage': 1 });
});

test('a later sync failure reports that an earlier chunk committed', async () => {
  const { runSourceSync } = await load();
  const harness = syncHarness();
  let committed = 0;
  const writeQuery = async sql => {
    if (sql.endsWith('ROLLBACK;')) return [{ batch_id: BATCH, results: [] }];
    committed += 1;
    if (committed === 2) throw new Error('connection reset');
    return [{ batch_id: BATCH, results: [{ phase: 'stage', outcome: 'staged', detail: '{"evt_inserted":1}' }] }];
  };
  await assert.rejects(runSourceSync({ sourcePlan: sourcePlan([sourceRow(1), sourceRow(2)]),
    providerOrganizationId: PROVIDER, readQuery: harness.readQuery, writeQuery, chunkSize: 1, commit: true }),
  error => error.message === 'connection reset' && error.sourceSyncReport?.committed === true
    && error.sourceSyncReport.batch_id === BATCH && error.sourceSyncWriteAttempted === true);
});

test('evidence-only sync preserves narrative fields but suppresses proposals on every chunk', async () => {
  const { runSourceSync } = await load();
  const rows = [sourceRow(1), sourceRow(2)];
  const plan = sourcePlan(rows, rows.map(row => ({
    source_record_key: row.external_ref, target_type: 'finance_service_cost',
  })));
  const harness = syncHarness();
  const report = await runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: harness.writeQuery, evidenceOnly: true, chunkSize: 1 });
  assert.equal(report.requested.proposals, 0);
  assert.equal(harness.writes.length, 2);
  for (const sql of harness.writes) {
    assert.ok(sql.includes('"proposals":[]'));
    assert.ok(sql.includes('"expected_proposal_count":0'));
    assert.ok(sql.includes('"comments":"original"'));
    assert.ok(!sql.includes('finance_service_cost'));
    assert.match(sql, /ROLLBACK;$/);
  }
  assert.equal(plan.proposals.length, 2);

  const standard = syncHarness();
  const defaultReport = await runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: standard.readQuery, writeQuery: standard.writeQuery });
  assert.equal(defaultReport.requested.proposals, 2);
});

test('a committed sync resumes an open batch, finalizes with a zero-direct-write receipt, and refuses a closed batch', async () => {
  const { runSourceSync } = await load();
  const plan = sourcePlan([sourceRow(1)]);
  const resumed = syncHarness({ batches: [{ id: BATCH, status: 'staging' }], serverHold: false });
  const report = await runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: resumed.readQuery, writeQuery: resumed.writeQuery, commit: true });
  assert.equal(report.committed, true);
  assert.match(resumed.writes[0], /ROLLBACK;$/);
  assert.match(resumed.writes[1], /COMMIT;$/);
  assert.ok(resumed.writes[1].includes(`"batch_id":"${BATCH}"`));
  const finalize = resumed.writes.at(-1);
  assert.ok(finalize.includes('finalize_patrol_import_batch') && finalize.includes('"direct_finance_writes":0'));

  const closed = syncHarness({ batches: [{ id: BATCH, status: 'needs_review' }] });
  await assert.rejects(runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: closed.readQuery, writeQuery: closed.writeQuery, commit: true }), /next --attempt/);
  assert.equal(closed.writes.length, 0);
  const next = syncHarness({ serverHold: false });
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

test('source sync holds the sheet when any source place is conflicting', async () => {
  const { runSourceSync, buildSyncChunks } = await load();
  const conflict = { ...sourcePlan([sourceRow(1)], [
    { source_record_key: 'rm_patrol_import:TEST:2', target_type: 'finance_service_cost' },
  ]), unresolved_places: [
    { name: null, reason: 'conflicting_place_fields', source_rows: [7] },
  ], source_holds: [
    { external_ref: 'rm_patrol_import:TEST:2', kind: 'event', source_row: 7, reason: 'conflicting_place_fields' },
  ] };
  const harness = syncHarness();
  const report = await runSourceSync({ sourcePlan: conflict, providerOrganizationId: PROVIDER,
    commit: true, readQuery: harness.readQuery, writeQuery: harness.writeQuery });
  assert.equal(report.status, 'source_rows_held');
  assert.equal(report.committed, false);
  assert.equal(report.plan_summary.hold, 1);
  assert.equal(report.plan_hold_reasons.conflicting_place_fields, 1);
  assert.deepEqual(report.plan_hold_samples, [{
    external_ref: 'rm_patrol_import:TEST:2', kind: 'event', source_row: 7, reason: 'conflicting_place_fields',
  }]);
  assert.equal(report.requested.inserts, 1);
  assert.equal(report.requested.proposals, 0);
  assert.deepEqual(harness.writes, []);
  assert.equal(buildSyncChunks(conflict, {
    source_sha256: HASH, actions: [{ external_ref: 'rm_patrol_import:TEST:2', kind: 'event', operation: 'hold',
      source_row: 7, reason: 'conflicting_place_fields' }],
  }).chunks.length, 0);

  for (const extra of [{ canonicalPlan: conflict }, { sheetUpdatePlan: conflict }]) {
    await assert.rejects(runSourceSync({
      sourcePlan: sourcePlan([sourceRow(1)]), providerOrganizationId: PROVIDER, commit: true,
      readQuery: async () => assert.fail('must not read or open a batch'),
      writeQuery: async () => assert.fail('must not write'), ...extra,
    }), /conflicting place fields.*review/i);
  }
  assert.throws(() => buildSyncChunks({ ...conflict, source_holds: [] }, { source_sha256: HASH, actions: [] }),
    /conflicting source rows/i);
});

test('prospective place planning does not call the sync writer or claim server validation', async () => {
  const { runSourceSync } = await load();
  const harness = syncHarness();
  const report = await runSourceSync({ sourcePlan: sourcePlan([sourceRow(1)]), providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: harness.writeQuery, planningOnly: true });
  assert.equal(report.status, 'planning_only');
  assert.equal(report.server_validation, 'not_run');
  assert.equal(report.requested.inserts, 1);
  assert.deepEqual(harness.writes, []);
  await assert.rejects(runSourceSync({ sourcePlan: sourcePlan([sourceRow(1)]), providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: harness.writeQuery, planningOnly: true, commit: true }), /cannot commit/i);
});

test('an unplaced sighting holds safe rows without opening a batch', async () => {
  const { runSourceSync } = await load();
  const source = sourcePlan([sourceRow(1)]);
  source.observations = [{ ...sourceRow(2), zone_id: null, site_id: null, officer_id: ACTOR, plate: 'ABC123' }];
  const harness = syncHarness();
  const report = await runSourceSync({ sourcePlan: source, providerOrganizationId: PROVIDER,
    commit: true, readQuery: harness.readQuery, writeQuery: harness.writeQuery });
  assert.equal(report.status, 'source_rows_held');
  assert.equal(report.committed, false);
  assert.equal(report.plan_hold_reasons.one_resolved_place_required, 1);
  assert.equal(report.requested.inserts, 1);
  assert.deepEqual(harness.writes, []);
});

test('an unresolved source row cannot disappear from both activity and holds', async () => {
  const { buildReconciliationPlan } = await load();
  const incomplete = { ...sourcePlan([sourceRow(1)]), unresolved_places: [
    { name: 'Unknown place', source_rows: [7] },
  ], source_holds: [] };
  assert.throws(() => buildReconciliationPlan({ sourcePlan: incomplete, existing: [] }), /unresolved.*row.*hold/i);
});

test('held source keys cannot be superseded or used in worksheet pairing', async () => {
  const { buildReconciliationPlan, buildSyncChunks, runSourceSync } = await load();
  const held = { ...sourcePlan([sourceRow(1)]), unresolved_places: [
    { reason: 'conflicting_place_fields', source_rows: [7] },
  ], source_holds: [
    { external_ref: 'rm_patrol_import:TEST:2', kind: 'event', source_row: 7, reason: 'conflicting_place_fields' },
  ] };
  const reconciliation = buildReconciliationPlan({ sourcePlan: held, existing: [] });
  reconciliation.actions.push({ external_ref: 'rm_patrol_import:TEST:2', kind: 'event',
    operation: 'supersede', canonical_external_ref: 'rm_patrol_import:OTHER:2' });
  assert.throws(() => buildSyncChunks(held, reconciliation), /held.*source|source.*held/i);
  const otherSheet = { ...held, source_sheet: 'OTHER' };
  assert.throws(() => buildReconciliationPlan({ sourcePlan: sourcePlan([sourceRow(1)]),
    existing: [], canonicalPlan: otherSheet }), /conflicting place fields/i);
  await assert.rejects(runSourceSync({ sourcePlan: held, providerOrganizationId: PROVIDER,
    copySheets: ['OTHER'], readQuery: async () => assert.fail('must not read or open a batch'),
    writeQuery: async () => assert.fail('must not write') }), /conflicting place fields/i);
});

test('a worksheet with unresolved visits cannot be used to pair canonical records', async () => {
  const { buildReconciliationPlan } = await load();
  const unresolved = { ...sourcePlan([sourceRow(1)]), source_sheet: 'OTHER',
    unresolved_places: [{ name: 'Unknown place', source_rows: [7] }],
    source_holds: [{ external_ref: 'rm_patrol_import:TEST:2', kind: 'event',
      source_row: 7, reason: 'unresolved_source_place' }] };
  assert.throws(() => buildReconciliationPlan({ sourcePlan: sourcePlan([sourceRow(1)]),
    existing: [], canonicalPlan: unresolved }), /unresolved.*place|place.*unresolved/i);
});

test('an unplaced source record stays held even when previously superseded', async () => {
  const { buildReconciliationPlan, runSourceSync } = await load();
  const row = { ...sourceRow(1), zone_id: null };
  const reconciliation = buildReconciliationPlan({ sourcePlan: sourcePlan([row]), existing: [],
    supersededRefs: [row.external_ref] });
  assert.equal(reconciliation.actions[0].operation, 'hold');
  assert.equal(reconciliation.actions[0].reason, 'one_resolved_place_required');
  await assert.rejects(runSourceSync({ sourcePlan: sourcePlan([row]), providerOrganizationId: PROVIDER,
    copySheets: ['OTHER'], readQuery: async () => assert.fail('must not read'),
    writeQuery: async () => assert.fail('must not write') }), /unresolved.*place|place.*unresolved/i);
});

test('held source rows never create a batch even after partial resolution', async () => {
  const { runSourceSync } = await load();
  const makePlan = rows => ({ ...sourcePlan([sourceRow(1)]),
    unresolved_places: [{ reason: 'conflicting_place_fields', source_rows: rows }],
    source_holds: rows.map(row => ({ external_ref: `rm_patrol_import:TEST:${row}`, kind: 'event',
      source_row: row, reason: 'conflicting_place_fields' })),
  });
  const first = syncHarness();
  const firstReport = await runSourceSync({ sourcePlan: makePlan([7, 8]), providerOrganizationId: PROVIDER,
    readQuery: first.readQuery, writeQuery: first.writeQuery, commit: true });
  assert.equal(firstReport.status, 'source_rows_held');
  assert.deepEqual(first.writes, []);
  assert.ok(!first.reads.some(sql => sql.includes('file_import_batches')));
  const second = syncHarness();
  const report = await runSourceSync({ sourcePlan: makePlan([8]), providerOrganizationId: PROVIDER,
    readQuery: second.readQuery, writeQuery: second.writeQuery, commit: true });
  assert.equal(report.status, 'source_rows_held');
  assert.deepEqual(second.writes, []);
  assert.ok(!second.reads.some(sql => sql.includes('file_import_batches')));
});

test('an existing evidence record with a different source place requires review', async () => {
  const { buildReconciliationPlan, buildSyncChunks } = await load();
  for (const kind of ['event', 'observation']) {
    const row = sourceRow(1, kind === 'observation' ? { plate: 'ABC123', officer_id: ACTOR } : {});
    const plan = sourcePlan(kind === 'event' ? [row] : []);
    if (kind === 'observation') plan.observations = [row];
    const first = buildReconciliationPlan({ sourcePlan: plan, existing: [] }).actions[0];
    const existing = [{ external_ref: row.external_ref, id: RECORD, kind, source_file: 'source.xlsx',
      source_sheet: 'DATA', record: first.desired }];
    const checkpoints = [{ external_ref: row.external_ref, record_id: RECORD, kind, source_file: 'source.xlsx',
      source_sheet: 'DATA', source_fingerprint: first.source_fingerprint, record_fingerprint: first.source_fingerprint }];
    row.zone_id = 'zone-2';
    const reconciliation = buildReconciliationPlan({ sourcePlan: plan, existing, checkpoints });
    assert.equal(reconciliation.actions[0].reason, 'source_place_difference_requires_review');
    assert.equal(reconciliation.actions[0].operation, 'hold');
    assert.deepEqual(buildSyncChunks(plan, reconciliation).chunks, []);
  }
});

test('an existing-place review hold blocks safe inserts and batch creation', async () => {
  const { buildReconciliationPlan, runSourceSync } = await load();
  const original = sourceRow(1);
  const previous = buildReconciliationPlan({ sourcePlan: sourcePlan([original]), existing: [] }).actions[0];
  const row = { ...original, zone_id: 'zone-2' };
  const harness = syncHarness({ existingEvents: [liveEvent(original)], checkpoints: [{
    external_ref: original.external_ref, record_id: RECORD, kind: 'event', source_file: 'source.xlsx', source_sheet: 'DATA',
    source_fingerprint: previous.source_fingerprint, record_fingerprint: previous.source_fingerprint,
  }] });
  const report = await runSourceSync({ sourcePlan: sourcePlan([row, sourceRow(2)]), providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: harness.writeQuery, commit: true });
  assert.equal(report.status, 'source_rows_held');
  assert.equal(report.committed, false);
  assert.equal(report.plan_hold_reasons.source_place_difference_requires_review, 1);
  assert.equal(report.requested.inserts, 1);
  assert.deepEqual(harness.writes, []);
});

const OTHER = '10000000-0000-4000-8000-000000000006';

function legacyLive(row, overrides = {}) {
  const { source_file, source_sheet, source_sha256, ...legacyPayload } = row.payload;
  return liveEvent({ ...row, payload: legacyPayload, ...overrides });
}

test('pre-provenance records become legacy corrections, not identity-mismatch holds', async () => {
  const { previewReconciliation, buildSyncChunks } = await load();
  const row = sourceRow(1);
  const plan = sourcePlan([row]);
  const live = legacyLive(row, { occurred_at: '2026-10-19T13:00:00+12:00' });
  const result = previewReconciliation(plan, { organization_id: CLIENT, observations: [], events: [live] });
  assert.equal(result.actions[0].operation, 'legacy_correct');
  assert.equal(result.actions[0].record_id, RECORD);
  assert.equal(result.summary.legacy_correct, 1);
  const { chunks, counts } = buildSyncChunks(plan, result);
  assert.equal(chunks[0].corrections[0].record_id, RECORD);
  assert.equal(chunks[0].corrections[0].desired, row);
  assert.equal(counts.corrections, 1);

  const sourced = liveEvent({ ...row, payload: { ...row.payload, source_sheet: 'OTHER' } });
  const mismatch = previewReconciliation(plan, { organization_id: CLIENT, observations: [], events: [sourced] });
  assert.equal(mismatch.actions[0].reason, 'existing_source_identity_mismatch');
});

test('legacy place changes are held rather than sent as corrections that the server will reject', async () => {
  const { previewReconciliation, buildSyncChunks } = await load();
  const event = sourceRow(1);
  const eventPlan = sourcePlan([event]);
  const eventResult = previewReconciliation(eventPlan, {
    organization_id: CLIENT, observations: [], events: [legacyLive(event, { zone_id: OTHER })],
  });
  assert.equal(eventResult.actions[0].operation, 'hold');
  assert.equal(eventResult.actions[0].reason, 'legacy_place_difference_requires_review');
  assert.equal(buildSyncChunks(eventPlan, eventResult).chunks.length, 0);

  const sighting = { ...sourceRow(2), plate: 'ABC123', officer_id: ACTOR, officer_notes: 'original' };
  const sightingPlan = sourcePlan([], [{ source_record_key: sighting.external_ref, target_type: 'finance_service_cost' }]);
  sightingPlan.observations = [sighting];
  const stored = {
    id: RECORD, organization_id: CLIENT, observed_at: sighting.occurred_at, zone_id: null, site_id: null,
    officer_id: ACTOR, plate_number: sighting.plate, officer_notes: sighting.officer_notes,
    distance_km: sighting.distance_km, external_refs: { external_ref: sighting.external_ref, import: sighting.payload },
  };
  const sightingResult = previewReconciliation(sightingPlan, {
    organization_id: CLIENT, observations: [stored], events: [],
  });
  assert.equal(sightingResult.actions[0].operation, 'hold');
  assert.equal(sightingResult.actions[0].reason, 'legacy_place_difference_requires_review');
  assert.equal(buildSyncChunks(sightingPlan, sightingResult).chunks.length, 0);
});

test('rows copied from a canonical worksheet are superseded only when the visit is identical', async () => {
  const { buildReconciliationPlan, buildSyncChunks } = await load();
  const canonicalRow = { ...sourceRow(7), external_ref: 'rm_patrol_import:CANON:7',
    payload: { ...sourceRow(7).payload, source_sheet: 'CANON' } };
  const canonicalPlan = { ...sourcePlan([canonicalRow]), source_sheet: 'CANON' };
  const copy = sourceRow(7);
  const differing = sourceRow(8, { payload: { ...sourceRow(8).payload, comments: 'different' } });
  const canonicalDiffering = { ...sourceRow(8), external_ref: 'rm_patrol_import:CANON:8',
    payload: { ...sourceRow(8).payload, source_sheet: 'CANON' } };
  canonicalPlan.events.push(canonicalDiffering);
  const plan = sourcePlan([copy, differing, sourceRow(9)]);
  const existing = [{ external_ref: copy.external_ref, id: RECORD, kind: 'event', source_file: null, source_sheet: null,
    record: { occurred_at: copy.occurred_at, zone_id: copy.zone_id, site_id: null } }];
  const result = buildReconciliationPlan({ sourcePlan: plan, existing, canonicalPlan });
  const byRef = Object.fromEntries(result.actions.map(action => [action.external_ref, action]));
  assert.equal(byRef[copy.external_ref].operation, 'supersede');
  assert.equal(byRef[copy.external_ref].canonical_external_ref, canonicalRow.external_ref);
  assert.equal(byRef[differing.external_ref].reason, 'canonical_job_differs');
  assert.equal(byRef[sourceRow(9).external_ref].operation, 'insert');
  const absent = buildReconciliationPlan({ sourcePlan: plan, existing: [], canonicalPlan });
  assert.equal(absent.actions[0].operation, 'canonical_copy');
  const { chunks, counts } = buildSyncChunks(plan, result);
  assert.deepEqual(chunks[0].supersedes[0], { kind: 'event', external_ref: copy.external_ref,
    canonical_external_ref: canonicalRow.external_ref, source_fingerprint: byRef[copy.external_ref].source_fingerprint, desired: copy });
  assert.equal(counts.supersedes, 1);
  assert.throws(() => buildReconciliationPlan({ sourcePlan: plan, existing: [], canonicalPlan: sourcePlan([]) }), /different worksheet/);
});

test('existing copies on another worksheet supersede to a unique planned visit and archived refs are skipped', async () => {
  const { previewReconciliation, buildSyncChunks } = await load();
  const row = sourceRow(1);
  const plan = sourcePlan([row]);
  const copyRow = { ...row, external_ref: 'rm_patrol_import:TEST:md5copy',
    payload: { ...row.payload, job_number: null, source_sheet: 'Update' } };
  const strayRow = { ...copyRow, external_ref: 'rm_patrol_import:TEST:md5stray', zone_id: 'zone-2' };
  const baseline = { organization_id: CLIENT, observations: [], events: [],
    sheet_copies: [liveEvent(copyRow, OTHER), liveEvent(strayRow, OTHER)] };
  const result = previewReconciliation(plan, baseline);
  const byRef = Object.fromEntries(result.actions.map(action => [action.external_ref, action]));
  assert.equal(byRef[copyRow.external_ref].operation, 'supersede');
  assert.equal(byRef[copyRow.external_ref].canonical_external_ref, row.external_ref);
  assert.equal(byRef[strayRow.external_ref].reason, 'canonical_visit_not_found');
  const { chunks } = buildSyncChunks(plan, result);
  assert.deepEqual(chunks.flatMap(chunk => chunk.supersedes), [{ kind: 'event', external_ref: copyRow.external_ref,
    canonical_external_ref: row.external_ref }]);

  const archived = previewReconciliation(plan, { ...baseline, superseded_refs: [row.external_ref, copyRow.external_ref] });
  const archivedByRef = Object.fromEntries(archived.actions.map(action => [action.external_ref, action]));
  assert.equal(archivedByRef[row.external_ref].operation, 'superseded');
  assert.equal(archivedByRef[copyRow.external_ref], undefined);
  assert.throws(() => previewReconciliation(plan, { ...baseline, sheet_copies: [{ ...liveEvent(copyRow), organization_id: OTHER }] }),
    /outside the selected client/);
});

test('linked baseline loads archived refs and named worksheet copies only when requested', async () => {
  const { loadLinkedBaseline } = await load();
  const plan = sourcePlan([sourceRow(1)]);
  const queries = [];
  const baseline = await loadLinkedBaseline(plan, PROVIDER, async sql => {
    queries.push(sql);
    if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true, supersede_history: true } }];
    if (sql.includes('AS copies')) return [{ copies: [{ id: OTHER }] }];
    return [{ activity: { observations: [], events: [], checkpoints: [], superseded: ['rm_patrol_import:TEST:1'] } }];
  }, { copySheets: ['Update'] });
  assert.ok(queries[0].includes('location_events_superseded'));
  assert.ok(queries[1].includes('location_events_superseded') && queries[1].includes(CLIENT));
  assert.ok(queries[2].includes('"Update"') && queries[2].includes(CLIENT) && queries[2].includes('rm_patrol_log_import'));
  assert.deepEqual(baseline.superseded_refs, ['rm_patrol_import:TEST:1']);
  assert.deepEqual(baseline.sheet_copies, [{ id: OTHER }]);
  await assert.rejects(loadLinkedBaseline(plan, PROVIDER, async () => [], { copySheets: ['DATA'] }), /differ from the source/);
  await assert.rejects(loadLinkedBaseline(plan, PROVIDER, async sql => sql.includes('AS scope')
    ? [{ scope: { authorized: true, eligible_officer_ids: [], supersede_history: true } }]
    : [{ activity: { observations: [], events: [] } }]), /Incomplete linked activity/);
});

test('sync SQL runs legacy corrections before supersedes and summarizes both phases', async () => {
  const { buildSyncChunkSql, summarizeSyncResults } = await load();
  const sql = buildSyncChunkSql({ actorId: ACTOR, providerOrganizationId: PROVIDER, clientOrganizationId: CLIENT,
    batchId: BATCH, chunk: { observations: [], events: [], proposals: [], baselines: [], updates: [],
      corrections: [{ external_ref: 'x' }], supersedes: [{ external_ref: 'y' }],
      dartUpdates: [{ update_external_ref: 'update-x' }] },
    dartUpdateBatch: { batch_name: 'DART Update 251215', source_file: 'dart.xlsx', source_sha256: HASH,
      parser: 'xlsx', manifest: { idempotency_key: 'dart-update-batch', source_sheet: 'Update 251215' },
      schema: {}, row_count: 1, duplicate_count: 0, unresolved_count: 0 }, commit: false });
  const correction = sql.indexOf('correct_legacy_patrol_source_records');
  const supersede = sql.indexOf('supersede_duplicate_patrol_events');
  const update = sql.indexOf('apply_dart_patrol_source_updates_and_supersede');
  assert.ok(correction > 0 && supersede > correction && update > supersede);
  assert.ok(sql.includes('DART Update 251215') && sql.includes('dart_update_batch_id'));
  assert.ok(sql.trim().endsWith('ROLLBACK;'));
  const summary = summarizeSyncResults([
    { phase: 'correction', outcome: 'corrected' },
    { phase: 'correction', outcome: 'held', detail: 'invoiced_record' },
    { phase: 'supersede', outcome: 'superseded' },
    { phase: 'dart_update', outcome: 'updated_and_superseded' },
  ]);
  assert.deepEqual(summary.correction, { corrected: 1, held: 1 });
  assert.deepEqual(summary.supersede, { superseded: 1 });
  assert.deepEqual(summary.dart_update, { updated_and_superseded: 1 });
  assert.deepEqual(summary.hold_reasons, { 'correction:invoiced_record': 1 });
});

test('one-to-one DART Update rows patch the 2025 event and archive the source copy as one unit', async () => {
  const { previewReconciliation, buildSyncChunks } = await load();
  const canonical = sourceRow(7, { payload: { ...sourceRow(7).payload, source_sheet: '2025',
    source_file: 'dart.xlsx', source_row: 12, source_sha256: HASH, derivative_sha256: 'b'.repeat(64),
    location_raw: 'Old reserve road', reserve_raw: 'R-7', source_category: 'Patrol',
    patroller_raw: 'Fixture Officer', plates_found: [] } });
  const canonicalPlan = { ...sourcePlan([canonical]), source_file: 'dart.xlsx', source_sheet: '2025' };
  const update = sourceRow('copy', { external_ref: 'rm_patrol_import:UPDATE:row-2', status: null,
    payload: { ...sourceRow(7).payload, job_number: null, source_sheet: 'Update 251215', source_file: 'dart.xlsx',
      source_row: 2, source_sha256: HASH, derivative_sha256: 'c'.repeat(64), location_raw: 'New reserve road',
      reserve_raw: 'R-7', source_category: 'Patrol', patroller_raw: 'Fixture Officer', plates_found: [] } });
  const updatePlan = { ...sourcePlan([update]), source_file: 'dart.xlsx', source_sheet: 'Update 251215' };
  const canonicalDesired = (await load()).buildReconciliationPlan({ sourcePlan: canonicalPlan, existing: [] }).actions[0].desired;
  const canonicalLive = legacyLive(canonical, { id: RECORD });
  const copyLive = liveEvent({ ...update, external_ref: 'rm_patrol_import:OLD:copy', status: null }, OTHER);
  const result = previewReconciliation(canonicalPlan, {
    organization_id: CLIENT, observations: [], events: [canonicalLive], sheet_copies: [copyLive],
  }, { sheetUpdatePlan: updatePlan });
  const pair = result.actions.find(action => action.operation === 'update_and_supersede');
  assert.ok(pair);
  assert.equal(pair.external_ref, canonical.external_ref);
  assert.equal(pair.copy_external_ref, 'rm_patrol_import:OLD:copy');
  assert.equal(pair.update_external_ref, update.external_ref);
  assert.equal(pair.update_patch.location_raw, 'New reserve road');
  assert.equal(pair.update_patch.job_cost, undefined);
  assert.equal(result.actions.some(action => action.operation === 'legacy_correct'
    && action.external_ref === canonical.external_ref), false);
  assert.equal(result.summary.update_and_supersede, 1);

  const { chunks, counts } = buildSyncChunks(canonicalPlan, result, { sheetUpdatePlan: updatePlan, includeProposals: false });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].corrections[0].desired, canonical);
  assert.equal(chunks[0].dartUpdates[0].copy_record_id, OTHER);
  assert.equal(chunks[0].dartUpdates[0].update_desired, update);
  assert.equal(counts.corrections, 1);
  assert.equal(counts.dart_updates, 1);
  assert.equal(counts.proposals, 0);
  assert.ok(canonicalDesired);
});

test('DART Update collisions and unmatched copies remain held without paired writes', async () => {
  const { previewReconciliation, buildSyncChunks } = await load();
  const canonical = sourceRow(7, { payload: { ...sourceRow(7).payload, source_sheet: '2025',
    source_file: 'dart.xlsx', source_row: 12, source_sha256: HASH, derivative_sha256: 'b'.repeat(64),
    location_raw: 'Reserve road' } });
  const canonicalPlan = { ...sourcePlan([canonical]), source_file: 'dart.xlsx', source_sheet: '2025' };
  const updateRow = (row, overrides = {}) => sourceRow(`copy-${row}`, { status: null,
    external_ref: `rm_patrol_import:UPDATE:${row}`,
    payload: { ...sourceRow(7).payload, job_number: null, source_file: 'dart.xlsx', source_sheet: 'Update 251215',
      source_row: row, source_sha256: HASH, derivative_sha256: 'c'.repeat(64), location_raw: `Updated ${row}`,
      ...overrides },
  });
  const updateRows = [updateRow(2), updateRow(3), updateRow(4)];
  const updatePlan = { ...sourcePlan(updateRows), source_file: 'dart.xlsx', source_sheet: 'Update 251215' };
  const copies = [
    liveEvent({ ...updateRows[0], external_ref: 'rm_patrol_import:OLD:copy-a' }, OTHER),
    liveEvent({ ...updateRows[1], external_ref: 'rm_patrol_import:OLD:copy-b' }, '10000000-0000-4000-8000-000000000007'),
    liveEvent({ ...updateRows[2], external_ref: 'rm_patrol_import:OLD:unmatched', zone_id: 'zone-unmatched' },
      '10000000-0000-4000-8000-000000000008'),
  ];
  const result = previewReconciliation(canonicalPlan, {
    organization_id: CLIENT, observations: [], events: [legacyLive(canonical, { id: RECORD })], sheet_copies: copies,
  }, { sheetUpdatePlan: updatePlan });
  const copyActions = result.actions.filter(action => action.source_sheet === 'Update 251215');
  assert.equal(copyActions.length, 3);
  assert.deepEqual(copyActions.map(action => action.reason).sort(), [
    'ambiguous_canonical_visit', 'ambiguous_canonical_visit', 'canonical_visit_not_found',
  ]);
  const { chunks, counts } = buildSyncChunks(canonicalPlan, result, { sheetUpdatePlan: updatePlan });
  assert.equal(counts.dart_updates, undefined);
  assert.equal(counts.supersedes, undefined);
  assert.equal(chunks.flatMap(chunk => chunk.dartUpdates ?? []).length, 0);
  assert.equal(chunks.flatMap(chunk => chunk.supersedes).length, 0);
});

function dartFixture() {
  const canonical = sourceRow(7, { payload: { ...sourceRow(7).payload, source_sheet: '2025',
    source_file: 'dart.xlsx', source_row: 12, source_sha256: HASH, derivative_sha256: 'b'.repeat(64),
    location_raw: 'Old reserve road', reserve_raw: 'R-7', source_category: 'Patrol',
    patroller_raw: 'Fixture Officer', plates_found: [] } });
  const canonicalPlan = { ...sourcePlan([canonical]), source_file: 'dart.xlsx', source_sheet: '2025' };
  const update = sourceRow('copy', { external_ref: 'rm_patrol_import:UPDATE:row-2', status: null,
    payload: { ...sourceRow(7).payload, job_number: null, source_sheet: 'Update 251215', source_file: 'dart.xlsx',
      source_row: 2, source_sha256: HASH, derivative_sha256: 'c'.repeat(64), location_raw: 'New reserve road',
      reserve_raw: 'R-7', source_category: 'Patrol', patroller_raw: 'Fixture Officer', plates_found: [] } });
  const updatePlan = { ...sourcePlan([update]), source_file: 'dart.xlsx', source_sheet: 'Update 251215' };
  const copyLive = liveEvent({ ...update, external_ref: 'rm_patrol_import:OLD:copy', status: null }, OTHER);
  return { canonical, canonicalPlan, update, updatePlan, copyLive };
}

test('DART update rows with source financial values stay held rather than paired for writing', async () => {
  const { previewReconciliation, buildSyncChunks } = await load();
  const { canonical, canonicalPlan, update, updatePlan, copyLive } = dartFixture();
  update.payload.source_leg_correction = { job_cost: 0 };
  const result = previewReconciliation(canonicalPlan, { organization_id: CLIENT, observations: [],
    events: [legacyLive(canonical)], sheet_copies: [copyLive] }, { sheetUpdatePlan: updatePlan });
  assert.equal(result.summary.hold, 1);
  assert.equal(result.actions.find(action => action.external_ref === copyLive.external_ref).reason,
    'source_financial_values_require_review');
  assert.equal(result.actions.some(action => action.operation === 'update_and_supersede'), false);
  assert.equal(buildSyncChunks(canonicalPlan, result, { sheetUpdatePlan: updatePlan }).counts.dart_updates, undefined);
});

// What the paired RPC leaves behind: the patched canonical and a version that keeps the 2025 identity.
function appliedOverlay(canonical, pair) {
  const live = liveEvent({ ...canonical, payload: { ...canonical.payload, ...pair.update_patch } }, RECORD);
  const checkpoint = { external_ref: canonical.external_ref, record_id: RECORD, kind: 'event',
    source_file: 'dart.xlsx', source_sheet: '2025', source_fingerprint: pair.source_fingerprint,
    record_fingerprint: pair.record_fingerprint };
  return { live, checkpoint };
}

test('an applied DART Update overlay resyncs as unchanged; a later source edit to that row is held', async () => {
  const { previewReconciliation } = await load();
  const { canonical, canonicalPlan, updatePlan, copyLive } = dartFixture();
  const first = previewReconciliation(canonicalPlan, { organization_id: CLIENT, observations: [],
    events: [legacyLive(canonical, { id: RECORD })], sheet_copies: [copyLive] }, { sheetUpdatePlan: updatePlan });
  const pair = first.actions.find(action => action.operation === 'update_and_supersede');
  assert.match(pair.record_fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(pair.record_fingerprint, pair.source_fingerprint);
  const { live, checkpoint } = appliedOverlay(canonical, pair);

  for (const options of [{ sheetUpdatePlan: updatePlan }, {}]) {
    const resync = previewReconciliation(canonicalPlan, { organization_id: CLIENT, observations: [], events: [live],
      sheet_copies: [], checkpoints: [checkpoint] }, options);
    const action = resync.actions.find(row => row.external_ref === canonical.external_ref);
    assert.equal(action.operation, 'unchanged');
    assert.equal(action.update_overlay, true);
    assert.equal(action.baseline_required, undefined);
    assert.equal(resync.summary.baseline_required, 0);
    assert.equal(resync.summary.hold, 0);
  }

  const edited = { ...canonicalPlan, events: [{ ...canonical, status: 'completed - gate damaged' }] };
  const held = previewReconciliation(edited, { organization_id: CLIENT, observations: [], events: [live],
    sheet_copies: [], checkpoints: [checkpoint] });
  const action = held.actions.find(row => row.external_ref === canonical.external_ref);
  assert.equal(action.operation, 'hold');
  assert.equal(action.reason, 'update_overlay_review_required');
});

test('Update-only payload fields do not change canonical fingerprints before or after the paired import', async () => {
  const { previewReconciliation } = await load();
  const { canonical, canonicalPlan, updatePlan, copyLive } = dartFixture();
  updatePlan.events[0].payload.charge_code_unresolved = true;
  const first = previewReconciliation(canonicalPlan, { organization_id: CLIENT, observations: [],
    events: [legacyLive(canonical)], sheet_copies: [copyLive] }, { sheetUpdatePlan: updatePlan });
  const pair = first.actions.find(action => action.operation === 'update_and_supersede');
  assert.ok(pair);
  const { live, checkpoint } = appliedOverlay(canonical, pair);
  const baseline = { organization_id: CLIENT, observations: [], events: [live], checkpoints: [checkpoint], sheet_copies: [] };
  const withUpdate = previewReconciliation(canonicalPlan, baseline, { sheetUpdatePlan: updatePlan });
  assert.deepEqual(withUpdate, previewReconciliation(canonicalPlan, baseline));
  assert.equal(withUpdate.summary.unchanged, 1);
  assert.equal(withUpdate.summary.hold, 0);
});

test('stored-state equality handles database distance rounding while retaining source and manual-edit protection', async () => {
  const { buildReconciliationPlan, previewReconciliation } = await load();
  for (const [sourceDistance, storedDistance] of [[2.3999999999999986, 2.4], [1.6000000000000014, 1.6],
    [8.200000000000003, 8.2], [0.7999999999999972, 0.8]]) {
    const row = sourceRow(29, { distance_km: sourceDistance });
    const plan = sourcePlan([row]);
    const fingerprint = buildReconciliationPlan({ sourcePlan: plan, existing: [] }).actions[0].source_fingerprint;
    const live = liveEvent({ ...row, distance_km: storedDistance });
    const checkpoint = { external_ref: row.external_ref, record_id: RECORD, kind: 'event',
      source_file: 'source.xlsx', source_sheet: 'DATA', source_fingerprint: fingerprint,
      record_fingerprint: fingerprint, record_matches_state_after: true };
    const baseline = { organization_id: CLIENT, observations: [], events: [live], checkpoints: [checkpoint] };
    assert.equal(previewReconciliation(plan, baseline).actions[0].operation, 'unchanged');
    const editedSource = sourcePlan([{ ...row, distance_km: 6 }]);
    const edit = previewReconciliation(editedSource, baseline).actions[0];
    assert.equal(edit.operation, 'update');
    assert.equal(edit.prior_source_fingerprint, fingerprint);
    assert.equal(edit.desired.distance_km, 6);

    const changedInFcm = { ...baseline, checkpoints: [{ ...checkpoint, record_matches_state_after: false }] };
    assert.equal(previewReconciliation(plan, changedInFcm).actions[0].reason, 'fcm_record_changed_since_last_sync');
    assert.equal(previewReconciliation(editedSource, changedInFcm).actions[0].reason, 'fcm_record_changed_since_last_sync');
  }
});

test('unchanged logical fields cannot mask a full-state checkpoint mismatch and held-only runs report reasons', async () => {
  const { runSourceSync, buildReconciliationPlan } = await load();
  const row = sourceRow(1);
  const plan = sourcePlan([row]);
  const fingerprint = buildReconciliationPlan({ sourcePlan: plan, existing: [] }).actions[0].source_fingerprint;
  const harness = syncHarness({ existingEvents: [liveEvent(row)], checkpoints: [{ external_ref: row.external_ref,
    record_id: RECORD, kind: 'event', source_file: 'source.xlsx', source_sheet: 'DATA',
    source_fingerprint: fingerprint, record_matches_state_after: false }] });
  const report = await runSourceSync({ sourcePlan: plan, providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: harness.writeQuery });
  assert.equal(report.status, 'source_rows_held');
  assert.deepEqual(report.plan_hold_reasons, { fcm_record_changed_since_last_sync: 1 });
  assert.equal(report.plan_summary.hold, 1);
  assert.equal(harness.writes.length, 0);
});

test('read-only CLI honors the Update plan and worksheet-copy inputs without overwriting an input', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
  const { execFileSync, spawnSync } = require('node:child_process');
  const path = require('node:path');
  const directory = mkdtempSync(path.join(require('node:os').tmpdir(), 'fcm-reconcile-test-'));
  try {
    const { canonical, canonicalPlan, updatePlan, copyLive } = dartFixture();
    const input = path.join(directory, 'source.json');
    const update = path.join(directory, 'update.json');
    const baseline = path.join(directory, 'baseline.json');
    const output = path.join(directory, 'report.json');
    writeFileSync(input, JSON.stringify(canonicalPlan));
    writeFileSync(update, JSON.stringify(updatePlan));
    writeFileSync(baseline, JSON.stringify({ organization_id: CLIENT, observations: [],
      events: [legacyLive(canonical)], sheet_copies: [copyLive] }));
    const args = [path.resolve('services', 'document-source-worker', 'reconcile-plan.mjs'), '--source-plan', input,
      '--baseline', baseline, '--sheet-update-plan', update, '--supersede-copies-sheet', 'Update 251215'];
    execFileSync(process.execPath, [...args, '--output', output], { stdio: 'pipe' });
    const report = JSON.parse(readFileSync(output));
    assert.equal(report.summary.update_and_supersede, 1);
    const refused = spawnSync(process.execPath, [...args, '--output', update], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /separate JSON file/);
    assert.deepEqual(JSON.parse(readFileSync(update)), updatePlan);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a DART Update pairing that repeats a canonical or copy is refused even across chunks', async () => {
  const { previewReconciliation, buildSyncChunks } = await load();
  const { canonical, canonicalPlan, updatePlan, copyLive } = dartFixture();
  const result = previewReconciliation(canonicalPlan, { organization_id: CLIENT, observations: [],
    events: [legacyLive(canonical, { id: RECORD })], sheet_copies: [copyLive] }, { sheetUpdatePlan: updatePlan });
  const pair = result.actions.find(action => action.operation === 'update_and_supersede');
  const repeated = { ...result, actions: [...result.actions,
    { ...pair, copy_external_ref: 'rm_patrol_import:OLD:copy-2', copy_record_id: '10000000-0000-4000-8000-000000000009' }] };
  assert.throws(() => buildSyncChunks(canonicalPlan, repeated, { sheetUpdatePlan: updatePlan, includeProposals: false, chunkSize: 1 }),
    /repeats a canonical event, copy, or Update row/);
  const { chunks } = buildSyncChunks(canonicalPlan, result, { sheetUpdatePlan: updatePlan, includeProposals: false });
  assert.equal(chunks[0].dartUpdates[0].record_fingerprint, pair.record_fingerprint);
});

test('a later chunk failure retains the committed DART Update batch identity', async () => {
  const { runSourceSync } = await load();
  const { canonical, canonicalPlan, update, updatePlan, copyLive } = dartFixture();
  const updateBatch = '10000000-0000-4000-8000-00000000000a';
  const next = { ...canonical, external_ref: 'rm_patrol_import:TEST:8', occurred_at: '2026-10-20T12:00:00+12:00',
    payload: { ...canonical.payload, job_number: '8', source_row: 13, reserve_raw: 'R-8' } };
  const nextUpdate = { ...update, external_ref: 'rm_patrol_import:UPDATE:row-3', occurred_at: next.occurred_at,
    payload: { ...update.payload, source_row: 3, reserve_raw: 'R-8' } };
  canonicalPlan.events.push(next);
  updatePlan.events.push(nextUpdate);
  const nextId = '10000000-0000-4000-8000-000000000009';
  const nextCopy = liveEvent({ ...nextUpdate, external_ref: 'rm_patrol_import:OLD:copy-2' },
    '10000000-0000-4000-8000-00000000000b');
  let committed = 0;
  const readQuery = async sql => {
    if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true, supersede_history: true } }];
    if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [
      legacyLive(canonical, { id: RECORD }), legacyLive(next, { id: nextId }),
    ], checkpoints: [], superseded: [] } }];
    if (sql.includes('AS copies')) return [{ copies: [copyLive, nextCopy] }];
    if (sql.includes('import_actor_id')) return [{ import_actor_id: ACTOR }];
    if (sql.includes('file_import_batches')) return [];
    throw new Error('unexpected read');
  };
  const writeQuery = async sql => {
    if (sql.endsWith('ROLLBACK;')) return [{ batch_id: BATCH, dart_update_batch_id: updateBatch, results: [] }];
    committed += 1;
    if (committed === 2) throw new Error('connection reset');
    assert.match(sql, /"dart_updates":\[\{/);
    return [{ batch_id: BATCH, dart_update_batch_id: updateBatch, results: [] }];
  };

  const sync = runSourceSync({ sourcePlan: canonicalPlan, providerOrganizationId: PROVIDER,
    readQuery, writeQuery, chunkSize: 1, commit: true, copySheets: ['Update 251215'],
    sheetUpdatePlan: updatePlan }).then(report => {
    throw new Error(`sync unexpectedly returned: ${JSON.stringify(report)}`);
  });
  await assert.rejects(sync, error => {
    assert.equal(error.message, 'connection reset');
    assert.equal(error.sourceSyncReport?.committed, true);
    assert.equal(error.sourceSyncReport.batch_id, BATCH);
    assert.equal(error.sourceSyncReport.dart_update_batch_id, updateBatch);
    return true;
  });
});

test('a failed resumed DART chunk retains both existing staging batch identities', async () => {
  const { runSourceSync } = await load();
  const { canonical, canonicalPlan, updatePlan, copyLive } = dartFixture();
  const updateBatch = '10000000-0000-4000-8000-00000000000a';
  const readQuery = async sql => {
    if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true, supersede_history: true } }];
    if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [legacyLive(canonical, { id: RECORD })],
      checkpoints: [], superseded: [] } }];
    if (sql.includes('AS copies')) return [{ copies: [copyLive] }];
    if (sql.includes('import_actor_id')) return [{ import_actor_id: ACTOR }];
    if (sql.includes('file_import_batches')) return [{ id: sql.includes('dart_update:') ? updateBatch : BATCH, status: 'staging' }];
    throw new Error('unexpected read');
  };
  const writeQuery = async sql => {
    if (sql.endsWith('ROLLBACK;')) return [{ batch_id: BATCH, dart_update_batch_id: updateBatch, results: [] }];
    throw new Error('connection reset');
  };

  await assert.rejects(runSourceSync({ sourcePlan: canonicalPlan, providerOrganizationId: PROVIDER,
    readQuery, writeQuery, chunkSize: 1, commit: true, copySheets: ['Update 251215'],
    sheetUpdatePlan: updatePlan }), error => {
    assert.equal(error.message, 'connection reset');
    assert.equal(error.sourceSyncWriteAttempted, true);
    assert.equal(error.sourceSyncReport?.batch_id, BATCH);
    assert.equal(error.sourceSyncReport.dart_update_batch_id, updateBatch);
    return true;
  });
});

test('a committed re-run with nothing left to send closes both open batches in one transaction', async () => {
  const { previewReconciliation, runSourceSync } = await load();
  const { canonical, canonicalPlan, updatePlan, copyLive } = dartFixture();
  const pair = previewReconciliation(canonicalPlan, { organization_id: CLIENT, observations: [],
    events: [legacyLive(canonical, { id: RECORD })], sheet_copies: [copyLive] }, { sheetUpdatePlan: updatePlan })
    .actions.find(action => action.operation === 'update_and_supersede');
  const { live, checkpoint } = appliedOverlay(canonical, pair);
  const UPDATE_BATCH = '10000000-0000-4000-8000-00000000000a';
  const writes = [];
  const harness = {
    readQuery: async sql => {
      if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true, supersede_history: true } }];
      if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [live], checkpoints: [checkpoint], superseded: [] } }];
      if (sql.includes('AS copies')) return [{ copies: [] }];
      if (sql.includes('import_actor_id')) return [{ import_actor_id: ACTOR }];
      if (sql.includes('file_import_batches')) {
        return sql.includes('dart_update:') ? [{ id: UPDATE_BATCH, status: 'staging' }] : [{ id: BATCH, status: 'staging' }];
      }
      throw new Error('unexpected read');
    },
    writeQuery: async sql => { writes.push(sql); return [{ id: BATCH }]; },
  };
  const report = await runSourceSync({ sourcePlan: canonicalPlan, providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: harness.writeQuery, commit: true,
    copySheets: ['Update 251215'], sheetUpdatePlan: updatePlan });
  assert.equal(report.status, 'receipt_recovered');
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^BEGIN;/);
  assert.match(writes[0], /COMMIT;$/);
  assert.equal(writes[0].match(/finalize_patrol_import_batch/g).length, 2);
  assert.ok(writes[0].includes(BATCH) && writes[0].includes(UPDATE_BATCH));
  assert.ok(writes[0].includes('"receipt_recovered":true'));

  const dryRun = [];
  const idle = await runSourceSync({ sourcePlan: canonicalPlan, providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: async sql => { dryRun.push(sql); return []; },
    copySheets: ['Update 251215'], sheetUpdatePlan: updatePlan });
  assert.equal(idle.status, 'no_source_changes');
  assert.equal(dryRun.length, 0);

  await assert.rejects(runSourceSync({ sourcePlan: canonicalPlan, providerOrganizationId: PROVIDER,
    readQuery: harness.readQuery, writeQuery: async () => { throw new Error('connection lost during finalization'); },
    commit: true, copySheets: ['Update 251215'], sheetUpdatePlan: updatePlan }), error => {
    assert.equal(error.sourceSyncWriteAttempted, true);
    assert.equal(error.sourceSyncReport.batch_id, BATCH);
    assert.equal(error.sourceSyncReport.dart_update_batch_id, UPDATE_BATCH);
    return true;
  });
});
