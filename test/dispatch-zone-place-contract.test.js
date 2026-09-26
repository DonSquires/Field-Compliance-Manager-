const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const migration = readFileSync(resolve(__dirname, '../supabase/migrations/20260927050000_dispatch_jobs_site_or_zone.sql'), 'utf8');
const routeGuidance = readFileSync(resolve(__dirname, '../supabase/functions/officer-route-guidance/index.ts'), 'utf8');

test('dispatch jobs require exactly one governed Site or Zone', () => {
  assert.match(migration, /ADD COLUMN zone_id uuid REFERENCES public\.location_zones\(id\)/);
  assert.match(migration, /CHECK \(num_nonnulls\(client_site_id, zone_id\) = 1\)/);
  assert.match(migration, /create_dispatch_job_for_place/);
  assert.match(migration, /Place is not active under this service agreement/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_dispatch_job\(/);
  assert.match(migration, /FROM public\.create_dispatch_job_for_place\(/);
});

test('Zone context reaches alarm provenance and completion pricing', () => {
  assert.match(migration, /SELECT zone\.name INTO v_place_name/);
  assert.match(migration, /st_y\(zone\.center_point\), st_x\(zone\.center_point\)/);
  assert.match(migration, /v_job\.client_site_id, v_job\.zone_id/);
  assert.match(migration, /haversine_dispatch_origin_to_zone/);
});

test('route guidance resolves Zone jobs and Zone patrol stops', () => {
  assert.match(routeGuidance, /zone:zone_id\(name, center_point\)/);
  assert.match(routeGuidance, /zone:zone_id\(center_point\)/);
  assert.match(routeGuidance, /const place = assignedSite \?\? assignedZone/);
  assert.match(routeGuidance, /const place = site \?\? zone/);
});