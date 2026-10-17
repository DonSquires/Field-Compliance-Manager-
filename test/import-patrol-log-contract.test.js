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

test('patrol imports preserve source and derivative provenance without storing an absolute path', () => {
  assert.match(importer, /const sourceLabel = flag\('--source-label'\)/);
  assert.match(importer, /const sourceHash = flag\('--source-hash'\)/);
  assert.match(importer, /source_sheet: sourceSheet \|\| null/);
  assert.match(importer, /source_row: sourceFirstRow \+ rowIndex/);
  assert.match(importer, /derivative_sha256: derivativeHash/);
  assert.match(importer, /--source-hash must be a SHA-256 hex digest/);
  assert.doesNotMatch(importer, /source_file:\s*csvPath/);
});

test('catalog data controls identities, mappings, and classifications', () => {
  assert.match(importer, /FROM public\.import_source_profiles/);
  assert.match(importer, /FROM public\.import_person_aliases/);
  assert.match(importer, /FROM public\.import_value_classification_rules/);
  assert.match(importer, /JOIN public\.reference_codes/);
  assert.match(importer, /classifyPatrolWork\(/);
  assert.match(importer, /if \(!Array\.isArray\(aliases\)\) throw new Error/);
  assert.doesNotMatch(importer, /const USERS\s*=/);
  assert.doesNotMatch(importer, /const PATROL_WORK_(?:SUBJECTS|ACTIVITIES)\s*=/);
});

test('narrative persistence and consequential proposals require explicit opt-in', () => {
  assert.match(importer, /args\.includes\('--include-narratives'\)/);
  assert.match(importer, /\.\.\.\(includeNarratives \? \{/);
  assert.match(importer, /comments: comments \|\| null/);
  assert.match(importer, /officer_notes: includeNarratives \? comments \|\| null : null/);
  assert.match(importer, /status: includeNarratives \?/);
  assert.match(importer, /if \(includeNarratives\) \{\s*proposalsBatch\.push/);
  assert.match(importer, /proposal_generation: includeNarratives \? 'enabled'/);
  assert.match(importer, /distance_km: importedNumber\(r\[col\.jobKms\]\)/);
});

test('imports use governed batch RPCs with linked-CLI fallback and strict dates', () => {
  assert.match(importer, /const useSupabaseCli = args\.includes\('--use-supabase-cli'\)/);
  assert.match(importer, /if \(!token && !useSupabaseCli\)/);
  assert.match(importer, /execFileSync\(process\.execPath, cliArgs/);
  assert.match(importer, /begin_patrol_import_batch/);
  assert.match(importer, /stage_patrol_import_chunk/);
  assert.match(importer, /finalize_patrol_import_batch/);
  assert.match(importer, /mode === 'apply' \? 'COMMIT;' : 'ROLLBACK;'/);
  assert.match(importer, /rmSync\(tempDir, \{ recursive: true, force: true \}\)/);
  assert.match(importer, /Number\(y\) < 2000/);
  assert.match(importer, /calendarDate\.getUTCFullYear\(\) !== Number\(y\)/);
});