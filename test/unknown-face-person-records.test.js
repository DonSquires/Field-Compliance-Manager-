const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260907002001_unknown_face_person_records.sql'),
  'utf8',
);

test('motion completion creates editable unknown person records for face events', () => {
  assert.match(migration, /INSERT INTO public\.person_records/);
  assert.match(migration, /'Unknown Person #' \|\| face_event\.event_number/);
  assert.match(migration, /INSERT INTO public\.face_observations/);
  assert.match(migration, /created_person_id/);
  assert.match(migration, /assign_face_observation_person/);
  assert.match(migration, /SET display_name = trim\(p_display_name\)/);
  assert.match(migration, /person_record_id = p_person_record_id/);
  assert.doesNotMatch(migration, /candidate_person_record_id/);
});