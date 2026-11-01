const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { repositoryPolicies } = require('./fixtures/policy-resolver');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const schema = read('supabase/schema.sql');
const migrationName = '20261102200000_org_access_policies_initplan.sql';
const migration = read(`supabase/migrations/${migrationName}`);
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: read(`supabase/migrations/${name}`) }));

// The migration text and the pg_dump deparse of the same expression differ in
// quoting, schema prefixes, sub-select aliases and spacing; normalise both.
const normalise = (sql) => sql.replace(/"/g, '').replace(/\s+AS\s+\w+/gi, '').replace(/\bpublic\./gi, '')
  .toLowerCase().replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
const PER_ROW_CALL = /\borg_access_allowed\s*\(/i;
const REACH_HEAD = '(select is_grand_master()) or coalesce(';
const REACH_TAIL = /= any \(\(select accessible_org_ids\(\)\)::uuid\[\]\)\)?, false$/;

// Replaces each complete reach template with a marker. The argument may be a
// column, an expression or a correlated scalar sub-select, so the COALESCE is
// matched by balancing parentheses rather than by pattern.
function markReach(text) {
  let marked = '';
  let at = 0;
  let templates = 0;
  for (;;) {
    const start = text.indexOf(REACH_HEAD, at);
    if (start === -1) return { marked: marked + text.slice(at), templates };
    let depth = 1;
    let quoted = false;
    let end = start + REACH_HEAD.length;
    for (; end < text.length && depth > 0; end += 1) {
      const char = text[end];
      if (char === "'") quoted = !quoted;
      else if (!quoted && char === '(') depth += 1;
      else if (!quoted && char === ')') depth -= 1;
    }
    const inner = text.slice(start + REACH_HEAD.length, end - 1);
    const complete = REACH_TAIL.test(inner) && inner.split('accessible_org_ids').length === 2;
    marked += text.slice(at, start) + (complete ? ' reach ' : text.slice(start, end));
    templates += complete ? 1 : 0;
    at = end;
  }
}

function reachShape(sql) {
  if (sql == null) return { templates: 0, unguarded: false, perRow: false };
  const { marked, templates } = markReach(normalise(sql));
  return { templates, unguarded: marked.includes('accessible_org_ids'), perRow: PER_ROW_CALL.test(sql) };
}

function functionDefinition(sql, name) {
  const opener = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'gi');
  const last = [...sql.matchAll(opener)].pop();
  if (!last) return null;
  const rest = sql.slice(last.index);
  const tag = rest.match(/\bAS\s+(\$\w*\$)/i);
  const bodyStart = tag.index + tag[0].length;
  const bodyEnd = rest.indexOf(tag[1], bodyStart);
  return rest.slice(0, rest.indexOf(';', bodyEnd) + 1);
}

const lastDefining = (name) => migrations.filter(({ sql }) => functionDefinition(sql, name)).map(({ name: file }) => file).pop();

// The definition in force: the newest pending migration, else the live snapshot.
function currentDefinition(name) {
  const applied = new Set(schema.match(/^-- applied_migrations: (.*)$/m)[1].split(',').map((version) => version.trim()));
  const pending = migrations.filter(({ name: file }) => !applied.has(file.split('_')[0]));
  for (const { sql } of [...pending].reverse()) {
    const definition = functionDefinition(sql, name);
    if (definition) return definition;
  }
  const definition = functionDefinition(schema, name);
  assert.ok(definition, `${name} must be defined in the schema snapshot or a pending migration`);
  return definition;
}

test('every organisation-scoped policy evaluates reach once per statement', () => {
  const policies = [...repositoryPolicies(root).values()];
  const shaped = policies.map((policy) => ({ policy, using: reachShape(policy.using), check: reachShape(policy.check) }));
  const label = ({ policy }) => `${policy.table}.${policy.name}`;

  const perRow = shaped.filter(({ using, check }) => using.perRow || check.perRow).map(label);
  assert.deepEqual(perRow, [],
    'use ((SELECT public.is_grand_master()) OR COALESCE((X) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) '
    + `instead of org_access_allowed(X) in these policies: ${perRow.join(', ')}`);

  const unguarded = shaped.filter(({ using, check }) => using.unguarded || check.unguarded).map(label);
  assert.deepEqual(unguarded, [], `accessible_org_ids() needs the grand-master arm and COALESCE in: ${unguarded.join(', ')}`);

  const rewritten = shaped.filter(({ using, check }) => using.templates + check.templates > 0);
  assert.ok(rewritten.length >= 357, `expected at least 357 initPlan reach policies, found ${rewritten.length}`);
});

