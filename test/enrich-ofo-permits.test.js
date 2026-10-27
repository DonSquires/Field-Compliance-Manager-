const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/enrich-ofo-permits.mjs');

test('parseOfoVehicles splits plate, make, model and colour typed with no separator', async () => {
  const { parseOfoVehicles } = await load();
  assert.deepEqual(parseOfoVehicles('ABC123Toyota Hilux, white'), {
    vehicles: [{ plate: 'ABC123', make: 'Toyota', model: 'Hilux', colour: 'white' }], unparsed: 0,
  });
  assert.deepEqual(parseOfoVehicles('ABC123Toyota Hilux, white,XY9876Ford Ranger Wildtrak, Dark Grey').vehicles, [
    { plate: 'ABC123', make: 'Toyota', model: 'Hilux', colour: 'white' },
    { plate: 'XY9876', make: 'Ford', model: 'Ranger Wildtrak', colour: 'Dark Grey' },
  ]);
  assert.deepEqual(parseOfoVehicles('QWE456 (trailer)Isuzu Dmax').vehicles,
    [{ plate: 'QWE456', make: 'Isuzu', model: 'Dmax', colour: null }]);
  assert.deepEqual(parseOfoVehicles('ZZ1 Suzuki').vehicles, [{ plate: 'ZZ1', make: 'Suzuki', model: null, colour: null }]);
});

test('parseOfoVehicles reports text it cannot read instead of guessing', async () => {
  const { parseOfoVehicles } = await load();
  assert.deepEqual(parseOfoVehicles(''), { vehicles: [], unparsed: 0 });
  assert.deepEqual(parseOfoVehicles(null), { vehicles: [], unparsed: 0 });
  assert.deepEqual(parseOfoVehicles('my ute'), { vehicles: [], unparsed: 1 });
  assert.equal(parseOfoVehicles('ABC123BMW X5, black').unparsed, 1);
  const mixed = parseOfoVehicles('ABC123Toyota Hilux, white, plus the farm bike');
  assert.equal(mixed.vehicles.length, 1);
  assert.equal(mixed.vehicles[0].colour, 'white, plus the farm bike');
});

const row = (overrides = {}) => Object.fromEntries(Object.entries({
  'permit description': 12345,
  'permit holder': ' Sam  Example ',
  'applicant type': 'Individual',
  'permit type': 'Recreational',
  'company name': null,
  'address 1': '1 Example Road',
  'address 2': null,
  suburb: 'Example Bay',
  city: 'Nelson',
  postcode: '7010',
  email: 'Sam@Example.TEST',
  'phone home': '03 555 0000',
  'phone mobile': 211234567,
  vehicles: 'ABC123Toyota Hilux, white',
  'forest areas': 'Forest A, Forest B, ',
  'forest activities': 'Hunting,Walking',
  'hunting season': 'Summer',
  'date from': new Date('2025-11-01T00:00:00Z'),
  finishing: new Date('2026-10-31T00:00:00Z'),
  'valid firearm license': 'F/A YES',
  'valid firearm number': 'FA-TEST-1',
  'chainsaw safety equipment': 'No',
  'keys issued': 'Lockvue access',
  'permit conditions': '  Keep gates closed.\r\nNo fires.  ',
  ...overrides,
}).map(([key, value]) => [key.toLowerCase(), value]));

test('mapOfoRow maps a worksheet row to the governed import payload', async () => {
  const { mapOfoRow } = await load();
  const { permit, issues } = mapOfoRow(row());
  assert.deepEqual(issues, []);
  assert.deepEqual(permit, {
    permit_number: '12345',
    holder_name: 'Sam Example',
    contact_email: 'sam@example.test',
    contact_phone: '0211234567',
    address_text: '1 Example Road, Example Bay, Nelson, 7010',
    permit_type: 'Recreational',
    applicant_type: 'Individual',
    forest_areas: ['Forest A', 'Forest B'],
    activities: ['Hunting', 'Walking'],
    hunting_season: 'Summer',
    date_from: '2025-11-01',
    date_to: '2026-10-31',
    firearm_licence_valid: true,
    firearm_licence_number: 'FA-TEST-1',
    chainsaw_safety_equipment: false,
    keys_issued: true,
    conditions: 'Keep gates closed.\nNo fires.',
    vehicles: [{ plate: 'ABC123', make: 'Toyota', model: 'Hilux', colour: 'white' }],
  });
});

