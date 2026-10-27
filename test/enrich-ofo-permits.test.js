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
