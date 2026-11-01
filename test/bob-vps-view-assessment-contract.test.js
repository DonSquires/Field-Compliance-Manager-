const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../supabase/functions/bob-vps-view/index.ts'), 'utf8');

test('Bob assessment relay uses the deployed control-plane configuration and verifies human callers', () => {
  assert.match(source, /STACK_RELAY_BASE_URL/);
  assert.match(source, /BOB_CONTROL_PLANE_URL/);
  assert.match(source, /STACK_RELAY_TOKEN/);
  assert.match(source, /BOB_ADMIN_TOKEN/);
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /profile\.role === 'grand_master'/);
  assert.match(source, /ep === '\/assessment'/);
  assert.match(source, /relayVpsRead\(\{ path, stackBase: STACK_BASE, stackToken: STACK_TOKEN, controlBase: CONTROL_BASE, controlToken: CONTROL_TOKEN \}\)/);
  assert.doesNotMatch(source, /deprecated_endpoint/);
});