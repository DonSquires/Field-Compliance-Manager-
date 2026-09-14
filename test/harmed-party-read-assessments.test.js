const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260914100000_harmed_party_read_assessments.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');

const policies = [...migration.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)\s+FOR (\w+) TO authenticated\s+USING \(([\s\S]*?)\);/g)]
  .map(([, name, table, command, using]) => ({ name, table, command, using }));

test('harmed-party read policies are additive SELECT-only grants on the assessment tables', () => {
  assert.deepEqual(policies.map((p) => `${p.table}.${p.name}`).sort(), [
    'biosecurity_assessments.ba_protected_land_select',
    'noise_assessments.na_harmed_party_select',
    'noise_seizures.noise_seizures_follows_assessment_select',
    'smoke_assessments.sa_harmed_party_select',
  ]);
  for (const policy of policies) assert.equal(policy.command, 'SELECT', `${policy.name} must be SELECT only`);
  assert.doesNotMatch(migration, /FOR (INSERT|UPDATE|DELETE|ALL)/);
  assert.doesNotMatch(migration, /ALTER TABLE|REVOKE|GRANT|CREATE OR REPLACE FUNCTION|DROP TABLE|DROP COLUMN/);
});

test('the operator custody gate is preserved, never dropped', () => {
  for (const custodyPolicy of ['na_select', 'sa_select', 'ba_select', 'noise_seizures_select', 'noise_assessments_select', 'smoke_assessments_select', 'biosecurity_assessments_select']) {
    assert.doesNotMatch(migration, new RegExp(`DROP POLICY IF EXISTS ${custodyPolicy}\\b`));
  }
  const dropped = [...migration.matchAll(/DROP POLICY IF EXISTS (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(dropped, policies.map((p) => p.name).sort(), 'only the policies this migration creates may be dropped for idempotency');
});

test('anchors are the harmed-party columns, never the source place', () => {
  const byTable = Object.fromEntries(policies.map((p) => [p.table, p.using]));
  assert.match(byTable.noise_assessments, /has_location_access\(complainant_site_id, NULL::uuid, 'client_reads_provider'\)/);
  assert.match(byTable.smoke_assessments, /has_location_access\(complainant_site_id, NULL::uuid, 'client_reads_provider'\)/);
  assert.match(byTable.biosecurity_assessments, /has_location_access\(protected_land_site_id, NULL::uuid, 'client_reads_provider'\)/);
  for (const table of ['noise_assessments', 'smoke_assessments', 'biosecurity_assessments']) {
    assert.doesNotMatch(byTable[table], /\bsite_id\b(?!\))/, `${table} must not anchor the read on the source site_id`);
    assert.doesNotMatch(byTable[table], /location_id|organization_id/);
  }
  assert.match(byTable.noise_seizures, /FROM public\.noise_assessments na\s+WHERE na\.id = noise_seizures\.noise_assessment_id/);
});

test('live schema carries the anchor columns and guards NULL anchors in has_location_access', () => {
  for (const [table, column] of [['noise_assessments', 'complainant_site_id'], ['smoke_assessments', 'complainant_site_id'], ['biosecurity_assessments', 'protected_land_site_id'], ['noise_seizures', 'noise_assessment_id']]) {
    const definition = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`));
    assert.match(definition.slice(0, definition.indexOf('\n);')), new RegExp(`"${column}" "uuid"`), `${table}.${column} must exist live`);
  }
  const fn = schema.slice(schema.indexOf('CREATE OR REPLACE FUNCTION "public"."has_location_access"('));
  const body = fn.slice(0, fn.indexOf('$function$;'));
  assert.match(body, /p_site_id is not null and exists/);
  assert.match(body, /p_zone_id is not null and exists/);
  assert.match(body, /location\.site_id = p_site_id or location\.zone_id = p_zone_id/);
});
