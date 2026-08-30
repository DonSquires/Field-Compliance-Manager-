const fs = require('node:fs');
const path = require('node:path');

const MANAGED_SOURCES = [
  'apps/web/src/pages/RosterOperationsPage.tsx',
  'apps/web/src/pages/OfficerSchedulePage.tsx',
  'apps/web/src/pages/RosterHRPage.tsx',
  'apps/web/src/pages/OfficerLeavePage.tsx',
  'apps/web/src/pages/CRMPage.tsx',
  'apps/web/src/pages/WelfareAlertsPage.tsx',
  'apps/web/src/pages/OfficerFieldReportPage.tsx',
  'apps/web/src/hooks/useOfficerSafety.ts',
  'supabase/migrations/20260830128000_roster_work_units.sql',
  'supabase/migrations/20260830129000_materialize_roster_slots.sql',
  'supabase/migrations/20260830130000_roster_slot_response.sql',
  'supabase/migrations/20260830131000_manage_roster_slot.sql',
  'supabase/migrations/20260830132000_reassign_roster_slot.sql',
  'supabase/migrations/20260830133000_enforce_roster_availability.sql',
  'supabase/migrations/20260830134000_organization_calendar_settings.sql',
  'supabase/migrations/20260830135000_roster_commercial_readiness.sql',
  'supabase/migrations/20260830136000_govern_hr_workflows.sql',
  'supabase/migrations/20260830137000_govern_staff_readiness.sql',
  'supabase/migrations/20260830138000_govern_crm_quote_creation.sql',
  'supabase/migrations/20260830139000_govern_crm_quote_lines.sql',
  'supabase/migrations/20260830140000_govern_crm_quote_lifecycle.sql',
  'supabase/migrations/20260830141000_govern_welfare_alert_transitions.sql',
  'supabase/migrations/20260830125000_submit_officer_field_report.sql',
  'supabase/migrations/20260830142000_harden_officer_field_report_submission.sql'
];

function uniqueBy(items, keyOf) {
  return Array.from(new Map(items.map((item) => [keyOf(item), item])).values());
}

