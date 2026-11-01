const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { effectivePolicies, flat } = require('./fixtures/policy-resolver');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const schema = read('supabase/schema.sql');
const migrationName = '20261102180000_close_anonymous_rls_exposure.sql';
const migration = read(`supabase/migrations/${migrationName}`);
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: read(`supabase/migrations/${name}`) }));

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

// Owner ruling 2026-11-01: org-less audit rows are platform records. The
// effective USING clause is parsed into a Boolean tree over named atoms and
// checked against the intended truth table, so a regrouped OR/AND fails even
// when the same atoms appear. Quoting, schema prefixes, aliases and redundant
// parentheses are normalised so the migration text and the pg_dump form match.
const AUDIT_ATOMS = [
  [/\(\s*select\s+is_platform_owner\(\s*\(\s*select\s+auth\.uid\(\)\s*\)\s*\)\s*\)/g, ' po '],
  [/is_platform_owner\(\s*(?:\(\s*select\s+auth\.uid\(\)\s*\)|auth\.uid\(\))\s*\)/g, ' po '],
  [/\(\s*select\s+is_grand_master\(\)\s*\)/g, ' gm '],
  [/is_grand_master\(\)/g, ' gm '],
  [/org_access_allowed\(\s*organization_id\s*\)/g, ' oa '],
  [/coalesce\(\s*\(*\s*organization_id\s*\)*\s*=\s*any\s*\(\s*\(\s*select\s+accessible_org_ids\(\)\s*\)\s*\)\s*\)*\s*,\s*false\s*\)/g, ' inset '],
  [/organization_id\s+is\s+not\s+null/g, ' nn '],
  [/organization_id\s+is\s+null/g, ' isnull '],
];

function auditPredicate(sql) {
  let text = sql.replace(/"/g, '').replace(/\s+AS\s+\w+/gi, '').replace(/::uuid\[\]/gi, '')
    .replace(/\bpublic\./gi, '')
    .toLowerCase().replace(/\s+/g, ' ');
  for (const [pattern, atom] of AUDIT_ATOMS) text = text.replace(pattern, atom);
  const tokens = text.match(/[()]|[a-z_]+|\S/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected) => {
    const token = tokens[at++];
    if (expected && token !== expected) throw new Error(`expected ${expected}, found ${token} in ${text}`);
    return token;
  };
  const atoms = new Set(['po', 'gm', 'oa', 'inset', 'nn', 'isnull']);
  const factor = () => {
    if (peek() === 'not') { take(); const inner = factor(); return (env) => !inner(env); }
    if (peek() === '(') { take(); const inner = disjunction(); take(')'); return inner; }
    const token = take();
    if (!atoms.has(token)) throw new Error(`unrecognised token ${token} in ${text}`);
    return (env) => env[token];
  };
  const conjunction = () => {
    const parts = [factor()];
    while (peek() === 'and') { take(); parts.push(factor()); }
    return (env) => parts.every((part) => part(env));
  };
  const disjunction = () => {
    const parts = [conjunction()];
    while (peek() === 'or') { take(); parts.push(conjunction()); }
    return (env) => parts.some((part) => part(env));
  };
  const predicate = disjunction();
  assert.equal(at, tokens.length, `trailing tokens in ${text}`);
  return predicate;
}

function auditTruthTableMismatches(sql) {
  const predicate = auditPredicate(sql);
  const mismatches = [];
  for (let bits = 0; bits < 16; bits += 1) {
    const [isNull, gm, po, inReach] = [1, 2, 4, 8].map((bit) => Boolean(bits & bit));
    const env = {
      nn: !isNull,
      isnull: isNull,
      gm,
      po,
      oa: gm || (!isNull && inReach),
      inset: !isNull && inReach,
    };
    const expected = isNull ? gm || po : gm || inReach;
    if (predicate(env) !== expected) mismatches.push({ isNull, gm, po, inReach, expected });
  }
  return mismatches;
}

test('org-less audit rows are readable only by the grand master or a platform owner', () => {
  const policy = effectivePolicies(schema, migrations).get('audit_log.audit_log_select');
  assert.ok(policy, 'audit_log_select must exist');
  assert.deepEqual(policy.roles, ['authenticated']);
  assert.deepEqual(auditTruthTableMismatches(policy.using), []);

  // The truth table holds for the pg_dump form and rejects a regrouped platform-owner arm.
  const dumped = '((("organization_id" IS NOT NULL) AND "public"."org_access_allowed"("organization_id")) OR (("organization_id" IS NULL) AND (( SELECT "public"."is_grand_master"() AS "is_grand_master") OR ( SELECT "public"."is_platform_owner"(( SELECT "auth"."uid"() AS "uid")) AS "is_platform_owner"))))';
  assert.deepEqual(auditTruthTableMismatches(dumped), []);
  const regrouped = '((organization_id IS NOT NULL AND org_access_allowed(organization_id)) OR (organization_id IS NULL AND (SELECT public.is_grand_master())) OR (SELECT public.is_platform_owner((SELECT auth.uid()))))';
  assert.ok(auditTruthTableMismatches(regrouped).some((row) => !row.isNull && row.po && !row.expected));
});
