const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

async function fixture() {
  const { buildReconciliationPlan, recordFingerprint } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const row = {
    external_ref: 'rm_patrol_import:TEST:42', occurred_at: '2026-10-19T12:00:00+12:00',
    zone_id: 'test-zone', event_type: 'camera_activation',
    payload: { job_number: '42', source_file: 'source.xlsx', source_sheet: 'DATA', source_sha256: 'hash-1', comments: 'original' },
  };
  const sourcePlan = { mode: 'plan', source_file: 'source.xlsx', source_sheet: 'DATA', source_sha256: 'hash-1', observations: [], events: [row] };
  const desired = buildReconciliationPlan({ sourcePlan, existing: [] }).actions[0].desired;
  const existing = [{ external_ref: row.external_ref, id: 'existing-id', kind: 'event', source_file: 'source.xlsx', source_sheet: 'DATA', record: desired }];
  const checkpoints = [{ external_ref: row.external_ref, record_fingerprint: recordFingerprint(desired), source_fingerprint: recordFingerprint(desired) }];
  return { buildReconciliationPlan, recordFingerprint, row, sourcePlan, existing, checkpoints };
}

test('new source jobs are insert candidates and identical rows are unchanged', async () => {
  const { buildReconciliationPlan, sourcePlan, existing } = await fixture();
  assert.equal(buildReconciliationPlan({ sourcePlan, existing: [] }).summary.insert, 1);
  const matched = buildReconciliationPlan({ sourcePlan, existing });
  assert.equal(matched.summary.unchanged, 1);
  assert.equal(matched.actions[0].record_id, 'existing-id');
});

test('a workbook-only hash or row-position change does not rewrite unchanged activity', async () => {
  const { buildReconciliationPlan, sourcePlan, existing } = await fixture();
  sourcePlan.source_sha256 = 'hash-2';
  sourcePlan.events[0].payload.source_sha256 = 'hash-2';
  sourcePlan.events[0].payload.source_row = 100;
  sourcePlan.events[0].payload.derivative_sha256 = 'another-derivative';
  assert.equal(buildReconciliationPlan({ sourcePlan, existing }).summary.unchanged, 1);
});

test('source corrections update only when the linked FCM baseline remains unchanged', async () => {
  const { buildReconciliationPlan, sourcePlan, existing, checkpoints } = await fixture();
  sourcePlan.events[0].payload.comments = 'corrected';
  const result = buildReconciliationPlan({ sourcePlan, existing, checkpoints });
  assert.equal(result.summary.update, 1);
  assert.equal(result.actions[0].desired.source_values.comments, 'corrected');
  assert.equal(result.actions[0].expected_record_fingerprint, checkpoints[0].record_fingerprint);
  existing[0].record.source_values.comments = 'edited inside FCM';
  const conflict = buildReconciliationPlan({ sourcePlan, existing, checkpoints });
  assert.equal(conflict.summary.hold, 1);
  assert.equal(conflict.actions[0].reason, 'fcm_record_changed_since_last_sync');
});

test('initial differences, unkeyed rows, changed source identity, and duplicate keys are held', async () => {
  const { buildReconciliationPlan, sourcePlan, existing } = await fixture();
  sourcePlan.events[0].payload.comments = 'different';
  assert.equal(buildReconciliationPlan({ sourcePlan, existing }).actions[0].reason, 'initial_difference_requires_review');
  sourcePlan.events[0].payload.job_number = null;
  assert.equal(buildReconciliationPlan({ sourcePlan, existing }).actions[0].reason, 'stable_source_job_required');
  sourcePlan.events[0].payload.job_number = '42';
  existing[0].source_sheet = 'another-sheet';
  assert.equal(buildReconciliationPlan({ sourcePlan, existing }).actions[0].reason, 'existing_source_identity_mismatch');
  existing[0].source_sheet = 'DATA';
  sourcePlan.events.push(structuredClone(sourcePlan.events[0]));
  const duplicate = buildReconciliationPlan({ sourcePlan, existing });
  assert.equal(duplicate.summary.hold, 2);
  assert.ok(duplicate.actions.every(action => action.reason === 'ambiguous_record_key'));
});

test('removed spreadsheet rows do not delete FCM records or recreate a missing linked record', async () => {
  const { buildReconciliationPlan, sourcePlan, existing, checkpoints } = await fixture();
  const missing = buildReconciliationPlan({ sourcePlan, existing: [], checkpoints });
  assert.equal(missing.actions[0].reason, 'previously_linked_record_missing');
  sourcePlan.events = [];
  const removed = buildReconciliationPlan({ sourcePlan, existing, checkpoints });
  assert.deepEqual(removed.actions, []);
  assert.deepEqual(removed.deletes, []);
});

