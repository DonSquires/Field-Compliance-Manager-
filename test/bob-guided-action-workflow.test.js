import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const conductor = fs.readFileSync('supabase/functions/onspace-ai-chat/index.ts', 'utf8');
const panel = fs.readFileSync('apps/web/src/components/BobPanel.tsx', 'utf8');
const approvals = fs.readFileSync('apps/web/src/pages/ApprovalsActivityPage.tsx', 'utf8');

test('Bob proposals include a visible guided workflow and exact review destination', () => {
  assert.match(conductor, /function attachGuidedProposalWorkflow\(meta\)/);
  assert.match(conductor, /\/admin\/approvals\?actionId=\$\{encodeURIComponent\(firstId\)\}&source=bob/);
  assert.match(conductor, /label: 'Human review'[\s\S]*status: 'current'/);
  assert.match(conductor, /label: 'Apply and verify'[\s\S]*status: 'pending'/);
  assert.match(panel, /<WorkflowProgress message=\{m\} \/>/);
  assert.match(panel, /aria-label="Bob workflow progress"/);
});

test('the approval workbench selects the requested action and preserves the authority check', () => {
  assert.match(approvals, /searchParams\.get\('actionId'\)/);
  assert.match(approvals, /row\.id === requestedActionId/);
  assert.match(approvals, /selected\.can_decide/);
  assert.match(approvals, /functions\.invoke\('bob-proposal-approver'/);
});
