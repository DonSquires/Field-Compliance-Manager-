const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ExcelJS = require('exceljs');

function plan(context, extra = [], csvOverride) {
  const directory = mkdtempSync(join(tmpdir(), 'fcm-patrol-plan-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const csvPath = join(directory, 'source.csv');
  const contextPath = join(directory, 'context.json');
  const csv = csvOverride ?? 'Job,Patroller,Date,Location,Comments,Reg\n42,Camera,19/10/2026,Test place,"Source note, with comma",\n';
  writeFileSync(csvPath, csv);
  writeFileSync(contextPath, JSON.stringify({
    provider_organization_id: '30000000-0000-4000-8000-000000000001', source_profile: 'test_patrol',
    rows: [
      { record_type: 'source_profile', payload: { parser: 'csv', import_actor_id: '40000000-0000-4000-8000-000000000001',
        column_mappings: { job: ['Job'], patroller: ['Patroller'], date: ['Date'], time: ['Time'], reserve: ['Reserve'], location: ['Location'],
          comments: ['Comments'], registration: ['Reg'], issue: ['Issue'],
          job_km: ['Job Km NCC', 'Job KM Stringer'], odometer: ['Travel Odometer', 'ODO'],
          job_time: ['Job Time'], job_cost: ['Job Cost'], travel_cost: ['Travel Cost'], total_cost: ['Total Cost'],
        }, target_mappings: {},
      } },
      { record_type: 'person_alias', payload: { alias_norm: 'fixture officer', user_profile_id: '40000000-0000-4000-8000-000000000002' } },
      { record_type: 'classification_rule', payload: { target_code_type: 'work_subject', conditions: [{ field: 'subject', operator: 'exact', value: 'fixture-only' }] } },
    ],
  }));
  const env = { ...process.env };
  delete env.FIELD_COMPLIANCE_CODESPACE;
  delete env.SUPABASE_ACCESS_TOKEN;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const args = [
    resolve('scripts/import-patrol-log.mjs'), '--export-plan', '--csv', csvPath,
    '--provider-org-id', '30000000-0000-4000-8000-000000000001', '--classification-profile', 'test_patrol', '--import-context', contextPath,
    '--org-id', '10000000-0000-4000-8000-000000000001', '--client-code', 'TEST',
    '--source-label', 'approved-source.xlsx', '--source-sheet', '2026',
    '--zone-map', JSON.stringify({ 'Test place': '20000000-0000-4000-8000-000000000001' }), ...extra,
  ];
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  return { result, csv, args, env, contextPath };
}

async function xlsxPlan(context, { requestedSheet = 'DATA', apply = false, typedDates = false, formulaDates = false,
  date1904 = false, sourceHash = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fcm-patrol-xlsx-plan-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const xlsxPath = join(directory, 'source.xlsx');
  const contextPath = join(directory, 'context.json');
  const workbook = new ExcelJS.Workbook();
  workbook.properties.date1904 = date1904;
  const readme = workbook.addWorksheet('README');
  readme.addRow(['Do not import this sheet']);
  const data = workbook.addWorksheet('DATA');
  data.addRow(['Workbook export']);
  data.addRow(['Generated for review']);
  data.addRow(['Job', 'Patroller', 'Date', 'Time', 'Location', 'Comments', 'Reg']);
  data.addRow(['42', 'Camera', '20/09/2026', '1636', 'Test place', 'winter row', '']);
  if (typedDates || formulaDates) {
    const date = new Date('2026-09-20T00:00:00Z');
    const time = new Date('1899-12-30T16:36:12Z');
    data.getCell('C4').value = formulaDates ? { formula: 'DATE(2026,9,20)', result: date } : date;
    data.getCell('C4').numFmt = 'dd/mm/yyyy';
    data.getCell('D4').value = formulaDates ? { formula: 'TIME(16,36,12)', result: time } : time;
    data.getCell('D4').numFmt = 'hh:mm:ss';
  }
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  writeFileSync(xlsxPath, bytes);
  writeFileSync(contextPath, JSON.stringify({
    provider_organization_id: '30000000-0000-4000-8000-000000000001', source_profile: 'test_patrol',
    rows: [
      { record_type: 'source_profile', payload: { parser: 'csv', import_actor_id: '40000000-0000-4000-8000-000000000001',
        column_mappings: { job: ['Job'], patroller: ['Patroller'], date: ['Date'], time: ['Time'], location: ['Location'],
          comments: ['Comments'], registration: ['Reg'], issue: ['Issue'], job_km: ['Job Km NCC'], odometer: ['ODO'],
        }, target_mappings: {},
      } },
      { record_type: 'person_alias', payload: { alias_norm: 'fixture officer', user_profile_id: '40000000-0000-4000-8000-000000000002' } },
      { record_type: 'classification_rule', payload: { target_code_type: 'work_subject', conditions: [{ field: 'subject', operator: 'exact', value: 'fixture-only' }] } },
    ],
  }));
  const env = { ...process.env };
  delete env.FIELD_COMPLIANCE_CODESPACE;
  delete env.SUPABASE_ACCESS_TOKEN;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const args = [
    resolve('scripts/import-patrol-log.mjs'), ...(apply ? ['--apply'] : ['--export-plan']), '--xlsx', xlsxPath,
    '--sheet', requestedSheet, '--header-row', '3',
    '--provider-org-id', '30000000-0000-4000-8000-000000000001', '--classification-profile', 'test_patrol', '--import-context', contextPath,
    '--org-id', '10000000-0000-4000-8000-000000000001', '--client-code', 'TEST',
    '--zone-map', JSON.stringify({ 'Test place': '20000000-0000-4000-8000-000000000001' }),
    ...(sourceHash ? ['--source-hash', sourceHash === 'actual' ? createHash('sha256').update(bytes).digest('hex') : sourceHash] : []),
  ];
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  return { result, bytes };
}

test('plan export reuses governed parser without requiring database credentials', context => {
  const { result, csv } = plan(context);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'plan');
  assert.equal(output.provider_organization_id, '30000000-0000-4000-8000-000000000001');
  assert.equal(output.source_sha256, createHash('sha256').update(csv).digest('hex'));
  assert.equal(output.manifest.target_client_organization_id, '10000000-0000-4000-8000-000000000001');
  assert.equal(output.events.length, 1);
  assert.equal(output.observations.length, 0);
  assert.equal(output.events[0].external_ref, 'rm_patrol_import:TEST:42');
  assert.equal(output.events[0].zone_id, '20000000-0000-4000-8000-000000000001');
  assert.equal(output.events[0].payload.source_file, 'approved-source.xlsx');
  assert.equal(output.events[0].payload.source_sheet, '2026');
  assert.equal(output.events[0].payload.source_row, 2);
  assert.equal(output.events[0].payload.comments, undefined);
  assert.match(output.events[0].payload.derivative_sha256, /^[a-f0-9]{64}$/);
});

test('conflicting mapped source places stage neither activity nor consequential proposals', async context => {
  const csv = [
    'Job,Patroller,Date,Reserve,Location,Comments,Reg',
    '42,fixture officer,19/10/2026,DONA,Hope saddle,vehicle sighted,ABC123',
    '43,Camera,19/10/2026,DONA,Hope saddle,camera alert,',
  ].join('\n');
  const reserve = '20000000-0000-4000-8000-000000000002';
  const location = '20000000-0000-4000-8000-000000000003';
  const { result } = plan(context, ['--include-narratives', '--place-overlay',
    JSON.stringify({ DONA: reserve, 'Hope saddle': location })], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.observations, []);
  assert.deepEqual(output.events, []);
  assert.deepEqual(output.proposals, []);
  assert.equal(output.counts.unresolved, 2);
  assert.deepEqual(output.unresolved_places, [{
    name: null, reason: 'conflicting_place_fields',
    conflicting_targets: { reserve, location },
    reserve_codes: ['DONA'], locations: ['Hope saddle'], source_rows: [2, 3],
  }]);
  assert.deepEqual(output.source_holds, [
    { external_ref: 'rm_patrol_import:TEST:42', kind: 'observation', source_row: 2, reason: 'conflicting_place_fields' },
    { external_ref: 'rm_patrol_import:TEST:43', kind: 'event', source_row: 3, reason: 'conflicting_place_fields' },
  ]);
  const { placesToRegister } = await import('../services/document-source-worker/source-places.mjs');
  assert.deepEqual(placesToRegister(output, {}), []);
});

test('a duplicate job key is held in either row order when one copy has conflicting places', async context => {
  const { buildReconciliationPlan, buildSyncChunks } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const safe = '42,Camera,19/10/2026,DONA,DONA,first copy,';
  const conflict = '42,Camera,19/10/2026,DONA,Hope saddle,conflicting copy,';
  for (const rows of [[safe, conflict], [conflict, safe]]) {
    const csv = [
      'Job,Patroller,Date,Reserve,Location,Comments,Reg',
      ...rows,
      '43,Camera,19/10/2026,,Test place,unrelated,',
    ].join('\n');
    const { result } = plan(context, ['--include-narratives', '--place-overlay', JSON.stringify({
      DONA: '20000000-0000-4000-8000-000000000002',
      'Hope saddle': '20000000-0000-4000-8000-000000000003',
    })], csv);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.events.map(row => row.external_ref), ['rm_patrol_import:TEST:43']);
    assert.ok(output.proposals.every(proposal => proposal.source_record_key !== 'rm_patrol_import:TEST:42'));
    assert.equal(output.source_holds.length, 2);
    assert.deepEqual(new Set(output.source_holds.map(hold => hold.reason)),
      new Set(['conflicting_place_fields', 'duplicate_source_key_with_conflict']));
    const reconciliation = buildReconciliationPlan({ sourcePlan: output, existing: [] });
    assert.equal(reconciliation.summary.hold, 2);
    assert.equal(reconciliation.summary.insert, 1);
    assert.ok(!JSON.stringify(buildSyncChunks(output, reconciliation).chunks).includes('rm_patrol_import:TEST:42'));
  }
});

function directApply(context, csv, extra = [], apply = true) {
  const { args, env, contextPath } = plan(context, extra, csv);
  const fetchStub = join(dirname(contextPath), 'fetch-stub.cjs');
  writeFileSync(fetchStub, `
    const fs = require('node:fs');
    globalThis.fetch = async (_url, options) => {
      const { query } = JSON.parse(options.body);
      if (!query.startsWith('SELECT * FROM (')) throw new Error('Unexpected database write in test');
      return new Response(JSON.stringify(JSON.parse(fs.readFileSync(process.env.TEST_IMPORT_CONTEXT)).rows));
    };
  `);
  const directArgs = args.filter((arg, index) => arg !== '--export-plan'
    && arg !== '--import-context' && args[index - 1] !== '--import-context');
  const result = spawnSync(process.execPath, ['--require', fetchStub, ...directArgs, apply ? '--apply' : '--dry-run'], { encoding: 'utf8', env: {
    ...env, SUPABASE_ACCESS_TOKEN: 'test-token', SUPABASE_PROJECT_REF: 'test-project',
    TEST_IMPORT_CONTEXT: contextPath,
  } });
  return result;
}

test('direct apply refuses a source-place conflict before opening a batch', context => {
  const csv = [
    'Job,Patroller,Date,Reserve,Location,Comments,Reg',
    '42,fixture officer,19/10/2026,DONA,Hope saddle,vehicle sighted,ABC123',
  ].join('\n');
  const result = directApply(context, csv, ['--place-overlay', JSON.stringify({
    DONA: '20000000-0000-4000-8000-000000000002',
    'Hope saddle': '20000000-0000-4000-8000-000000000003',
  })]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicting place fields.*review/i);
  assert.doesNotMatch(result.stderr, /Unexpected database write/);
});

test('direct apply refuses unplaced sightings and unresolved visits before opening a batch', context => {
  for (const row of [
    '42,fixture officer,19/10/2026,Unknown place,vehicle sighted,ABC123',
    '42,fixture officer,19/10/2026,,vehicle sighted,ABC123',
    '42,Camera,19/10/2026,Unknown place,camera alert,',
    '42,Camera,19/10/2026,,camera alert,',
  ]) {
    const result = directApply(context, ['Job,Patroller,Date,Location,Comments,Reg', row].join('\n'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unresolved place.*review/i);
    assert.doesNotMatch(result.stderr, /Unexpected database write/);
  }
});

test('direct apply refuses source financial values before opening a client-readable batch', context => {
  const header = 'Job,Patroller,Date,Location,Comments,Reg,Job Cost,Travel Cost,Total Cost';
  for (const row of [
    '42,Camera,19/10/2026,Test place,camera alert,,12,,',
    '43,fixture officer,19/10/2026,Test place,vehicle sighted,ABC123,0,,',
  ]) {
    const result = directApply(context, [header, row].join('\n'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /financial.*review/i);
    assert.doesNotMatch(result.stderr, /Unexpected database write/);
  }
});

test('populated unparseable cost cells survive local planning and block source promotion', async context => {
  const { runSourceSync } = await import('../services/document-source-worker/reconcile-plan.mjs');
  for (const cell of ['(12.50)', '#VALUE!', '1.25e2']) {
    const csv = [
      'Job,Patroller,Date,Location,Comments,Total Cost',
      `42,Camera,19/10/2026,Test place,all clear,${cell}`,
    ].join('\n');
    const result = plan(context, [], csv).result;
    assert.equal(result.status, 0, result.stderr);
    const source = JSON.parse(result.stdout);
    assert.equal(source.financial_source_present, true, cell);
    assert.equal(source.events[0].payload.source_cost_cells.total_cost, cell);
    const writes = [];
    const report = await runSourceSync({
      sourcePlan: source, providerOrganizationId: source.provider_organization_id, commit: true,
      readQuery: async sql => {
        if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }];
        if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [], checkpoints: [] } }];
        throw new Error('Unexpected read');
      },
      writeQuery: async sql => { writes.push(sql); throw new Error('Unexpected database write'); },
    });
    assert.equal(report.status, 'source_rows_held');
    assert.deepEqual(writes, []);
    const applied = directApply(context, csv);
    assert.equal(applied.status, 1);
    assert.match(applied.stderr, /financial.*review/i);
    assert.doesNotMatch(applied.stderr, /Unexpected database write/);
  }
});

