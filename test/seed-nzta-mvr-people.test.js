'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const load = () => import('../scripts/seed-nzta-mvr-people.mjs');

const shot = (overrides = {}) => ({
  sha256: 'a'.repeat(64),
  path: 'C:/photos/ABC123 NZTA 260901.png',
  name: 'ABC123 NZTA 260901.png',
  size: 1000,
  parsed: { plate: 'ABC123', client_code: null, file_date: '2026-09-01' },
  plate_verification: { value: 'ABC123', candidates: [] },
  fields: {
    display_name: 'Test Person',
    physical_address: '1 Example Road, Town',
    query_completed_at: '2026-09-01T10:00:00',
    vehicle_make: 'Toyota',
  },
  ...overrides,
});

test('retries failed OCR entries instead of treating them as completed', async () => {
  const { completedOcrPaths } = await load();
  const completed = completedOcrPaths([
    { path: 'failed.png', error: 'temporary OCR failure' },
    { path: 'partial.png' },
    { path: 'good.png', sha256: 'a'.repeat(64) },
  ]);
  assert.deepEqual([...completed], ['good.png']);
});

test('binds an upload to the cached screenshot digest and size', async () => {
  const { screenshotContentMatches } = await load();
  const bytes = Buffer.from('fixture screenshot');
  const expected = { size: bytes.length, sha: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(screenshotContentMatches(bytes, expected), true);
  assert.equal(screenshotContentMatches(Buffer.from('changed screenshot'), expected), false);
  assert.equal(screenshotContentMatches(bytes, { ...expected, size: bytes.length + 1 }), false);
  assert.equal(screenshotContentMatches(bytes, { ...expected, sha: '0'.repeat(64) }), false);
});

test('confirms the person on shared-vehicle conflicts while holding vehicle facts for review', async () => {
  const { screenshotsSql } = await load();
  const sql = screenshotsSql([], { dryRun: false });
  assert.equal((sql.match(/public\.review_nzta_mvr_identity_evidence/g) || []).length, 1);
  assert.equal((sql.match(/public\.review_nzta_mvr_owner_evidence/g) || []).length, 3);
  assert.match(sql, /EXCEPTION WHEN OTHERS THEN\s+IF SQLERRM IN \(/);
  assert.match(sql, /v_outcome := 'owner_approved_vehicle_facts_pending'/);
  assert.match(sql, /ELSE\s+RAISE;\s+END IF;/);
});

test('parses staff-typed screenshot names and rejects impossible dates', async () => {
  const { parseScreenshotName } = await load();
  assert.deepEqual(parseScreenshotName('abc123 NZTA OFO 260901.png'), { plate: 'ABC123', client_code: 'OFO', file_date: '2026-09-01' });
  assert.equal(parseScreenshotName('ABC123 NZTA 263101.png'), null);
  assert.equal(parseScreenshotName('random photo.png'), null);
});

test('confirms the plate only when OCR agrees with the file name, allowing OCR confusions', async () => {
  const { confirmPlate } = await load();
  assert.equal(confirmPlate('ABC123', { value: 'ABC123', candidates: [] }), 'exact');
  assert.equal(confirmPlate('ABC123', { value: 'XYZ', candidates: [{ value: 'ABC123' }] }), 'exact');
  assert.equal(confirmPlate('BSO123', { value: '850123', candidates: [] }), 'ocr_confusable');
  assert.equal(confirmPlate('ABC123', { value: 'ABC124', candidates: [] }), null);
  assert.equal(confirmPlate('ABC123', null), null);
});

test('holds organisations, unread names and future query dates', async () => {
  const { classifyScreenshot } = await load();
  assert.equal(classifyScreenshot(shot()).decision, 'approve');
  assert.deepEqual(classifyScreenshot(shot({ fields: { ...shot().fields, display_name: 'Acme Rentals Limited' } })).reasons, ['registered_to_organisation']);
  assert.ok(classifyScreenshot(shot({ fields: { ...shot().fields, display_name: undefined } })).reasons.includes('name_not_read'));
  assert.ok(classifyScreenshot(shot({ fields: { ...shot().fields, query_completed_at: '2999-01-01T00:00:00' } })).reasons.includes('query_date_in_future'));
  assert.ok(classifyScreenshot(shot({ plate_verification: { value: 'ZZZ999', candidates: [] } })).reasons.includes('plate_not_confirmed_by_ocr'));
});

test('promotes only clean vehicle facts and keeps the file-name plate', async () => {
  const { approvedVehicleFields } = await load();
  const fields = approvedVehicleFields(shot({
    plate: 'ABC123',
    fields: {
      ...shot().fields,
      vin: 'JTEBR3FJ20K012345 Vehicle',
      chassis_number: 'no data Engine number',
      fuel_type: 'Diesel Last COF inspection: 06',
      vehicle_year: '20O5',
      wof_expiry: '2027-01-31',
      rego_expiry: '31/01/2027',
    },
  }));
  assert.equal(fields.plate_number, 'ABC123');
  assert.equal(fields.person_vehicle_match_confirmed, 'true');
  assert.equal(fields.vin, 'JTEBR3FJ20K012345');
  assert.equal(fields.fuel_type, 'Diesel');
  assert.equal(fields.wof_expiry, '2027-01-31');
  assert.equal('chassis_number' in fields, false);
  assert.equal('vehicle_year' in fields, false);
  assert.equal('rego_expiry' in fields, false);
  assert.equal('physical_address' in fields, false);
});

test('groups people by name and address and marks each plate latest owner', async () => {
  const { buildPlan } = await load();
  const older = shot({ sha256: '1'.repeat(64) });
  const newerSamePerson = shot({ sha256: '2'.repeat(64), fields: { ...shot().fields, query_completed_at: '2026-10-01T10:00:00' } });
  const newOwner = shot({
    sha256: '3'.repeat(64),
    fields: { ...shot().fields, display_name: 'Other Person', physical_address: '9 Elsewhere', query_completed_at: '2026-10-05T10:00:00' },
  });
  const plan = buildPlan([older, newerSamePerson, newOwner, { ...older }, { path: 'x', error: 'boom' }]);
  assert.equal(plan.summary.screenshots, 3);
  assert.equal(plan.summary.ocr_errors, 1);
  assert.equal(plan.summary.people, 2);
  const owners = plan.people.flatMap((person) => person.screenshots).filter((entry) => entry.current_owner);
  assert.deepEqual(owners.map((entry) => entry.sha256), ['3'.repeat(64)]);
});

test('apply payload runs screenshots oldest first and keeps PII out of person keys', async () => {
  const { buildPlan, applyPayload, seedPersonKey, screenshotsSql, storagePathFor } = await load();
  const plan = buildPlan([
    shot({ sha256: 'b'.repeat(64), fields: { ...shot().fields, query_completed_at: '2026-10-01T10:00:00' } }),
    shot({ sha256: 'c'.repeat(64), fields: { ...shot().fields, query_completed_at: '2025-01-01T10:00:00' } }),
  ]);
  const { people, screenshots } = applyPayload(plan);
  assert.equal(people.length, 1);
  assert.match(people[0].key_hash, /^[0-9a-f]{32}$/);
  assert.equal(people[0].key_hash, seedPersonKey(plan.people[0].key));
  assert.deepEqual(screenshots.map((entry) => entry.query_local), ['2025-01-01T10:00:00', '2026-10-01T10:00:00']);
  assert.equal(screenshots[0].file_type, 'image/png');
  assert.equal(screenshots[0].file_name.includes('Test Person'), false);
  assert.match(storagePathFor('11111111-1111-4111-8111-111111111111', 'c'.repeat(64), '.png'),
    /^org\/e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13\/identity\/f1c00000-0000-4000-8000-000000000001\/submission-11111111-1111-4111-8111-111111111111\/nzta-c{16}\.png$/);
  assert.match(screenshotsSql([], { dryRun: true }), /IF NOT EXISTS \(SELECT 1 FROM storage\.objects WHERE bucket_id = 'identity-evidence' AND name = v_path\)/);
});
