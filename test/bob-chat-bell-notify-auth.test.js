const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-chat-bell-notify/index.ts'), 'utf8');

test('Bob chat bell notifications require an exact service-role bearer token', () => {
  assert.match(source, /const isServiceRole = Boolean\(SUPABASE_SERVICE_ROLE_KEY\) && authHeader === `Bearer \$\{SUPABASE_SERVICE_ROLE_KEY\}`;\s*if \(!isServiceRole\)/);
});
