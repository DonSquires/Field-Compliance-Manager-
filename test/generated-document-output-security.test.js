const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/generate-bob-document-output/index.ts'), 'utf8');

test('generated document outputs sanitize active content before PDF rendering', () => {
  assert.match(source, /ALLOWED_TAGS/);
  assert.match(source, /script\|style\|iframe\|object\|embed/);
  assert.match(source, /javascript\|vbscript\|data/);
  assert.match(source, /htmlToLines/);
});

test('generated document output remains approval-gated', () => {
  assert.match(source, /authoring_status.*approved/);
  assert.match(source, /Only approved document versions can be rendered/);
  assert.match(source, /!\['pdf', 'print', 'docx'\]\.includes\(output\.output_format\)/);
});