test('direct dry run does not expose held-row financial values in its receipt', context => {
  const csv = [
    'Job,Patroller,Date,Location,Comments,Job Cost',
    '42,Camera,19/10/2026,Unknown place,camera alert,8675309.42',
  ].join('\n');
  const result = directApply(context, csv, [], false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /financial.*review/i);
  assert.doesNotMatch(result.stdout + result.stderr, /8675309\.42/);
  assert.doesNotMatch(result.stderr, /Unexpected database write/);
});

test('local plan marks financial values even when the source row is held for an unresolved place', context => {
  const csv = [
    'Job,Patroller,Date,Location,Comments,Job Cost',
    '42,Camera,19/10/2026,Unknown place,camera alert,0',
  ].join('\n');
  const result = plan(context, [], csv).result;
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.events, []);
  assert.equal(output.source_holds[0].reason, 'unresolved_source_place');
  assert.equal(output.financial_source_present, true);
});

test('a cost on an unplaced Start marker holds direct source sync before any write', async context => {
  const { runSourceSync } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const csv = [
    'Job,Patroller,Date,Location,Comments,Job Cost',
    '41,Camera,19/10/2026,,Start,12',
    '42,Camera,19/10/2026,Test place,all clear,',
  ].join('\n');
  const result = plan(context, [], csv).result;
  assert.equal(result.status, 0, result.stderr);
  const source = JSON.parse(result.stdout);
  assert.equal(source.financial_source_present, true);
  assert.equal(source.events.length, 1);
  assert.equal(source.source_holds[0]?.reason, 'source_financial_values_require_review');
  const writes = [];
  const report = await runSourceSync({ sourcePlan: source, providerOrganizationId: source.provider_organization_id, commit: true,
    readQuery: async sql => {
      if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }];
      if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [], checkpoints: [] } }];
      throw new Error('Unexpected read');
    },
    writeQuery: async sql => { writes.push(sql); throw new Error('Unexpected database write'); },
  });
  assert.equal(report.status, 'source_rows_held');
  assert.deepEqual(writes, []);
});

