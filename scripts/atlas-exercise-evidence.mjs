#!/usr/bin/env node
/**
 * Atlas exercise evidence.
 *
 * Doctrine: `wired` is a static claim; `exercised` may only come from real
 * invocation receipts. This reads append-only runtime evidence and marks the
 * capabilities that genuinely ran. It never infers exercise from wiring, never
 * writes `exercised = false` from absence of evidence, and writes only Atlas's
 * own capability column plus its append-only evidence ledger.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAGE_SIZE = 1000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOOL_ROUTING_SOURCE = 'supabase/functions/onspace-ai-chat/caddie.ts';

/**
 * The conductor owns the authoritative tool -> edge function routing table.
 * Parsing it keeps exercise evidence aligned with code truth instead of a
 * hand-copied duplicate that silently drifts.
 */
export function parseToolRouting(source) {
  const start = source.indexOf('const toolToEdgeFn');
  if (start === -1) return {};
  const open = source.indexOf('{', start);
  if (open === -1) return {};

  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  if (end === -1) return {};

  const routing = {};
  const block = source.slice(open + 1, end);
  for (const line of block.split('\n')) {
    const withoutComment = line.replace(/\/\/.*$/, '');
    const match = withoutComment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']+)'\s*,?\s*$/);
    if (match) routing[match[1]] = match[2];
  }
  return routing;
}

function loadToolRouting() {
  const file = path.join(ROOT, TOOL_ROUTING_SOURCE);
  if (!fs.existsSync(file)) return {};
  return parseToolRouting(fs.readFileSync(file, 'utf8'));
}

const TOOL_ROUTING = loadToolRouting();

export const EVIDENCE_SOURCES = Object.freeze([
  {
    id: 'bob_tool_invocation',
    table: 'bob_event_log',
    select: 'tool,created_at',
    entityType: 'edge_function',
    basis: 'Bob conductor dispatched this tool in a live conversation turn.',
    extract: (row) => (row.tool ? { key: row.tool, at: row.created_at } : null),
    candidateNames: (key) => (TOOL_ROUTING[key] ? [TOOL_ROUTING[key]] : []),
  },
  {
    id: 'audited_table_write',
    table: 'audit_log',
    select: 'target_table,created_at',
    entityType: 'table',
    basis: 'An audited platform action wrote this table.',
    extract: (row) => {
      // The capability map inventories the public schema only; a qualified
      // name such as vault.secrets is deliberately out of scope.
      if (!row.target_table || (row.target_table.includes('.') && !row.target_table.startsWith('public.'))) return null;
      return { key: row.target_table, at: row.created_at };
    },
    candidateNames: (key) => [key, key.replace(/^public\./, '')],
  },
  {
    id: 'perception_envelope_write',
    table: 'perception_evidence_envelopes',
    select: 'domain,created_at',
    entityType: 'table',
    basis: 'A perception adapter compiled a hash-backed evidence envelope.',
    extract: (row) => (row.domain ? { key: row.domain, at: row.created_at } : null),
    candidateNames: () => ['perception_evidence_envelopes', 'perception_evidence_fields'],
  },
  {
    id: 'human_evidence_review',
    table: 'perception_evidence_reviews',
    select: 'decision,decided_at',
    entityType: 'table',
    basis: 'A human recorded an attributable decision over a perception candidate.',
    extract: (row) => (row.decision ? { key: row.decision, at: row.decided_at } : null),
    candidateNames: () => ['perception_evidence_reviews'],
  },
  {
    id: 'builder_model_run',
    table: 'builder_model_runs',
    select: 'id,created_at',
    entityType: 'table',
    basis: 'A Builder model run was recorded.',
    extract: (row) => ({ key: 'builder_model_run', at: row.created_at }),
    candidateNames: () => ['builder_model_runs'],
  },
  {
    id: 'builder_worker_run',
    table: 'builder_worker_runs',
    select: 'id,created_at',
    entityType: 'table',
    basis: 'A Builder worker run was recorded.',
    extract: (row) => ({ key: 'builder_worker_run', at: row.created_at }),
    candidateNames: () => ['builder_worker_runs'],
  },
  {
    id: 'bob_task_run',
    table: 'bob_task_runs',
    select: 'id,created_at',
    entityType: 'table',
    basis: 'A governed Bob task run was recorded.',
    extract: (row) => ({ key: 'bob_task_run', at: row.created_at }),
    candidateNames: () => ['bob_task_runs'],
  },
]);

