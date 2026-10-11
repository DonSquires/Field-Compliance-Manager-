const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const atlas = readFileSync(resolve(__dirname, '../supabase/functions/bob-query-atlas/index.ts'), 'utf8');
const conductor = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');

test('Bob can paginate every Atlas inventory surface without losing result windows', () => {
  assert.match(atlas, /const offset = Math\.min\(Math\.max\(Number\(body\.offset/);
  assert.match(atlas, /\.range\(offset, offset \+ limit - 1\)/g);
  assert.match(atlas, /next_offset:/g);
  assert.match(conductor, /const initialOffset = Math\.max\(typeof toolArgs\.offset/);
  assert.doesNotMatch(conductor, /results\.slice\(0, 50\)/);
  assert.match(conductor, /continue from offset/);
  assert.match(caddie, /no next_offset remains/);
});

test('gap and expectation requests scan bounded pages before claiming a result', () => {
  assert.match(conductor, /const scanAll = action === 'gap_report' \|\| action === 'expectation_report'/);
  assert.match(conductor, /const maxScanRows = scanAll \? 2000 : requestedLimit/);
  assert.match(conductor, /complete bounded scan/);
  assert.match(conductor, /partial bounded scan/);
  assert.doesNotMatch(conductor, /I found \$\{results\.length\} Atlas gaps in this page/);
});