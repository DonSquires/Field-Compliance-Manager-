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

test('narrative fields are opt-in and provider cost fields are not added to activity payloads', () => {
  assert.match(importer, /job: pick\('Job', 'Log No', 'Logno'\)/);
  assert.match(importer, /reg: pick\('Reg', 'Numbers'\)/);
  assert.match(importer, /args\.includes\('--include-narratives'\)/);
  assert.match(importer, /includeNarratives \? \{/);
  assert.match(importer, /comments: comments \|\| null/);
  assert.match(importer, /action_notes:/);
  assert.doesNotMatch(importer, /job_cost|travel_cost|total_cost/);
});

test('narrative mode merges into existing source-keyed records and reports updated counts', () => {
  assert.match(importer, /if coalesce\(\(v_data->>'include_narratives'\)::boolean, false\) then/i);
  assert.match(importer, /UPDATE public\.location_events[\s\S]*payload = coalesce\(payload, '\{\}'::jsonb\) \|\| coalesce\(v_evt->'payload', '\{\}'::jsonb\)/);
  assert.match(importer, /UPDATE public\.observations[\s\S]*officer_notes = coalesce\(nullif\(v_obs->>'officer_notes', ''\), officer_notes\)/);
  assert.match(importer, /observations_updated=/);
  assert.match(importer, /events_updated=/);
});