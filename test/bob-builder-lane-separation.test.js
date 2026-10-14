const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const conductor = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const prompt = fs.readFileSync(path.join(root, 'services/fcm-api/src/bob/planPrompt.js'), 'utf8');

test('diagnostic and recommendation requests do not implicitly enter Builder', () => {
  assert.match(prompt, /Atlas scans, repository questions, diagnosis, explanations, reviews, recommendations[\s\S]*STAY in the agentic\/read lane/);
  assert.match(prompt, /Finding a defect or Atlas gap by itself is not permission to propose a job/);
  assert.match(conductor, /outcome:\s*'builder_not_requested'/);
  assert.match(conductor, /explicitly ask me to implement a code change/);
});

test('a pending Builder proposal requires an unambiguous affirmative', () => {
  assert.match(conductor, /const builderProposalDecision =/);
  assert.match(conductor, /\^\(\?:no\(\?: cancel\)\?\|cancel\|cancel it\|stop/);
  assert.match(conductor, /storedJob && proposalDecision === 'decline'/);
  assert.match(conductor, /Cancelled\. I did not open the Builder job\./);
  assert.match(conductor, /\(!storedJob \|\| proposalDecision !== 'confirm'\)/);
  assert.match(prompt, /"No, cancel"[\s\S]*are never confirmations/);
});
