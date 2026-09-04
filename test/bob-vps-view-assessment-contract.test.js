const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../supabase/functions/bob-vps-view/index.ts'), 'utf8');

test('Bob assessment relay uses the deployed control-plane configuration and verifies human callers', () => {
  assert.match(source, /STACK_RELAY_BASE_URL.*BOB_CONTROL_PLANE_URL/);
  assert.match(source, /STACK_RELAY_TOKEN.*BOB_ADMIN_TOKEN/);
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /profile\.role === 'grand_master'/);
  assert.match(source, /ep === '\/assessment'/);
  assert.match(source, /normalizedBase = BASE\.replace/);
  assert.match(source, /normalizedBase}\/api\/bob/);
  assert.doesNotMatch(source, /deprecated_endpoint/);
});