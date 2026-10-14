const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const migration = read('supabase/migrations/20261014234958_retire_crm_activity_log.sql');
const schema = read('supabase/schema.sql');
const types = read('src/types/database.ts');
const accountWorkspace = read('apps/web/src/components/CrmAccountWorkspace.tsx');
const genericFunctions = [
  'supabase/functions/bob-ingest-document/index.ts',
  'supabase/functions/bob-plan-import/index.ts',
  'supabase/functions/bob-upsert-generic/index.ts',
].map(read).join('\n');

test('legacy CRM activity retirement refuses to delete populated data', () => {
  assert.match(migration, /to_regclass\('public\.crm_activity_log'\)/);
  assert.match(migration, /SELECT EXISTS \(SELECT 1 FROM public\.crm_activity_log\)/);
  assert.match(migration, /contains rows; migrate them to crm_account_activities before retirement/);
  assert.match(migration, /DROP TABLE public\.crm_activity_log/);
  assert.doesNotMatch(migration, /CASCADE/i);
});

test('canonical CRM activity remains and stale references are removed', () => {
  assert.match(accountWorkspace, /\.from\('crm_account_activities'\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS "public"\."crm_account_activities"/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS "public"\."crm_activity_log"/);
  assert.doesNotMatch(types, /crm_activity_log:/);
  assert.doesNotMatch(genericFunctions, /crm_activity_log/);
});
