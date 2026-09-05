const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004400_quote_proposal_work_models.sql'), 'utf8');

test('proposal work models are independent from SLA and activate only after acceptance', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS work_model text NOT NULL DEFAULT 'scheduled_patrol'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.set_crm_quote_proposal_work_model/);
  assert.match(migration, /Work model can only be changed on a draft quote/);
  assert.match(migration, /'scheduled_patrol', 'scheduled_static', 'on_demand_callout', 'inspection_or_notice', 'recurring_service'/);
  assert.match(migration, /'work_model',scope\.work_model/);
  assert.match(migration, /'work_model',module_intent\.work_model/);
  assert.doesNotMatch(migration, /insert into public\.roster_slots/);
});