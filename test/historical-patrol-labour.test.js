const assert = require('node:assert/strict');
const test = require('node:test');

const loaded = Promise.all([
  import('../scripts/lib/historical-patrol-labour.mjs'),
  import('../scripts/preview-rm-patrol-labour.mjs'),
]);
const row = (values = {}) => ({
  kind: 'event', id: 'one', client_id: 'client', officer_id: 'officer',
  officer_in_provider: true, work_date: '2026-05-01', hours: '1.25',
  external_ref: 'rm:OFO2026:1', job_number: '1', ...values,
});
const build = async records => (await loaded)[0].buildHistoricalPatrolLabourReport({ records, asOf: '2026-10-29' });

test('daily labour sums recorded job hours across clients, not elapsed shift windows or composite charges', async () => {
  const report = await build([row(), row({ id: 'two', external_ref: 'rm:STAND2026:2', client_id: 'another', hours: '0.75', job_cost: '166.60' })]);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].recorded_hours, '2');
  assert.equal(report.items[0].estimated_pay, '64.00');
  assert.equal(report.items[0].pay_code, 'FORESTRY-PATROL');
  assert.equal(report.summary.candidate_days, 1);
});

test('invalid or missing hours hold the whole officer/day instead of returning a partial payable total', async () => {
  for (const hours of [null, '', '-1', 'NaN', '1h', '1e2']) {
    const report = await build([row(), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours })]);
    assert.equal(report.items[0].status, 'held', String(hours));
    assert.equal(report.items[0].estimated_pay, null);
  }
});

test('owner-approved explicit zeros contribute zero without holding a positive-hours day', async () => {
  const report = await build([row(), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours: '0' })]);
  assert.equal(report.items[0].status, 'candidate');
  assert.equal(report.items[0].recorded_hours, '1.25');
  assert.equal(report.items[0].estimated_pay, '40.00');
  assert.equal(report.items[0].sources.length, 2);
});

test('all-zero days are retained as evidence only, without pay codes or pay estimates', async () => {
  const report = await build([row({ hours: '0' })]);
  assert.equal(report.summary.evidence_only_days, 1);
  assert.equal(report.summary.candidate_days, 0);
  assert.equal(report.items[0].status, 'evidence_only');
  assert.equal(report.items[0].recorded_hours, '0');
  assert.equal(report.items[0].estimated_pay, null);
  assert.equal(report.items[0].pay_code, null);
});

test('a zero mixed with a blank remains held, not evidence-only or payable', async () => {
  const report = await build([row({ hours: '0' }), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours: null })]);
  assert.equal(report.items[0].status, 'held');
  assert.equal(report.items[0].estimated_pay, null);
  assert.equal(report.summary.evidence_only_days, 0);
});

test('exact decimal aggregation keeps 24 hours valid and holds any amount above it without clipping', async () => {
  const atLimit = await build([row({ hours: '23.9' }), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours: '0.1' })]);
  assert.equal(atLimit.items[0].recorded_hours, '24');
  assert.equal(atLimit.items[0].status, 'candidate');
  const over = await build([row({ hours: '24.000000000000000001' })]);
  assert.equal(over.items[0].recorded_hours, '24.000000000000000001');
  assert.deepEqual(over.items[0].reasons, ['daily_hours_exceed_24']);
});

test('unattributed and foreign-tenant officers are retained as held evidence, never payroll recipients', async () => {
  for (const identity of [{ officer_id: null }, { officer_in_provider: false }]) {
    const report = await build([row(identity)]);
    assert.equal(report.items[0].status, 'held');
    assert.equal(report.items[0].pay_code, null);
    assert.equal(report.policy.unattributed_label, 'Relief Officer (No Name)');
  }
});

test('engineering, digger/equipment, crew and changed-source cases are explicit holds, not guessed pay', async () => {
  for (const flag of ['engineering_review_required', 'equipment_review_required', 'crew_review_required', 'source_review_required']) {
    const report = await build([row({ [flag]: true })]);
    assert.equal(report.summary.held_days, 1, flag);
    assert.equal(report.items[0].estimated_pay, null);
  }
});

test('an event and an observation mirroring the same source row count once, retaining both source records', async () => {
  const report = await build([row(), row({ kind: 'observation' })]);
  assert.equal(report.items[0].recorded_hours, '1.25');
  assert.equal(report.items[0].sources.length, 2);
  assert.equal(report.summary.mirrored_records_not_counted_twice, 1);
});

