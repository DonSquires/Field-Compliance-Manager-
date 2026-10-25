const assert = require('node:assert/strict');
const test = require('node:test');

const loaded = Promise.all([
  import('../scripts/lib/historical-patrol-labour.mjs'),
  import('../scripts/preview-rm-patrol-labour.mjs'),
]);
const row = (values = {}) => ({
  kind: 'event', id: 'one', client_id: 'client', officer_id: 'officer',
  officer_in_provider: true, work_date: '2026-05-01', hours: '1.25',
  external_ref: 'rm:OFO2026:1', job_number: '1', happened_at: '2026-04-30T20:00:00.000Z', ...values,
});
const STAFF = [
  { id: 'officer', display_name: 'Pat Officer' },
  { id: 'cheryl', display_name: 'Cheryl Murray' },
  { id: 'reuben', display_name: 'Reuben Stanfield' },
  { id: 'deb', display_name: 'Deb Crawford' },
  { id: 'pete', display_name: 'Pete Crawford' },
  { id: 'rob-field', display_name: 'Rob Crawford field' },
];
const ACCOUNTS = [{ id: 'rob-master', display_name: 'Rob Crawford' }, { id: 'orphan', display_name: 'Nobody Known' }];
const build = async (records, extra = {}) =>
  (await loaded)[0].buildHistoricalPatrolLabourReport({ records, asOf: '2026-10-29', ...extra });
const buildWithStaff = records => build(records, { staff: STAFF, accounts: ACCOUNTS });

test('daily labour sums recorded job hours across clients, not elapsed shift windows or composite charges', async () => {
  const report = await build([row(), row({ id: 'two', external_ref: 'rm:STAND2026:2', client_id: 'another', hours: '0.75', job_cost: '166.60' })]);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].recorded_hours, '2');
  assert.equal(report.items[0].estimated_pay, '64.00');
  assert.equal(report.items[0].pay_code, 'FORESTRY-PATROL');
  assert.equal(report.summary.candidate_days, 1);
});

test('owner ruling: invalid or missing hours make the whole officer/day evidence only, never a partial payable total', async () => {
  for (const hours of [null, '', '-1', 'NaN', '1h', '1e2']) {
    const report = await build([row(), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours })]);
    assert.equal(report.items[0].status, 'evidence_only', String(hours));
    assert.ok(report.items[0].evidence_reasons.includes('missing_or_invalid_hours'));
    assert.equal(report.items[0].estimated_pay, null);
    assert.equal(report.slots.length, 0);
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

test('a zero mixed with a blank is evidence only, never payable', async () => {
  const report = await build([row({ hours: '0' }), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours: null })]);
  assert.equal(report.items[0].status, 'evidence_only');
  assert.equal(report.items[0].estimated_pay, null);
  assert.equal(report.summary.candidate_days, 0);
});

test('exact decimal aggregation keeps 24 hours valid; anything above is evidence only without clipping', async () => {
  const atLimit = await build([row({ hours: '23.9' }), row({ id: 'two', external_ref: 'rm:OFO2026:2', hours: '0.1' })]);
  assert.equal(atLimit.items[0].recorded_hours, '24');
  assert.equal(atLimit.items[0].status, 'candidate');
  const over = await build([row({ hours: '24.000000000000000001' })]);
  assert.equal(over.items[0].recorded_hours, '24.000000000000000001');
  assert.equal(over.items[0].status, 'evidence_only');
  assert.deepEqual(over.items[0].evidence_reasons, ['daily_hours_exceed_24']);
  assert.equal(over.slots.length, 0);
});

test('a review hold outranks evidence-only so a flagged day is never quietly archived', async () => {
  const report = await build([row({ hours: null, engineering_review_required: true })]);
  assert.equal(report.items[0].status, 'held');
  assert.ok(report.items[0].reasons.includes('engineering_pay_review_required'));
});

