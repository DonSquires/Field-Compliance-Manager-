'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261030170000_person_search_role_gate.sql',
), 'utf8');

test('person search and notice expiry RPCs enforce the operations-role boundary', () => {
  const functions = [
    ['search_people', 'COMMENT ON FUNCTION public.search_people'],
    ['get_notice_expiry_register', 'COMMENT ON FUNCTION public.get_notice_expiry_register'],
  ];

  for (const [name, endMarker] of functions) {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const end = migration.indexOf(endMarker, start);
    assert.notEqual(start, -1, `${name} definition exists`);
    assert.notEqual(end, -1, `${name} comment follows its definition`);
    const definition = migration.slice(start, end);
    assert.match(definition, /SECURITY DEFINER/);
    assert.match(definition, /deactivated_at IS NULL\s+AND role IN \('grand_master', 'master', 'admin', 'admin_officer'\)/);
  }
});

test('preserves owner-identity access on protected person-to-vehicle relationships', () => {
  assert.match(migration, /link\.relationship NOT IN \('owner', 'registered_owner', 'driver', 'associated_person'\)\s+OR link\.organization_id = ANY \(v_identity_orgs\)/);
});

test('calculates notice days using Auckland dates for both operands', () => {
  assert.match(migration, /\(notice\.expires_at AT TIME ZONE 'Pacific\/Auckland'\)::date\s+- \(clock_timestamp\(\) AT TIME ZONE 'Pacific\/Auckland'\)::date/);
  assert.doesNotMatch(migration, /notice\.expires_at::date/);
});
