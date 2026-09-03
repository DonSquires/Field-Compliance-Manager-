const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const research = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-web-research/index.ts'), 'utf8');

test('Bob web research passes bounded redacted source evidence to reasoning', () => {
  assert.match(source, /const evidence = sources\.slice\(0, 5\)/);
  assert.match(source, /String\(source\.excerpt \|\| ''\)\.slice\(0, 1500\)/);
  assert.match(source, /Web research returned no safe sources/);
  assert.match(source, /source_count: sources\.length/);
  assert.match(research, /excerpt: redactPII\(s\.content\)\.slice\(0, 1500\)/);
  assert.match(research, /web_research_requires_human_invocation/);
  assert.match(research, /isSafePublicUrl/);
  assert.match(source, /module_key: agentWorkspaceContext\.agent_mode/);
});