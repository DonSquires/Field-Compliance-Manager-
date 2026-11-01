// Resolves the effective RLS policy catalog: the live schema snapshot at its
// applied_migrations header, with every newer migration's CREATE / ALTER /
// DROP POLICY statements replayed on top.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

function repositoryPolicies(root) {
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: read(`supabase/migrations/${name}`) }));
  return effectivePolicies(read('supabase/schema.sql'), migrations);
}

module.exports = {
  applyPolicyStatements,
  clauses,
  effectivePolicies,
  flat,
  parenthesised,
  repositoryPolicies,
  unquote,
};
