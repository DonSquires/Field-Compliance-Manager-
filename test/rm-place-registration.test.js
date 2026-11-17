const test = require('node:test');
const assert = require('node:assert/strict');

const loadResolver = () => import('../scripts/rm-place-resolver.mjs');
const loadPlaces = () => import('../services/document-source-worker/source-places.mjs');

const ZONES = {
  SER: 'zone-serpentine', 'Serpentine Rd': 'zone-serpentine',
  'Spooners Gate': 'zone-spooners', 'Dart South': 'zone-dart-south', 'Dart North': 'zone-dart-north',
  Elveys: 'zone-elveys',
};

test('known places resolve by code, text, case, normalised text and single-letter spelling slips', async () => {
  const { buildPlaceResolver } = await loadResolver();
  const resolve = buildPlaceResolver(ZONES);
  assert.deepEqual(resolve('SER', ''), { target: 'zone-serpentine', match: 'reserve', sourceCode: 'SER', sourceText: '' });
  assert.equal(resolve('ser', '').match, 'reserve_case');
  assert.equal(resolve('', 'serpentine road').target, 'zone-serpentine');
  assert.equal(resolve('', 'Sepentine Rd').match, 'location_spelling');
  assert.equal(resolve('', 'Sepentine Rd').target, 'zone-serpentine');
  assert.equal(resolve('', 'Spooners Rd').match, 'location_spelling');
  assert.equal(resolve('', 'Spooners Rd').target, 'zone-spooners');
  assert.equal(resolve('', 'Elveys Rd').target, 'zone-elveys');
});

test('a different or missing directional qualifier cannot resolve to a mapped place', async () => {
  const { buildPlaceResolver } = await loadResolver();
  for (const [known, source] of [
    ['Dart South', 'Dart North'],
    ['Dart South', 'Dart'],
    ['Pine Upper', 'Pine Lower'],
    ['Red East', 'Red West'],
    ['Valley Top', 'Valley Bottom'],
  ]) {
    const result = buildPlaceResolver({ [known]: 'mapped-zone' })('', source);
    assert.equal(result.target, null, `${source} must not resolve to ${known}`);
  }
});

test('conflicting mapped reserve and location fields require review instead of choosing either place', async () => {
  const { buildPlaceResolver } = await loadResolver();
  const resolve = buildPlaceResolver(ZONES);
  assert.deepEqual(resolve('ser', 'Dart South'), {
    target: null, match: 'conflicting_place_fields', placeName: null,
    sourceCode: 'ser', sourceText: 'Dart South',
    conflictingTargets: { reserve: 'zone-serpentine', location: 'zone-dart-south' },
  });
  assert.equal(resolve('SER', 'Serpentine Rd').target, 'zone-serpentine');
  assert.equal(resolve('SER', 'Unmapped checkpoint').target, 'zone-serpentine');
});

test('a reviewed reserve alias that conflicts with a mapped location requires review', async () => {
  const { buildPlaceResolver } = await loadResolver();
  const resolve = buildPlaceResolver({ ...ZONES, 'Head Office': 'zone-hq' }, { placeAliases: { HQ: 'Head Office' } });
  assert.deepEqual(resolve('HQ', 'Dart South'), {
    target: null, match: 'conflicting_place_fields', placeName: null,
    sourceCode: 'HQ', sourceText: 'Dart South',
    conflictingTargets: { reserve: 'zone-hq', location: 'zone-dart-south' },
  });
  assert.equal(resolve('HQ', 'Head Office').target, 'zone-hq');
});

test('a location that is ambiguous or unknown becomes a new place name, never a guess', async () => {
  const { buildPlaceResolver, newPlaceName } = await loadResolver();
  const resolve = buildPlaceResolver(ZONES);
  assert.deepEqual(resolve('', 'Dart'), { target: null, match: null, placeName: 'Dart', sourceCode: '', sourceText: 'Dart' });
  assert.deepEqual(resolve('PFO', 'Quinneys Rd'), { target: null, match: null, placeName: 'Quinneys Rd', sourceCode: 'PFO', sourceText: 'Quinneys Rd' });
  // Short words are not spelling-matched, so one slip cannot turn one real place into another.
  assert.equal(resolve('', 'Bowns').target, null);
  assert.equal(newPlaceName('', ''), null);
  assert.equal(newPlaceName('9', 'x'), null);
  assert.equal(newPlaceName('PFO', ''), 'PFO');
});

