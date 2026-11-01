const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const schema = read('supabase/schema.sql');
const migrationName = '20261102180000_close_anonymous_rls_exposure.sql';
const migration = read(`supabase/migrations/${migrationName}`);
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: read(`supabase/migrations/${name}`) }));

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flat = (text) => text.replace(/\s+/g, ' ');

// A policy without a TO clause applies to PUBLIC, which includes anon.
const publicPolicies = [...schema.matchAll(/CREATE POLICY "([^"]+)" ON "public"\."([^"]+)"([\s\S]*?);\n/g)]
  .map(([, name, table, body]) => ({ name, table, body: flat(body) }))
  .filter(({ body }) => !/ TO "?\w+"?/.test(body.split(/ (?:USING|WITH CHECK) /)[0]));

const admitsAnon = ({ body }) => /(?:USING|WITH CHECK) \(true\)/.test(body) || body.includes('organization_id IS NULL) OR');

function lastStatementFor({ name, table }) {
  const tableRef = `(?:"?public"?\\.)?"?${escape(table)}"?`;
  const pattern = new RegExp(`(CREATE|ALTER) POLICY\\s+"${escape(name)}"\\s+ON\\s+${tableRef}([^;]*);`, 'gi');
  let last = null;
  for (const { name: file, sql } of migrations) {
    for (const match of sql.matchAll(pattern)) last = { file, verb: match[1].toUpperCase(), rest: flat(match[2]) };
  }
  return last;
}

test('no PUBLIC policy with a true or org-null arm survives without a later role retarget', () => {
  const exposed = publicPolicies.filter(admitsAnon);
  const unresolved = exposed
    .filter((policy) => {
      const last = lastStatementFor(policy);
      return !(last && last.verb === 'ALTER' && /^\s*TO (authenticated|service_role)\b/.test(last.rest));
    })
    .map(({ table, name }) => `${table}.${name}`);
  assert.deepEqual(unresolved, [], `retarget these PUBLIC policies away from anon: ${unresolved.join(', ')}`);
});

test('Atlas, Bob governance, audit, import, and retention policies are authenticated-only', () => {
  const authenticated = [
    ['access_presets_select', 'access_presets'],
    ['app_map_expectations_select', 'app_map_expectations'],
    ['audit_log_select', 'audit_log'],
    ['bob_app_map_edges_select', 'bob_app_map_edges'],
    ['bob_capability_map_select', 'bob_capability_map'],
    ['bob_conduct_log_insert', 'bob_conduct_log'],
    ['bob_conduct_log_select', 'bob_conduct_log'],
    ['bob_conduct_log_update', 'bob_conduct_log'],
    ['bob_knowledge_cards_select', 'bob_knowledge_cards'],
    ['bob_knowledge_cards_write', 'bob_knowledge_cards'],
    ['bob_learnings_select', 'bob_learnings'],
    ['bob_owner_rulings_select', 'bob_owner_rulings'],
    ['import_code_reference_select', 'import_code_reference'],
    ['import_code_reference_write', 'import_code_reference'],
    ['retention_policies_select', 'retention_policies'],
    ['retention_policies_write', 'retention_policies'],
    ['scv_import_batches_insert', 'scv_import_batches'],
    ['scv_import_batches_select', 'scv_import_batches'],
    ['scv_import_batches_update', 'scv_import_batches'],
    ['scv_import_rows_insert', 'scv_import_rows'],
    ['scv_import_rows_select', 'scv_import_rows'],
    ['scv_import_rows_update', 'scv_import_rows'],
    ['Admins can view audit records for their org', 'user_management_audit'],
  ];
  for (const [policy, table] of authenticated) {
    assert.ok(
      migration.includes(`ALTER POLICY "${policy}" ON public.${table} TO authenticated;`),
      `${table}.${policy} must apply to authenticated, not PUBLIC`,
    );
  }

  for (const [policy, table] of [
    ['Service role full access on invite_rate_log', 'invite_rate_log'],
    ['Service role can insert audit records', 'user_management_audit'],
  ]) {
    assert.ok(
      migration.includes(`ALTER POLICY "${policy}" ON public.${table} TO service_role;`),
      `${table}."${policy}" must apply to service_role only`,
    );
  }
});

test('a direct audit_log insert cannot forge platform rows or another actor', () => {
  const statement = flat(migration.match(/ALTER POLICY "audit_log_insert"[\s\S]*?;/)[0]);
  assert.match(statement, /ON public\.audit_log TO authenticated WITH CHECK \(/);
  assert.match(statement, /organization_id IS NOT NULL/);
  assert.match(statement, /org_access_allowed\(organization_id\)/);
  assert.match(statement, /actor_user_id = \(SELECT auth\.uid\(\)\)/);

  const clientSources = ['apps/web/src', 'apps/mobile/src']
    .flatMap((dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
      .filter((file) => /\.(tsx?|jsx?)$/.test(file))
      .map((file) => path.join(dir, file)));
  const directWriters = clientSources.filter((file) => /from\(['"]audit_log['"]\)\s*\.insert/.test(read(file)));
  assert.deepEqual(directWriters, [], 'browser and mobile clients must audit through governed RPCs or service-role functions');
});

test('only the service role can run the invite rate-limit gate', () => {
  assert.ok(
    migration.includes('REVOKE EXECUTE ON FUNCTION public.check_invite_rate_limit(uuid, uuid) FROM PUBLIC, anon, authenticated;'),
    'clients must not be able to fill another caller or organisation invite window',
  );
  assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.check_invite_rate_limit(uuid, uuid) TO service_role;'));

  const inviteOrg = read('supabase/functions/invite-org/index.ts');
  assert.match(inviteOrg, /const adminClient = createClient\(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY\)/);
  assert.match(inviteOrg, /adminClient\.rpc\('check_invite_rate_limit'/);
});
