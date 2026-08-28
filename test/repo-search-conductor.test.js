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