test('non-place words are blank and reviewed aliases name a client-wide place', async () => {
  const { buildPlaceResolver } = await loadResolver();
  const general = 'General / All Forests (Admin, HQ, Travel)';
  const resolve = buildPlaceResolver({ ...ZONES, [`${general} (M&R)`]: 'zone-general' },
    { nonPlaceTerms: ['N/A', 'Enter', 'Exit', 'start'], placeAliases: { ALLF: general, HQ: 'Head Office' } });
  // An action word in either column names no place, so the other column decides.
  assert.equal(resolve('Enter', 'Serpentine Rd').target, 'zone-serpentine');
  assert.deepEqual(resolve('MTRN', 'enter'), { target: null, match: null, placeName: 'MTRN', sourceCode: 'MTRN', sourceText: '' });
  assert.equal(resolve('N/A', 'Exit').placeName, null);
  // A code alias wins over the text, like a mapped code; it records only the code for the overlay.
  assert.deepEqual(resolve('allf', 'Clover Rd'), { target: 'zone-general', match: 'alias_code', sourceCode: 'allf', sourceText: 'Clover Rd' });
  const unplaced = buildPlaceResolver(ZONES, { placeAliases: { ALLF: general } });
  assert.deepEqual(unplaced('ALLF', 'Clover Rd'), { target: null, match: null, placeName: general, sourceCode: 'ALLF', sourceText: '' });
  // A mapped code still beats an alias, and a text alias still prefers a mapped text.
  assert.equal(resolve('SER', 'ALLF').target, 'zone-serpentine');
  assert.equal(resolve('', 'hq').placeName, 'Head Office');
});

test('places to register are named with the client suffix and merged by name', async () => {
  const { placesToRegister, placeOverlay } = await loadPlaces();
  const plan = { unresolved_places: [
    { name: 'Quinneys Rd', reserve_codes: ['PFO'], locations: ['Quinneys Rd'], source_rows: [10] },
    { name: 'Quinneys Rd', reserve_codes: ['PFO'], locations: ['quinneys rd'], source_rows: [12] },
    { name: null, reserve_codes: [], locations: [], source_rows: [13] },
  ] };
  const places = placesToRegister(plan, { place_name_suffix: 'OneFortyOne' });
  assert.deepEqual(places, [{ name: 'Quinneys Rd (OneFortyOne)', source_name: 'Quinneys Rd', reserve_codes: ['PFO'],
    locations: ['Quinneys Rd', 'quinneys rd'], source_rows: [10, 12] }]);
  assert.deepEqual(placeOverlay(places, [{ name: 'Quinneys Rd (OneFortyOne)', status: 'created', zone_id: 'z1' }]),
    { 'Quinneys Rd': 'z1', 'quinneys rd': 'z1' });
  assert.deepEqual(placeOverlay(places, [{ name: 'Quinneys Rd (OneFortyOne)', status: 'registry_match_review', zone_id: null }]), {});
});

test('an unregistered reserve alias cannot override a mapped location or create a new place', async () => {
  const { buildPlaceResolver } = await loadResolver();
  const resolve = buildPlaceResolver({ 'Dart South': 'zone-dart-south' }, {
    placeAliases: { HQ: 'Head Office' },
  });
  assert.deepEqual(resolve('HQ', 'Dart South'), {
    target: null, match: 'unresolved_reserve_alias', placeName: null,
    sourceCode: 'HQ', sourceText: 'Dart South',
  });
});

test('place registration runs as the import identity through governed RPCs and never revives an ended link', async () => {
  const { placeRegistrationSql } = await loadPlaces();
  const id = '11111111-1111-4111-8111-111111111111';
  const places = [{ name: "O'Neills (OneFortyOne)", source_name: "O'Neills", source_rows: [1] }];
  const args = { actorId: id, providerId: id, clientId: id, source: { file: 'f.xlsx', sheet: '2026', sha256: 'a'.repeat(64) }, places };
  const preview = placeRegistrationSql({ ...args, commit: false });
  assert.match(preview, /^BEGIN;\nSET LOCAL request\.jwt\.claim\.sub = '11111111-/);
  assert.match(preview, /ROLLBACK;\s*$/);
  assert.match(placeRegistrationSql({ ...args, commit: true }), /COMMIT;\s*$/);
  assert.match(preview, /public\.manage_crm_location\(/);
  assert.match(preview, /public\.manage_crm_zone\(/);
  assert.match(preview, /ON CONFLICT[^;]*DO NOTHING/i);
  // Place names travel base64-encoded, so a quote in a name cannot break out of the SQL.
  assert.doesNotMatch(preview, /O'Neills/);
  assert.throws(() => placeRegistrationSql({ ...args, actorId: 'nope' }), /valid identities/);
  assert.throws(() => placeRegistrationSql({ ...args, places: [] }), /out of range/);
  const many = Array.from({ length: 11 }, (_, i) => ({ ...places[0], name: `Place ${i}` }));
  assert.throws(() => placeRegistrationSql({ ...args, places: many }), /out of range/);
  assert.doesNotThrow(() => placeRegistrationSql({ ...args, places: many, limit: 40 }));
  assert.throws(() => placeRegistrationSql({ ...args, places: [...many, ...many, ...many, ...many, ...many], limit: 99 }), /out of range/);
});
