const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const conductor = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');

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
});