test('the reach template is recognised in migration and pg_dump form and nowhere else', () => {
  const migrationForm = '((SELECT public.is_grand_master()) OR COALESCE((s.client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))';
  const dumpForm = '(( SELECT is_grand_master() AS is_grand_master) OR COALESCE((organization_id = ANY (( SELECT accessible_org_ids() AS accessible_org_ids)::uuid[])), false))';
  const multiColumn = '((SELECT public.is_grand_master()) OR COALESCE((COALESCE(provider_organization_id, client_organization_id, jurisdiction_organization_id)) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))';
  const correlated = '((SELECT public.is_grand_master()) OR COALESCE((( SELECT l.organization_id\n   FROM locations l\n  WHERE (l.id = location_module_assignments.location_id))) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))';
  const correlatedDump = '(( SELECT is_grand_master() AS is_grand_master) OR COALESCE((( SELECT l.organization_id FROM locations l WHERE (l.id = t.location_id)) = ANY (( SELECT accessible_org_ids() AS accessible_org_ids)::uuid[])), false))';
  assert.deepEqual(reachShape(migrationForm), { templates: 1, unguarded: false, perRow: false });
  assert.deepEqual(reachShape(dumpForm), { templates: 1, unguarded: false, perRow: false });
  assert.deepEqual(reachShape(multiColumn), { templates: 1, unguarded: false, perRow: false });
  assert.deepEqual(reachShape(correlated), { templates: 1, unguarded: false, perRow: false });
  assert.deepEqual(reachShape(correlatedDump), { templates: 1, unguarded: false, perRow: false });
  assert.deepEqual(reachShape(`CASE kind WHEN 'a' THEN ${migrationForm} WHEN 'b' THEN ${correlated} ELSE false END`),
    { templates: 2, unguarded: false, perRow: false });

  assert.equal(reachShape('organization_id = ANY ((SELECT public.accessible_org_ids())::uuid[])').unguarded, true, 'no NULL guard');
  assert.equal(reachShape('COALESCE(organization_id = ANY ((SELECT accessible_org_ids())::uuid[]), false)').unguarded, true, 'no grand-master arm');
  assert.equal(reachShape('(org_access_allowed(organization_id))').perRow, true);
});

test('accessible_org_ids is a locked-down set form of org_access_allowed', () => {
  const definition = functionDefinition(migration, 'accessible_org_ids');
  assert.ok(definition, 'the migration defines accessible_org_ids');
  assert.match(definition, /RETURNS uuid\[\]\s+LANGUAGE sql\s+STABLE SECURITY DEFINER\s+SET search_path TO 'public'/);
  assert.match(definition, /where p\.id = auth\.uid\(\)\s+and p\.deactivated_at is null/);
  assert.match(definition, /filter \(where reach\.org_id is not null\), array\[\]::uuid\[\]\)/);
  assert.match(definition, /sa\.agreement_type = 'operational'/);
  assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.accessible_org_ids() FROM PUBLIC;'));
  assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.accessible_org_ids() TO anon, authenticated, service_role;'),
    'PUBLIC-role policies are evaluated as anon, so anon needs EXECUTE');

  const statements = migration.match(/^ALTER POLICY [\s\S]*?;\r?$/gm) ?? [];
  assert.ok(statements.length >= 357, `expected at least 357 rewritten policies, found ${statements.length}`);
  assert.deepEqual(statements.filter((statement) => PER_ROW_CALL.test(statement)), []);
  assert.ok(statements.every((statement) => /^ALTER POLICY "[^"]+" ON public\."[^"]+"\r?\n {2}(?:USING|WITH CHECK) \(/.test(statement)),
    'ALTER POLICY keeps each policy\'s roles and command; only its expressions change');
  const lockGuard = migration.search(/^SET LOCAL lock_timeout = '\d+s';\r?$/m);
  assert.ok(lockGuard !== -1 && lockGuard < migration.search(/^ALTER POLICY /m),
    'the rewrite locks every table it touches, so it must fail fast rather than queue live reads behind a long query');
});

