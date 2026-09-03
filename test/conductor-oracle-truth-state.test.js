const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const root = resolve(__dirname, '..');
const seam = readFileSync(resolve(root, 'supabase/functions/onspace-ai-chat/conductor-welfare-seam.ts'), 'utf8');
const conductor = readFileSync(resolve(root, 'supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

test('Oracle turn truth-state carries general scope and proof fields', () => {
  assert.match(seam, /turn_scope: input\.turn_scope \?\? null/);
  assert.match(seam, /proof_grade: normalizeProofGrade\(input\.proof_grade\)/);
  for (const grade of ['observed', 'inferred', 'alleged', 'determined']) {
    assert.match(seam, new RegExp(`'${grade}'`));
  }
});

test('Conductor supplies caller scope to Oracle truth-state at the enforcement seam', () => {
  assert.match(conductor, /turn_scope: \{ tier: caps\.tier, scope_org_ids: caps\.scopeOrgIds, organization_id: orgId, user_id: user\.id \}/);
  assert.match(conductor, /proof_grade: 'observed'/);
});