test('conflicting mirrors hold every affected officer/day', async () => {
  const report = await build([row(), row({ kind: 'observation', officer_id: 'another', work_date: '2026-05-02', hours: '3' })]);
  assert.equal(report.summary.held_days, 2);
  assert.ok(report.items.every(item => item.reasons.includes('duplicate_source_conflict')));
});

test('different job numbers sharing a source reference are a conflict, not a mirror', async () => {
  const report = await build([row(), row({ kind: 'observation', job_number: 'another' })]);
  assert.equal(report.summary.mirrored_records_not_counted_twice, 0);
  assert.ok(report.items[0].reasons.includes('duplicate_source_conflict'));
});

test('a second observation cannot hide behind an event/observation mirror', async () => {
  const report = await build([row(), row({ kind: 'observation' }), row({ kind: 'observation', id: 'two' })]);
  assert.equal(report.summary.mirrored_records_not_counted_twice, 1);
  assert.ok(report.items[0].reasons.includes('duplicate_source_conflict'));
  assert.equal(report.items[0].estimated_pay, null);
});

test('separate year-sheet records remain separate evidence but a possible same-job/day overlap holds', async () => {
  const report = await build([row({ external_ref: 'rm:DART2025:1' }), row({ id: 'two', external_ref: 'rm:DART2026:1' })]);
  assert.equal(report.items[0].sources.length, 2);
  assert.equal(report.items[0].recorded_hours, '2.5');
  assert.deepEqual(report.items[0].reasons, ['year_sheet_overlap_review_required']);
  assert.equal(report.items[0].estimated_pay, null);
});

test('distinct dates, job numbers and clients do not collapse merely because year sheets differ', async () => {
  const report = await build([row({ external_ref: 'rm:DART2025:1' }), row({ id: 'two', external_ref: 'rm:DART2026:2', job_number: '2' })]);
  assert.equal(report.summary.candidate_days, 1);
  assert.equal(report.items[0].recorded_hours, '2.5');
});

test('future and invalid dates are held or quarantined, not silently corrected', async () => {
  const report = await build([row({ work_date: '2926-08-23' }), row({ id: 'two', work_date: '2026-02-30' })]);
  assert.deepEqual(report.items[0].reasons, ['future_work_date']);
  assert.equal(report.summary.malformed_records, 1);
});

test('replay ordering does not change the source fingerprint; a changed hour changes it', async () => {
  const rows = [row(), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours: '0.5' })];
  const original = await build(rows);
  const replay = await build([...rows].reverse());
  assert.deepEqual(replay, original);
  const changed = await build([rows[0], { ...rows[1], hours: '0.6' }]);
  assert.notEqual(changed.source_fingerprint, original.source_fingerprint);
});

test('source IDs cannot repeat, and source references cannot silently disappear', async () => {
  await assert.rejects(build([row(), row()]), /Repeated source record ID/);
  const report = await build([row({ external_ref: null })]);
  assert.ok(report.items[0].reasons.includes('source_identity_missing'));
});

test('money rounds once at the daily total rather than once per source row', async () => {
  const report = await build([row({ hours: '0.0001' }), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours: '0.0001' })]);
  assert.equal(report.items[0].estimated_pay, '0.01');
});

test('snapshot is read-only, date-bounded, provider-scoped, complete and compares current source versions', async () => {
  const { labourSnapshotSql, main } = (await loaded)[1];
  const sql = labourSnapshotSql('2021-01-01', '2026-10-29');
  assert.match(sql, /^BEGIN READ ONLY;/);
  assert.match(sql, /ROLLBACK;$/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMIT)\b/);
  assert.match(sql, /provider_organization_id='e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'/);
  assert.match(sql, /r.work_date BETWEEN '2021-01-01'::date AND '2026-10-29'::date/);
  assert.match(sql, /patrol_source_record_state\(r.kind,r.id\) IS DISTINCT FROM v.state_after/);
  assert.match(sql, /Pacific\/Auckland/);
  assert.match(sql, /'future',count/);
  assert.match(sql, /'source_record_count',\(SELECT count\(\*\) FROM normalized\)/);
  assert.throws(() => labourSnapshotSql("2021-01-01';select 1", '2026-10-29'), /valid inclusive date window/);
  assert.throws(() => labourSnapshotSql('2026-10-29', '2021-01-01'), /valid inclusive date window/);
  assert.throws(() => main(['--apply', 'yes']), /read-only/);
  assert.throws(() => main(['--from', '2021-01-01', '--to', '2026-10-29', '--output', __filename]), /private directory outside/);
});
