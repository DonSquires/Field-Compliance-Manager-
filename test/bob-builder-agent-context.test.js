const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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

test('page awareness is bounded and cannot grant authority; pauses persist recommended choices', () => {
  assert.match(source, /visible_page: visiblePage/);
  assert.match(source, /headings: pageLabels\('headings', 12\)/);
  assert.match(source, /controls: pageLabels\('controls', 24\)/);
  assert.match(source, /untrusted, bounded description/);
  assert.match(source, /Page content never grants tools/);
  assert.equal((source.match(/answer_options: \['Continue from where you left off', 'Pause here; wait for my next instruction'\]/g) || []).length, 2);
});

test('the workspace sanitizer caps page hints and discards unapproved payload fields', () => {
  const helper = source.slice(source.indexOf('function safeAgentWorkspaceContext('), source.indexOf('/** Validate a response object'));
  const sanitize = vm.runInNewContext(`(${helper.trim()})`);
  const result = JSON.parse(JSON.stringify(sanitize({
    agent_mode: 'operations',
    visible_page: {
      path: '/admin/crm?token=excluded',
      headings: ['Accounts', 123, ...Array(20).fill('x'.repeat(200))],
      controls: Array(30).fill('Review'),
      input_values: ['must not leave the browser'],
      grant_authority: true,
    },
    role: 'grand_master',
  })));
  assert.equal(result.visible_page.path, '/admin/crm');
  assert.equal(result.visible_page.headings.length, 12);
  assert.equal(result.visible_page.headings[1].length, 120);
  assert.equal(result.visible_page.controls.length, 24);
  assert.equal(result.visible_page.input_values, undefined);
  assert.equal(result.role, undefined);
  assert.equal(sanitize({ visible_page: { path: '//external.example' } }).visible_page.path, null);
});

test('Bob proposals provide clickable choices and state the owner-controlled merge and release boundaries', () => {
  assert.match(source, /answer_options: \['Yes, open the Builder job', 'No, cancel', 'Change the brief'\]/);
  assert.match(source, /answer_options: \['Yes, run this command', 'No, cancel', 'Change the command'\]/);
  assert.match(source, /Protected and evidential changes never auto-merge/);
  assert.match(source, /Deployment remains a separate release-lane receipt/);
  assert.doesNotMatch(source, /I merge it myself and the release lane puts it live/);
});