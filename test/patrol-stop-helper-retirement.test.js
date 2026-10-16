const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const retirement = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261016221613_retire_legacy_patrol_stop_helpers.sql'),
  'utf8',
);
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = fs.readFileSync(
  path.join(root, 'src/types/database.ts'),
  'utf8',
);
const patrolStops = fs.readFileSync(
  path.join(root, 'apps/web/src/components/OfficerPatrolStops.tsx'),
  'utf8',
);

test('partial public patrol stop helpers are retired', () => {
  assert.match(
    retirement,
    /DROP FUNCTION IF EXISTS public\.patrol_stop_coords\(uuid\)/,
  );
  assert.match(
    retirement,
    /DROP FUNCTION IF EXISTS public\.patrol_stop_module_keys\(uuid\)/,
  );
  for (const name of ['patrol_stop_coords', 'patrol_stop_module_keys']) {
    assert.equal(
      fs.existsSync(
        path.join(root, `supabase/schemas/public/functions/${name}.sql`),
      ),
      false,
    );
    assert.doesNotMatch(
      schema,
      new RegExp(`CREATE OR REPLACE FUNCTION "public"\\."${name}"`),
    );
    assert.doesNotMatch(databaseTypes, new RegExp(`^\\s+${name}:`, 'm'));
  }
});

test('the accountable officer patrol workflow remains canonical', () => {
  assert.match(
    schema,
    /CREATE OR REPLACE FUNCTION "public"\."get_officer_patrol_stops"/,
  );
  assert.match(
    schema,
    /CREATE OR REPLACE FUNCTION "public"\."manage_officer_patrol_stop"/,
  );
  assert.match(patrolStops, /supabase\.rpc\('get_officer_patrol_stops'/);
  assert.match(patrolStops, /supabase\.rpc\('manage_officer_patrol_stop'/);
  assert.match(patrolStops, /setReceipt\(data as StopReceipt\)/);
});
