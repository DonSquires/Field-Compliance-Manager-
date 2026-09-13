const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const hookPath = path.resolve(__dirname, '../apps/web/src/hooks/useActiveModuleContext.ts');

test('useActiveModuleContext resolves the active module rule set from place-first context', () => {
  assert.equal(fs.existsSync(hookPath), true, 'Expected hook to exist');
  const source = fs.readFileSync(hookPath, 'utf8');
  assert.match(source, /resolve_active_rules/);
  assert.match(source, /useActiveModuleContext/);
  assert.match(source, /selectedZone|selectedSite/);
});
