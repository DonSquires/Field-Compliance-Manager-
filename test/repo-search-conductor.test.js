const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Conductor validates repo_search arguments before calling GitLab', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

  assert.match(source, /action !== 'search' && action !== 'read'/);
  assert.match(source, /query is required/);
  assert.match(source, /query\.length > 200/);
  assert.match(source, /path is required/);
  assert.match(source, /outcome: 'invalid_args'/);
});

test('Conductor exposes the repository catalogue and forwards the selected source', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
  const catalogue = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');

  assert.match(source, /action !== 'catalog'/);
  assert.match(source, /repository: args\.repository/);
  assert.match(source, /Repository catalogue/);
  assert.match(catalogue, /legacy_gitlab/);
  assert.match(catalogue, /active_github/);
  assert.match(catalogue, /bob_gitea/);
});

test('Conductor enables bounded read-only search chaining by default', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

  assert.match(source, /const BOB_LOOP_ENABLED = Deno\.env\.get\('BOB_LOOP_ENABLED'\) !== 'false'/);
  assert.match(source, /const BOB_LOOP_MAX_STEPS = Math\.max\(1, parseInt\(Deno\.env\.get\('BOB_LOOP_MAX_STEPS'\) \?\? '8'/);
  assert.match(source, /LOOP_CONTINUABLE_READ_TOOLS = new Set\(\[[\s\S]*'repo_search'/);
  assert.match(source, /if \(BOB_LOOP_ENABLED && chosenTool && LOOP_CONTINUABLE_READ_TOOLS\.has\(chosenTool\)\)/);
  assert.match(source, /if \(!LOOP_CONTINUABLE_READ_TOOLS\.has\(next\.chosenTool\)\)/);
  assert.match(source, /WRITES NEVER AUTO-CHAIN/);
});