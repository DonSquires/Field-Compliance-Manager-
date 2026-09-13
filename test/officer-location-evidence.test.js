const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913150000_add_physical_address_to_officer_gps_evidence.sql'), 'utf8');
const timelineMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913151000_include_physical_address_in_officer_timeline.sql'), 'utf8');
const breadcrumb = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/lib/officerBreadcrumb.ts'), 'utf8');
const officerShell = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/shells/OfficerShell.tsx'), 'utf8');

test('officer GPS evidence persists reverse-resolved physical address', () => {
  assert.match(migration, /add column if not exists\s+physical_address text/i);
  assert.match(migration, /p_physical_address text/);
  assert.match(migration, /physical_address\s*\)\s*VALUES/);
  assert.match(breadcrumb, /physicalAddress: string \| null/);
  assert.match(breadcrumb, /p_physical_address: event\.physicalAddress/);
  assert.match(timelineMigration, /physical_address/);
  assert.match(timelineMigration, /get_officer_activity_timeline_unlogged/);
});

test('officer breadcrumb capture resolves address before sending the receipt', () => {
  assert.match(officerShell, /resolveAddressForCoordinates/);
  assert.match(officerShell, /buildOfficerBreadcrumb\(position, activeShift\?\.id, address\?\.label \?\? null\)/);
});