test('a malformed-date duplicate holds both source rows in either order', async context => {
  const { buildReconciliationPlan, buildSyncChunks } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const valid = '42,Camera,19/10/2026,Test place,valid visit,';
  const invalid = '42,Camera,bad date,Other place,uncertain visit,';
  for (const rows of [[valid, invalid], [invalid, valid]]) {
    const csv = ['Job,Patroller,Date,Location,Comments,Reg', ...rows].join('\n');
    const { result } = plan(context, ['--include-narratives'], csv);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.events, []);
    assert.deepEqual(output.proposals, []);
    assert.deepEqual(new Set(output.source_holds.map(hold => hold.reason)),
      new Set(['duplicate_source_key_with_invalid_date', 'invalid_date_in_duplicate_source_key']));
    assert.deepEqual(output.source_holds.map(hold => hold.source_row).sort(), [2, 3]);
    const reconciliation = buildReconciliationPlan({ sourcePlan: output, existing: [] });
    assert.equal(reconciliation.summary.hold, 2);
    assert.deepEqual(buildSyncChunks(output, reconciliation).chunks, []);
    const direct = directApply(context, csv);
    assert.equal(direct.status, 1);
    assert.match(direct.stderr, /duplicate.*date.*review/i);
    assert.doesNotMatch(direct.stderr, /Unexpected database write/);
  }
});

