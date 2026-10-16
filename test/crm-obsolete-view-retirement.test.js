const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261016110319_retire_obsolete_crm_views.sql'),
  'utf8',
);
const crmPage = fs.readFileSync(
  path.join(root, 'apps/web/src/pages/CRMPage.tsx'),
  'utf8',
);

test('obsolete CRM views are retired together', () => {
  assert.match(migration, /DROP VIEW IF EXISTS public\.crm_account_health/);
  assert.match(migration, /DROP VIEW IF EXISTS public\.crm_account_list/);
  assert.equal(
    fs.existsSync(path.join(root, 'supabase/schemas/public/views/crm_account_health.sql')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, 'supabase/schemas/public/views/crm_account_list.sql')),
    false,
  );
});

test('CRM keeps the governed provider portfolio and authoritative account reads', () => {
  assert.match(crmPage, /rpc\('get_crm_provider_portfolio'/);
  assert.match(crmPage, /\.from\('organizations'\)/);
  assert.match(crmPage, /rpc\('get_crm_organization_readiness'/);
  assert.doesNotMatch(crmPage, /crm_account_health|crm_account_list/);
});
