import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('a lost attachment response does not delete the uploaded evidence', async () => {
  const { attachMatchedPhoto } = await import('../scripts/import-approved-rm-vehicle-history.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-upload-'));
  try {
    const localPath = path.join(root, 'photo.jpg');
    await writeFile(localPath, 'photo bytes');
    const objects = new Map();
    const query = {
      select() { return this; },
      eq() { return this; },
      limit() { return this; },
      async maybeSingle() { return { data: null, error: null }; },
    };
    const service = { from: () => query };
    const governed = {
      storage: { from: () => ({
        async upload(key, bytes) { objects.set(key, bytes); return { error: null }; },
        async remove(keys) { keys.forEach(key => objects.delete(key)); return { error: null }; },
      }) },
      rpc: async () => ({ error: { message: 'gateway response lost' } }),
    };
    const prepared = [];
    const row = { localPath, relativePath: 'Photos/photo.jpg', organizationId: 'org-1',
      observationId: 'event-1', recordKind: 'location_event', matchType: 'event_minute',
      onPrepared: async details => { assert.equal(objects.size, 0); prepared.push(details); } };

    await assert.rejects(attachMatchedPhoto(service, governed, row), /gateway response lost/);
    assert.equal(prepared.length, 1);
    assert.match(prepared[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(objects.has(prepared[0].storage_path), true);
    assert.equal(objects.size, 1, 'the server may already have linked the uploaded object');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a concurrent duplicate uses the returned evidence record and retains the other upload for review', async () => {
  const { attachMatchedPhoto } = await import('../scripts/import-approved-rm-vehicle-history.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-duplicate-'));
  try {
    const localPath = path.join(root, 'photo.jpg');
    await writeFile(localPath, 'photo bytes');
    const objects = new Map();
    const service = { from: () => {
      const filters = new Map();
      return {
        select() { return this; },
        eq(name, value) { filters.set(name, value); return this; },
        limit() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async single() {
          return { data: { storage_path: filters.get('id') === 'canonical-evidence'
            ? 'org/canonical.jpg' : 'org/unrelated-duplicate.jpg', location_event_id: 'event-1' }, error: null };
        },
      };
    } };
    const governed = {
      storage: { from: () => ({
        async upload(key, bytes) { objects.set(key, bytes); return { error: null }; },
        async remove(keys) { keys.forEach(key => objects.delete(key)); return { error: null }; },
      }) },
      rpc: async () => ({ data: 'canonical-evidence', error: null }),
    };
    const row = { localPath, relativePath: 'Photos/photo.jpg', organizationId: 'org-1',
      observationId: 'event-1', recordKind: 'location_event', matchType: 'event_minute' };

    const outcome = await attachMatchedPhoto(service, governed, row);
    assert.equal(outcome.storage_path, 'org/canonical.jpg');
    assert.equal(outcome.retained_duplicate_upload, true);
    assert.equal(objects.size, 1, 'a concurrent writer may already reference the extra upload');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a concurrent hash match on a different event is held instead of acknowledged', async () => {
  const { attachMatchedPhoto } = await import('../scripts/import-approved-rm-vehicle-history.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'fcm-photo-other-event-'));
  try {
    const localPath = path.join(root, 'photo.jpg');
    await writeFile(localPath, 'photo bytes');
    const objects = new Map();
    const query = {
      select() { return this; },
      eq() { return this; },
      limit() { return this; },
      async maybeSingle() { return { data: null, error: null }; },
      async single() { return { data: { storage_path: 'org/other.jpg', location_event_id: 'other-event' }, error: null }; },
    };
    const service = { from: () => query };
    const governed = {
      storage: { from: () => ({
        async upload(key, bytes) { objects.set(key, bytes); return { error: null }; },
        async remove(keys) { keys.forEach(key => objects.delete(key)); return { error: null }; },
      }) },
      rpc: async () => ({ data: 'other-evidence', error: null }),
    };
    const row = { localPath, relativePath: 'Photos/photo.jpg', organizationId: 'org-1',
      observationId: 'event-1', recordKind: 'location_event', matchType: 'event_minute' };

    const outcome = await attachMatchedPhoto(service, governed, row);
    assert.equal(outcome.held, 'photo_attachment_record_mismatch');
    assert.notEqual(outcome.no_write, true);
    assert.equal(objects.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('standalone photo imports cannot apply without governed recovery and private staging', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/import-approved-rm-vehicle-history.mjs', import.meta.url)),
    '--inventory', 'unused.json', '--source-root', 'unused', '--apply',
  ], {
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', RM_PHOTO_IMPORT_ACTOR_EMAIL: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /standalone photo apply is disabled/i);
});
