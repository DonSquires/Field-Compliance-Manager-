const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const conductor = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');

test('Bob whole-build assessment stays visible through the Atlas-gated Caddie catalogue', () => {
  assert.match(conductor, /ATLAS CALLS: bob-vps-view/);
  assert.match(conductor, /callFn\('bob-vps-view\/assessment'/);
  assert.match(caddie, /assess_system: 'bob-vps-view'/);
});