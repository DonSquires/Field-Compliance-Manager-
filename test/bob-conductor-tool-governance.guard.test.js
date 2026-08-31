const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

test('registered Bob tools are policy-checked and evidence-backed before conductor dispatch', () => {
  assert.match(source, /async function prepareRegisteredToolExecution/);
  assert.match(source, /from\('bob_tool_registry'\)/);
  assert.match(source, /from\('bob_tool_tenant_policy'\)/);
  assert.match(source, /from\('bob_tool_executions'\)\.insert/);
  assert.match(source, /from\('bob_action_approvals'\)\.insert/);
  assert.match(source, /reason: 'tool_not_active'/);
  assert.match(source, /const registeredGovernance = await prepareRegisteredToolExecution/);
  assert.match(source, /if \(registeredGovernance\.blocked\)/);
  assert.match(source, /await finishRegisteredToolExecution/);
});