test('unattributed rows roster to the non-login Relief Officer placeholder; foreign-tenant officers stay held', async () => {
  const { RELIEF_OFFICER_ID } = (await loaded)[0];
  for (const raw of [null, '', '?', 'Start']) {
    const relief = await buildWithStaff([row({ officer_id: null, officer_in_provider: null, patroller_raw: raw })]);
    assert.equal(relief.items[0].status, 'candidate', String(raw));
    assert.equal(relief.items[0].officer_id, RELIEF_OFFICER_ID);
    assert.equal(relief.summary.relief_candidate_days, 1);
    assert.equal(relief.slots[0].staff_id, RELIEF_OFFICER_ID);
  }
  const foreign = await build([row({ officer_in_provider: false })]);
  assert.equal(foreign.items[0].status, 'held');
  assert.equal(foreign.items[0].pay_code, null);
  assert.equal(foreign.policy.unattributed_label, 'Relief Officer (No Name)');
});

test('Camera, External and Digger labels are non-labour evidence even with hours', async () => {
  for (const raw of ['Camera', 'External', 'digger']) {
    const report = await buildWithStaff([row({ officer_id: null, officer_in_provider: null, patroller_raw: raw })]);
    assert.equal(report.items[0].status, 'evidence_only', raw);
    assert.deepEqual(report.items[0].evidence_reasons, ['non_labour_source_label']);
    assert.equal(report.slots.length, 0);
  }
});

test('owner ruling: names resolve by surname with shortened or one-letter-different first names', async () => {
  const { resolveStaffIdentity } = (await loaded)[0];
  const cases = {
    'Cheryl Murray': ['cheryl', 'exact_name'],
    'Sheryl Murray': ['cheryl', 'surname_and_compatible_first_name'],
    'Reuben Standfield': ['reuben', 'surname_and_compatible_first_name'],
    'Deborah Crawford': ['deb', 'surname_and_compatible_first_name'],
    'Rob Crawford': ['rob-field', 'exact_name'],
    Sheryl: ['cheryl', 'unique_first_name'],
  };
  for (const [name, [id, method]] of Object.entries(cases)) {
    assert.deepEqual(resolveStaffIdentity(name, STAFF), { kind: 'matched', officer_id: id, method }, name);
  }
  assert.equal(resolveStaffIdentity('Hayley Stanfield', STAFF).reason, 'officer_identity_unknown_person');
  assert.equal(resolveStaffIdentity('Murray', STAFF).kind, 'unattributed');
  assert.equal(resolveStaffIdentity('Pat & Cheryl', STAFF).reason, 'crew_attribution_review_required');
  const twins = [...STAFF, { id: 'cheryl-2', display_name: 'Cheryl Murrays' }];
  assert.equal(resolveStaffIdentity('Sheryl Murray', twins).reason, 'officer_identity_ambiguous');
  assert.equal(resolveStaffIdentity('Cheryl Murray', twins).officer_id, 'cheryl');
});

test('labour linked to a login without a staff record moves to that person\'s field account, or is held', async () => {
  const moved = await buildWithStaff([row({ officer_id: 'rob-master' })]);
  assert.equal(moved.items[0].officer_id, 'rob-field');
  assert.equal(moved.slots[0].staff_id, 'rob-field');
  assert.equal(moved.summary.unlinked_name_resolutions.login_to_staff_account, 1);
  const orphan = await buildWithStaff([row({ officer_id: 'orphan' })]);
  assert.equal(orphan.items[0].status, 'held');
  assert.ok(orphan.items[0].reasons.includes('officer_identity_review_required'));
  assert.equal(orphan.slots.length, 0);
});

test('slots split per client, chain back to back from the first entry and never overlap the same officer', async () => {
  const report = await build([
    row({ hours: '1.5', happened_at: '2026-04-30T21:00:00.000Z' }),
    row({ id: 'two', external_ref: 'rm:STAND2026:2', client_id: 'another', hours: '0.5', happened_at: '2026-04-30T20:00:00.000Z' }),
    row({ id: 'three', external_ref: 'rm:OFO2026:3', work_date: '2026-05-02', happened_at: '2026-05-01T20:00:00.000Z' }),
  ]);
  const [first, second, third] = report.slots;
  assert.equal(report.summary.roster_slots_planned, 3);
  assert.equal(first.client_organization_id, 'another');
  assert.equal(first.scheduled_start, '2026-04-30T20:00:00.000Z');
  assert.equal(first.scheduled_end, '2026-04-30T20:30:00.000Z');
  assert.equal(second.scheduled_start, first.scheduled_end);
  assert.equal(second.scheduled_end, '2026-04-30T22:00:00.000Z');
  assert.equal(second.recorded_hours, '1.5');
  assert.equal(second.source_key, 'rm_patrol_log_labour:officer:2026-05-01:client');
  assert.equal(third.work_date, '2026-05-02');
  assert.ok(first.source_fingerprint);
  assert.equal(first.source_fingerprint, second.source_fingerprint, 'a day chain is replaced as one unit');
  assert.notEqual(first.source_fingerprint, third.source_fingerprint);
});

