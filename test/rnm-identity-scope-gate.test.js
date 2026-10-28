const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const migrationsDir = path.join(root, 'supabase/migrations');
const migrationName = '20261101170000_rnm_identity_scope_gate.sql';
const migration = read(`supabase/migrations/${migrationName}`);
const schema = read('supabase/schema.sql');

function functionBlock(sql, qualifiedName) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${qualifiedName}(`);
  assert.notEqual(start, -1, `${qualifiedName} not found`);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end + '$function$;'.length);
}

test('the public R&M identity gate wraps the private check without opening schema private', () => {
  const wrapper = functionBlock(migration, 'public.can_view_rnm_identity_for_organization');
  assert.match(wrapper, /SECURITY DEFINER/);
  assert.match(wrapper, /SET search_path = ''/);
  // The whole body is pinned: a wrapper that keeps the private call but returns
  // true (or ORs in anything else) would silently widen identity access.
  const body = /AS \$function\$([\s\S]*?)\$function\$;/.exec(wrapper)?.[1].trim();
  assert.equal(body, 'SELECT COALESCE(private.rnm_admin_for_organization(p_organization_id), false);');
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.can_view_rnm_identity_for_organization\(uuid\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.can_view_rnm_identity_for_organization\(uuid\) TO authenticated;/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.can_view_rnm_identity_for_organization\(uuid\) TO anon/);
  assert.doesNotMatch(migration, /GRANT USAGE ON SCHEMA private/i);
});

test('search_observations stays SECURITY INVOKER and no longer touches schema private', () => {
  const search = functionBlock(migration, 'public.search_observations');
  assert.doesNotMatch(search, /SECURITY DEFINER/);
  assert.doesNotMatch(search, /\bprivate\./);
  assert.match(search, /SELECT public\.can_view_rnm_identity_for_organization\(p_organization_id\) AS can_view/);
  assert.match(search, /AND public\.org_access_allowed\(o\.organization_id\)/);

  // Everything except the identity gate must match the live definition, so the
  // fix cannot silently roll back an earlier search_observations change.
  const live = functionBlock(schema, '"public"."search_observations"')
    .replace('"public"."search_observations"', 'public.search_observations')
    .replace(
      'SELECT private.rnm_admin_for_organization(p_organization_id) AS can_view',
      'SELECT public.can_view_rnm_identity_for_organization(p_organization_id) AS can_view',
    );
  assert.equal(search, live);
});

test('no SECURITY INVOKER public function calls schema private once migrations apply', () => {
  const laterDefinitions = new Map();
  for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const match of sql.matchAll(/CREATE OR REPLACE FUNCTION (?:public|"public")\.(?:"(\w+)"|(\w+))\(/g)) {
      laterDefinitions.set(match[1] ?? match[2], file);
    }
  }
  const pattern = /CREATE OR REPLACE FUNCTION "public"\."(\w+)"\([\s\S]*?\n([\s\S]*?)\$function\$([\s\S]*?)\$function\$;/g;
  const offenders = [];
  for (const [, name, header, body] of schema.matchAll(pattern)) {
    if (header.includes('SECURITY DEFINER') || !/\bprivate\./.test(body)) continue;
    const latest = laterDefinitions.get(name);
    if (latest) {
      const sql = fs.readFileSync(path.join(migrationsDir, latest), 'utf8');
      const start = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.${name}|"public"\\."${name}")\\(`));
      const opening = /\bAS\s+(\$\w*\$)/.exec(sql.slice(start));
      const bodyStart = start + opening.index + opening[0].length;
      const latestBlock = sql.slice(start, sql.indexOf(opening[1], bodyStart) + opening[1].length);
      if (latestBlock.includes('SECURITY DEFINER') || !/\bprivate\./.test(latestBlock)) continue;
    }
    offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test('web identity gates ask the same org-scoped question the RPCs enforce', () => {
  const page = read('apps/web/src/pages/ObservationSearchPage.tsx');
  assert.match(page, /rpc\('can_view_rnm_identity_for_organization', \{ p_organization_id: organizationId \}\)/);
  assert.doesNotMatch(page, /rpc\('can_manage_r_and_m_identity'\)/);
  // Only an explicit true grants access; null, errors and truthy non-booleans deny.
  assert.match(page, /setCanManageIdentity\(identityAccess === true\)/);
  assert.match(page, /const peopleResult = identityAccess === true/);
  // A slower answer for an earlier organisation must not overwrite the current one.
  assert.match(page, /if \(requestId !== optionsRequest\.current\) return;\n    setCanManageIdentity/);

  const panel = read('apps/web/src/components/RepeatSubjectsPanel.tsx');
  assert.match(panel, /rpc\('can_view_rnm_identity_for_organization', \{ p_organization_id: organizationId \}\)/);
  assert.match(panel, /linkOrgIds\.filter\(\(_, index\) => scopes\[index\]\.data === true\)/);
  assert.match(panel, /identityLinkOrgIds\.has\(item\.organization_id\) && <PersonObservationLink/);
});
