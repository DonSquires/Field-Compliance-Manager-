const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-voice-speak/index.ts'), 'utf8');

test('browser voice playback validates the caller JWT before proxying speech', () => {
  assert.match(source, /createClient/);
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /if \(authError \|\| !user\) return json\(\{ error: 'Unauthorized' \}, 401\)/);
  assert.match(source, /text\.slice\(0, 2000\)/);
});