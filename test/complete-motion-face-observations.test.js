const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260907002500_record_motion_face_observations.sql'),
  'utf8'
);

test('motion completion records consolidated face candidates as manual review only', () => {
  assert.match(migration, /INSERT INTO public\.face_observations/);
  assert.match(migration, /jsonb_array_elements\(COALESCE\(p_motion_result #> '\{consolidated_events,face_events\}'/);
  assert.match(migration, /person_record_id,[\s\S]*?NULL/);
  assert.match(migration, /'cctv_video_motion_candidate'/);
  assert.match(migration, /'manual_review_required'/);
  assert.doesNotMatch(migration, /candidate_person_record_id/);
});