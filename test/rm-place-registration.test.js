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
  assert.deepEqual(resolve('SER', ''), { target: 'zone-serpentine', match: 'reserve' });
  assert.equal(resolve('ser', '').match, 'reserve_case');
  assert.equal(resolve('', 'serpentine road').target, 'zone-serpentine');
  assert.deepEqual(resolve('', 'Sepentine Rd'), { target: 'zone-serpentine', match: 'location_spelling' });
  assert.deepEqual(resolve('', 'Spooners Rd'), { target: 'zone-spooners', match: 'location_spelling' });
  assert.equal(resolve('', 'Elveys Rd').target, 'zone-elveys');
});

test('a location that is ambiguous or unknown becomes a new place name, never a guess', async () => {
  const { buildPlaceResolver, newPlaceName } = await loadResolver();
  const resolve = buildPlaceResolver(ZONES);
  assert.deepEqual(resolve('', 'Dart'), { target: null, match: null, placeName: 'Dart' });
  assert.deepEqual(resolve('PFO', 'Quinneys Rd'), { target: null, match: null, placeName: 'Quinneys Rd' });
  // Short words are not spelling-matched, so one slip cannot turn one real place into another.
  assert.equal(resolve('', 'Bowns').target, null);
  assert.equal(newPlaceName('', ''), null);
  assert.equal(newPlaceName('9', 'x'), null);
  assert.equal(newPlaceName('PFO', ''), 'PFO');
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
});
