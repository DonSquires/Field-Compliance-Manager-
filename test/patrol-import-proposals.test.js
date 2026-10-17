const assert = require('node:assert/strict');
const test = require('node:test');

const loadModule = () => import('../scripts/patrol-import-proposals.mjs');

function row(overrides = {}) {
  return {
    externalRef: 'rm_patrol_import:OFO2025:123',
    evidenceRecordType: 'location_events',
    providerOrganizationId: '11111111-1111-4111-8111-111111111111',
    clientOrganizationId: '22222222-2222-4222-8222-222222222222',
    clientCode: 'OFO2025',
    occurredAt: '2025-08-14T09:30:00+12:00',
    zoneId: '33333333-3333-4333-8333-333333333333',
    siteId: null,
    officerId: '44444444-4444-4444-8444-444444444444',
    payload: {
      classification_profile: 'rm_patrol_log',
      source_file: 'reviewed-source.xlsx',
      source_sha256: 'a'.repeat(64),
      derivative_sha256: 'b'.repeat(64),
      source_sheet: '2025',
      source_row: 12,
      job_number: '123',
      patroller_raw: 'Reviewed Officer',
      location_raw: 'Reviewed Place',
      reserve_raw: 'ZONE',
      source_category: 'Maintenance',
      subject: 'E-Lock',
      issue: 'Repair',
      comments: 'Electronic lock would not open.',
      job_cost: 85,
      travel_cost: 20,
      total_cost: 105,
      work_order_candidate: true,
      work_subject_code_id: '55555555-5555-4555-8555-555555555555',
      work_subject_code: 'electronic_lock',
      work_activity_code_id: '66666666-6666-4666-8666-666666666666',
      work_activity_code: 'maintenance',
      classification_rule_ids: ['77777777-7777-4777-8777-777777777777'],
    },
    ...overrides,
  };
}

test('stages separate work-order and finance proposals without treating cost evidence as complete finance data', async () => {
  const { buildPatrolImportProposals } = await loadModule();
  const proposals = buildPatrolImportProposals(row());

  assert.deepEqual(proposals.map((proposal) => proposal.target_type), ['workshop_work_order', 'finance_service_cost']);
  assert.equal(proposals[0].proposed_payload.kind, 'maintenance');
  assert.equal(proposals[0].proposed_payload.work_subject_code_id, '55555555-5555-4555-8555-555555555555');
  assert.equal(proposals[1].proposed_payload.requires_cost_type_mapping, true);
  assert.equal(proposals[1].confidence, null);
  assert.equal(proposals[1].source_values.patroller_raw, 'Reviewed Officer');
  assert.equal(proposals[1].source_values.work_subject_code, 'electronic_lock');
  assert.equal(proposals[1].source_values.comments, 'Electronic lock would not open.');
});

test('does not propose maintenance work for routine rows', async () => {
  const { buildPatrolImportProposals } = await loadModule();
  const input = row({ payload: { ...row().payload, work_order_candidate: false, job_cost: null, travel_cost: null, total_cost: null } });
  assert.deepEqual(buildPatrolImportProposals(input), []);
});

test('keeps cost-only evidence in review even when no work subject or place is resolved', async () => {
  const { buildPatrolImportProposals } = await loadModule();
  const input = row({
    zoneId: null,
    payload: {
      ...row().payload,
      work_subject_code_id: null,
      work_order_candidate: true,
      job_cost: null,
      travel_cost: 12.5,
      total_cost: null,
    },
  });
  const proposals = buildPatrolImportProposals(input);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].target_type, 'finance_service_cost');
  assert.equal(proposals[0].source_values.travel_cost, 12.5);
});