test('mapOfoRow leaves unanswered questions out and flags unreadable answers', async () => {
  const { mapOfoRow } = await load();
  const { permit, issues } = mapOfoRow(row({
    'valid firearm license': 'F/A No', 'chainsaw safety equipment': null, 'keys issued': null,
    'phone mobile': null, vehicles: 'old ute',
  }));
  assert.equal(permit.firearm_licence_valid, false);
  assert.equal('chainsaw_safety_equipment' in permit, false);
  assert.equal('keys_issued' in permit, false);
  assert.equal(permit.contact_phone, '03 555 0000');
  assert.deepEqual(permit.vehicles, []);
  assert.deepEqual(issues, ['vehicle_text_unparsed']);
  assert.deepEqual(mapOfoRow(row({ 'valid firearm license': 'maybe' })).issues, ['firearm_answer_unrecognised']);
});

test('buildPermitPlan holds unreadable, reversed and repeated permits', async () => {
  const { buildPermitPlan } = await load();
  const plan = buildPermitPlan([
    row(),
    row({ 'permit description': 'n/a' }),
    row({ 'permit description': 22222, finishing: new Date('2024-01-01T00:00:00Z') }),
    row({ 'permit description': 33333 }),
    row({ 'permit description': 33333 }),
  ], { today: '2026-01-15' });
  assert.equal(plan.summary.permits, 1);
  assert.equal(plan.summary.held, 4);
  assert.deepEqual(plan.summary.held_reasons, {
    permit_number_unreadable: 1, finishes_before_start: 1, permit_number_repeated_in_file: 2,
  });
  assert.equal(plan.summary.in_date_today, 1);
  assert.equal(plan.summary.vehicles, 1);
  assert.deepEqual(plan.held.map((held) => held.permit_number), ['n/a', '22222', '33333', '33333']);
});

