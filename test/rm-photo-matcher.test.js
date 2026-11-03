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

test('treats NZTA owner/vehicle screenshots as privileged and never parses them', () => {
  return loadMatcher().then(({ isPrivilegedPhotoName, parsePhotoName }) => {
  for (const fileName of ['NZTA 240817 112216.png', 'ABC123 NZTA 240817 112216.png', 'Photos/Site/abc123 nzta 230914 0621.jpg',
    'ABC123 NZTA Rabb Is 280831 143518.jpg', 'NZTA check ABC123 230615 175300.png']) {
    assert.equal(isPrivilegedPhotoName(fileName), true, fileName);
    assert.equal(parsePhotoName(fileName), null, fileName);
  }
  assert.equal(isPrivilegedPhotoName('260920 163612 GKJ550.jpg'), false);
  assert.equal(isPrivilegedPhotoName('260920 163612 NZTAX1.jpg'), false);
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

test('matches the leading location segment of "<Location> - <Area> - <Client>" folders', () => {
  return loadMatcher().then(({ indexPhotoTargets, matchPhotoTarget, parsePhotoName }) => {
  const parsed = parsePhotoName('251213 102734 cyclist enters .jpg');
  const index = indexPhotoTargets([
    { id: 'serpentine-card-review', observed_at: '2025-12-12T21:27:00Z', place_aliases: ['Serpentine Rd', 'SERP'] },
    { id: 'other-place', observed_at: '2025-12-12T21:27:00Z', place_aliases: ['Rai Forest Rd'] },
  ]);
  const result = matchPhotoTarget(parsed, 'Photos/Serpentine Rd - Rai Forest - OFO/251213 102734 cyclist enters .jpg', index);
  assert.equal(result.status, 'matched');
  assert.equal(result.target.id, 'serpentine-card-review');
  assert.equal(matchPhotoTarget(parsed, 'Photos/Inwoods Lookout  - OFO/251213 102734 x.jpg', index).status, 'unmatched');
  });
});

test('falls back to a shared distinctive place word for drifted folder names', () => {
  return loadMatcher().then(({ indexPhotoTargets, matchPhotoTarget, parsePhotoName }) => {
  const homestead = parsePhotoName('261003 094018.png');
  const index = indexPhotoTargets([
    { id: 'manuka-card-review', observed_at: '2026-10-02T20:40:00Z', place_aliases: ['Manuka Island Forest (OneFortyOne)', 'Homestead Rd', 'MANU'] },
    { id: 'other-forest', observed_at: '2026-10-02T20:40:00Z', place_aliases: ['Serpentine (OneFortyOne)', 'Serpentine Gate'] },
  ]);
  const typo = matchPhotoTarget(homestead, 'Photos/Homstead Rd - Manuka Island - OFO/261003 094018.png', index);
  assert.equal(typo.status, 'matched');
  assert.equal(typo.target.id, 'manuka-card-review');
  assert.equal(typo.matchType, 'place_near');
  const serpentine = matchPhotoTarget(homestead, 'Photos/Serpentine Rd - Rai Forest - OFO/261003 094018.png', index);
  assert.equal(serpentine.target.id, 'other-forest');
  assert.equal(matchPhotoTarget(homestead, 'Photos/Gate Rd - Forest - OFO/261003 094018.png', index).status, 'unmatched');
  assert.equal(matchPhotoTarget(homestead, 'Photos/Manuka Serpentine/261003 094018.png', index).status, 'unmatched');
  });
});

test('matches the four OFO card-review photos from exact-minute event place aliases', () => {
  return loadMatcher().then(({ indexPhotoTargets, matchPhotoTarget, parsePhotoName }) => {
    const index = indexPhotoTargets([
      { id: 'homestead-0940', observed_at: '2026-10-02T20:40:00Z', place_aliases: ['Manuka Island Forest (OneFortyOne)', 'Homestead Rd'] },
      { id: 'homestead-1340', observed_at: '2026-10-03T00:40:00Z', place_aliases: ['Manuka Island Forest (OneFortyOne)', 'Homestead Rd'] },
      { id: 'homestead-1624', observed_at: '2026-10-04T03:24:00Z', place_aliases: ['Manuka Island Forest (OneFortyOne)', 'Homestead Rd'] },
      { id: 'serpentine-1548', observed_at: '2026-10-11T02:48:00Z', place_aliases: ['Serpentine (OneFortyOne)', 'Serpentine Gate'] },
    ]);
    const files = [
      ['Photos/Homstead Rd - Manuka Island - OFO/261003 094018.png', 'homestead-0940'],
      ['Photos/Homstead Rd - Manuka Island - OFO/261003 134044.png', 'homestead-1340'],
      ['Photos/Homstead Rd - Manuka Island - OFO/261004 1624.png', 'homestead-1624'],
      ['Photos/Serpentine Rd - Rai Forest - OFO/261011 154832 cyclists x 2 and dog.jpg', 'serpentine-1548'],
    ];
    for (const [file, expectedId] of files) {
      const match = matchPhotoTarget(parsePhotoName(file), file, index);
      assert.equal(match.status, 'matched', file);
      assert.equal(match.target.id, expectedId, file);
    }
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