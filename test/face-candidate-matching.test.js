const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260907002900_face_candidate_matching.sql'),
  'utf8',
);

 test('face completion stores ranked visual candidates without auto-assignment', () => {
  assert.match(migration, /face_embedding_cosine/);
  assert.match(migration, /LIMIT 5/);
  assert.match(migration, /'similarity'/);
  assert.match(migration, /'reference_thumbnail'/);
  assert.match(migration, /'candidates', candidate_list/);
  assert.match(migration, /'original_thumbnail'/);
  assert.match(migration, /'manual_review_required'/);
  assert.doesNotMatch(migration, /candidate_person_record_id/);
});
