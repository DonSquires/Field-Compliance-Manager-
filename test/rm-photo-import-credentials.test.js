const test = require('node:test');
const assert = require('node:assert/strict');

test('photo match preview needs scoped database access but no user password', async () => {
  const { validatePhotoImportEnvironment } = await import('../scripts/rm-photo-import-config.mjs');
  assert.doesNotThrow(() => validatePhotoImportEnvironment({
    apply: false,
    url: 'https://example.supabase.co',
    serviceRole: 'not-a-real-key',
  }));
});

test('photo apply requires an explicitly configured dedicated importer identity', async () => {
  const { validatePhotoImportEnvironment } = await import('../scripts/rm-photo-import-config.mjs');
  assert.throws(() => validatePhotoImportEnvironment({
    apply: true,
    url: 'https://example.supabase.co',
    serviceRole: 'not-a-real-key',
  }), /RM_PHOTO_IMPORT_ACTOR_EMAIL and RM_PHOTO_IMPORT_ACTOR_PASSWORD/);
  assert.doesNotThrow(() => validatePhotoImportEnvironment({
    apply: true,
    url: 'https://example.supabase.co',
    serviceRole: 'not-a-real-key',
    actorEmail: 'importer@example.invalid',
    actorPassword: 'test-only',
  }));
});