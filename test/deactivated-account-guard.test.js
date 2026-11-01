const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const schema = read('supabase/schema.sql');
const migration = read('supabase/migrations/20261102140000_rm_verified_only_operational_custody_consolidation.sql');

const policies = [...schema.matchAll(/CREATE POLICY "([^"]+)" ON "public"\."([^"]+)"([\s\S]*?);\n/g)]
  .map(([, name, table, body]) => ({ name, table, body }));

function functionBodies(source, pattern) {
  const bodies = new Map();
  for (const match of source.matchAll(pattern)) {
    const list = bodies.get(match[1]) ?? [];
    list.push(match[2]);
    bodies.set(match[1], list);
  }
  return bodies;
}

const schemaFunctions = functionBodies(
  schema,
  /CREATE OR REPLACE FUNCTION "public"\."([^"]+)"\((?:[^()]|\([^()]*\))*\)\n[\s\S]*?\$function\$([\s\S]*?)\$function\$;/g,
);
const migrationFunctions = functionBodies(
  migration,
  /CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/g,
);

const guardedTables = new Set([
  ...[...(migration.match(/DO \$guards\$[\s\S]*?FOREACH v_table IN ARRAY ARRAY\[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([a-z_0-9]+)'/g)]
    .map(([, table]) => table),
  ...policies
    .filter((policy) => policy.name === 'deactivated_account_guard' && /AS RESTRICTIVE/.test(policy.body))
    .map((policy) => policy.table),
]);

const calledFunctions = (text) => new Set(
  [...text.matchAll(/\b([a-z_][a-z0-9_]*)\(/g)].map(([, name]) => name).filter((name) => schemaFunctions.has(name)),
);

function checksDeactivation(name, stack = new Set()) {
  if ((migrationFunctions.get(name) ?? []).some((body) => body.includes('deactivated_at'))) return true;
  if (stack.has(name)) return false;
  stack.add(name);
  return (schemaFunctions.get(name) ?? []).some((body) => (
    body.includes('deactivated_at') || [...calledFunctions(body)].some((callee) => checksDeactivation(callee, stack))
  ));
}

// Never a sole grant: each policy using it must also pass deactivation-aware helpers.
const CONJOINED_HELPERS = new Map([
  ['nzta_reveal_active', ['org_access_allowed', 'can_access_vehicle_owner_identity', 'can_access_person_contacts']],
]);

test('every table whose policies read user_profiles inline without a deactivation check carries the restrictive guard', () => {
  const unguarded = [...new Set(
    policies
      .filter((policy) => /\buser_profiles\b/.test(policy.body) && !policy.body.includes('deactivated_at'))
      .map((policy) => policy.table),
  )].filter((table) => !guardedTables.has(table)).sort();
  assert.deepEqual(unguarded, [], `add these tables to the deactivated_account_guard list: ${unguarded.join(', ')}`);
});

test('every policy helper keyed on auth.uid() fails closed for a deactivated profile', () => {
  const helpers = new Set(policies.flatMap((policy) => [...calledFunctions(policy.body)]));
  const unchecked = [...helpers]
    .filter((name) => (schemaFunctions.get(name) ?? []).some((body) => body.includes('auth.uid()')))
    .filter((name) => !checksDeactivation(name) && !CONJOINED_HELPERS.has(name))
    .sort();
  assert.deepEqual(unchecked, [], `make these helpers check user_profiles.deactivated_at: ${unchecked.join(', ')}`);

  for (const [helper, required] of CONJOINED_HELPERS) {
    for (const policy of policies.filter((candidate) => candidate.body.includes(`${helper}(`))) {
      for (const guard of required) {
        assert.ok(checksDeactivation(guard), `${guard} must check deactivation`);
        assert.ok(policy.body.includes(`${guard}(`), `${policy.table}.${policy.name} uses ${helper} without ${guard}`);
      }
    }
  }
});

function callArguments(text, openParen) {
  let depth = 0;
  for (let index = openParen; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && --depth === 0) return text.slice(openParen + 1, index);
  }
  return '';
}

// The migration's replacement, when present, is the body that will be live.
const directlyChecksDeactivation = (name) => {
  const bodies = migrationFunctions.get(name) ?? schemaFunctions.get(name) ?? [];
  return bodies.length > 0 && bodies.every((body) => body.includes('deactivated_at'));
};

test('every policy helper handed auth.uid() as an argument fails closed for a deactivated profile', () => {
  const keyed = new Map();
  for (const policy of policies) {
    for (const match of policy.body.matchAll(/\b([a-z_][a-z0-9_]*)\(/g)) {
      if (!schemaFunctions.has(match[1])) continue;
      if (!/\bauth\.uid\(\)/.test(callArguments(policy.body, match.index + match[0].length - 1))) continue;
      keyed.set(match[1], (keyed.get(match[1]) ?? new Set()).add(policy.table));
    }
  }
  assert.ok(keyed.has('user_has_task_entitlement') && keyed.has('is_platform_owner'), 'the argument scan must see the known keyed helpers');
  // A helper is safe if it rejects a deactivated profile itself or every table that uses it carries the restrictive guard.
  const unchecked = [...keyed]
    .filter(([name, tables]) => !directlyChecksDeactivation(name) && !CONJOINED_HELPERS.has(name)
      && [...tables].some((table) => !guardedTables.has(table)))
    .map(([name, tables]) => `${name} (${[...tables].filter((table) => !guardedTables.has(table)).join(', ')})`)
    .sort();
  assert.deepEqual(unchecked, [], `make these helpers reject a deactivated profile for their user argument: ${unchecked.join('; ')}`);
});

test('the restrictive guard is a revoked-from-anon definer helper evaluated once per statement', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.current_account_is_active\(\)[\s\S]*?SECURITY DEFINER\s+SET search_path = ''[\s\S]*?p\.deactivated_at IS NOT NULL/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.current_account_is_active\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.current_account_is_active\(\) TO postgres, authenticated, service_role;/);
  assert.match(migration, /AS RESTRICTIVE FOR ALL TO authenticated '\s*'USING \(\(SELECT public\.current_account_is_active\(\)\)\) '\s*'WITH CHECK \(\(SELECT public\.current_account_is_active\(\)\)\)'/);
});

test('deactivation bans the Auth user and revokes sessions; reactivation lifts the ban', () => {
  const rpc = migration.match(/CREATE OR REPLACE FUNCTION public\.set_user_deactivation\([\s\S]*?\$function\$;/)?.[0] ?? '';
  assert.match(rpc, /IF p_action = 'deactivate' THEN\s+UPDATE auth\.users\s+SET banned_until = clock_timestamp\(\) \+ interval '100 years'\s+WHERE id = v_target\.id;\s+DELETE FROM auth\.sessions\s+WHERE user_id = v_target\.id;/);
  assert.match(rpc, /ELSE\s+UPDATE auth\.users\s+SET banned_until = NULL\s+WHERE id = v_target\.id;/);
  assert.match(rpc, /'auth_sessions_revoked', v_sessions_revoked/);
  // the bulk boundary reconciles Auth for every deactivated profile, including earlier ones
  assert.match(migration, /UPDATE auth\.users au\s+SET banned_until = clock_timestamp\(\) \+ interval '100 years'\s+FROM public\.user_profiles u\s+WHERE u\.id = au\.id\s+AND u\.deactivated_at IS NOT NULL/);
  assert.match(migration, /DELETE FROM auth\.sessions s\s+USING public\.user_profiles u\s+WHERE u\.id = s\.user_id\s+AND u\.deactivated_at IS NOT NULL;/);
  assert.match(migration, /RAISE EXCEPTION 'Deactivated profiles still hold usable Auth access';/);
});

test('profiles without an Auth user are audited in audit_log, never through the auth.users-keyed audit', () => {
  const rpc = migration.match(/CREATE OR REPLACE FUNCTION public\.set_user_deactivation\([\s\S]*?\$function\$;/)?.[0] ?? '';
  const loop = migration.match(/FOR v_profile IN\s+SELECT u\.id, u\.organization_id, u\.role, u\.email[\s\S]*?END LOOP;/)?.[0] ?? '';
  assert.ok(rpc && loop, 'set_user_deactivation and the deactivation loop must be present');
  for (const [label, body] of [['set_user_deactivation', rpc], ['migration deactivation loop', loop]]) {
    // user_management_audit.target_user_id references auth.users, so an unconditional call fails for roster-only profiles.
    const calls = [...body.matchAll(/PERFORM public\.log_user_management_action\(/g)].length;
    const guarded = [...body.matchAll(/IF EXISTS \(SELECT 1 FROM auth\.users au WHERE au\.id = v_(?:target|profile)\.id\) THEN\s+PERFORM public\.log_user_management_action\(/g)].length;
    assert.equal(guarded, calls, `${label} must check auth.users before logging to user_management_audit`);
    assert.match(body, /ELSE\s+INSERT INTO public\.audit_log \([\s\S]*?'user_profiles',[\s\S]*?'auth_account', 'absent'/, `${label} must audit Auth-less profiles in audit_log`);
  }
});

test('a banned sign-in shows the deactivated-account message on web and mobile', () => {
  const authContext = read('apps/web/src/context/AuthContext.tsx');
  const mobile = read('apps/mobile/App.tsx');
  assert.match(authContext, /signInError\.code === 'user_banned' \? DEACTIVATED_ACCOUNT_MESSAGE : signInError\.message/);
  assert.match(mobile, /error\.code === 'user_banned'\s+\? 'This account has been deactivated\./);
});
