'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261117013747_generator_reads_terms.sql'),
  'utf8',
);

test('generator migration adds place checks and keeps the internal writer private', () => {
  assert.match(migration, /ALTER TABLE public\.shift_stops\s+ADD COLUMN required_checks text\[\] NOT NULL DEFAULT '\{\}'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.generate_shift_stops_internal\(/);
  assert.match(migration, /public\.place_service_terms_at\(/);
  assert.match(migration, /public\.place_service_runs_on\(/);
  assert.match(migration, /public\.place_service_window_at\(/);
  assert.match(migration, /required_checks/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.generate_shift_stops_internal\(uuid,date,uuid\) FROM PUBLIC,anon,authenticated,service_role/);
});

if (process.env.BOB_TEST_POSTGRES === '1') require('./place-service-terms-migration.test');
