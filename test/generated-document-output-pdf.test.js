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

test('generated document worker supports governed DOCX output', () => {
  assert.match(source, /fflate@0\.8\.2/);
  assert.match(source, /buildDocxBytes/);
  assert.match(source, /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  assert.match(source, /fcm-ooxml-docx-v1/);
  assert.match(source, /zipSync/);
});

test('generated outputs remain approval and format gated', () => {
  assert.match(source, /authoring_status.*approved/);
  assert.match(source, /Only approved document versions can be rendered/);
  assert.match(source, /!\['pdf', 'print', 'docx'\]\.includes\(output\.output_format\)/);
});
