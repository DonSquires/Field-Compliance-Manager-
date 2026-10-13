const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const controlRoom = fs.readFileSync(
  path.resolve(__dirname, '../supabase/functions/bob-builder-control-room/index.ts'),
  'utf8',
);

test('autonomous Builder admission reuses an active owner request after research enrichment', () => {
  assert.match(controlRoom, /if \(body\.autopilot === true\) \{/);
  assert.match(controlRoom, /\.eq\('autopilot_requested_by', user\.id\)/);
  assert.match(controlRoom, /\.in\('autopilot_state', \['driving', 'awaiting_human'\]\)/);
  assert.match(controlRoom, /\.eq\('title', title\)/);
  assert.match(controlRoom, /\.not\('status', 'in', '\("release_ready","deployed","failed","cancelled"\)'\)/);
});

test('manual Builder admission retains exact-brief bounded deduplication', () => {
  assert.match(controlRoom, /duplicateQuery = duplicateQuery\.eq\('task_description', taskDescription\)\.gte\('created_at', duplicateSince\)/);
});