test('an unplaced sighting is visible as unresolved and cannot enter a sync chunk', async context => {
  const { buildReconciliationPlan, buildSyncChunks } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const csv = [
    'Job,Patroller,Date,Location,Comments,Reg',
    '42,fixture officer,19/10/2026,Unknown place,vehicle sighted,ABC123',
  ].join('\n');
  const { result } = plan(context, [], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.counts.unresolved, 1);
  const reconciliation = buildReconciliationPlan({ sourcePlan: output, existing: [] });
  assert.equal(reconciliation.actions[0].reason, 'one_resolved_place_required');
  assert.equal(reconciliation.actions[0].source_row, 2);
  assert.deepEqual(buildSyncChunks(output, reconciliation).chunks, []);
});

test('an unresolved visit remains a hold, not a removed row, while another remains a candidate', async context => {
  const { buildReconciliationPlan, buildSyncChunks, compareSourcePlans } =
    await import('../services/document-source-worker/reconcile-plan.mjs');
  const headers = 'Job,Patroller,Date,Location,Comments,Reg';
  const known = '42,Camera,19/10/2026,Test place,known visit,';
  const visit = '43,Camera,19/10/2026,Unknown place,unresolved visit,';
  const current = JSON.parse(plan(context, ['--include-narratives'], [headers, known, visit].join('\n')).result.stdout);
  const previous = JSON.parse(plan(context, ['--include-narratives'],
    [headers, known, visit.replace('Unknown place', 'Test place')].join('\n')).result.stdout);
  assert.deepEqual(current.source_holds, [{
    external_ref: 'rm_patrol_import:TEST:43', kind: 'event', source_row: 3, reason: 'unresolved_source_place',
  }]);
  assert.ok(current.proposals.every(proposal => proposal.source_record_key !== 'rm_patrol_import:TEST:43'));
  const reconciliation = buildReconciliationPlan({ sourcePlan: current, existing: [] });
  assert.equal(reconciliation.summary.hold, 1);
  const chunks = buildSyncChunks(current, reconciliation).chunks;
  assert.deepEqual(chunks.flatMap(chunk => chunk.events.map(row => row.external_ref)), ['rm_patrol_import:TEST:42']);
  const comparison = compareSourcePlans(current, previous);
  assert.equal(comparison.actions.find(action => action.external_ref === 'rm_patrol_import:TEST:43').operation, 'hold');
});

test('a visit with a blank place is held while a shift Start marker is not a visit', async context => {
  const { buildReconciliationPlan } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const csv = [
    'Job,Patroller,Date,Location,Comments,Reg',
    '42,Camera,19/10/2026,,Start,',
    '43,Camera,19/10/2026,,camera alert,',
  ].join('\n');
  const { result } = plan(context, ['--include-narratives'], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.source_holds, [{
    external_ref: 'rm_patrol_import:TEST:43', kind: 'event', source_row: 3, reason: 'unresolved_source_place',
  }]);
  assert.deepEqual(output.events, []);
  assert.equal(output.counts.unresolved, 1);
  assert.equal(buildReconciliationPlan({ sourcePlan: output, existing: [] }).summary.hold, 1);
});

test('imported unresolved visits hold the sheet before safe rows are synced', async context => {
  const { runSourceSync } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { promoteSheet } = await import('../services/document-source-worker/source-promote.mjs');
  const csv = [
    'Job,Patroller,Date,Location,Comments,Reg',
    '42,Camera,19/10/2026,Test place,known visit,',
    '43,Camera,19/10/2026,Unknown place,unresolved visit,',
  ].join('\n');
  const { result } = plan(context, [], csv);
  assert.equal(result.status, 0, result.stderr);
  const source = JSON.parse(result.stdout);
  const batchId = '50000000-0000-4000-8000-000000000001';
  const writes = [];
  const readQuery = async sql => {
    if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }];
    if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [], checkpoints: [] } }];
    if (sql.includes('import_actor_id')) return [{ import_actor_id: '40000000-0000-4000-8000-000000000001' }];
    if (sql.includes('file_import_batches')) return [];
    throw new Error('Unexpected read');
  };
  const writeQuery = async sql => {
    writes.push(sql);
    if (sql.includes('finalize_patrol_import_batch')) return [{ id: batchId }];
    return [{ batch_id: batchId, results: [{ phase: 'stage', outcome: 'staged',
      detail: JSON.stringify({ evt_inserted: 1, obs_inserted: 0, proposals_inserted: 0 }) }] }];
  };
  const promoted = await promoteSheet({
    version: { sha256: source.source_sha256 },
    sheet: { sheet: '2026', client_code: 'TEST', client_organization_id: source.manifest.target_client_organization_id },
    map: { max_new_rows_per_sheet: 10 }, commit: true,
    exportPlan: async () => source, namespaceEventCount: async () => 1,
    syncPlan: ({ sourcePlan, commit }) => runSourceSync({ sourcePlan,
      providerOrganizationId: source.provider_organization_id, commit, readQuery, writeQuery }),
  });
  assert.equal(promoted.status, 'held');
  assert.equal(promoted.reason, 'unresolved_source_place');
  assert.equal(promoted.batch_id, undefined);
  assert.equal(promoted.row_holds.unresolved_source_place, 1);
  assert.deepEqual(writes, []);
});

