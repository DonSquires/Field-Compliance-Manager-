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

test('Bob Operations preserves capped page context and Studio artifact provenance without granting authority', () => {
  assert.match(source, /page: text\('page', 100\)/);
  assert.match(source, /agreement: safeEntity\(source\.agreement\)/);
  assert.match(source, /agreements: safeEntityList\('agreements'\)/);
  assert.match(source, /studio_artifact_type: source\.studio_artifact_type === 'document'/);
  assert.match(source, /agent_context: agentWorkspaceContext/);
  assert.match(source, /studio_document_kind: agentWorkspaceContext\.studio_document_kind/);
});

test('Bob proposals provide clickable choices and never claim merge or deployment authority', () => {
  assert.match(source, /answer_options: \['Yes, open the Builder job', 'No, cancel', 'Change the brief'\]/);
  assert.match(source, /answer_options: \['Yes, run this command', 'No, cancel', 'Change the command'\]/);
  assert.match(source, /Bob does not merge protected branches or deploy production/);
  assert.doesNotMatch(source, /I merge it myself and the release lane puts it live/);
});