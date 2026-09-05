const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260905003600_commercial_pricing_bureau_foundation.sql'),
  'utf8',
);

test('the commercial pricing bureau stays provider-governed and operationally inert', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.commercial_discount_schedules/);
  assert.match(migration, /provider_organization_id uuid NOT NULL REFERENCES public\.organizations/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.quote_commercial_snapshots/);
  assert.match(migration, /quote_id uuid NOT NULL UNIQUE REFERENCES public\.quotes/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.commercial_discount_schedules, public\.commercial_discount_schedule_rules, public\.quote_commercial_snapshots FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /Only draft discount schedules can be changed/);
  assert.match(migration, /A discount rule can target a Site or Zone, not both/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.manage_commercial_discount_schedule/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS tender_id uuid REFERENCES public\.tenders/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.manage_crm_quote_commercial_source/);
  assert.match(migration, /Commercial sources can only be changed on a draft quote/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.capture_accepted_quote_commercial_snapshot/);
  assert.match(migration, /if new\.status = 'accepted' and new\.service_agreement_id is not null and old\.status is distinct from 'accepted' then/);
  assert.match(migration, /CREATE TRIGGER trg_prevent_quote_commercial_snapshot_mutation/);
  assert.doesNotMatch(migration, /insert into public\.service_agreement_modules/);
  assert.doesNotMatch(migration, /insert into public\.service_agreement_locations/);
});