test('an unregistered reserve alias holds both sightings and visits through promotion', async context => {
  const { runSourceSync } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { promoteSheet } = await import('../services/document-source-worker/source-promote.mjs');
  const { placesToRegister } = await import('../services/document-source-worker/source-places.mjs');
  const csv = [
    'Job,Patroller,Date,Reserve,Location,Comments,Reg',
    '42,fixture officer,19/10/2026,HQ,Test place,vehicle sighted,ABC123',
    '43,Camera,19/10/2026,HQ,Test place,camera alert,',
    '44,Camera,19/10/2026,,Test place,known visit,',
  ].join('\n');
  const { result } = plan(context, ['--place-aliases', JSON.stringify({ HQ: 'Head Office' })], csv);
  assert.equal(result.status, 0, result.stderr);
  const source = JSON.parse(result.stdout);
  assert.deepEqual(placesToRegister(source, {}), []);
  const writes = [];
  const readQuery = async sql => {
    if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }];
    if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [], checkpoints: [] } }];
    throw new Error('Unexpected read');
  };
  const promoted = await promoteSheet({
    version: { sha256: source.source_sha256 },
    sheet: { sheet: '2026', client_code: 'TEST', client_organization_id: source.manifest.target_client_organization_id },
    map: { max_new_rows_per_sheet: 10 }, commit: true, namespaceEventCount: async () => 1,
    exportPlan: async () => source,
    syncPlan: ({ sourcePlan, commit }) => runSourceSync({ sourcePlan,
      providerOrganizationId: source.provider_organization_id, commit, readQuery,
      writeQuery: async sql => { writes.push(sql); return []; } }),
  });
  assert.equal(promoted.status, 'held');
  assert.equal(promoted.reason, 'unresolved_source_place');
  assert.equal(promoted.row_holds.unresolved_source_place, 1);
  assert.equal(promoted.row_holds.one_resolved_place_required, 1);
  assert.deepEqual(writes, []);
});

test('a real importer overlay reveals conflicting reserve and location before place creation', async context => {
  const { runSourceSync } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { promoteSheet } = await import('../services/document-source-worker/source-promote.mjs');
  const csv = [
    'Job,Patroller,Date,Reserve,Location,Comments,Reg',
    '42,Camera,19/10/2026,Test place,Unknown place,first,',
    '43,Camera,19/10/2026,,Unknown place,second,',
  ].join('\n');
  const initial = plan(context, [], csv);
  assert.equal(initial.result.status, 0, initial.result.stderr);
  const source = JSON.parse(initial.result.stdout);
  const registrations = [];
  const writes = [];
  const readQuery = async sql => {
    if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: [], sync_history: true } }];
    if (sql.includes('AS activity')) return [{ activity: { observations: [], events: [], checkpoints: [] } }];
    throw new Error('Unexpected read');
  };
  const promoted = await promoteSheet({
    version: { sha256: source.source_sha256 },
    sheet: { sheet: '2026', client_code: 'TEST', client_organization_id: source.manifest.target_client_organization_id },
    map: { max_new_rows_per_sheet: 10 }, commit: true, namespaceEventCount: async () => 1,
    exportPlan: async ({ placeOverlay }) => {
      const { result } = plan(context, placeOverlay ? ['--place-overlay', JSON.stringify(placeOverlay)] : [], csv);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    },
    registerPlaces: async ({ places, commit }) => {
      registrations.push(commit);
      return places.map(place => ({ name: place.name, status: 'created',
        zone_id: '20000000-0000-4000-8000-000000000003', agreement_linked: true }));
    },
    syncPlan: ({ sourcePlan, commit, planningOnly }) => runSourceSync({ sourcePlan,
      providerOrganizationId: source.provider_organization_id, commit, planningOnly, readQuery,
      writeQuery: async sql => { writes.push(sql); return []; } }),
  });
  assert.equal(promoted.status, 'held');
  assert.equal(promoted.reason, 'conflicting_place_fields');
  assert.deepEqual(promoted.source_rows, [2]);
  assert.deepEqual(registrations, [false]);
  assert.deepEqual(writes, []);
});

test('duplicate visits are held in either order if one has an unresolved place', async context => {
  const { buildReconciliationPlan } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const known = '42,Camera,19/10/2026,Test place,known visit,';
  const blank = '42,Camera,19/10/2026,,missing place,';
  const unknown = '42,Camera,19/10/2026,Unknown place,unresolved visit,';
  for (const rows of [[known, unknown], [unknown, known], [blank, unknown], [unknown, blank]]) {
    const csv = ['Job,Patroller,Date,Location,Comments,Reg', ...rows].join('\n');
    const { result } = plan(context, ['--include-narratives'], csv);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.events, []);
    assert.deepEqual(output.proposals, []);
    assert.deepEqual(new Set(output.source_holds.map(hold => hold.reason)),
      new Set(rows.includes(blank)
        ? ['unresolved_source_place'] : ['unresolved_source_place', 'duplicate_source_key_with_unresolved_place']));
    assert.equal(buildReconciliationPlan({ sourcePlan: output, existing: [] }).summary.hold, 2);
  }
});

test('duplicate jobs with different places or source amounts are held instead of discarding a row', async context => {
  const { buildReconciliationPlan, buildSyncChunks } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const first = '42,Camera,19/10/2026,Test place,known visit,10';
  for (const second of [
    '42,Camera,19/10/2026,Other place,known visit,10',
    '42,Camera,19/10/2026,Test place,known visit,20',
  ]) {
    for (const rows of [[first, second], [second, first]]) {
      const csv = ['Job,Patroller,Date,Location,Comments,Job Cost', ...rows].join('\n');
      const { result } = plan(context, ['--place-overlay',
        JSON.stringify({ 'Other place': '20000000-0000-4000-8000-000000000002' })], csv);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.events, []);
      assert.deepEqual(output.source_holds.map(hold => hold.reason),
        ['divergent_duplicate_source_key', 'divergent_duplicate_source_key']);
      const reconciliation = buildReconciliationPlan({ sourcePlan: output, existing: [] });
      assert.equal(reconciliation.summary.hold, 2);
      assert.deepEqual(buildSyncChunks(output, reconciliation).chunks, []);
    }
  }
  const identical = plan(context, [], ['Job,Patroller,Date,Location,Comments,Job Cost', first, first].join('\n'));
  const output = JSON.parse(identical.result.stdout);
  assert.equal(output.events.length, 1);
  assert.deepEqual(output.source_holds, []);
  const direct = directApply(context,
    ['Job,Patroller,Date,Location,Comments,Job Cost', first, '42,Camera,19/10/2026,Test place,known visit,20'].join('\n'));
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /duplicate.*review/i);
  assert.doesNotMatch(direct.stderr, /Unexpected database write/);
});

