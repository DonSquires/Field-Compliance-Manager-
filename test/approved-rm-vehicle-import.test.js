import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20261010213204_promote_approved_vehicle_mentions.sql', import.meta.url),
  'utf8',
);
const importer = readFileSync(
  new URL('../scripts/import-approved-rm-vehicle-history.mjs', import.meta.url),
  'utf8',
);
const matcher = readFileSync(
  new URL('../scripts/rm-photo-matcher.mjs', import.meta.url),
  'utf8',
);
const batchMigration = readFileSync(
  new URL('../supabase/migrations/20261010214242_batch_approved_vehicle_promotion.sql', import.meta.url),
  'utf8',
);

test('approved working-file plate mentions promote replay-safely with provenance and audit', () => {
  assert.match(migration, /event\.payload->>'source' = 'rm_patrol_log_import'/);
  assert.match(migration, /'rm_approved_note_plate:' \|\| v_candidate\.event_id/);
  assert.match(migration, /ON CONFLICT \(organization_id, import_key\)/);
  assert.match(migration, /'approved_working_file_plate_promoted'/);
  assert.match(migration, /'approved_in_working_file'/);
  assert.match(migration, /source_document_name/);
  assert.match(migration, /source_sha256/);
  assert.match(batchMigration, /LIMIT 100/);
  assert.match(batchMigration, /approved_rnm_vehicle_mentions_batch/);
  assert.doesNotMatch(importer, /promote_approved_rnm_vehicle_mentions/);
});

test('identity registry includes observation-linked canonical vehicles and evidence totals', () => {
  assert.match(migration, /observation\.canonical_vehicle_id = candidate\.id/);
  assert.match(migration, /'vehicle_total'/);
  assert.match(migration, /'observation_count'/);
  assert.match(migration, /'evidence_count'/);
  assert.match(migration, /get_identity_vehicle_activity/);
});

test('photo importer requires filename plate/date/time and holds ambiguous matches', () => {
  assert.match(matcher, /PLATE_PATTERN/);
  assert.match(importer, /parsePhotoName/);
  assert.match(importer, /exact Auckland-local date and minute plus filename rego or exact folder place alias/);
  assert.match(importer, /ambiguousMatchesHeld/);
  assert.match(importer, /attach_external_photo_to_record/);
  assert.match(importer, /createHash\('sha256'\)/);
  assert.match(importer, /local:\/\/rm\/remsec-documents\//);
});
