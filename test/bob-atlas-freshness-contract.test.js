const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const atlas = readFileSync(resolve(__dirname, '../supabase/functions/bob-query-atlas/index.ts'), 'utf8');
const conductor = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');

test('Atlas exposes refresh evidence without claiming unrecorded source parity', () => {
  assert.match(atlas, /async function readAtlasStatus/);
  assert.match(atlas, /capability_last_refreshed_at/);
  assert.match(atlas, /edge_last_refreshed_at/);
  assert.match(atlas, /source_commit_recorded: Boolean\(sourceCommit\)/);
  assert.match(atlas, /let sourceParity = 'unknown'/);
  assert.match(atlas, /if \(action === 'status'\)/);
  assert.match(atlas, /atlas_status: atlasStatus/);
});

test('Bob checks Atlas status and warns when current-source parity is unknown', () => {
  assert.match(caddie, /Start with \(1\) status/);
  assert.match(caddie, /compare Atlas with current repo_search or assess_system evidence/);
  assert.match(conductor, /if \(action === 'status'\)/);
  assert.match(conductor, /Do not call this current when source parity is unknown/);
  assert.match(conductor, /Atlas source parity is unknown; compare this with current repo evidence/);
  assert.match(conductor, /atlas_status: atlasStatus/);
});