test('a held duplicate Start cannot determine the next visit distance or charges', async context => {
  const { buildReconciliationPlan } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const header = 'Job,Patroller,Date,Time,Location,Comments,ODO,Job Time,Job Cost,Job KM Stringer,Travel Cost,Total Cost';
  const starts = [
    '41,Camera,05/06/2026,0900,Test place,Start,100,,,,,',
    '41,Camera,05/06/2026,0900,Other place,Start,150,,,,,',
  ];
  const visit = '42,Camera,05/06/2026,1000,Test place,All clear,160,-1,-50,-80,-80,-130';
  for (const rows of [starts, [...starts].reverse()]) {
    const { result } = plan(context, ['--place-overlay',
      JSON.stringify({ 'Other place': '20000000-0000-4000-8000-000000000002' })],
    [header, ...rows, visit].join('\n'));
    assert.equal(result.status, 0, result.stderr);
    const source = JSON.parse(result.stdout);
    assert.equal(source.events[0].distance_km, -80);
    assert.equal(source.events[0].payload.source_leg_correction, undefined);
    const reconciliation = buildReconciliationPlan({ sourcePlan: source, existing: [] });
    assert.equal(reconciliation.actions.find(action => action.external_ref.endsWith(':42')).reason, 'invalid_source_distance');
  }
});

test('a held prior-day row cannot justify a trip-odometer reset for the next visit', async context => {
  const { buildReconciliationPlan } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const header = 'Job,Patroller,Date,Time,Location,Comments,ODO,Job Time,Job Cost,Job KM Stringer,Travel Cost,Total Cost';
  const previous = [
    '41,Camera,05/06/2026,0900,Test place,Start,100,,,,,',
    '41,Camera,05/06/2026,0900,Other place,Start,150,,,,,',
  ];
  const visit = '42,Camera,06/06/2026,1000,Test place,All clear,160,-1,-50,-80,-80,-130';
  for (const rows of [previous, [...previous].reverse()]) {
    const { result } = plan(context, ['--place-overlay',
      JSON.stringify({ 'Other place': '20000000-0000-4000-8000-000000000002' })],
    [header, ...rows, visit].join('\n'));
    assert.equal(result.status, 0, result.stderr);
    const source = JSON.parse(result.stdout);
    assert.equal(source.events[0].distance_km, -80);
    assert.equal(source.events[0].payload.job_kms_correction, undefined);
    const reconciliation = buildReconciliationPlan({ sourcePlan: source, existing: [] });
    assert.equal(reconciliation.actions.find(action => action.external_ref.endsWith(':42')).reason, 'invalid_source_distance');
  }
});

test('XLSX plan reads the exact selected sheet and preserves original workbook hash and row number', async context => {
  const { result, bytes } = await xlsxPlan(context);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.source_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(output.source_sheet, 'DATA');
  assert.equal(output.events.length, 1);
  assert.equal(output.events[0].payload.source_sheet, 'DATA');
  assert.equal(output.events[0].payload.source_row, 4);
  assert.equal(output.events[0].occurred_at, '2026-09-20T04:36:00Z');
});

test('XLSX plan refuses bytes that do not match the scanned workbook hash', async context => {
  const mismatched = await xlsxPlan(context, { sourceHash: 'a'.repeat(64) });
  assert.notEqual(mismatched.result.status, 0);
  assert.match(mismatched.result.stderr, /workbook.*hash/i);
  const matched = await xlsxPlan(context, { sourceHash: 'actual' });
  assert.equal(matched.result.status, 0, matched.result.stderr);
  assert.equal(JSON.parse(matched.result.stdout).source_sha256, createHash('sha256').update(matched.bytes).digest('hex'));
});

test('XLSX plan rejects a missing selected sheet rather than falling back', async context => {
  const { result } = await xlsxPlan(context, { requestedSheet: 'NOT_DATA' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Selected worksheet was not found: NOT_DATA/);
  assert.equal(result.stdout, '');
});

test('XLSX typed and cached formula date/time cells retain Auckland time instead of silently skipping every row', async context => {
  for (const options of [{ typedDates: true }, { formulaDates: true }, { typedDates: true, date1904: true }]) {
    const { result } = await xlsxPlan(context, options);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.counts.skipped, 0);
    assert.equal(output.events.length, 1);
    assert.equal(output.events[0].occurred_at, '2026-09-20T04:36:12Z');
  }
});

test('CSV Excel time fractions preserve seconds without accepting invalid clock values', context => {
  const csv = [
    'Job,Patroller,Date,Time,Location',
    `42,Camera,20/09/2026,${(16 * 3600 + 36 * 60 + 12) / 86400},Test place`,
    '43,Camera,20/09/2026,16:36:12,Test place',
    '44,Camera,20/09/2026,24:00:00,Test place',
    '45,Camera,20/09/2026,0,Test place',
  ].join('\n');
  const { result } = plan(context, [], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.counts.skipped, 1);
  assert.deepEqual(output.events.map(row => row.occurred_at), [
    '2026-09-20T04:36:12Z', '2026-09-20T04:36:12Z', '2026-09-19T12:00:00Z',
  ]);
});

