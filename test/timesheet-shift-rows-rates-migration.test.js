'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../supabase/migrations/20261111120000_timesheet_shift_rows_rates.sql');
const squash = (text) => text.replace(/\s+/g, ' ');

test('shift hour rows resolve hourly pay and charge rates from the rate rules', () => {
  const sql = squash(fs.readFileSync(file, 'utf8'));
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_timesheet_shift_rows\(p_organization_id uuid, p_from date, p_to date, p_staff_id uuid DEFAULT NULL::uuid\)/);
  assert.match(sql, /resolve_rate_rule\(p_organization_id, 'pay', s\.scheduled_start, s\.service_type, NULL, s\.module_key, sa\.client_organization_id, sal\.site_id, coalesce\(s\.zone_id, sal\.zone_id\), sp\.role_code, NULL, NULL, 'hourly'\)/);
  assert.match(sql, /resolve_rate_rule\(p_organization_id, 'billing', s\.scheduled_start, s\.service_type, NULL, s\.module_key, sa\.client_organization_id, sal\.site_id, coalesce\(s\.zone_id, sal\.zone_id\), NULL, NULL, NULL, 'hourly'\)/);
  assert.match(sql, /LEFT JOIN public\.service_agreement_locations sal ON sal\.id ?= ?s\.service_agreement_location_id/);
  assert.match(sql, /LEFT JOIN public\.service_agreements sa ON sa\.id ?= ?sal\.service_agreement_id/);
});

test('rates are returned only to organisation administrators', () => {
  const sql = squash(fs.readFileSync(file, 'utf8'));
  assert.match(sql, /v_rates_visible boolean := public\.is_admin_for_org\(p_organization_id\)/);
  assert.match(sql, /LEFT JOIN LATERAL public\.resolve_rate_rule\(p_organization_id, 'pay', [^;]*?'hourly'\) pay ON v_rates_visible/);
  assert.match(sql, /LEFT JOIN LATERAL public\.resolve_rate_rule\(p_organization_id, 'billing', [^;]*?'hourly'\) bill ON v_rates_visible/);
  assert.match(sql, /AND \(v_rates_visible OR public\.user_can_exercise_branch_authority\(/);
  assert.match(sql, /\|\| CASE WHEN v_rates_visible THEN jsonb_build_object\('pay_rate', ?pay_rate, ?'charge_rate', ?charge_rate\) ELSE '\{\}'::jsonb END/);
});

test('existing review authority and grants are preserved', () => {
  const sql = squash(fs.readFileSync(file, 'utf8'));
  assert.match(sql, /RAISE EXCEPTION 'Timesheet review authority required' USING ERRCODE='42501'/);
  assert.match(sql, /'timesheet_local_review'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_timesheet_shift_rows\(uuid, date, date, uuid\) FROM PUBLIC, anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_timesheet_shift_rows\(uuid, date, date, uuid\) TO authenticated, service_role/);
});
