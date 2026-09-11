const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/generate-bob-document-output/index.ts'), 'utf8');

test('generated document worker uses a real PDF renderer and private artifact path', () => {
  assert.match(source, /pdf-lib@1\.17\.1/);
  assert.match(source, /PDFDocument\.create/);
  assert.match(source, /application\/pdf/);
  assert.match(source, /org\/\$\{output\.organization_id\}\/generated/);
  assert.match(source, /crypto\.subtle\.digest\('SHA-256'/);
});

test('generated PDF remains approval and format gated', () => {
  assert.match(source, /authoring_status.*approved/);
  assert.match(source, /Only approved document versions can be rendered/);
  assert.match(source, /!\['pdf', 'print'\]\.includes\(output\.output_format\)/);
  assert.match(source, /DOCX renderer is not enabled yet/);
});
