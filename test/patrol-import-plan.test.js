const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
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
        column_mappings: { job: ['Job'], patroller: ['Patroller'], date: ['Date'], time: ['Time'], location: ['Location'],
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

async function xlsxPlan(context, { requestedSheet = 'DATA', apply = false, typedDates = false, formulaDates = false, date1904 = false } = {}) {
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