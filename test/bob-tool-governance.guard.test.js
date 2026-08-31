const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-tool-governance/index.ts'), 'utf8');

test('Bob tool governance is authenticated, admin-scoped, and never executes registered endpoints', () => {
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /isAdminTier\(role\)/);
  assert.match(source, /organization_id: organizationId/);
  assert.match(source, /from\('bob_tool_tenant_policy'\)\.upsert/);
  assert.match(source, /from\('bob_action_approvals'\)\.update/);
  assert.match(source, /action === 'diagnostics'/);
  assert.match(source, /count: 'exact', head: true/);
  assert.match(source, /actor_user_id: user\.id/);
  assert.match(source, /target_table: targetTable/);
  assert.match(source, /bob_tool_governance\.policy_saved/);
  assert.match(source, /bob_tool_governance\.approval_requested/);
  assert.match(source, /void audit\('bob_tool_governance\.policy_saved'/);
  assert.match(source, /Read-only tools cannot require action approval/);
  assert.match(source, /action === 'request-approval'/);
  assert.match(source, /decision_reason: 'manual_governance_approval_request'/);
  assert.match(source, /input_payload: \{ input_fields: inputFields \}/);
  assert.match(source, /organization_id: organizationId/);
  assert.match(source, /\.in\('status', \['pending', 'approved'\]\)/);
  assert.match(source, /const actionableApprovals/);
  assert.match(source, /approval\.status === 'pending' \|\| !executionById\.get\(approval\.tool_execution_id\)\?\.ok/);
  assert.match(source, /function safeApproval/);
  assert.match(source, /input_fields: Object\.keys\(input\)/);
  assert.doesNotMatch(source, /proposed_action: approval\.proposed_action/);
  assert.doesNotMatch(source, /fetch\(.*endpoint_url/s);
});