const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260909030000_cctv_identity_draft_review.sql'), 'utf8');

test('CCTV identity drafts keep AI suggestions provisional and require explicit human approval', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cctv_identity_drafts/);
  assert.match(migration, /authority_level.*provisional.*draft.*approved/);
  assert.match(migration, /candidate_matches jsonb NOT NULL DEFAULT '\[]'::jsonb/);
  assert.match(migration, /status text NOT NULL CHECK \(status IN \('proposed', 'draft', 'approved', 'relocated', 'rejected', 'unresolved', 'escalated'\)\)/);
  assert.match(migration, /record_cctv_identity_draft/);
  assert.match(migration, /approve_cctv_identity_draft/);
  assert.match(migration, /p_final_action.*approve_draft.*create_new_record.*match_existing.*reject.*relocate.*manual_review/);
  assert.match(migration, /status = 'draft'/);
  assert.match(migration, /authority_level = 'draft'/);
});