function componentName(sourceFile) {
  return sourceFile.replace(/^apps\/web\/src\//, '').replace(/\.(tsx?|jsx?)$/, '');
}

function schemaInventory(rootDir) {
  const schema = fs.readFileSync(path.join(rootDir, 'supabase/schema.sql'), 'utf8');
  const tables = new Set(Array.from(schema.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "public"\."([^"]+)"/g), (match) => match[1]));
  for (const match of schema.matchAll(/create table(?: if not exists)? public\.([a-zA-Z0-9_]+)/gi)) tables.add(match[1]);
  const rpcs = new Set(Array.from(schema.matchAll(/CREATE(?: OR REPLACE)? FUNCTION "public"\."([^"]+)"/g), (match) => match[1]));
  for (const match of schema.matchAll(/create(?: or replace)? function public\.([a-zA-Z0-9_]+)/gi)) rpcs.add(match[1]);
  return { tables, rpcs };
}

function collectComponentEdges(sourceFile, content) {
  const sourceName = componentName(sourceFile);
  const edges = [];
  const tableCalls = Array.from(content.matchAll(/supabase\s*\.\s*from\(['"]([^'"]+)['"]\)/g));
  for (const [index, match] of tableCalls.entries()) {
    const chainEnd = content.indexOf(';', match.index);
    const nextCall = tableCalls[index + 1]?.index ?? content.length;
    const segmentEnd = chainEnd === -1 ? nextCall : Math.min(chainEnd, nextCall);
    const chain = content.slice(match.index, segmentEnd);
    const edgeKind = /\.\s*(?:insert|update|delete|upsert)\s*\(/.test(chain) ? 'writes' : 'reads';
    edges.push({ source_type: 'component', source_name: sourceName, target_type: 'table', target_name: match[1], edge_kind: edgeKind, evidence_class: 'live-code', source_file: sourceFile, caller_context: `Supabase table ${edgeKind === 'writes' ? 'mutation' : 'query'} in component` });
  }
  for (const match of content.matchAll(/supabase\s*\.\s*rpc\(['"]([^'"]+)['"]/g)) {
    edges.push({ source_type: 'component', source_name: sourceName, target_type: 'rpc', target_name: match[1], edge_kind: 'calls', evidence_class: 'live-code', source_file: sourceFile, caller_context: 'Supabase RPC call in component' });
  }
  return edges;
}

function staleGeneratedEdgeIds(existingEdges, generatedEdges) {
  const generatedKeys = new Set(generatedEdges.map((edge) => [edge.source_type, edge.source_name, edge.target_type, edge.target_name, edge.edge_kind, edge.source_file].join('|')));
  return existingEdges.filter((edge) => edge.refresh_source === 'ci_generator' && edge.retirement_status === 'live' && !generatedKeys.has([edge.source_type, edge.source_name, edge.target_type, edge.target_name, edge.edge_kind, edge.source_file].join('|'))).map((edge) => edge.id);
}

function collectRpcEdges(sourceFile, content, inventory) {
  const edges = [];
  const functionPattern = /create(?: or replace)? function public\.([a-zA-Z0-9_]+)[\s\S]*?as \$\$([\s\S]*?)\$\$;/gi;
  for (const match of content.matchAll(functionPattern)) {
    const sourceName = match[1];
    const body = match[2];
    const writes = new Set();
    for (const write of body.matchAll(/(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-zA-Z0-9_]+)/gi)) {
      if (inventory.tables.has(write[1])) writes.add(write[1]);
    }
    const reads = new Set();
    for (const read of body.matchAll(/(?:from|join)\s+(?:public\.)?([a-zA-Z0-9_]+)/gi)) {
      if (inventory.tables.has(read[1])) reads.add(read[1]);
    }
    for (const table of writes) edges.push({ source_type: 'rpc', source_name: sourceName, target_type: 'table', target_name: table, edge_kind: 'writes', evidence_class: 'live-schema', source_file: sourceFile, caller_context: 'SQL mutation in RPC body' });
    for (const table of reads) edges.push({ source_type: 'rpc', source_name: sourceName, target_type: 'table', target_name: table, edge_kind: 'reads', evidence_class: 'live-schema', source_file: sourceFile, caller_context: 'SQL query in RPC body' });
    for (const call of body.matchAll(/public\.([a-zA-Z0-9_]+)\s*\(/gi)) {
      if (call[1] !== sourceName && inventory.rpcs.has(call[1])) edges.push({ source_type: 'rpc', source_name: sourceName, target_type: 'rpc', target_name: call[1], edge_kind: 'calls', evidence_class: 'live-schema', source_file: sourceFile, caller_context: 'SQL function call in RPC body' });
    }
  }
  for (const trigger of content.matchAll(/create trigger\s+[a-zA-Z0-9_]+[\s\S]*?\s+on\s+public\.([a-zA-Z0-9_]+)[\s\S]*?execute function\s+public\.([a-zA-Z0-9_]+)\s*\(/gi)) {
    edges.push({ source_type: 'table', source_name: trigger[1], target_type: 'rpc', target_name: trigger[2], edge_kind: 'triggers', evidence_class: 'live-schema', source_file: sourceFile, caller_context: 'PostgreSQL trigger execution' });
  }
  return edges;
}

function collectManagedAtlas(rootDir = process.cwd()) {
  const inventory = schemaInventory(rootDir);
  const edges = [];
  for (const sourceFile of MANAGED_SOURCES) {
    const content = fs.readFileSync(path.join(rootDir, sourceFile), 'utf8');
    edges.push(...(sourceFile.startsWith('apps/web/src/') ? collectComponentEdges(sourceFile, content) : collectRpcEdges(sourceFile, content, inventory)));
  }
  const dedupedEdges = uniqueBy(edges, (edge) => [edge.source_type, edge.source_name, edge.target_type, edge.target_name, edge.edge_kind, edge.source_file].join('|'));
  const nodes = uniqueBy(dedupedEdges.flatMap((edge) => [
    ...(['table', 'rpc'].includes(edge.source_type) ? [{ entity_type: edge.source_type, entity_name: edge.source_name }] : []),
    ...(['table', 'rpc'].includes(edge.target_type) ? [{ entity_type: edge.target_type, entity_name: edge.target_name }] : [])
  ]), (node) => `${node.entity_type}|${node.entity_name}`);
  return { scope: 'managed_app', sources: MANAGED_SOURCES, nodes, edges: dedupedEdges };
}

async function requestJson(url, key, pathname, options = {}) {
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${pathname}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Atlas request failed (${response.status}): ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function syncManagedAtlas(atlas, env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const now = new Date().toISOString();
  for (const sourceFile of atlas.sources) {
    const existing = await requestJson(url, key, `bob_app_map_edges?source_file=eq.${encodeURIComponent(sourceFile)}&refresh_source=eq.ci_generator&select=id,source_type,source_name,target_type,target_name,edge_kind,source_file,refresh_source,retirement_status`);
    const generated = atlas.edges.filter((edge) => edge.source_file === sourceFile);
    for (const edgeId of staleGeneratedEdgeIds(existing, generated)) {
      await requestJson(url, key, `bob_app_map_edges?id=eq.${edgeId}&refresh_source=eq.ci_generator`, { method: 'PATCH', body: JSON.stringify({ retirement_status: 'legacy', last_refreshed_at: now, updated_at: now }) });
    }
  }
  for (const node of atlas.nodes) {
    const filter = `entity_type=eq.${encodeURIComponent(node.entity_type)}&entity_name=eq.${encodeURIComponent(node.entity_name)}&select=id,refresh_source`;
    const existing = await requestJson(url, key, `bob_capability_map?${filter}`);
    const callers = atlas.edges.filter((edge) => edge.target_type === node.entity_type && edge.target_name === node.entity_name).map((edge) => edge.source_name);
    const payload = { present: true, wired: true, caller_summary: Array.from(new Set(callers)).sort().join(', ') || 'roster SQL flow', notes: '[repo-atlas-refresh:v1] static source inventory; exercised is never inferred', last_refreshed_at: now, updated_at: now, retirement_status: 'live' };
    if (existing[0]?.refresh_source === 'manual_seed') continue;
    if (existing[0]) await requestJson(url, key, `bob_capability_map?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify({ ...payload, refresh_source: 'ci_generator' }) });
    else await requestJson(url, key, 'bob_capability_map', { method: 'POST', body: JSON.stringify({ ...node, ...payload, refresh_source: 'ci_generator' }) });
  }
  for (const edge of atlas.edges) {
    const identity = `source_type=eq.${encodeURIComponent(edge.source_type)}&source_name=eq.${encodeURIComponent(edge.source_name)}&target_type=eq.${encodeURIComponent(edge.target_type)}&target_name=eq.${encodeURIComponent(edge.target_name)}&edge_kind=eq.${encodeURIComponent(edge.edge_kind)}&source_file=eq.${encodeURIComponent(edge.source_file)}&select=id,refresh_source`;
    const existing = await requestJson(url, key, `bob_app_map_edges?${identity}`);
    if (existing[0] && existing[0].refresh_source !== 'ci_generator') continue;
    const payload = { ...edge, refresh_source: 'ci_generator', retirement_status: 'live', last_refreshed_at: now, updated_at: now };
    if (existing[0]) await requestJson(url, key, `bob_app_map_edges?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await requestJson(url, key, 'bob_app_map_edges', { method: 'POST', body: JSON.stringify(payload) });
  }
  return { nodes: atlas.nodes.length, edges: atlas.edges.length };
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const atlas = collectManagedAtlas(rootDir);
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ mode: 'dry-run', ...atlas }, null, 2));
    return;
  }
  const result = await syncManagedAtlas(atlas);
  console.log(`Atlas managed refresh applied: ${result.nodes} nodes, ${result.edges} edges`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { collectComponentEdges, collectManagedAtlas, staleGeneratedEdgeIds, syncManagedAtlas };