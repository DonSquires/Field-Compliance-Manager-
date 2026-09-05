const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905003900_organization_branch_department_hierarchy.sql'), 'utf8');

test('branch and department children preserve organization hierarchy boundaries', () => {
  assert.match(migration, /'branch', 'department', 'client'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.manage_crm_organization_child/);
  assert.match(migration, /A branch must belong to a provider organization or branch/);
  assert.match(migration, /A department must belong to a client organization or department/);
  assert.match(migration, /A client organization must belong to a provider organization or branch/);
  assert.match(migration, /public\.is_admin_for_org\(v_parent\.id\)/);
});