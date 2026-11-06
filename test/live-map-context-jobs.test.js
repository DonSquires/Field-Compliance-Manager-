const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'apps/web/src/pages/LiveMapPage.tsx'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');

test('live map open-job statuses are all valid dispatch_jobs statuses', () => {
  const check = schema.match(/dispatch_jobs_status_check" CHECK \(status = ANY \(ARRAY\[([^\]]+)\]/);
  assert.ok(check, 'dispatch_jobs status check constraint not found');
  const allowed = [...check[1].matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
  const list = page.match(/const ACTIVE_JOB_STATUSES = \[([^\]]+)\]/);
  assert.ok(list, 'ACTIVE_JOB_STATUSES not found');
  const used = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  for (const status of used) assert.ok(allowed.includes(status), `${status} is not a dispatch_jobs status`);
  assert.ok(used.includes('pending_approval'), 'jobs awaiting approval must stay visible');
  assert.ok(!used.includes('completed') && !used.includes('cancelled'), 'closed jobs are not open work');
});

test('live map open jobs honour the selected agreement zones like the overview counts', () => {
  assert.match(page, /if \(zoneIds\) jobsQuery = jobsQuery\.in\('zone_id', zoneIds\)/);
});