function requireCredentials() {
  if (!BASE_URL || !SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
}

async function rest(path, init = {}) {
  const response = await fetch(`${BASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function fetchAll(table, select) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await rest(`${table}?select=${select}&limit=${PAGE_SIZE}&offset=${offset}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

export function buildExercisePlan(capabilities, observations) {
  const byKey = new Map();
  for (const capability of capabilities) {
    byKey.set(`${capability.entity_type}\u0000${capability.entity_name}`, capability);
  }

  const resolved = new Map();
  const unresolved = new Map();

  for (const observation of observations) {
    const names = observation.candidateNames;
    const match = names
      .map((name) => byKey.get(`${observation.entityType}\u0000${name}`))
      .find(Boolean);

    if (!match) {
      const key = `${observation.entityType}:${observation.key}`;
      const existing = unresolved.get(key) ?? { entity_type: observation.entityType, key: observation.key, source_id: observation.sourceId, invocations: 0 };
      existing.invocations += 1;
      unresolved.set(key, existing);
      continue;
    }

    const entityKey = `${match.entity_type}\u0000${match.entity_name}`;
    const entry = resolved.get(entityKey) ?? {
      id: match.id,
      entity_type: match.entity_type,
      entity_name: match.entity_name,
      present: match.present,
      wired: match.wired,
      previously_exercised: match.exercised,
      invocations: 0,
      sources: new Map(),
      first_seen_at: null,
      last_seen_at: null,
    };

    entry.invocations += 1;
    const source = entry.sources.get(observation.sourceId) ?? { source_id: observation.sourceId, basis: observation.basis, invocations: 0, keys: new Set() };
    source.invocations += 1;
    source.keys.add(observation.key);
    entry.sources.set(observation.sourceId, source);

    if (observation.at) {
      if (!entry.first_seen_at || observation.at < entry.first_seen_at) entry.first_seen_at = observation.at;
      if (!entry.last_seen_at || observation.at > entry.last_seen_at) entry.last_seen_at = observation.at;
    }
    resolved.set(entityKey, entry);
  }

  const exercised = [...resolved.values()]
    .map((entry) => ({
      ...entry,
      sources: [...entry.sources.values()]
        .map((source) => ({ ...source, keys: [...source.keys].sort().slice(0, 20) }))
        .sort((left, right) => right.invocations - left.invocations),
    }))
    .sort((left, right) => right.invocations - left.invocations);

  return {
    exercised,
    pending_writes: exercised.filter((entry) => entry.previously_exercised !== true),
    unresolved: [...unresolved.values()].sort((left, right) => right.invocations - left.invocations),
  };
}

async function collectObservations() {
  const observations = [];
  const sourceStats = [];

  for (const source of EVIDENCE_SOURCES) {
    let rows = [];
    let error = null;
    try {
      rows = await fetchAll(source.table, source.select);
    } catch (cause) {
      error = cause.message;
    }

    let used = 0;
    for (const row of rows) {
      const extracted = source.extract(row);
      if (!extracted?.key) continue;
      used += 1;
      observations.push({
        sourceId: source.id,
        basis: source.basis,
        entityType: source.entityType,
        key: extracted.key,
        at: extracted.at ?? null,
        candidateNames: source.candidateNames(extracted.key),
      });
    }
    sourceStats.push({ source_id: source.id, table: source.table, rows_read: rows.length, observations: used, error });
  }

  return { observations, sourceStats };
}

async function applyExercised(entries) {
  let written = 0;
  for (const entry of entries) {
    await rest(`bob_capability_map?id=eq.${entry.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ exercised: true }),
    });
    written += 1;
  }
  return written;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  requireCredentials();

  const capabilities = await fetchAll('bob_capability_map', 'id,entity_type,entity_name,present,wired,exercised,retirement_status');
  const live = capabilities.filter((row) => row.retirement_status !== 'legacy');
  const { observations, sourceStats } = await collectObservations();
  const plan = buildExercisePlan(live, observations);

  const report = {
    generated_at: new Date().toISOString(),
    tool_routing_source: TOOL_ROUTING_SOURCE,
    tool_routes_known: Object.keys(TOOL_ROUTING).length,
    capabilities_considered: live.length,
    evidence_sources: sourceStats,
    total_observations: observations.length,
    exercised_entities: plan.exercised.length,
    newly_exercised: plan.pending_writes.length,
    already_exercised: plan.exercised.length - plan.pending_writes.length,
    unresolved_evidence: plan.unresolved.length,
    applied: false,
    exercised: plan.exercised.map((entry) => ({
      entity_type: entry.entity_type,
      entity_name: entry.entity_name,
      wired: entry.wired,
      invocations: entry.invocations,
      first_seen_at: entry.first_seen_at,
      last_seen_at: entry.last_seen_at,
      sources: entry.sources.map((source) => ({ source_id: source.source_id, invocations: source.invocations })),
    })),
    unresolved: plan.unresolved,
  };

  if (args.has('--apply')) {
    report.written = await applyExercised(plan.pending_writes);
    report.applied = true;
  }

  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Atlas exercise evidence');
    for (const stat of sourceStats) {
      const detail = stat.error ? `ERROR ${stat.error}` : `${stat.rows_read} rows -> ${stat.observations} observations`;
      console.log(`  ${stat.source_id}: ${detail}`);
    }
    console.log(`Exercised capabilities proven by invocation: ${report.exercised_entities}`);
    console.log(`Newly provable: ${report.newly_exercised}; already recorded: ${report.already_exercised}`);
    console.log(`Unresolved evidence keys (no matching capability): ${report.unresolved_evidence}`);
    console.log(report.applied ? `Applied exercised=true to ${report.written} capabilities` : 'Dry run; pass --apply to record exercise evidence');
  }

  if (sourceStats.some((stat) => stat.error)) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Atlas exercise evidence failed: ${error.message}`);
    process.exitCode = 1;
  });
}
