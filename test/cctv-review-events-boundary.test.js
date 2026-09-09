const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20260909150000_cctv_review_events.sql'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'apps/web/src/pages/CCTVReviewPage.tsx'), 'utf8');

test('CCTV review events provide append-only human state and tenant-safe canonical links', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cctv_review_events/);
  assert.match(migration, /review_state text NOT NULL CHECK \(review_state IN \('unreviewed', 'accepted', 'rejected', 'uncertain', 'needs_more_context', 'superseded'\)\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cctv_review_event_decisions/);
  assert.match(migration, /record_cctv_review_event/);
  assert.match(migration, /Accepted person events require an explicit person record link/);
  assert.match(migration, /Accepted vehicle events require an explicit vehicle record link/);
  assert.match(migration, /organization_id = p_organization_id/);
  assert.match(migration, /INSERT INTO public\.cctv_review_event_decisions/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.record_cctv_review_event/);
  assert.match(page, /record_cctv_review_event/);
  assert.match(page, /recordObservationState/);
  assert.match(page, />Uncertain<\/button>/);
  assert.match(page, />Reject<\/button>/);
});