test('XLSX input refuses apply mode before requiring database credentials', async context => {
  const { result } = await xlsxPlan(context, { apply: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--xlsx is currently supported for --export-plan only/);
  assert.equal(result.stdout, '');
});

test('patrol plan converts Auckland daylight offsets and skips ambiguous local clock times', context => {
  const csv = [
    'Job,Patroller,Date,Time,Location',
    '42,Camera,20/09/2026,1636,Test place',
    '43,Camera,01/11/2026,1636,Test place',
    '44,Camera,27/09/2026,0230,Test place',
    '45,Camera,05/04/2026,0230,Test place',
  ].join('\n');
  const { result } = plan(context, [], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.events.map(row => row.occurred_at), [
    '2026-09-20T04:36:00Z',
    '2026-11-01T03:36:00Z',
  ]);
  assert.equal(output.counts.skipped, 2);
});

test('plan export preserves narratives only when explicitly selected', context => {
  const { result } = plan(context, ['--include-narratives']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).events[0].payload.comments, 'Source note, with comma');
});

test('plan export refuses apply rather than silently entering a write path', context => {
  const { result } = plan(context, ['--apply']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined/);
  assert.equal(result.stdout, '');
});

test('approved unused duplicate column is identified without changing the active issue mapping', context => {
  const csv = 'Job,Patroller,Date,Location,Issue,Issue\n42,Camera,19/10/2026,Test place,Reported issue,\n';
  const aliases = { 6: { source_header: 'Issue', alias: 'Unused Issue (F)', require_empty: true } };
  const { result } = plan(context, ['--include-narratives', '--source-column-aliases', JSON.stringify(aliases)], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.events[0].payload.issue, 'Reported issue');
  assert.deepEqual(output.schema.headers, ['Job', 'Patroller', 'Date', 'Location', 'Issue', 'Unused Issue (F)']);
  assert.deepEqual(output.schema.original_headers, ['Job', 'Patroller', 'Date', 'Location', 'Issue', 'Issue']);
  assert.deepEqual(output.schema.source_column_aliases, aliases);
});

test('new content or changed header in an approved unused column stops the import plan', context => {
  const aliases = { 6: { source_header: 'Issue', alias: 'Unused Issue (F)', require_empty: true } };
  const populated = plan(context, ['--source-column-aliases', JSON.stringify(aliases)],
    'Job,Patroller,Date,Location,Issue,Issue\n42,Camera,19/10/2026,Test place,First,Now used\n').result;
  assert.equal(populated.status, 1);
  assert.match(populated.stderr, /no longer empty/);
  assert.equal(populated.stdout, '');
  const renamed = plan(context, ['--source-column-aliases', JSON.stringify(aliases)],
    'Job,Patroller,Date,Location,Issue,Another column\n42,Camera,19/10/2026,Test place,First,\n').result;
  assert.equal(renamed.status, 1);
  assert.match(renamed.stderr, /exact unused or source-only/);
});

test('owner-selected primary Issue remains active while secondary values are preserved only as source metadata', context => {
  const aliases = { 6: { source_header: 'Issue', alias: 'Secondary Issue (F)', preserve_source: true } };
  const csv = 'Job,Patroller,Date,Location,Issue,Issue\n42,Camera,19/10/2026,Test place,Primary issue,Historical secondary value\n';
  const { result } = plan(context, ['--include-narratives', '--source-column-aliases', JSON.stringify(aliases)], csv);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout).events[0].payload;
  assert.equal(payload.issue, 'Primary issue');
  assert.deepEqual(payload.source_only_columns, { 6: {
    source_header: 'Issue', alias: 'Secondary Issue (F)', value: 'Historical secondary value',
  } });
  const withoutNarratives = plan(context, ['--source-column-aliases', JSON.stringify(aliases)], csv).result;
  assert.equal(withoutNarratives.status, 0, withoutNarratives.stderr);
  assert.equal(JSON.parse(withoutNarratives.stdout).events[0].payload.source_only_columns, undefined);
});

test('source distance and trip odometer retain separate values and column provenance', context => {
  const csv = 'Job,Patroller,Date,Location,Job Km NCC,Travel Odometer\n42,Camera,19/10/2026,Test place,12.5,145.8\n';
  const { result } = plan(context, [], csv);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout).events[0];
  assert.equal(row.distance_km, 12.5);
  assert.equal(row.payload.job_kms, '12.5');
  assert.equal(row.payload.travel_odometer, '145.8');
  assert.equal(row.payload.distance_source, 'source_job_km');
  assert.equal(row.payload.distance_source_column, 'Job Km NCC');
  assert.equal(row.payload.odometer_source_column, 'Travel Odometer');
  assert.equal(row.payload.between_site_distance_km, undefined);
});

