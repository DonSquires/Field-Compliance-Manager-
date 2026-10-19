const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const conductor = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');
const atlasRefresh = fs.readFileSync(path.join(root, 'scripts/atlas-refresh.js'), 'utf8');

test('Bob roster proposal tools are discoverable but remain draft-only', () => {
  for (const tool of ['propose_roster_fill', 'propose_roster_rollback']) {
    assert.ok(caddie.includes(`${tool}: {`));
    assert.ok(conductor.includes(`'${tool}'`));
  }
  assert.ok(caddie.includes("propose_roster_fill: 'bob-propose-roster-fill'"));
  assert.ok(caddie.includes("propose_roster_rollback: 'bob-propose-roster-rollback'"));
  assert.ok(conductor.includes("callFn('bob-propose-roster-fill'"));
  assert.ok(conductor.includes("callFn('bob-propose-roster-rollback'"));
  assert.ok(conductor.includes('a human must review and publish'));
  assert.ok(conductor.includes('ATLAS CALLS: bob-propose-roster-fill, bob-propose-roster-rollback'));
  assert.ok(atlasRefresh.includes("'supabase/functions/onspace-ai-chat/index.ts'"));
});

test('tentative roster block tool is wired end to end and stays draft-only', () => {
  const executor = fs.readFileSync(path.join(root, 'supabase/functions/bob-proposal-execute/index.ts'), 'utf8');
  const fn = fs.readFileSync(path.join(root, 'supabase/functions/bob-propose-tentative-roster-block/index.ts'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261020090000_bob_tentative_roster_block.sql'), 'utf8');
  assert.ok(caddie.includes('propose_tentative_roster_block: {'));
  assert.ok(caddie.includes("propose_tentative_roster_block: 'bob-propose-tentative-roster-block'"));
  assert.ok(conductor.includes("callFn('bob-propose-tentative-roster-block'"));
  assert.ok(conductor.includes("case 'propose_tentative_roster_block':"));
  assert.ok(conductor.match(/'propose_tentative_roster_block'/g).length >= 4);
  assert.ok(executor.includes("'apply_tentative_roster_block'"));
  assert.ok(executor.includes("admin.rpc('apply_bob_tentative_roster_block'"));
  assert.ok(fn.includes("status: 'pending'") && !fn.includes("from('roster_slots').insert"));
  assert.match(migration, /staff_id[\s\S]*null[\s\S]*'draft'/);
  assert.ok(!migration.includes("'published'"));
  assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.apply_bob_tentative_roster_block(uuid) FROM PUBLIC, anon, authenticated, service_role'));
});
