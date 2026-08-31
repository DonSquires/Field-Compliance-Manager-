const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('conductor lifecycle uses ESM helpers compatible with Supabase Edge Runtime', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/task-lifecycle.ts'), 'utf8');
  assert.match(source, /task-persistence\.ts/);
  assert.match(source, /task-state-machine\.ts/);
  assert.doesNotMatch(source, /task-persistence\.js|task-state-machine\.js/);
});