test('a leg whose sheet formulas skipped the day Start row is recomputed from the Start row with provenance', context => {
  const csv = 'Job,Patroller,Date,Time,Location,Comments,ODO,Job Time,Job Cost,Job KM Stringer,Travel Cost,Total Cost\n'
    + '1,Camera,04/06/2026,1300,Test place,finish,127,1.5,93.75,61,60.39,154.14\n'
    + '2,Camera,05/06/2026,0915,,Start,0,,,,,\n'
    + '3,Camera,05/06/2026,1019,Test place,All clear,43,-2.683333333333332,-167.70833333333323,-84,-83.16,-250.86833333333323\n'
    + '4,Camera,05/06/2026,1019,Test place,All clear,43,1.0666666666666669,66.66666666666669,43,42.57,109.23666666666668\n'
    + '5,Camera,05/06/2026,1100,Test place,odd,38,0.5,31.25,-5,-4.95,26.3\n';
  const { result } = plan(context, [], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const rows = Object.fromEntries(output.events.map(row => [row.payload.job_number, row]));
  assert.equal(output.counts.start_row_leg_corrections, 1);
  assert.equal(rows['1'].payload.source_leg_correction, undefined);
  const fixed = rows['3'];
  assert.equal(fixed.distance_km, 43);
  assert.equal(fixed.payload.job_kms, '43');
  assert.equal(fixed.payload.job_kms_source_value, '-84');
  assert.equal(fixed.payload.job_kms_correction, 'formula_skipped_start_row');
  assert.equal(fixed.payload.distance_source, 'formula_skipped_start_row');
  assert.ok(Math.abs(Number(fixed.payload.job_time_hours) - 64 / 60) < 1e-9);
  assert.ok(Math.abs(fixed.payload.job_cost - 66.6666666667) < 1e-6);
  assert.equal(fixed.payload.travel_cost, 42.57);
  assert.ok(Math.abs(fixed.payload.total_cost - 109.2366666667) < 1e-6);
  assert.deepEqual({ ...fixed.payload.source_leg_correction, job_time_hours: undefined, job_cost: undefined, total_cost: undefined }, {
    rule: 'formula_skipped_start_row', start_source_row: 3, job_kms: '-84', travel_cost: -83.16,
    job_time_hours: undefined, job_cost: undefined, total_cost: undefined,
  });
  assert.equal(rows['4'].payload.source_leg_correction, undefined);
  // A negative leg that does not follow a Start row is not this artifact; it is kept as recorded and held downstream.
  assert.equal(rows['5'].distance_km, -5);
  assert.equal(rows['5'].payload.source_leg_correction, undefined);
});

test('a Start-row correction accepts every normalised time format and keeps unknown costs unknown', context => {
  const csv = 'Job,Patroller,Date,Time,Location,Comments,ODO,Job Time,Job Cost,Job KM Stringer,Travel Cost,Total Cost\n'
    + '1,Camera,04/06/2026,13:00:00,Test place,finish,127,1.5,93.75,61,60.39,154.14\n'
    + '2,Camera,05/06/2026,0.3854166666666667,,Start,0,,,,,\n'
    + '3,Camera,05/06/2026,10:19:00,Test place,All clear,43,-2.683333333333332,,-84,,\n';
  const { result } = plan(context, [], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const fixed = output.events.find(row => row.payload.job_number === '3');
  assert.equal(output.counts.start_row_leg_corrections, 1);
  assert.equal(fixed.distance_km, 43);
  assert.ok(Math.abs(Number(fixed.payload.job_time_hours) - 64 / 60) < 1e-9);
  assert.equal(fixed.payload.job_cost, null);
  assert.equal(fixed.payload.travel_cost, null);
  assert.equal(fixed.payload.total_cost, null);
});

test('a negative first-job distance on a new day uses the trip odometer and preserves the source value', context => {
  const csv = 'Job,Patroller,Date,Time,Location,Comments,ODO,Job Time,Job Cost,Job KM Stringer,Travel Cost,Total Cost\n'
    + '790,Camera,04/06/2026,1710,Test place,finish,125,0.5,31.25,10,10.4,41.65\n'
    + '793,Camera,05/06/2026,0915,Test place,first,43,0.5,31.25,-82,44.72,75.97\n'
    + '794,Camera,05/06/2026,1000,Test place,second,48,0.5,31.25,-5,4.95,36.2\n'
    + '982,Camera,06/06/2026,0915,Test place,first,43,0.5,31.25,-89,44.72,75.97\n'
    + '1068,Camera,07/06/2026,0915,Test place,first,48,0.5,31.25,-90,49.92,81.17\n';
  const { result } = plan(context, [], csv);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const rows = Object.fromEntries(output.events.map(row => [row.payload.job_number, row]));
  assert.equal(output.counts.day_reset_km_corrections, 3);
  for (const [job, kms, source] of [['793', 43, '-82'], ['982', 43, '-89'], ['1068', 48, '-90']]) {
    assert.equal(rows[job].distance_km, kms);
    assert.equal(rows[job].payload.job_kms, String(kms));
    assert.equal(rows[job].payload.job_kms_source_value, source);
    assert.equal(rows[job].payload.job_kms_correction, 'trip_odometer_day_reset');
    assert.equal(rows[job].payload.distance_source, 'trip_odometer_day_reset');
  }
  assert.equal(rows['793'].payload.job_cost, 31.25);
  assert.equal(rows['794'].distance_km, -5);
  assert.equal(rows['794'].payload.job_kms_correction, undefined);

  const firstRow = plan(context, [], 'Job,Patroller,Date,Time,Location,Comments,ODO,Job KM Stringer\n'
    + '793,Camera,05/06/2026,0915,Test place,first,43,-82\n').result;
  assert.equal(firstRow.status, 0, firstRow.stderr);
  assert.equal(JSON.parse(firstRow.stdout).events[0].distance_km, -82);
});

test('missing distances stay unknown and recorded zero remains a real source value', context => {
  const missing = plan(context, [], 'Job,Patroller,Date,Location\n42,Camera,19/10/2026,Test place\n').result;
  assert.equal(missing.status, 0, missing.stderr);
  const unknown = JSON.parse(missing.stdout).events[0];
  assert.equal(unknown.distance_km, null);
  assert.equal(unknown.payload.travel_odometer, null);
  assert.equal(unknown.payload.distance_source, null);
  const zero = plan(context, [], 'Job,Patroller,Date,Location,Job KM Stringer,ODO\n42,Camera,19/10/2026,Test place,0,0\n').result;
  assert.equal(zero.status, 0, zero.stderr);
  const recorded = JSON.parse(zero.stdout).events[0];
  assert.equal(recorded.distance_km, 0);
  assert.equal(recorded.payload.travel_odometer, '0');
});

test('local catalog context cannot be used for a write or another provider', context => {
  const { args, env, contextPath } = plan(context);
  const write = spawnSync(process.execPath, args.filter(value => value !== '--export-plan'), { env, encoding: 'utf8' });
  assert.equal(write.status, 1);
  assert.match(write.stderr, /only allowed with --export-plan/);
  const snapshot = JSON.parse(require('node:fs').readFileSync(contextPath, 'utf8'));
  snapshot.provider_organization_id = '50000000-0000-4000-8000-000000000001';
  writeFileSync(contextPath, JSON.stringify(snapshot));
  const otherProvider = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.equal(otherProvider.status, 1);
  assert.match(otherProvider.stderr, /must match the selected provider/);
});