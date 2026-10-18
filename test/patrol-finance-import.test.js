const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const loadModule = () => import('../scripts/lib/patrol-finance-import.mjs');

test('patrol finance headers cover client-specific cost and provenance variants', async () => {
  const { resolvePatrolColumns, resolveProfileMappings } = await loadModule();
  const headers = [
    'Log No', 'Date', 'Forest', 'Location', 'Job Time TPFL', 'Job Cost TPFL',
    'Job KM TPFL', 'Travel Cost TPFL', 'Total Cost TPFL', 'GL Code',
    'GL Description', 'Issue', 'Issue #2', 'Travel ODO', 'TYPE',
  ];
  const columns = resolvePatrolColumns(headers);
  assert.equal(columns.jobCost, 5);
  assert.equal(columns.travelCost, 7);
  assert.equal(columns.totalCost, 8);
  assert.equal(columns.odo, 13);
  assert.equal(resolveProfileMappings(headers).length, headers.length);
});

test('patrol finance profile mappings ignore unnamed workbook columns', async () => {
  const { resolveProfileMappings } = await loadModule();
  const headers = ['Log No', '', 'Date', '   ', 'Job Cost'];
  assert.deepEqual(
    resolveProfileMappings(headers).map((mapping) => mapping.source_column),
    ['Log No', 'Date', 'Job Cost'],
  );
});

test('patrol finance rows use components without double-counting displayed totals', async () => {
  const { buildPatrolFinanceRows } = await loadModule();
  const derivative = {
    source_file: 'ACTIVE Example.xlsx',
    source_sha256: 'a'.repeat(64),
    derivative_sha256: 'b'.repeat(64),
    source_sheet: '2026',
    headers: ['Log No', 'Date', 'Forest', 'Location', 'Job Cost', 'Travel Cost', 'Total Cost'],
    rows: [
      { source_row: 2, values: ['1', '01/09/2026', 'ALPHA', 'Gate', 100, 20, 120], formulas: { 5: '=1*100', 6: '=20*1' } },
    ],
  };
  const result = buildPatrolFinanceRows({
    derivative,
    clientCode: 'EXAMPLE2026',
    providerOrganizationId: '10000000-0000-4000-8000-000000000001',
    clientOrganizationId: '10000000-0000-4000-8000-000000000002',
    serviceAgreementId: '10000000-0000-4000-8000-000000000003',
    zoneMap: { ALPHA: '10000000-0000-4000-8000-000000000004' },
  });
  assert.deepEqual(result.rows.map((row) => [row.component, row.cost_type, row.amount]), [
    ['job_cost', 'labour', 100],
    ['travel_cost', 'vehicle', 20],
  ]);
  assert.equal(result.summary.eligible_total, 120);
  assert.ok(result.rows.every((row) => row.status === 'eligible'));
  assert.ok(result.rows.every((row) => row.total_cost === 120));
});

test('patrol finance rows quarantine formula errors, mismatches, duplicates, and unresolved places', async () => {
  const { buildPatrolFinanceRows } = await loadModule();
  const derivative = {
    source_file: 'ACTIVE Example.xlsx',
    source_sha256: 'a'.repeat(64),
    derivative_sha256: 'b'.repeat(64),
    source_sheet: '2026',
    headers: ['Log No', 'Date', 'Forest', 'Location', 'Job Cost', 'Travel Cost', 'Total Cost'],
    rows: [
      { source_row: 2, values: ['1', '01/09/2026', 'ALPHA', 'Gate', 100, 20, 999], formulas: {} },
      { source_row: 3, values: ['2', '02/09/2026', 'ALPHA', 'Gate', '#VALUE!', 20, '#VALUE!'], formulas: {} },
      { source_row: 4, values: ['3', '03/09/2026', 'UNKNOWN', 'Unknown', 100, 20, 120], formulas: {} },
      { source_row: 5, values: ['3', '03/09/2026', 'ALPHA', 'Gate', 100, 20, 120], formulas: {} },
    ],
  };
  const result = buildPatrolFinanceRows({
    derivative,
    clientCode: 'EXAMPLE2026',
    providerOrganizationId: '10000000-0000-4000-8000-000000000001',
    clientOrganizationId: '10000000-0000-4000-8000-000000000002',
    serviceAgreementId: '10000000-0000-4000-8000-000000000003',
    zoneMap: { ALPHA: '10000000-0000-4000-8000-000000000004' },
  });
  assert.equal(result.summary.total_mismatches, 1);
  assert.equal(result.summary.formula_errors, 1);
  assert.equal(result.summary.unresolved_places, 1);
  assert.equal(result.summary.duplicate_external_refs, 1);
  assert.ok(result.rows.every((row) => row.status === 'quarantined'));
});

test('patrol finance database path is review-gated, replay-safe, and source-row backed', () => {
  const migration = readFileSync(resolve(__dirname, '../supabase/migrations/20261018014551_apply_patrol_finance_import_proposals.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.file_import_finance_cost_rows/);
  assert.match(migration, /UNIQUE \(batch_id, source_file, source_sheet, source_row, component\)/);
  assert.match(migration, /'dispatch_job','patrol_log'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.stage_patrol_finance_cost_rows/);
  assert.match(migration, /outside_agreement_term/);
  assert.doesNotMatch(migration, /agreement\.starts_on<=current_date/);
  assert.match(migration, /Previously accepted finance source row changed and requires governed financial reconciliation/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(v_batch\.organization_id::text\|\|':finance_pl_period:'/);
  assert.match(migration, /operational_evidence_not_found/);
  assert.match(migration, /displayed_total_mismatch/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.review_file_import_finance_proposals/);
  assert.match(migration, /Every source mapping must be confirmed/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.apply_file_import_finance_batch/);
  assert.match(migration, /v_batch\.status NOT IN \('approved','applied'\)/);
  assert.match(migration, /source_document_type='patrol_log'/);
  assert.doesNotMatch(migration, /GRANT (?:ALL|INSERT|UPDATE|DELETE).*file_import_finance_cost_rows TO authenticated/i);
});

test('file review UI separates proposal approval from finance apply', () => {
  const page = readFileSync(resolve(__dirname, '../apps/web/src/pages/FileSystemPage.tsx'), 'utf8');
  assert.match(page, /confirm_file_import_profile_mappings/);
  assert.match(page, /review_file_import_finance_proposals/);
  assert.match(page, /apply_file_import_finance_batch/);
  assert.match(page, /Approval records a decision only/);
  assert.doesNotMatch(page, /Approve and apply/);
});

test('patrol finance staging sends bounded database requests', () => {
  const staging = readFileSync(resolve(__dirname, '../scripts/stage-patrol-financials.mjs'), 'utf8');
  assert.match(staging, /const chunkSize = 150/);
  assert.match(staging, /for \(const \[index, chunk\] of chunks\.entries\(\)\)/);
  assert.match(staging, /CREATE TEMP TABLE fcm_patrol_stage_receipt ON COMMIT DROP/);
  assert.match(staging, /Rollback preview chunk \$\{index \+ 1\}\/\$\{chunks\.length\}/);
  assert.match(staging, /Batch \$\{batchId\} remains in staging and can be resumed safely/);
  assert.match(staging, /SELECT batch_row FROM public\.file_import_batches batch_row WHERE id=/);
  assert.doesNotMatch(staging, /SELECT \* FROM public\.file_import_batches WHERE id=/);
  assert.doesNotMatch(staging, /JSON\.stringify\(\{ chunks,/);
});
