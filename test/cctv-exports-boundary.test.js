const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20260909160000_cctv_exports.sql'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'apps/web/src/pages/CCTVReviewPage.tsx'), 'utf8');

test('CCTV exports require accepted events and separate approval and sealing', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cctv_exports/);
  assert.match(migration, /manifest_sha256 text NOT NULL/);
  assert.match(migration, /approval_state IN \('draft', 'submitted', 'approved', 'rejected', 'sealed', 'issued'\)/);
  assert.match(migration, /Only accepted CCTV review events may be exported/);
  assert.match(migration, /create_cctv_export_draft/);
  assert.match(migration, /approve_cctv_export/);
  assert.match(migration, /seal_cctv_export/);
  assert.match(migration, /Sealed exports cannot be changed/);
  assert.match(migration, /cctv_export_sealed/);
  assert.match(page, /createExportDraft/);
  assert.match(page, /Create export draft/);
  assert.match(page, /p_selected_event_ids: acceptedEvents\.map/);
  assert.match(page, /Approval and sealing are still required/);
  assert.match(page, /transitionExport/);
  assert.match(page, /Submit for approval/);
  assert.match(page, /Approve export/);
  assert.match(page, /Seal export/);
});
