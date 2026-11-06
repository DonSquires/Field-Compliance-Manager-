const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261107150000_identity_registry_setwise_nzta_masking.sql'),
  'utf8',
);
const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.get_identity_registry(');
const registry = migration.slice(start, migration.indexOf('$function$;', start));

test('registry keeps its administrator gate and response contract', () => {
  assert.ok(start >= 0);
  assert.match(registry, /IF v_uid IS NULL OR NOT public\.is_admin_for_org\(p_organization_id\) THEN/);
  for (const key of ["'people'", "'vehicle_total'", "'vehicles'", "'documents'", "'nzta_restricted', true", "'nzta_restricted', false"]) {
    assert.ok(registry.includes(key), key);
  }
});

test('NZTA masking is resolved set-wise instead of one helper call per document', () => {
  assert.doesNotMatch(registry, /public\.nzta_document_restricted\(/);
  assert.match(registry, /WHERE public\.can_access_vehicle_owner_identity\(scope\.organization_id\);/);
  assert.match(registry, /nzta_check\.organization_id = ANY\(coalesce\(v_owner_access_orgs, ARRAY\[\]::uuid\[\]\)\)/);
  for (const subject of ['vehicle', 'person']) {
    assert.match(registry, new RegExp(`reveal\\.subject_type = '${subject}'[\\s\\S]*?reveal\\.actor_user_id|reveal\\.actor_user_id = v_uid[\\s\\S]*?reveal\\.subject_type = '${subject}'`));
  }
  assert.equal((registry.match(/reveal\.expires_at > clock_timestamp\(\)/g) || []).length, 2);
});

test('per-row lookups gain supporting indexes', () => {
  assert.match(migration, /CREATE INDEX IF NOT EXISTS person_identity_documents_person_record_idx\s+ON public\.person_identity_documents \(person_record_id\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS evidence_items_observation_link_idx\s+ON public\.evidence_items \(organization_id, \(metadata->>'observation_id'\)\);/);
});

test('execute stays limited to signed-in callers and the service role', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_identity_registry\(uuid, text, integer\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_identity_registry\(uuid, text, integer\) TO authenticated, service_role;/);
  assert.doesNotMatch(migration, /TO anon/);
});
