'use strict';

/**
 * Data-path gate for backend patches: a caller-scoped Supabase read of a table whose row-level
 * security admits only the service role returns nothing for every real user. It passes every
 * syntax check and every regex test, and the feature is dead on arrival.
 *
 * Live 2026-09-27 (job 79b4c08f, Gitea PR #8): the chat `cancel_builder_job` tool looked jobs up with
 * `callerClient.from('builder_jobs')`; builder_jobs has one policy (service_role) — every lookup would
 * have answered "no job found". The 7B reviewer and the static security scan both passed it. This
 * check is what AGENTS.md asks of every agent ("Atlas says wired but no reader") made mechanical.
 *
 * Ground truth is supabase/schema.sql (regenerated from the live catalog). Pure functions; no I/O
 * beyond what the caller hands in.
 */

// Identifiers this codebase uses for a client that carries the caller's JWT (edge functions).
const CALLER_CLIENTS = ['callerClient', 'userClient', 'callerSupabase', 'userSupabase', 'clientAsCaller', 'asCaller'];
const CALLER_READ = new RegExp(`\\b(?:${CALLER_CLIENTS.join('|')})\\s*\\.\\s*from\\(\\s*['"\`]([a-z_][a-z0-9_]*)['"\`]\\s*\\)`, 'g');

/** Added lines per file from a unified diff (paths from the +++ header). */
function addedLinesByFile(patchText) {
  const files = new Map();
  let current = null;
  for (const line of String(patchText ?? '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !files.has(current)) files.set(current, []);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('@@') || line.startsWith('index ')) continue;
    if (current && line.startsWith('+')) files.get(current).push(line.slice(1));
  }
  return files;
}

/**
 * RLS facts per table from schema.sql: whether RLS is enabled and the USING/WITH CHECK expressions
 * of every policy. A table with RLS enabled whose policies are all service_role-only is invisible to
 * an authenticated caller.
 */
function tableAccessFromSchema(schemaSql) {
  const text = String(schemaSql ?? '');
  const rls = new Set();
  for (const match of text.matchAll(/ALTER TABLE(?: ONLY)? "public"\."([a-z_][a-z0-9_]*)" ENABLE ROW LEVEL SECURITY;/g)) rls.add(match[1]);
  const policies = new Map();
  for (const match of text.matchAll(/CREATE POLICY "([^"]+)" ON "public"\."([a-z_][a-z0-9_]*)"([^;]*);/g)) {
    const [, name, table, rest] = match;
    const list = policies.get(table) || [];
    list.push({ name, clause: rest.replace(/\s+/g, ' ').trim() });
    policies.set(table, list);
  }
  return {
    tables: new Set([...text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "public"\."([a-z_][a-z0-9_]*)"/g)].map((m) => m[1])),
    rlsEnabled: (table) => rls.has(table),
    policies: (table) => policies.get(table) || [],
  };
}

const SERVICE_ROLE_ONLY = /auth\.role\(\)\s*=\s*'service_role'/;
// A policy that names any other principal or condition lets some caller through.
const CALLER_PATH = /auth\.uid\(\)|authenticated|org_access_allowed|is_admin|has_role|current_user_org|jwt\(\)|TO\s+"?(?:authenticated|anon|public)"?/i;

function callerCanRead(access, table) {
  if (!access.tables.has(table)) return { known: false };
  if (!access.rlsEnabled(table)) return { known: true, readable: true, reason: 'RLS is not enabled' };
  const policies = access.policies(table);
  if (!policies.length) return { known: true, readable: false, reason: 'RLS is enabled and the table has no policies' };
  const serviceOnly = policies.every((policy) => SERVICE_ROLE_ONLY.test(policy.clause) && !CALLER_PATH.test(policy.clause.replace(SERVICE_ROLE_ONLY, '')));
  if (serviceOnly) return { known: true, readable: false, reason: `the only polic${policies.length === 1 ? 'y is' : 'ies are'} service_role-only (${policies.map((p) => p.name).join(', ')})` };
  return { known: true, readable: true, reason: 'a caller-facing policy exists' };
}

/**
 * Findings for a patch: every added caller-scoped read of a table the caller cannot see.
 * Returns [] when the patch is clean or schema.sql is not available.
 */
function checkCallerReads(patchText, schemaSql) {
  if (!schemaSql) return [];
  const access = tableAccessFromSchema(schemaSql);
  const findings = [];
  for (const [file, lines] of addedLinesByFile(patchText)) {
    if (!/\.(?:ts|js|mjs|tsx)$/.test(file) || /^test\//.test(file)) continue;
    lines.forEach((line, index) => {
      for (const match of line.matchAll(CALLER_READ)) {
        const table = match[1];
        const verdict = callerCanRead(access, table);
        if (verdict.known && !verdict.readable) {
          findings.push({
            file,
            table,
            line: line.trim().slice(0, 200),
            added_line_index: index,
            reason: verdict.reason,
            message: `${file}: caller-scoped read of "${table}" will always return no rows for a real user — ${verdict.reason}. Read it through a path that verifies the caller and then uses the service role (for Builder tables: callFn('bob-builder-control-room', authHeader, { action: 'list' }) like create_builder_job does), or add a policy in a NEW migration.`,
          });
        }
      }
    });
  }
  return findings;
}

module.exports = { CALLER_CLIENTS, addedLinesByFile, callerCanRead, checkCallerReads, tableAccessFromSchema };
