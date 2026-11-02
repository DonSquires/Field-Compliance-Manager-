const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const migrationName = '20261103120000_enqueue_notification_server_only.sql';
const migration = read(`supabase/migrations/${migrationName}`).replace(/\r\n/g, '\n');
const SIGNATURE = 'public.enqueue_notification(uuid, text, text, text, text, uuid, text, text, jsonb, text)';
const CALLS = /\benqueue_notification\s*\(/;

const laterMigrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql') && name > migrationName)
  .sort()
  .map((name) => ({ name, sql: read(`supabase/migrations/${name}`) }));

// Each CREATE FUNCTION statement with its attributes (before or after the body) and its body.
function functionStatements(sql) {
  const found = [];
  const head = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi;
  let match;
  while ((match = head.exec(sql))) {
    const rest = sql.slice(match.index);
    const tag = rest.match(/\bAS\s+(\$\w*\$)/i);
    if (!tag) continue;
    const bodyStart = tag.index + tag[0].length;
    const bodyEnd = rest.indexOf(tag[1], bodyStart);
    if (bodyEnd < 0) continue;
    const after = rest.slice(bodyEnd + tag[1].length);
    found.push({
      name: match[1],
      attributes: `${rest.slice(0, tag.index)} ${after.slice(0, after.indexOf(';'))}`,
      body: rest.slice(bodyStart, bodyEnd),
    });
    head.lastIndex = match.index + bodyEnd + tag[1].length;
  }
  return found;
}

const sourceFiles = (dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter((file) => /\.(tsx?|jsx?|mjs)$/.test(file))
  .map((file) => path.join(dir, file));

test('only the service role and definer code can execute enqueue_notification', () => {
  assert.doesNotMatch(migration, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, 'a failed guard must not leave an explicit transaction open');
  assert.ok(migration.includes(`REVOKE ALL ON FUNCTION ${SIGNATURE}\n  FROM PUBLIC, anon, authenticated;`));
  assert.ok(migration.includes(`GRANT EXECUTE ON FUNCTION ${SIGNATURE}\n  TO service_role;`));

  const guard = migration.indexOf('$guard$');
  const revoke = migration.indexOf('REVOKE ALL ON FUNCTION');
  const verify = migration.indexOf('$verify$');
  assert.ok(guard > 0 && guard < revoke && revoke < verify, 'caller-rights check runs before the revoke and the grant check after it');
  assert.match(migration, /AND NOT p\.prosecdef\s+AND p\.prosrc ~ '\\menqueue_notification\\s\*\\\('/);
  assert.match(migration, /has_function_privilege\('anon', v_fn, 'EXECUTE'\) OR has_function_privilege\('authenticated', v_fn, 'EXECUTE'\)/);
  assert.match(migration, /NOT has_function_privilege\(p\.proowner, v_fn, 'EXECUTE'\)/);

  for (const line of migration.split(/\r?\n/)) {
    assert.doesNotMatch(line, /^\s*(drop\s+(table|schema|database|column)|truncate\s+table|alter\s+table[^;]*\bdrop\b|delete\s+from\s+\S+\s*;)/i, line);
  }
});

test('no later migration grants enqueue_notification back to a client role', () => {
  for (const { name, sql } of laterMigrations) {
    assert.doesNotMatch(sql, /GRANT\s+(?:EXECUTE|ALL)[^;]*enqueue_notification[^;]*\bTO\b[^;]*\b(PUBLIC|anon|authenticated)\b/i, name);
  }
});

test('every SQL caller of enqueue_notification is SECURITY DEFINER', () => {
  const sources = [{ name: 'supabase/schema.sql', sql: read('supabase/schema.sql') }, ...laterMigrations];
  const callers = sources.flatMap(({ name, sql }) => functionStatements(sql)
    .filter((fn) => fn.name !== 'enqueue_notification' && CALLS.test(fn.body))
    .map((fn) => ({ ...fn, source: name })));
  assert.ok(callers.length >= 30, `expected the catalogued callers, found ${callers.length}`);
  const invoker = callers.filter((fn) => !/\bSECURITY\s+DEFINER\b/i.test(fn.attributes)).map((fn) => `${fn.source}: ${fn.name}`);
  assert.deepEqual(invoker, [], 'a caller-rights function would fail once clients lose EXECUTE');
});

test('the caller scan reads attributes on either side of the body', () => {
  const parsed = functionStatements(`
    create or replace function public.a() returns void as $$ begin perform public.enqueue_notification(null, 'c', 't'); end $$ language plpgsql security definer;
    CREATE FUNCTION public.b() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN PERFORM enqueue_notification (NULL, 'c', 't'); END $fn$;
  `);
  assert.deepEqual(parsed.map((fn) => [fn.name, CALLS.test(fn.body), /\bSECURITY\s+DEFINER\b/i.test(fn.attributes)]), [
    ['a', true, true],
    ['b', true, false],
  ]);
});

test('web and mobile clients never call enqueue_notification', () => {
  const callers = [...sourceFiles('apps/web/src'), ...sourceFiles('apps/mobile/src')]
    .filter((file) => /rpc\(\s*['"]enqueue_notification['"]/.test(read(file)));
  assert.deepEqual(callers, [], 'clients reach notifications through governed RPCs, not the raw write path');
});

test('edge functions call enqueue_notification only on a service-role client', () => {
  const callers = sourceFiles('supabase/functions')
    .map((file) => ({ file, source: read(file) }))
    .filter(({ source }) => /\.rpc\(\s*['"]enqueue_notification['"]/.test(source));
  assert.ok(callers.length >= 3, `expected the known edge callers, found ${callers.length}`);
  for (const { file, source } of callers) {
    for (const [, receiver] of source.matchAll(/(\w+)\s*\.rpc\(\s*['"]enqueue_notification['"]/g)) {
      assert.match(source, new RegExp(`const ${receiver} = createClient\\(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY\\)`), `${file}: ${receiver}`);
    }
  }
});
