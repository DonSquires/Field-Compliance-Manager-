const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerOfflinePackage.ts'), 'utf8');
const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260903140000_officer_offline_data_package.sql'),
  'utf8'
);

test('mobile offline package uses governed get_officer_data_package RPC', () => {
  assert.match(source, /rpc\('get_officer_data_package'/);
  assert.match(source, /p_shift_id: shiftId/);
  assert.match(source, /Data package download was not confirmed/);
});

test('mobile offline package caches downloaded package in AsyncStorage', () => {
  assert.match(source, /AsyncStorage\.setItem/);
  assert.match(source, /AsyncStorage\.getItem/);
});

test('migration defines get_officer_data_package returning scoped org package', () => {
  assert.match(migration, /create or replace function public\.get_officer_data_package/);
  assert.match(migration, /v_zones/);
  assert.match(migration, /v_matrix/);
  assert.match(migration, /v_flags/);
  assert.match(migration, /v_rules/);
  assert.match(migration, /officer_data_package_downloaded/);
});
