const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const importer = readFileSync(resolve(__dirname, '../scripts/import-patrol-log.mjs'), 'utf8');

test('patrol imports collapse duplicate external references before chunking', () => {
  assert.match(importer, /const seenExternalRefs = new Set\(\)/);
  assert.match(importer, /if \(seenExternalRefs\.has\(externalRef\)\)/);
  assert.match(importer, /skippedDuplicate \+= 1/);
  assert.match(importer, /skipped: duplicate external reference/);
  assert.ok(importer.indexOf('seenExternalRefs.has(externalRef)') < importer.indexOf('eventsBatch.push'));
});

test('patrol imports preserve optional source-file provenance without storing an absolute path', () => {
  assert.match(importer, /const sourceLabel = flag\('--source-label'\)/);
  assert.match(importer, /const sourceHash = flag\('--source-hash'\)/);
  assert.match(importer, /source_sheet: sourceSheet \|\| null/);
  assert.match(importer, /source_row: sourceSheet \? sourceFirstRow \+ rowIndex : null/);
  assert.match(importer, /--source-hash must be a SHA-256 hex digest/);
  assert.doesNotMatch(importer, /source_file:\s*csvPath/);
});