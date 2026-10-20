const test = require('node:test');
const assert = require('node:assert/strict');

const loadMatcher = () => import('../scripts/rm-photo-matcher.mjs');

test('parses timestamp-plus-rego and timestamp-only filenames', () => {
  return loadMatcher().then(({ parsePhotoName }) => {
  const withPlate = parsePhotoName('260920 163612 GKJ550.jpg');
  assert.equal(withPlate.minuteKey, '2026-09-20 16:36');
  assert.equal(withPlate.plate, 'GKJ550');

  const withoutPlate = parsePhotoName('260920 163612.jpg');
  assert.equal(withoutPlate.minuteKey, '2026-09-20 16:36');
  assert.equal(withoutPlate.plate, null);
  });
});

test('rejects invalid dates and out-of-range local times', () => {
  return loadMatcher().then(({ parsePhotoName }) => {
  for (const fileName of ['260230 163612.jpg', '260920 246012.jpg', '260920 16361 GKJ550.jpg']) {
    assert.equal(parsePhotoName(fileName), null, fileName);
  }
  });
});

test('matches Auckland date and minute while ignoring differing seconds', () => {
  return loadMatcher().then(({ indexPhotoTargets, matchPhotoTarget, parsePhotoName }) => {
  const parsed = parsePhotoName('260920 163612 GKJ550.jpg');
  const index = indexPhotoTargets([{
    id: 'observation-one',
    observed_at: '2026-09-20T04:36:01Z',
    plate_number: 'GKJ 550',
  }]);
  const result = matchPhotoTarget(parsed, 'Photos/Camera/260920 163612 GKJ550.jpg', index);
  assert.equal(result.status, 'matched');
  assert.equal(result.target.id, 'observation-one');
  assert.equal(result.matchType, 'rego');
  });
});

test('does not match an adjacent minute or a different Auckland-local date', () => {
  return loadMatcher().then(({ indexPhotoTargets, matchPhotoTarget, parsePhotoName }) => {
  const parsed = parsePhotoName('260920 163612 GKJ550.jpg');
  const index = indexPhotoTargets([
    { id: 'next-minute', observed_at: '2026-09-20T04:37:01Z', plate_number: 'GKJ550' },
    { id: 'next-date', observed_at: '2026-09-21T04:36:01Z', plate_number: 'GKJ550' },
  ]);
  assert.equal(matchPhotoTarget(parsed, 'Photos/Camera/photo.jpg', index).status, 'unmatched');
  });
});

test('matches filename rego against plate text in observation notes', () => {
  return loadMatcher().then(({ extractPlateCandidates, indexPhotoTargets, matchPhotoTarget, parsePhotoName }) => {
  assert.deepEqual([...extractPlateCandidates('White ute observed, plate GKJ-550 in notes')], ['GKJ550']);
  const parsed = parsePhotoName('260920 163612 GKJ550.jpg');
  const index = indexPhotoTargets([{
    id: 'notes-only-plate',
    observed_at: '2026-09-20T04:36:48Z',
    plate_number: null,
    officer_notes: 'White ute, registration GKJ-550',
  }]);
  assert.equal(matchPhotoTarget(parsed, 'Photos/Camera/photo.jpg', index).target.id, 'notes-only-plate');
  });
});

test('matches timestamp-only photos only through an exact folder place alias', () => {
  return loadMatcher().then(({ indexPhotoTargets, matchPhotoTarget, parsePhotoName }) => {
  const parsed = parsePhotoName('260920 163612.jpg');
  const index = indexPhotoTargets([{
    id: 'place-observation',
    observed_at: '2026-09-20T04:36:30Z',
    place_aliases: ['North Reserve'],
  }]);
  const result = matchPhotoTarget(parsed, 'Photos/North Reserve/260920 163612.jpg', index);
  assert.equal(result.status, 'matched');
  assert.equal(result.target.id, 'place-observation');
  assert.equal(result.matchType, 'place');
  assert.equal(matchPhotoTarget(parsed, 'Photos/Other Reserve/260920 163612.jpg', index).status, 'unmatched');
  });
});

test('holds multiple same-minute plate or place candidates as ambiguous', () => {
  return loadMatcher().then(({ indexPhotoTargets, matchPhotoTarget, parsePhotoName }) => {
  const parsed = parsePhotoName('260920 163612 GKJ550.jpg');
  const index = indexPhotoTargets([
    { id: 'observation-one', observed_at: '2026-09-20T04:36:01Z', plate_number: 'GKJ550' },
    { id: 'observation-two', observed_at: '2026-09-20T04:36:59Z', officer_notes: 'rego GKJ550' },
  ]);
  assert.equal(matchPhotoTarget(parsed, 'Photos/Camera/photo.jpg', index).status, 'ambiguous');
  });
});

test('formats observations in Auckland time across daylight-saving offsets', () => {
  return loadMatcher().then(({ aucklandMinuteKey }) => {
    assert.equal(aucklandMinuteKey('2026-11-01T03:36:45Z'), '2026-11-01 16:36');
  });
});

test('converts Auckland-local photo timestamps to UTC across daylight-saving changes', () => {
  return loadMatcher().then(({ aucklandInstant, parsePhotoName }) => {
    assert.equal(aucklandInstant(parsePhotoName('260920 163612 GKJ550.jpg')), '2026-09-20T04:36:12.000Z');
    assert.equal(aucklandInstant(parsePhotoName('261101 163612 GKJ550.jpg')), '2026-11-01T03:36:12.000Z');
    assert.equal(aucklandInstant(parsePhotoName('260927 023000.jpg')), null);
  });
});

test('converts patrol local times with Auckland DST and holds skipped or repeated clock minutes', () => {
  return loadMatcher().then(({ aucklandInstantFromLocalParts }) => {
    assert.equal(aucklandInstantFromLocalParts(2026, 9, 20, 16, 36), '2026-09-20T04:36:00.000Z');
    assert.equal(aucklandInstantFromLocalParts(2026, 11, 1, 16, 36), '2026-11-01T03:36:00.000Z');
    assert.equal(aucklandInstantFromLocalParts(2026, 9, 27, 2, 30), null);
    assert.equal(aucklandInstantFromLocalParts(2026, 4, 5, 2, 30), null);
    assert.equal(aucklandInstantFromLocalParts(2026, 9, 20, 24, 0), null);
  });
});