test('fingerprints are key-order independent but detect real source changes', async () => {
  const { recordFingerprint } = await fixture();
  assert.equal(recordFingerprint({ a: 1, b: { c: 2 } }), recordFingerprint({ b: { c: 2 }, a: 1 }));
  assert.notEqual(recordFingerprint({ a: 1 }), recordFingerprint({ a: 2 }));
});

test('live activity normalization compares managed fields while retaining source identity', async () => {
  const { normalizeExistingActivity } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { buildReconciliationPlan, sourcePlan, existing } = await fixture();
  const payload = { ...sourcePlan.events[0].payload, old_import_metadata: 'unmanaged', source_sha256: 'old-hash' };
  const normalized = normalizeExistingActivity({
    id: 'existing-id', external_ref: sourcePlan.events[0].external_ref,
    occurred_at: '2026-10-19T00:00:00Z', zone_id: 'test-zone', client_site_id: null,
    event_type: 'camera_activation', payload,
  }, 'event', Object.keys(existing[0].record.source_values));
  assert.equal(normalized.source_file, 'source.xlsx');
  assert.equal(normalized.record.source_values.old_import_metadata, undefined);
  assert.equal(buildReconciliationPlan({ sourcePlan, existing: [normalized] }).summary.unchanged, 1);
});

test('preview refuses cross-client baselines before producing any candidates', async () => {
  const { previewReconciliation } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { sourcePlan } = await fixture();
  sourcePlan.manifest = { target_client_organization_id: 'client-one' };
  assert.throws(() => previewReconciliation(sourcePlan, { organization_id: 'client-two', observations: [], events: [] }), /must match/);
  assert.throws(() => previewReconciliation(sourcePlan, {
    organization_id: 'client-one', observations: [], events: [{ organization_id: 'client-two' }],
  }), /outside the selected client/);
  assert.equal(previewReconciliation(sourcePlan, { organization_id: 'client-one', observations: [], events: [] }).summary.insert, 1);
});

test('new records require exactly one resolved site or zone before reaching an insert plan', async () => {
  const { buildReconciliationPlan, sourcePlan } = await fixture();
  sourcePlan.events[0].zone_id = null;
  assert.equal(buildReconciliationPlan({ sourcePlan, existing: [] }).actions[0].reason, 'one_resolved_place_required');
  sourcePlan.events[0].zone_id = 'test-zone';
  sourcePlan.events[0].site_id = 'test-site';
  assert.equal(buildReconciliationPlan({ sourcePlan, existing: [] }).actions[0].reason, 'one_resolved_place_required');
});

test('staff-linked source rows are held unless the current provider eligibility snapshot allows them', async () => {
  const { buildReconciliationPlan, sourcePlan } = await fixture();
  sourcePlan.events[0].observed_entity_id = 'historical-officer';
  const held = buildReconciliationPlan({ sourcePlan, existing: [], eligibleOfficerIds: [] });
  assert.equal(held.summary.hold, 1);
  assert.equal(held.actions[0].reason, 'source_staff_not_active_for_provider');
  const allowed = buildReconciliationPlan({ sourcePlan, existing: [], eligibleOfficerIds: ['historical-officer'] });
  assert.equal(allowed.summary.insert, 1);
  sourcePlan.events[0].observed_entity_id = null;
  assert.equal(buildReconciliationPlan({ sourcePlan, existing: [], eligibleOfficerIds: [] }).summary.insert, 1);
});

test('R&M completion policy maps Dave to Blenheim and Dan to Nelson without assigning shifts', async () => {
  const { completionPatrolRoutes } = await import('../services/document-source-worker/attendance-policy.mjs');
  const policy = JSON.parse(readFileSync('scripts/data/rm-attendance-patrol-policy.json', 'utf8'));
  const routes = performerIds => completionPatrolRoutes(policy, policy.provider_organization_id, performerIds);
  assert.deepEqual(routes(['5bd14029-b00b-4240-b42a-c739c168b6e4']), [{
    id: 'a08fb622-28ae-448c-bd48-f41d98e0a4bb', name: 'Blenheim Forestry Patrol', attendance_mode: 'as_attended',
  }]);
  assert.deepEqual(routes(['60b73649-ddae-4386-be6b-3d9243db625c']), [{
    id: '5438c224-02e1-41fd-af00-952ba46cb8c0', name: 'Nelson Forestry Patrol', attendance_mode: 'as_attended',
  }]);
  assert.deepEqual(routes(['unresolved-performer']), []);
  assert.equal(routes(['5bd14029-b00b-4240-b42a-c739c168b6e4', '5bd14029-b00b-4240-b42a-c739c168b6e4']).length, 1);
  assert.equal(routes(['5bd14029-b00b-4240-b42a-c739c168b6e4', '60b73649-ddae-4386-be6b-3d9243db625c']).length, 2);
  assert.throws(() => completionPatrolRoutes(policy, 'another-provider', []), /provider-scoped/);
});