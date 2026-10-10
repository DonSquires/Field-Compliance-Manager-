import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.resolve(
    __dirname,
    '../supabase/migrations/20261010192429_human_authored_subject_observations.sql',
  ),
  'utf8',
);

test('person observations do not require fabricated vehicle or officer values', () => {
  assert.match(migration, /ALTER COLUMN officer_id DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN plate_number DROP NOT NULL/);
  assert.match(migration, /subject_kind IN \('vehicle', 'person', 'mixed', 'place', 'other'\)/);
  assert.doesNotMatch(migration, /NO-PLATE|UNKNOWN-PLATE|N\/A-PLATE/);
});

test('human-authored notice import preserves governed provenance', () => {
  assert.match(migration, /p_source_reference text/);
  assert.match(migration, /p_source_sha256 text/);
  assert.match(migration, /p_source_locator text/);
  assert.match(migration, /'human_authored_source'/);
  assert.match(migration, /'manual_review_required'/);
  assert.match(migration, /'enforcement_authority_inferred', false/);
});

test('notice and observation imports are tenant-scoped and replay safe', () => {
  assert.match(migration, /org_access_allowed\(p_organization_id\)/);
  assert.match(migration, /FROM public\.location_zones z/);
  assert.doesNotMatch(migration, /FROM public\.zones z/);
  assert.match(migration, /notices_org_import_key_unique/);
  assert.match(migration, /observations_org_import_key_unique/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /'inserted', false/);
});

test('trespass imports create linked person, observation, notice, and audit records', () => {
  assert.match(migration, /INSERT INTO public\.person_records/);
  assert.match(migration, /ensure_canonical_person_for_record/);
  assert.match(migration, /INSERT INTO public\.observations/);
  assert.match(migration, /INSERT INTO public\.notices/);
  assert.match(migration, /human_authored_trespass_notice_imported/);
});