test('permitsSql calls only the governed RPC, one savepoint per permit, and refuses delimiter injection', async () => {
  const { permitsSql, buildPermitPlan } = await load();
  const source = { sourceDocument: "HABITAT - RAMS/Permit Extract OFO.xlsx", sourceSha256: 'a'.repeat(64), sourceCheckedAt: '2025-11-17T21:32:59.000Z' };
  const sql = permitsSql(buildPermitPlan([row()]).permits, source);
  assert.match(sql, /public\.import_person_permit\(/);
  assert.match(sql, /EXCEPTION WHEN OTHERS/);
  assert.doesNotMatch(sql, /INSERT INTO public\.|UPDATE public\.|DELETE FROM/i);
  assert.throws(() => permitsSql([{ permit_number: '1', conditions: '$permit_rows$' }], source), /delimiter/);
  assert.throws(() => permitsSql([], { ...source, sourceSha256: 'nothex' }), /SHA-256/);
});

test('summariseResults counts outcomes and keeps values out of error summaries', async () => {
  const { summariseResults } = await load();
  const summary = summariseResults([
    { outcome: 'enriched', match_basis: 'existing_permit', fields_filled: ['date_from', 'date_to'], fields_differing: ['contact_phone'],
      holder_name_differs: true, vehicles_linked: 2, vehicles_created: 1, vehicles_already_linked: 0, vehicles_invalid: 0 },
    { outcome: 'held_holder_not_resolved', error: 'Permit holder not resolved: 0 existing permit holders share this name and application email' },
    { outcome: 'error', error: 'invalid input syntax for type date: "sam@example.test 12345"' },
  ], { mode: 'dry_run_rolled_back', planned: 3 });
  assert.deepEqual(summary.outcomes, { enriched: 1, held_holder_not_resolved: 1, error: 1 });
  assert.deepEqual(summary.fields_filled, { date_from: 1, date_to: 1 });
  assert.equal(summary.holder_name_differs, 1);
  assert.equal(summary.vehicles.vehicles_linked, 2);
  assert.deepEqual(Object.keys(summary.errors), ['invalid input syntax for type date: "…"']);
});

test('nameExtends mirrors public.person_name_extends', async () => {
  const { nameExtends } = await load();
  assert.equal(nameExtends('Smith', 'Jane Smith'), true);
  assert.equal(nameExtends('smith', '  JANE   smith '), true);
  assert.equal(nameExtends('Jane Smith', 'Mary Jane Smith'), true);
  assert.equal(nameExtends('van der Berg', 'Piet Van Der Berg'), true);
  assert.equal(nameExtends('Smith', 'Smith'), false);
  assert.equal(nameExtends('Smith', 'Jane Smyth'), false);
  assert.equal(nameExtends('Smith', 'Smith Jane'), false);
  assert.equal(nameExtends('Tama Ngata', 'Hine Ngata'), false);
  assert.equal(nameExtends(null, 'Jane Smith'), false);
});

const holder = (permit_number, canonical_person_id, display_name, contact_email) =>
  ({ permit_number, canonical_person_id, display_name, contact_email });
const extract = (permit_number, holder_name, contact_email) => ({ permit_number, holder_name, contact_email });

test('planHolderRepair completes a surname record only when every permit is accounted for', async () => {
  const { planHolderRepair } = await load();
  const plan = planHolderRepair([
    holder('100', 'p-ngata', 'Ngata', 'n@example.test'),
    holder('101', 'p-ngata', 'Ngata', ' N@example.test'),
    holder('102', 'p-ngata', 'Ngata', 'n@example.test'),
  ], [extract('100', 'Tama Ngata', 'n@example.test'), extract('101', 'Tama  Ngata', 'n@example.test')]);
  assert.deepEqual(plan.attributions, [{ canonical_person_id: 'p-ngata', full_name: 'Tama Ngata',
    permit_numbers: ['100', '101', '102'], expected: 'name_completed' }]);
  assert.deepEqual(plan.summary.categories, { completed: 1 });
});

test('planHolderRepair separates two named holders and keeps the larger on the record', async () => {
  const { planHolderRepair } = await load();
  const plan = planHolderRepair([
    holder('200', 'p-smith', 'Smith', 'jane@example.test'),
    holder('201', 'p-smith', 'Smith', 'jane@example.test'),
    holder('202', 'p-smith', 'Smith', 'mary@example.test'),
  ], [extract('200', 'Jane Smith', 'jane@example.test'), extract('202', 'Mary Smith', 'mary@example.test')]);
  assert.deepEqual(plan.attributions, [
    { canonical_person_id: 'p-smith', full_name: 'Mary Smith', permit_numbers: ['202'], expected: 'split' },
    { canonical_person_id: 'p-smith', full_name: 'Jane Smith', permit_numbers: ['200', '201'], expected: 'name_completed' },
  ]);
  assert.deepEqual(plan.summary.categories, { split_then_completed: 1 });
});

test('planHolderRepair never guesses who an unproven permit belongs to', async () => {
  const { planHolderRepair } = await load();
  const plan = planHolderRepair([
    holder('300', 'p-brown', 'Brown', 'ann@example.test'),
    holder('301', 'p-brown', 'Brown', 'other@example.test'),
    holder('400', 'p-lee', 'Lee', 'family@example.test'),
    holder('401', 'p-lee', 'Lee', 'family@example.test'),
    holder('402', 'p-lee', 'Lee', 'family@example.test'),
    holder('500', 'p-hall', 'Hall', 'h@example.test'),
    holder('600', 'p-reid', 'Reid', 'r@example.test'),
    holder('700', 'p-kim', 'Ana Kim', 'k@example.test'),
  ], [
    extract('300', 'Ann Brown', 'ann@example.test'),
    extract('400', 'Kim Lee', 'family@example.test'), extract('401', 'Sam Lee', 'family@example.test'),
    extract('500', 'Harry Hallett', 'h@example.test'),
    extract('700', 'Ana Kim', 'k@example.test'),
  ]);
  assert.deepEqual(plan.attributions, [
    { canonical_person_id: 'p-brown', full_name: 'Ann Brown', permit_numbers: ['300'], expected: 'split' },
    { canonical_person_id: 'p-lee', full_name: 'Kim Lee', permit_numbers: ['400'], expected: 'split' },
    { canonical_person_id: 'p-lee', full_name: 'Sam Lee', permit_numbers: ['401'], expected: 'split' },
  ]);
  assert.deepEqual(plan.summary.categories, {
    split_record_kept_surname: 2, name_does_not_extend: 1, no_evidence_surname_only: 1, already_named: 1,
  });
});

test('planHolderRepair predicts how each new permit finds its holder', async () => {
  const { planHolderRepair } = await load();
  const plan = planHolderRepair([
    holder('800', 'p-ngata', 'Ngata', 'n@example.test'),
    holder('810', 'p-hall', 'Hall', 'h@example.test'),
    holder('820', 'p-reid', 'Reid', 'r@example.test'),
    holder('821', 'p-reid', 'Reid', 'other@example.test'),
    holder('830', 'p-cole', 'Cole', 'jo@example.test'),
    holder('831', 'p-cole', 'Cole', 'family@example.test'),
    holder('840', 'p-ward', 'Ward', 'w@example.test'),
    holder('841', 'p-ward-2', 'Ward', 'w@example.test'),
  ], [
    extract('800', 'Tama Ngata', 'n@example.test'),
    extract('830', 'Jo Cole', 'jo@example.test'),
    extract('900', 'TAMA ngata', 'n@example.test'),
    extract('901', 'Hine Ngata', 'n@example.test'),
    extract('902', 'Harry Hall', 'h@example.test'),
    extract('903', 'Rua Reid', 'r@example.test'),
    extract('904', 'Mia Cole', 'family@example.test'),
    extract('905', 'Ari Ward', 'w@example.test'),
    extract('906', 'Solo', 'solo@example.test'),
    extract('907', 'Harry Hall', 'h@example.test'),
  ]);
  assert.deepEqual(plan.new_permits.map(({ permit, expected, expected_follow_up }) => [permit.permit_number, expected, expected_follow_up]), [
    ['900', 'permit_email_and_name', null],
    ['901', 'created_holder', null],
    ['902', 'permit_email_and_surname', 'name_completed'],
    ['903', 'permit_email_and_surname', 'split'],
    ['904', 'permit_email_and_surname', 'name_completed'],
    ['905', 'held_holder_not_resolved', null],
    ['906', 'held_holder_not_resolved', null],
    ['907', 'permit_email_and_name', null],
  ]);
  assert.deepEqual(plan.summary.new_permit_follow_ups, { name_completed: 2, split: 1 });
});

test('holderRepairSql calls only governed RPCs and holds any step that departs from the plan', async () => {
  const { holderRepairSql } = await load();
  const source = { sourceDocument: 'HABITAT - RAMS/Permit Extract OFO.xlsx', sourceSha256: 'a'.repeat(64), sourceCheckedAt: '2025-11-17T21:32:59.000Z' };
  const repair = {
    attributions: [{ canonical_person_id: '11111111-1111-4111-8111-111111111111', full_name: "Rua O'Neill", permit_numbers: ['1'], expected: 'split' }],
    new_permits: [{ permit: { permit_number: '2', holder_name: 'Ari Ward' }, expected: 'created_holder', expected_follow_up: null }],
  };
  const sql = holderRepairSql(repair, source);
  assert.match(sql, /public\.attribute_permit_holder\(/);
  assert.match(sql, /public\.import_person_permit\([^;]*NULL, true\)/);
  assert.match(sql, /Unexpected repair outcome/);
  assert.match(sql, /held_unexpected_outcome/);
  assert.equal(sql.match(/EXCEPTION WHEN OTHERS/g).length, 2);
  assert.doesNotMatch(sql, /INSERT INTO public\.|UPDATE public\.|DELETE FROM/i);
  assert.throws(() => holderRepairSql({ ...repair, attributions: [{ ...repair.attributions[0], full_name: '$attributions$' }] }, source), /delimiter/);
  assert.throws(() => holderRepairSql(repair, { ...source, sourceSha256: 'nothex' }), /SHA-256/);
});

test('summariseHolderRepair counts outcomes and keeps values out of error summaries', async () => {
  const { summariseHolderRepair } = await load();
  const summary = summariseHolderRepair([
    { step: 'attribute', outcome: 'split', permits_moved: 2 },
    { step: 'attribute', outcome: 'name_completed', permits_moved: 0 },
    { step: 'attribute', outcome: 'held_unexpected_outcome', error: 'Unexpected repair outcome: split' },
    { step: 'import', outcome: 'inserted', match_basis: 'permit_email_and_surname', follow_up: 'name_completed', permits_moved: 0 },
    { step: 'import', outcome: 'inserted', match_basis: 'created_holder' },
    { step: 'import', outcome: 'error', error: 'value "Jane Smith 12345" is too long' },
  ], { mode: 'dry_run_rolled_back', planned: {}, before: { holders: 2 }, after: { holders: 3 } });
  assert.deepEqual(summary.attributions, { split: 1, name_completed: 1, held_unexpected_outcome: 1 });
  assert.deepEqual(summary.new_permits, { 'inserted:permit_email_and_surname': 1, 'inserted:created_holder': 1, error: 1 });
  assert.deepEqual(summary.follow_ups, { name_completed: 1 });
  assert.equal(summary.permits_moved, 2);
  assert.equal(summary.unexpected, 1);
  assert.deepEqual(Object.keys(summary.errors), ['value "…" is too long']);
});
test('writePrivate keeps personal reports outside the repository and owner-only', async () => {
  const { writePrivate } = await load();
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  assert.throws(() => writePrivate(path.join(process.cwd(), 'report.json'), 'repair report', '{}'), /outside the repository/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-private-'));
  try {
    const fresh = path.join(directory, 'fresh.json');
    const existing = path.join(directory, 'existing.json');
    fs.writeFileSync(existing, 'old', { mode: 0o644 });
    writePrivate(fresh, 'repair report', '{"a":1}');
    writePrivate(existing, 'repair report', '{"b":2}');
    assert.equal(fs.readFileSync(fresh, 'utf8'), '{"a":1}');
    assert.equal(fs.readFileSync(existing, 'utf8'), '{"b":2}');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
      assert.equal(fs.statSync(existing).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});