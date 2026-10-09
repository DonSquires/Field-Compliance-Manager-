const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const migration = readFileSync(resolve(__dirname, '../supabase/migrations/20261009110000_patrol_stop_billing.sql'), 'utf8');

test('patrol billing is idempotent per completed contracted stop', () => {
  assert.ok(migration.includes('shift_stop_id uuid NOT NULL UNIQUE REFERENCES public.shift_stops(id)'));
  assert.ok(migration.includes("NULL, NULL, NULL, 'per_visit'"));
  assert.ok(migration.includes("status IN ('ready', 'unresolved_rate', 'unresolved_agreement', 'waived_sla', 'invoiced')"));
  assert.ok(migration.includes('ON CONFLICT (shift_stop_id) DO UPDATE'));
  assert.ok(migration.includes('invoice_line_item_id IS NULL'));
});

test('patrol SLA discounts are explicit, bounded, admin-managed and audited', () => {
  assert.match(migration, /module_key = 'patrol'/);
  assert.match(migration, /discount_pct BETWEEN 0 AND 1/);
  assert.match(migration, /over_by_minutes_max.*over_by_minutes_min/s);
  assert.match(migration, /overlaps an active patrol discount band/);
  assert.match(migration, /is_admin_for_org\(p_organization_id\)/);
  assert.match(migration, /patrol_sla_discount_band_managed/);
});

test('late patrol discounts use actual arrival, keep unpriced lines out of invoices, and waive only at 100%', () => {
  assert.ok(migration.includes('IF v_stop.actual_arrived_at > v_stop.sla_arrive_by THEN'));
  assert.ok(migration.includes('v_stop.actual_arrived_at - v_stop.sla_arrive_by'));
  assert.ok(migration.includes("CASE WHEN v_discount = 1 THEN 'waived_sla' ELSE 'ready' END"));
  assert.ok(migration.includes('completed patrol visit(s) need a per-visit rate before this invoice can be created'));
  assert.ok(migration.includes("AND line.status = 'ready' AND line.invoice_line_item_id IS NULL"));
  assert.ok(migration.includes("status = 'invoiced'"));
  assert.ok(migration.includes("billing_review_required', v_billing_failed OR coalesce(v_charge.status IN ('unresolved_rate', 'unresolved_agreement'), false)"));
  assert.ok(!migration.includes("'billing_amount'"), 'officer receipts must not expose customer charges');
});

test('patrol travel is not charged by this migration', () => {
  assert.doesNotMatch(migration, /compute_travel_distance_km|Travel to place|rate_type.*per_km/);
});