test('missing entry times or an anchor outside the work date are held, not invented', async () => {
  const missing = await build([row({ happened_at: null })]);
  assert.deepEqual(missing.items[0].reasons, ['source_time_missing']);
  assert.equal(missing.slots.length, 0);
  const elsewhere = await build([row({ happened_at: '2026-05-03T20:00:00.000Z' })]);
  assert.equal(elsewhere.items[0].status, 'held');
  assert.deepEqual(elsewhere.items[0].reasons, ['roster_time_overlap_review_required']);
  assert.equal(elsewhere.slots.length, 0);
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
  assert.match(sql, /patroller_raw/);
  assert.match(sql, /happened_at/);
  assert.match(sql, /'staff',/);
  assert.match(sql, /'accounts',/);
  assert.throws(() => labourSnapshotSql("2021-01-01';select 1", '2026-10-29'), /valid inclusive date window/);
  assert.throws(() => labourSnapshotSql('2026-10-29', '2021-01-01'), /valid inclusive date window/);
  assert.throws(() => main(['--apply', 'yes']), /read-only/);
  assert.throws(() => main(['--from', '2021-01-01', '--to', '2026-10-29', '--output', __filename]), /private directory outside/);
});

const applyLoaded = import('../scripts/apply-rm-patrol-labour.mjs');
const FP = 'a'.repeat(64);
const slot = (n) => ({ source_key: `k${n}`, staff_id: 's', recorded_hours: 1 });

test('import batch request ids are deterministic UUIDs per fingerprint and batch', async () => {
  const { batchRequestId } = await applyLoaded;
  const id = batchRequestId(FP, 0);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(batchRequestId(FP, 0), id);
  assert.notEqual(batchRequestId(FP, 1), id);
  assert.notEqual(batchRequestId('b'.repeat(64), 0), id);
});

test('import SQL rolls back by default, splits batches and commits only on request', async () => {
  const { importSql, batchRequestId, routingRequestId } = await applyLoaded;
  const slots = [1, 2, 3, 4, 5].map(slot);
  const rollback = importSql({ slots, reportFingerprint: FP, batchSize: 2 });
  assert.match(rollback, /ROLLBACK;\s*$/);
  assert.doesNotMatch(rollback, /COMMIT;/);
  assert.equal((rollback.match(/import_historical_patrol_labour_slots\(/g) ?? []).length, 3);
  for (const index of [0, 1, 2]) assert.ok(rollback.includes(batchRequestId(FP, index)));
  assert.equal((rollback.match(/apply_historical_patrol_labour_routes\(/g) ?? []).length, 1);
  assert.ok(rollback.indexOf('apply_historical_patrol_labour_routes(') > rollback.lastIndexOf('import_historical_patrol_labour_slots('),
    'routing runs once, after every batch has been imported');
  assert.ok(rollback.includes(routingRequestId(FP)));
  assert.notEqual(routingRequestId(FP), routingRequestId('b'.repeat(64)));
  assert.match(importSql({ slots, reportFingerprint: FP, commit: true }), /COMMIT;\s*$/);
});

test('import SQL refuses unsafe or incomplete requests', async () => {
  const { importSql } = await applyLoaded;
  const slots = [slot(1)];
  assert.throws(() => importSql({ slots, reportFingerprint: 'nope' }), /fingerprint is required/);
  assert.throws(() => importSql({ slots: [], reportFingerprint: FP }), /No roster slots/);
  assert.throws(() => importSql({ slots, reportFingerprint: FP, batchSize: 1001 }), /Batch size/);
  assert.throws(() => importSql({ slots, reportFingerprint: FP, commit: true, migrationSql: 'SELECT 1;' }), /never be committed/);
  assert.throws(() => importSql({ slots: [{ source_key: '$slots$' }], reportFingerprint: FP }), /quote tag/);
});
