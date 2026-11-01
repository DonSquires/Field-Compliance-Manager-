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

const flat = (text) => text.replace(/\s+/g, ' ');

const IDENT = '"(?:[^"]|"")+"|[A-Za-z_][\\w$]*';
const POLICY_STATEMENT = new RegExp(
  `\\b(CREATE|ALTER|DROP)\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})([^;]*);`,
  'gi',
);
const unquote = (ident) => (ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident.toLowerCase());

function parenthesised(text, opener) {
  const match = opener.exec(text);
  if (!match) return null;
  let depth = 0;
  let quoted = false;
  const start = match.index + match[0].length;
  for (let i = start - 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth += 1;
    if (char === ')' && (depth -= 1) === 0) return text.slice(start, i);
  }
  return null;
}

// Roles end where USING / WITH CHECK begin. With no TO clause a policy applies to PUBLIC.
function clauses(rest) {
  const text = flat(rest).trim();
  const split = text.search(/\b(?:USING|WITH\s+CHECK)\s*\(/i);
  const head = split === -1 ? text : text.slice(0, split);
  const tail = split === -1 ? '' : text.slice(split);
  const to = head.match(/\bTO\s+(.+?)\s*$/i);
  return {
    roles: to ? to[1].split(',').map((role) => unquote(role.trim()).toLowerCase()) : null,
    using: parenthesised(tail, /\bUSING\s*\(/i),
    check: parenthesised(tail, /\bWITH\s+CHECK\s*\(/i),
  };
}

function applyPolicyStatements(state, sql) {
  for (const [, verb, rawName, rawSchema, rawTable, rest] of sql.replace(/--[^\n]*/g, '').matchAll(POLICY_STATEMENT)) {
    if (rawSchema && unquote(rawSchema) !== 'public') continue;
    const table = unquote(rawTable);
    const key = `${table}.${unquote(rawName)}`;
    const command = verb.toUpperCase();
    if (command === 'DROP') {
      state.delete(key);
      continue;
    }
    const rename = rest.match(/^\s*RENAME\s+TO\s+(\S+)\s*$/i);
    if (command === 'ALTER' && rename) {
      const policy = state.get(key);
      state.delete(key);
      if (policy) state.set(`${table}.${unquote(rename[1])}`, { ...policy, name: unquote(rename[1]) });
      continue;
    }
    const parsed = clauses(rest);
    if (command === 'CREATE') {
      state.set(key, { table, name: unquote(rawName), roles: parsed.roles ?? ['public'], using: parsed.using, check: parsed.check });
      continue;
    }
    const policy = state.get(key) ?? { table, name: unquote(rawName), roles: ['public'], using: null, check: null };
    state.set(key, {
      ...policy,
      roles: parsed.roles ?? policy.roles,
      using: parsed.using ?? policy.using,
      check: parsed.check ?? policy.check,
    });
  }
  return state;
}

// The snapshot is the live catalog at its applied_migrations header. Only
// migrations newer than that header are replayed on top of it.
function effectivePolicies(snapshotSql, migrationFiles) {
  const header = snapshotSql.match(/^-- applied_migrations: (.*)$/m);
  assert.ok(header, 'schema snapshot must record its applied_migrations header');
  const applied = new Set(header[1].split(',').map((version) => version.trim()));
  const snapshotStatements = [...snapshotSql.matchAll(/^CREATE POLICY [^;]*;/gm)].map(([statement]) => statement).join('\n');
  const state = applyPolicyStatements(new Map(), snapshotStatements);
  for (const { name, sql } of migrationFiles) {
    if (!applied.has(name.split('_')[0])) applyPolicyStatements(state, sql);
  }
  return state;
}

const reachesAnon = ({ roles }) => roles.includes('public') || roles.includes('anon');
const opensToAnyone = (predicate) => {
  if (predicate == null) return false;
  const compact = predicate.toLowerCase().replace(/["\s]/g, '');
  return /^\(*true\)*$/.test(compact) || /organization_idisnull\)*or/.test(compact);
};
const anonExposed = (state) => [...state.values()]
  .filter((policy) => reachesAnon(policy) && (opensToAnyone(policy.using) || opensToAnyone(policy.check)))
  .map(({ table, name }) => `${table}.${name}`)
  .sort();

test('no policy anon can reach has a true or org-null arm after pending migrations', () => {
  const state = effectivePolicies(schema, migrations);
  assert.ok(state.size > 900, `expected the full policy catalog, parsed ${state.size}`);
  const exposed = anonExposed(state);
  assert.deepEqual(exposed, [], `retarget these policies away from PUBLIC/anon: ${exposed.join(', ')}`);
});

test('the policy resolver catches later regressions and partial retargets', () => {
  const snapshot = (body) => `-- applied_migrations: 20990101000000\n${body}\n`;
  const exposedPublic = 'CREATE POLICY "p" ON "public"."t" FOR SELECT USING (true);';
  const authenticated = 'CREATE POLICY "p" ON "public"."t" FOR SELECT TO "authenticated" USING (true);';
  const resolve = (base, ...sql) => anonExposed(effectivePolicies(
    snapshot(base),
    sql.map((text, index) => ({ name: `2099010200000${index}_fixture.sql`, sql: text })),
  ));

  assert.deepEqual(resolve(authenticated, 'alter policy p on t to public;'), ['t.p'], 'unquoted PUBLIC regression');
  assert.deepEqual(resolve(authenticated, 'ALTER POLICY "p" ON public.t TO authenticated, anon;'), ['t.p'], 'role list keeps anon');
  assert.deepEqual(resolve(exposedPublic, 'ALTER POLICY "p" ON public.t TO authenticated, PUBLIC USING (true);'), ['t.p']);
  assert.deepEqual(resolve(exposedPublic, 'alter policy p on public.t to authenticated;'), [], 'unquoted retarget resolves');
  assert.deepEqual(resolve(exposedPublic, 'ALTER POLICY "p" ON "public"."t" TO "service_role";'), []);
  assert.deepEqual(resolve(exposedPublic, 'DROP POLICY IF EXISTS "p" ON public.t;'), []);
  assert.deepEqual(resolve(exposedPublic, 'ALTER POLICY p ON public.t USING (owner_id = (SELECT auth.uid()));'), []);
  assert.deepEqual(
    resolve(authenticated, 'DROP POLICY "p" ON public.t;', 'CREATE POLICY p ON public.t FOR SELECT USING ((organization_id IS NULL) OR x);'),
    ['t.p'],
    'recreated without a TO clause',
  );
  assert.deepEqual(
    anonExposed(effectivePolicies(snapshot(authenticated), [{ name: '20990101000000_applied.sql', sql: 'ALTER POLICY p ON t TO public;' }])),
    [],
    'migrations already in the snapshot header are not replayed',
  );
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

// Owner ruling 2026-11-01: org-less audit rows are platform records. Normalising
// away quoting, schema prefixes, aliases and parentheses lets the same pin hold
// for the migration text and for the pg_dump form after the catalog refresh.
test('org-less audit rows are readable only by the grand master or a platform owner', () => {
  const policy = effectivePolicies(schema, migrations).get('audit_log.audit_log_select');
  assert.ok(policy, 'audit_log_select must exist');
  assert.deepEqual(policy.roles, ['authenticated']);
  const normalised = policy.using
    .replace(/\s+AS\s+"?\w+"?/gi, '')
    .replace(/["()\s]/g, '')
    .replace(/public\./gi, '')
    .toLowerCase();
  assert.equal(
    normalised,
    'organization_idisnotnullandorg_access_allowedorganization_id'
      + 'ororganization_idisnullandselectis_grand_masterorselectis_platform_ownerselectauth.uid',
  );
});
