const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260831092000_aam_e2e_seed.sql'), 'utf8');
const runner = fs.readFileSync(path.resolve(__dirname, '../scripts/seed-aam-e2e.js'), 'utf8');
const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');

test('AAM seed is service-only, marker-scoped, and idempotently purgeable', () => {
  assert.match(sql, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(sql, /AAM dataset identity collision/);
  assert.match(sql, /external_refs->>'dataset' is distinct from 'aam_e2e_20260831'/);
  assert.match(sql, /grant execute on function public\.purge_aam_e2e_dataset[^;]+ to service_role/);
  assert.doesNotMatch(sql, /grant execute on function public\.seed_aam_e2e_dataset[^;]+ to authenticated/);
});

test('AAM seed covers every live capability class without inventing shift types', () => {
  for (const shiftType of ['day', 'swing', 'night', 'overnight', 'split']) assert.match(sql, new RegExp(`'${shiftType}'`));
  for (const operationalModule of ['access_control', 'biosecurity', 'ems', 'freedom_camping', 'noise_control', 'parking_enforcement', 'patrol', 'smoke_complaints', 'static_guarding']) assert.match(sql, new RegExp(`'${operationalModule}'`));
  assert.match(sql, /from public\.module_catalog mc where mc\.active/);
  assert.match(sql, /Exactly five AAM officers are required/);
  assert.match(sql, /public\.staff_profiles/);
  assert.match(sql, /public\.shift_templates/);
});

test('AAM readiness uses canonical agreement, boundary, commercial, and work-unit records', () => {
  for (const entity of ['service_agreements', 'service_agreement_modules', 'service_agreement_locations', 'geofence_boundary_history', 'crm_commercial_settings', 'roster_work_units']) assert.match(sql, new RegExp(`public\\.${entity}`));
  assert.match(sql, /boundary_verification/);
  assert.match(sql, /AAM E2E synthetic commercial readiness/);
});

test('AAM runner creates marked auth identities and exercises governed human workflows', () => {
  assert.match(runner, /user_metadata: \{ dataset: DATASET \}/);
  for (const rpc of ['seed_aam_e2e_dataset', 'manage_crm_onboarding_workflow', 'activate_crm_account', 'create_roster_slot', 'materialize_roster_slot', 'create_roster_shift', 'manage_crm_activation_handoff_task']) assert.match(runner, new RegExp(`['"]${rpc}['"]`));
  assert.match(runner, /passwordFor/);
  assert.match(runner, /sameValues\(templateTypes, SHIFT_TYPES\)/);
  assert.match(runner, /targetsSiteAndZone/);
  assert.match(runner, /officerClient\.auth\.signInWithPassword/);
  assert.doesNotMatch(runner, /console\.log\([^)]*password/i);
});

test('canonical schema includes the service-only AAM seed contract', () => {
  assert.match(schema, /CREATE (OR REPLACE )?FUNCTION "public"\."seed_aam_e2e_dataset"/);
  assert.match(schema, /CREATE (OR REPLACE )?FUNCTION "public"\."purge_aam_e2e_dataset"/);
  assert.match(schema, /GRANT EXECUTE ON FUNCTION "public"\."purge_aam_e2e_dataset"[^;]+ TO "service_role"/);
});