const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase', 'migrations', '20261010094927_local_document_reference_sources.sql'),
  'utf8'
);

test('local document sources use neutral worker-resolved aliases', () => {
  assert.match(migration, /'local_folder'/);
  assert.match(migration, /neutral alias resolved only by an approved worker/);
  assert.match(migration, /absolute workstation paths and credentials are never exposed/);
});
