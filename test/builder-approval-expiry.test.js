const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901022000_builder_approval_expiry.sql'), 'utf8');

test('Builder approvals expire without allowing stale evidence decisions', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT \(now\(\) \+ interval '7 days'\)/);
  assert.match(migration, /builder_approvals_pending_expiry/);
  const expiryChecks = migration.match(/Approval has expired and requires a new evidence review/g) ?? [];
  assert.equal(expiryChecks.length, 2);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_decide_approval/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_decide_human_code_review/);
});