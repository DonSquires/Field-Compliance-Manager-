const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260914002000_link_operational_records_to_canonical_vehicles.sql'),
  'utf8',
);
const webRule = fs.readFileSync(path.join(root, 'apps/web/src/lib/canonicalIdentity.ts'), 'utf8');
const scanRule = fs.readFileSync(path.join(root, 'supabase/functions/process-officer-scan/index.ts'), 'utf8');

test('canonical vehicle resolver links observations and parking records by normalized plate', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.normalize_plate_number\(p_plate text\)/);
  assert.match(migration, /left\(upper\(regexp_replace\(coalesce\(p_plate, ''\), '\[\^A-Za-z0-9\]', '', 'g'\)\), 10\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS canonical_vehicle_id uuid REFERENCES public\.canonical_vehicles\(id\) ON DELETE SET NULL/);
  assert.match(migration, /TG_TABLE_NAME = 'parking_chalk_records'/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF plate\s+ON public\.parking_chalk_records/);
  assert.match(migration, /SET canonical_vehicle_id = cv\.id[\s\S]*WHERE o\.canonical_vehicle_id IS NULL/);
  assert.match(migration, /SET canonical_vehicle_id = cv\.id[\s\S]*WHERE p\.canonical_vehicle_id IS NULL/);
});

test('backfill never touches frozen observation fact fields', () => {
  const backfill = migration.slice(migration.indexOf('UPDATE public.observations o'));
  const setClauses = [...backfill.matchAll(/\bSET\b([\s\S]*?)\bFROM\b/g)].map((match) => match[1]);
  assert.ok(setClauses.length >= 2, 'expected observation and parking backfill SET clauses');
  for (const clause of setClauses) {
    assert.match(clause.trim(), /^canonical_vehicle_id = cv\.id$/);
  }
});

test('plate identity rule matches across database, web, and scan pipeline', () => {
  assert.match(webRule, /\.toUpperCase\(\)\s*\.replace\(\/\[\^A-Z0-9\]\/g, ''\)/);
  assert.match(scanRule, /toUpperCase\(\)\.replace\(\/\[\^A-Z0-9\]\/g, ''\)\.slice\(0, 10\)/);
  assert.match(migration, /'\[\^A-Za-z0-9\]', '', 'g'\)\), 10\)/);
});