test('a change to org_access_allowed also redefines accessible_org_ids', () => {
  const organisation = lastDefining('org_access_allowed');
  const reach = lastDefining('accessible_org_ids');
  assert.ok(reach >= migrationName, 'accessible_org_ids is defined by this migration or a later one');
  assert.ok(organisation <= reach,
    `${organisation} redefines org_access_allowed after ${reach} last defined accessible_org_ids; change both together and re-prove them equivalent`);
});

// Seeded tenancy graph: hierarchy, NULL and partly-NULL arrays, deactivated
// accounts, expired and open grants, operational and financial agreements.
function seededFixture() {
  let state = 0x5eed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const quote = (value) => (value == null ? 'NULL' : `'${value}'`);
  const orgs = Array.from({ length: 40 }, (_, i) => id('30000000', i + 1));
  const orgOrNull = (nullShare) => (random() < nullShare ? null : pick(orgs));
  const roles = ['grand_master', 'master', 'admin', 'admin_officer', 'officer', 'officer', 'officer', 'client_admin', 'client_viewer'];

  const organisations = orgs.map((org, i) => `(${quote(org)}, ${quote(i > 0 && random() < 0.6 ? orgs[Math.floor(random() * i)] : null)})`);
  const profiles = Array.from({ length: 90 }, (_, i) => {
    const organisation = orgOrNull(0.12);
    const employer = random() < 0.5 ? null : random() < 0.5 ? organisation : pick(orgs);
    const shape = random();
    const authorised = shape < 0.3 ? 'NULL'
      : shape < 0.5 ? `'{}'::uuid[]`
        : `ARRAY[${Array.from({ length: 1 + Math.floor(random() * 4) }, () => quote(orgOrNull(0.15))).join(', ')}]::uuid[]`;
    const role = i === 0 || i === 1 ? 'grand_master' : pick(roles);
    const deactivated = i === 1 || random() < 0.2 ? 'now()' : 'NULL';
    return `(${quote(id('40000000', i + 1))}, '${role}', ${quote(organisation)}, ${quote(employer)}, ${authorised}, ${deactivated})`;
  });
  const until = (column) => pick([`NULL`, `${column} - interval '1 day'`, `${column} + interval '1 day'`]);
  const grants = Array.from({ length: 30 }, () => `(${quote(orgOrNull(0.1))}, ${quote(orgOrNull(0.1))}, ${until('now()')})`);
  const agreements = Array.from({ length: 30 }, () => `(${quote(orgOrNull(0.05))}, ${quote(orgOrNull(0.05))}, `
    + `${pick(['NULL', 'current_date - 1', 'current_date', 'current_date + 5'])}, '${random() < 0.7 ? 'operational' : 'financial'}')`);
  const actors = [...profiles.keys()].map((i) => id('40000000', i + 1)).concat([randomUUID()]);
  return { orgs, organisations, profiles, grants, agreements, actors };
}

