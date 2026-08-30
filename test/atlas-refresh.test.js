const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { collectComponentEdges, collectManagedAtlas, staleGeneratedEdgeIds } = require('../scripts/atlas-refresh');
const refreshSource = require('node:fs').readFileSync(path.resolve(__dirname, '../scripts/atlas-refresh.js'), 'utf8');

test('managed Atlas refresh derives real component and RPC flow edges', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);

  assert.equal(atlas.scope, 'managed_app');
  assert.equal(hasEdge('pages/RosterOperationsPage', 'roster_slots', 'reads'), true);
  assert.equal(hasEdge('pages/RosterOperationsPage', 'reassign_roster_slot', 'calls'), true);
  assert.equal(hasEdge('reassign_roster_slot', 'roster_slots', 'reads'), true);
  assert.equal(hasEdge('reassign_roster_slot', 'roster_slots', 'writes'), true);
  assert.equal(hasEdge('reassign_roster_slot', 'shifts', 'writes'), true);
  assert.equal(hasEdge('manage_roster_slot', 'materialize_roster_slot', 'calls'), true);
  assert.equal(hasEdge('respond_to_roster_slot', 'audit_log', 'writes'), true);
  assert.equal(hasEdge('staff_has_roster_availability_conflict', 'staff_availability', 'reads'), true);
  assert.equal(hasEdge('enforce_roster_slot_availability', 'staff_has_roster_availability_conflict', 'calls'), true);
  assert.equal(hasEdge('roster_slots', 'enforce_roster_slot_availability', 'triggers'), true);
  assert.equal(hasEdge('pages/RosterOperationsPage', 'organization_calendar_settings', 'reads'), true);
  assert.equal(hasEdge('pages/RosterOperationsPage', 'set_organization_calendar_region', 'calls'), true);
  assert.equal(hasEdge('set_organization_calendar_region', 'organization_calendar_settings', 'writes'), true);
  assert.equal(hasEdge('pages/RosterOperationsPage', 'get_roster_commercial_readiness', 'calls'), true);
  assert.equal(hasEdge('get_roster_commercial_readiness', 'rate_rules', 'reads'), true);
  assert.equal(hasEdge('get_roster_commercial_readiness', 'quotes', 'reads'), true);
  assert.equal(hasEdge('roster_place_geofence_state', 'geofence_boundary_history', 'reads'), true);
  assert.equal(hasEdge('pages/RosterHRPage', 'review_leave_request', 'calls'), true);
  assert.equal(hasEdge('pages/OfficerLeavePage', 'submit_officer_leave_request', 'calls'), true);
  assert.equal(hasEdge('review_timesheet', 'timesheets', 'writes'), true);
  assert.equal(hasEdge('create_shift_coverage_request', 'shift_coverage_requests', 'writes'), true);
  assert.equal(hasEdge('pages/RosterHRPage', 'get_staff_readiness_assessment', 'calls'), true);
  assert.equal(hasEdge('pages/RosterHRPage', 'set_staff_work_readiness', 'calls'), true);
  assert.equal(hasEdge('get_staff_readiness_assessment', 'staff_credentials', 'reads'), true);
  assert.equal(hasEdge('get_staff_readiness_assessment', 'staff_training_records', 'reads'), true);
  assert.equal(hasEdge('set_staff_work_readiness', 'staff_profiles', 'writes'), true);
  assert.equal(hasEdge('pages/CRMPage', 'crm_contacts', 'reads'), true);
  assert.equal(hasEdge('pages/CRMPage', 'quotes', 'reads'), true);
  assert.equal(hasEdge('pages/CRMPage', 'create_crm_draft_quote', 'calls'), true);
  assert.equal(hasEdge('create_crm_draft_quote', 'quotes', 'writes'), true);
  assert.equal(hasEdge('pages/CRMPage', 'add_crm_quote_line', 'calls'), true);
  assert.equal(hasEdge('add_crm_quote_line', 'quote_lines', 'writes'), true);
  assert.equal(hasEdge('add_crm_quote_line', 'quotes', 'writes'), true);
  assert.equal(hasEdge('add_crm_quote_line', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('pages/CRMPage', 'manage_crm_quote', 'calls'), true);
  assert.equal(hasEdge('manage_crm_quote', 'quote_lines', 'reads'), true);
  assert.equal(hasEdge('manage_crm_quote', 'quotes', 'writes'), true);
  assert.equal(hasEdge('manage_crm_quote', 'accept_quote', 'calls'), true);
});

test('managed Atlas refresh includes capability nodes without inferring exercise', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  assert.ok(atlas.nodes.some((node) => node.entity_type === 'table' && node.entity_name === 'roster_slots'));
  assert.ok(atlas.nodes.some((node) => node.entity_type === 'rpc' && node.entity_name === 'reassign_roster_slot'));
  assert.equal(atlas.nodes.some((node) => Object.hasOwn(node, 'exercised')), false);
  assert.match(refreshSource, /refresh_source !== 'ci_generator'/);
});

test('component extraction tolerates formatted multiline Supabase chains', () => {
  const edges = collectComponentEdges('apps/web/src/pages/ExamplePage.tsx', `
    const rows = supabase
      .from('crm_contacts')
      .select('*');
    await supabase
      .rpc('create_crm_draft_quote', { p_title: 'Example' });
  `);
  assert.ok(edges.some((edge) => edge.target_name === 'crm_contacts' && edge.edge_kind === 'reads'));
  assert.ok(edges.some((edge) => edge.target_name === 'create_crm_draft_quote' && edge.edge_kind === 'calls'));
});

test('stale edge retirement is scoped to live CI-generated identities', () => {
  const base = { source_type: 'component', source_name: 'pages/CRMPage', target_type: 'table', source_file: 'apps/web/src/pages/CRMPage.tsx', retirement_status: 'live' };
  const existing = [
    { ...base, id: 'keep', target_name: 'quotes', edge_kind: 'reads', refresh_source: 'ci_generator' },
    { ...base, id: 'stale', target_name: 'quote_lines', edge_kind: 'writes', refresh_source: 'ci_generator' },
    { ...base, id: 'manual', target_name: 'quote_lines', edge_kind: 'writes', refresh_source: 'manual_seed' },
  ];
  const generated = [{ ...base, target_name: 'quotes', edge_kind: 'reads' }];
  assert.deepEqual(staleGeneratedEdgeIds(existing, generated), ['stale']);
});