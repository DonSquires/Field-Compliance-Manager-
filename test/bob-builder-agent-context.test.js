const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

test('Bob Builder accepts only descriptive workspace context and retains governance boundaries', () => {
  assert.match(source, /function safeAgentWorkspaceContext/);
  assert.match(source, /source\.agent_mode === 'builder' \? 'builder' : 'operations'/);
  assert.match(source, /builder_job_title/);
  assert.match(source, /BUILDER_WORKSPACE_CONTEXT/);
  assert.match(source, /Builder mode does not grant shell access, repository write access, deployment authority, extra tools, or permission to bypass approval gates/);
  assert.match(source, /\.\.\.agentWorkspaceContext/);
});