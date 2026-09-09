const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'apps/web/src/pages/CCTVReviewPage.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'apps/web/src/pages/CCTVReviewPage.css'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260909134500_cctv_desktop_review_batch_metadata.sql'), 'utf8');

test('CCTV Review surfaces desktop SD-card batch metadata for grouped review', () => {
  assert.match(page, /type DesktopReviewBatch/);
  assert.match(page, /function desktopReviewBatch/);
  assert.match(page, /metadata\?\.desktop_review_batch/);
  assert.match(page, /Desktop batch/);
  assert.match(page, /clip \{batch\.clip_index\}\/\{batch\.clip_total\}/);
  assert.match(page, /clip \{selectedBatch\.clip_index\} of \{selectedBatch\.clip_total\}/);
  assert.match(page, /SD-card batch review/);
  assert.match(page, /Missing clips remain outside the current queue view/);
  assert.match(page, /selectedBatchClipIndexes/);
  assert.match(page, /Load full batch/);
  assert.match(page, /setBatchJobs\(mappedJobs\)/);
  assert.match(styles, /\.cctv-batch-link/);
  assert.match(styles, /\.cctv-batch-clip-list/);
  assert.match(styles, /\.is-missing/);
  assert.match(migration, /desktop_review_batch/);
  assert.match(migration, /attachment\.extraction_payload->'desktop_review_batch'/);
});