test('the initPlan form admits exactly the rows org_access_allowed admits', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-org-access-initplan-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  const fixture = seededFixture();
  const template = migration.match(/\(\(SELECT public\.is_grand_master\(\)\) OR COALESCE\(\(organization_id\) = ANY \(\(SELECT public\.accessible_org_ids\(\)\)::uuid\[\]\), false\)\)/);
  assert.ok(template, 'the migration rewrites a plain organization_id call');
  const prelude = migration.slice(0, migration.search(/^ALTER POLICY /m));
  const phase = (label) => fixture.actors.map((actor) => `
    RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${actor}', false); SET ROLE authenticated;
    INSERT INTO public.seen SELECT '${actor}', '${label}', coalesce(array_agg(id ORDER BY id), '{}') FROM public.things;`)
    .concat(`
    RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false); SET ROLE anon;
    INSERT INTO public.seen SELECT 'anon', '${label}', coalesce(array_agg(id ORDER BY id), '{}') FROM public.things;
    RESET ROLE;`).join('\n');

  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL ready');

    const output = docker(['exec', '-i', name, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], `
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $f$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY, parent_organization_id uuid);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, role text, organization_id uuid, employer_organization_id uuid,
        authorized_organization_ids uuid[], deactivated_at timestamptz);
      CREATE TABLE public.provider_client_access_grants(provider_organization_id uuid, client_organization_id uuid, ends_at timestamptz);
      CREATE TABLE public.service_agreements(provider_organization_id uuid, client_organization_id uuid, ends_on date, agreement_type text);
      ${currentDefinition('is_grand_master')}
      ${currentDefinition('get_descendant_organizations')}
      ${currentDefinition('org_access_allowed')}
      ${prelude}
      INSERT INTO public.organizations VALUES ${fixture.organisations.join(',\n')};
      INSERT INTO public.user_profiles VALUES ${fixture.profiles.join(',\n')};
      INSERT INTO public.provider_client_access_grants VALUES ${fixture.grants.join(',\n')};
      INSERT INTO public.service_agreements VALUES ${fixture.agreements.join(',\n')};

      CREATE TABLE public.things(id serial PRIMARY KEY, organization_id uuid);
      INSERT INTO public.things(organization_id) SELECT id FROM public.organizations;
      INSERT INTO public.things(organization_id) VALUES (NULL), (NULL), (gen_random_uuid());
      ALTER TABLE public.things ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON public.things FOR SELECT USING (org_access_allowed(organization_id));
      GRANT SELECT ON public.things TO anon, authenticated;
      CREATE TABLE public.seen(actor text, phase text, ids int[]);
      GRANT INSERT ON public.seen TO anon, authenticated;

      CREATE TEMP TABLE targets AS SELECT id FROM public.organizations UNION ALL SELECT NULL UNION ALL SELECT gen_random_uuid();
      CREATE TEMP TABLE function_mismatches(actor text, target uuid);
      DO $d$
      DECLARE v_actor text;
      BEGIN
        FOREACH v_actor IN ARRAY ARRAY[${fixture.actors.map((actor) => `'${actor}'`).join(', ')}, ''] LOOP
          PERFORM set_config('request.jwt.claim.sub', v_actor, true);
          INSERT INTO function_mismatches
            SELECT v_actor, t.id FROM targets t
             WHERE public.org_access_allowed(t.id)
                   IS DISTINCT FROM (public.is_grand_master() OR COALESCE(t.id = ANY (public.accessible_org_ids()), false));
        END LOOP;
      END $d$;

      ${phase('pre')}
      ALTER POLICY p ON public.things USING (${template[0]});
      ${phase('post')}

      SELECT 'function_checks=' || (SELECT count(*) FROM targets) * ${fixture.actors.length + 1};
      SELECT 'function_mismatches=' || count(*) FROM function_mismatches;
      SELECT 'row_mismatches=' || count(*) FROM public.seen a
        JOIN public.seen b ON b.actor = a.actor AND b.phase = 'post' WHERE a.phase = 'pre' AND a.ids IS DISTINCT FROM b.ids;
      SELECT 'paired=' || count(*) FROM public.seen a JOIN public.seen b ON b.actor = a.actor AND b.phase = 'post' WHERE a.phase = 'pre';
      SELECT 'distinct_views=' || count(DISTINCT ids) FROM public.seen WHERE phase = 'pre';
      SELECT 'anon_rows=' || cardinality(ids) FROM public.seen WHERE actor = 'anon' AND phase = 'post';
      SELECT 'deparsed=' || pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'p';
    `);
    const result = Object.fromEntries(output.trim().split('\n')
      .filter((line) => /^\w+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

    assert.equal(Number(result.function_checks), (fixture.orgs.length + 2) * (fixture.actors.length + 1));
    assert.equal(result.function_mismatches, '0', 'org_access_allowed(X) and the initPlan form agree for every caller and target');
    assert.equal(Number(result.paired), fixture.actors.length + 1);
    assert.equal(result.row_mismatches, '0', 'every caller sees the same rows through the rewritten policy');
    assert.ok(Number(result.distinct_views) >= 10, `the fixture exercises varied reach, saw ${result.distinct_views} distinct views`);
    assert.equal(result.anon_rows, '0');
    assert.deepEqual(reachShape(result.deparsed), { templates: 1, unguarded: false, perRow: false },
      `Postgres deparses the rewritten policy in a form the static guard recognises: ${result.deparsed}`);
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
