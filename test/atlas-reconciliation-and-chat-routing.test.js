const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260908002000_reconcile_seed_data_for_atlas.sql'), 'utf8');
const compare = fs.readFileSync(path.join(root, 'supabase/functions/bob-client-site-compare/index.ts'), 'utf8');
const chat = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');

test('seed data reconciliation is service-role-only and never invents canonical records', () => {
  assert.match(migration, /refresh_fs_nelson_clients_clean/);
  assert.match(migration, /reconcile_downer_linz_vehicle_log/);
  assert.match(migration, /canonical_vehicles vehicle on vehicle\.plate_number = candidate\.plate/);
  assert.doesNotMatch(migration, /insert into public\.(?:organizations|client_sites|canonical_vehicles|observations)/i);
  assert.match(migration, /grant execute on function public\.refresh_fs_nelson_clients_clean\(\) to service_role/i);
  assert.match(migration, /grant execute on function public\.reconcile_downer_linz_vehicle_log\(integer\) to service_role/i);
  assert.match(compare, /'fs_nelson_clients_clean'/);
  assert.doesNotMatch(compare, /'_seed_fs_nelson_clients_raw'/);
});

test('explicit admiral Atlas requests reach the read-only Atlas tool when planning falls back to an answer', () => {
  assert.match(chat, /const explicitAtlasRequest = caps\.tier === 'admiral'/);
  assert.match(chat, /chosenTool = 'query_atlas'/);
  assert.match(chat, /action: requestedAtlasAction/);
  assert.match(chat, /'expectation_report'/);
  assert.match(caddie, /export function resolveCatalogueTool/);
  assert.match(chat, /resolveCatalogueTool\(catalogue, d\.tool\)/);
  assert.doesNotMatch(chat, /const toolByCanon = new Map/);
});

test('site risk is available only through Caddie and its scoped edge function', () => {
  assert.match(caddie, /site_risk: \{/);
  assert.match(caddie, /site_risk: 'bob-site-risk'/);
  assert.match(chat, /async function execSiteRisk/);
  assert.match(chat, /callFn\('bob-site-risk', authHeader/);
  assert.match(chat, /case 'site_risk':/);
});

test('site risk changes are routed through Caddie to the governed proposal producer', () => {
  assert.match(caddie, /propose_site_risk: \{/);
  assert.match(caddie, /propose_site_risk: 'bob-propose-site-risk'/);
  assert.match(chat, /async function execProposeSiteRisk/);
  assert.match(chat, /callFn\('bob-propose-site-risk', authHeader/);
  assert.match(chat, /case 'propose_site_risk':/);
  assert.match(chat, /_idempotency_key: args\._idempotency_key/);
});