const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { collectRosterAtlas } = require('../scripts/atlas-refresh');
const refreshSource = require('node:fs').readFileSync(path.resolve(__dirname, '../scripts/atlas-refresh.js'), 'utf8');

test('roster Atlas refresh derives real component and RPC flow edges', () => {
  const atlas = collectRosterAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);

  assert.equal(atlas.scope, 'roster');
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
});

test('roster Atlas refresh includes capability nodes without inferring exercise', () => {
  const atlas = collectRosterAtlas(path.resolve(__dirname, '..'));
  assert.ok(atlas.nodes.some((node) => node.entity_type === 'table' && node.entity_name === 'roster_slots'));
  assert.ok(atlas.nodes.some((node) => node.entity_type === 'rpc' && node.entity_name === 'reassign_roster_slot'));
  assert.equal(atlas.nodes.some((node) => Object.hasOwn(node, 'exercised')), false);
  assert.match(refreshSource, /refresh_source !== 'ci_generator'/);
});