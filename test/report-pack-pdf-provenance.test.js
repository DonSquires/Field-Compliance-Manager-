const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.resolve(__dirname, '../supabase/functions/generate-report-pack-pdf/index.ts'),
  'utf8',
);

test('report-pack PDFs expose source snapshot provenance and scope', () => {
  assert.match(source, /Report pack ID: \$\{packId\}/);
  assert.match(source, /Source snapshot generated:/);
  assert.match(source, /Renderer: \$\{rendererVersion\}/);
  assert.match(source, /governed aggregate snapshot/);
  assert.match(source, /generated_at/);
});
