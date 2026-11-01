const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../scripts/rerun-prefix-cctv-jobs.mjs'), 'utf8');
const engineV2Scope = source.match(/const ENGINE_V2_SCOPE = `([\s\S]*?)`;/)?.[1] ?? '';

test('engine-v2 rerun scope selects only video results that engine v2 has not produced', () => {
  assert.ok(engineV2Scope, 'ENGINE_V2_SCOPE template not found');
  assert.match(engineV2Scope, /model_manifest,engine_version\}'\) IS DISTINCT FROM 'cctv-engine-v2'/);
  // Photo results never carry a classification plan, so without this exclusion every batch would re-select
  // the same stills (live canary 2026-11-01: both re-queued jobs were photos, and both stayed in scope).
  assert.match(engineV2Scope, /coalesce\(r\.result->>'media_kind', 'video'\) <> 'photo'/);
  assert.match(engineV2Scope, /ORDER BY j\.created_at DESC, j\.id/);
});
