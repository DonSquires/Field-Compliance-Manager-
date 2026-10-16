const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const retirement = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261016222828_retire_legacy_repeat_stay_helper.sql'),
  'utf8',
);
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = fs.readFileSync(
  path.join(root, 'src/types/database.ts'),
  'utf8',
);
const scanPipeline = fs.readFileSync(
  path.join(root, 'supabase/functions/process-officer-scan/index.ts'),
  'utf8',
);

test('the unscoped repeat-stay helper is retired', () => {
  assert.match(
    retirement,
    /DROP FUNCTION IF EXISTS public\.check_repeat_stay\([\s\S]*?timestamp with time zone[\s\S]*?\)/,
  );
  assert.equal(
    fs.existsSync(
      path.join(root, 'supabase/schemas/public/functions/check_repeat_stay.sql'),
    ),
    false,
  );
  assert.doesNotMatch(
    schema,
    /CREATE OR REPLACE FUNCTION "public"\."check_repeat_stay"/,
  );
  assert.doesNotMatch(databaseTypes, /^\s+check_repeat_stay:/m);
});

test('the governed scan pipeline remains the canonical repeat-stay verdict path', () => {
  assert.match(
    schema,
    /CREATE OR REPLACE FUNCTION "public"\."calculate_vehicle_compliance"/,
  );
  assert.match(
    scanPipeline,
    /supabase\.rpc\('calculate_vehicle_compliance'/,
  );
  assert.match(scanPipeline, /nights_this_zone: compliance\.nights_this_zone/);
  assert.match(scanPipeline, /breach_alert_id: breachAlertId/);
});
