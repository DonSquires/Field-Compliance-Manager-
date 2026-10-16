const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const retirement = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261016214239_retire_unsafe_parking_number_path.sql'),
  'utf8',
);
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = fs.readFileSync(
  path.join(root, 'src/types/database.ts'),
  'utf8',
);

test('the race-prone parking number generator and empty counter island are retired', () => {
  assert.match(
    retirement,
    /DROP FUNCTION IF EXISTS public\.generate_parking_notice_number\(uuid\)/,
  );
  assert.match(retirement, /DROP TABLE IF EXISTS public\.notice_counters/);
  assert.equal(
    fs.existsSync(
      path.join(root, 'supabase/schemas/public/functions/generate_parking_notice_number.sql'),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(root, 'supabase/schemas/public/tables/notice_counters.sql'),
    ),
    false,
  );
  assert.doesNotMatch(
    schema,
    /CREATE OR REPLACE FUNCTION "public"\."generate_parking_notice_number"/,
  );
  assert.doesNotMatch(
    schema,
    /CREATE TABLE IF NOT EXISTS "public"\."notice_counters"/,
  );
  assert.doesNotMatch(databaseTypes, /^\s+generate_parking_notice_number:/m);
  assert.doesNotMatch(databaseTypes, /^\s+notice_counters:/m);
});

test('the governed module-scoped notice reservation path remains canonical', () => {
  assert.match(
    schema,
    /CREATE OR REPLACE FUNCTION "public"\."reserve_infringement_notice_number"/,
  );
  assert.match(
    schema,
    /INSERT INTO public\.infringement_notice_counters \(organization_id, module_key, last_number, prefix\)/,
  );
  assert.match(schema, /public\.org_access_allowed\(p_organization_id\)/);
});
