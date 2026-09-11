const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/generate-bob-document-output/index.ts'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20260911101000_bob_generated_output_pdf_metadata.sql'), 'utf8');

test('PDF output records retain MIME type and renderer version', () => {
  assert.match(worker, /RENDERER_VERSION/);
  assert.match(worker, /mime_type: 'application\/pdf'/);
  assert.match(worker, /renderer_version: RENDERER_VERSION/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS mime_type/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS renderer_version/);
});
