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

test('explicit Atlas requests at any rank reach the read-only Atlas tool when planning falls back to an answer', () => {
  assert.doesNotMatch(chat, /atlasDiagnosticTier/);
  // Declared once: a redeclaration took onspace-ai-chat down with BOOT_ERROR on 2026-10-14.
  assert.equal(chat.match(/const explicitAtlasRequest =/g).length, 1);
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

test('GPS point context is resolved through Caddie and the scoped field service', () => {
  assert.match(caddie, /resolve_point_context: \{/);
  assert.match(caddie, /resolve_point_context: 'resolve-point-context'/);
  assert.match(chat, /async function execResolvePointContext/);
  assert.match(chat, /callFn\('resolve-point-context', authHeader/);
  assert.match(chat, /case 'resolve_point_context':/);
});

test('document search is routed through Caddie to the policy-filtered service', () => {
  assert.match(caddie, /document_search: \{/);
  assert.match(caddie, /document_search: 'bob-document-search'/);
  assert.match(chat, /async function execDocumentSearch/);
  assert.match(chat, /callFn\('bob-document-search', authHeader/);
  assert.match(chat, /case 'document_search':/);
});

test('site risk changes are routed through Caddie to the governed proposal producer', () => {
  assert.match(caddie, /propose_site_risk: \{/);
  assert.match(caddie, /propose_site_risk: 'bob-propose-site-risk'/);
  assert.match(chat, /async function execProposeSiteRisk/);
  assert.match(chat, /callFn\('bob-propose-site-risk', authHeader/);
  assert.match(chat, /case 'propose_site_risk':/);
  assert.match(chat, /_idempotency_key: args\._idempotency_key/);
});

test('patrol route service areas are Caddie-routed governed proposals', () => {
  assert.match(caddie, /propose_patrol_route_service_area: \{/);
  assert.match(caddie, /'bob-propose-patrol-route-service-area'/);
  assert.match(chat, /async function execProposePatrolRouteServiceArea/);
  assert.match(chat, /callFn\('bob-propose-patrol-route-service-area', authHeader/);
  assert.match(chat, /case 'propose_patrol_route_service_area':/);
});

test('organization service areas are Caddie-routed governed proposals', () => {
  assert.match(caddie, /propose_org_jurisdiction: \{/);
  assert.match(caddie, /propose_org_jurisdiction: 'bob-propose-org-jurisdiction'/);
  assert.match(chat, /async function execProposeOrgJurisdiction/);
  assert.match(chat, /callFn\('bob-propose-org-jurisdiction', authHeader/);
  assert.match(chat, /case 'propose_org_jurisdiction':/);
});

test('page friction is routed through the bounded triage organ without claiming a repair receipt', () => {
  assert.match(caddie, /triage_friction: \{/);
  assert.match(caddie, /triage_friction: 'bob-triage-report'/);
  assert.match(chat, /async function execTriageFriction/);
  assert.match(chat, /callFn\('bob-triage-report', authHeader/);
  assert.match(chat, /case 'triage_friction':/);
  assert.match(chat, /Work is queued, not yet started; a Builder receipt will identify the job/);
  assert.match(chat, /This confirms routing, not that a repair has started/);
});

test('visible app navigation is bounded to known role-gated destinations', () => {
  assert.match(caddie, /navigate_app: \{/);
  assert.match(caddie, /navigate_app: 'onspace-ai-chat'/);
  assert.match(chat, /const APP_DESTINATIONS:/);
  assert.match(chat, /roster: \{ label: 'Open Schedules & Rosters', path: '\/admin\/roster'/);
  assert.match(chat, /organization_settings: \{ label: 'Open Organisation Settings', path: '\/admin\/org-setup'/);
  assert.match(chat, /case 'navigate_app':/);
  assert.match(chat, /navigation_actions: \[\{ label: destination\.label, path: destination\.path \}\]/);
  assert.match(chat, /The page will apply your current role, organisation, and module access/);
});

test('corporate profiles are Caddie-routed pending proposals', () => {
  assert.match(caddie, /propose_corporate_profile: \{/);
  assert.match(caddie, /'bob-propose-corporate-profile'/);
  assert.match(chat, /async function execProposeCorporateProfile/);
  assert.match(chat, /callFn\('bob-propose-corporate-profile', authHeader/);
  assert.match(chat, /case 'propose_corporate_profile':/);
});

test('national client roots remain grandmaster-only Caddie-routed proposals', () => {
  assert.match(caddie, /propose_client_root_org: \{/);
  assert.match(caddie, /'bob-propose-client-root-org'/);
  assert.match(chat, /async function execProposeClientRootOrg/);
  assert.match(chat, /caps\.tier !== 'admiral'/);
  assert.match(chat, /callFn\('bob-propose-client-root-org', authHeader/);
  assert.match(chat, /case 'propose_client_root_org':/);
});