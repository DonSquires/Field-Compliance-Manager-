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
  const checkpoints = [{ external_ref: row.external_ref, record_id: 'existing-id', kind: 'event',
    source_file: 'source.xlsx', source_sheet: 'DATA',
    record_fingerprint: recordFingerprint(desired), source_fingerprint: recordFingerprint(desired) }];
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

test('observation identity and timestamp corrections are held in preview while notes can update', async () => {
  const { buildReconciliationPlan, recordFingerprint, row, sourcePlan } = await fixture();
  const observation = { ...row, plate: 'ABC123', officer_id: 'officer-1', officer_notes: 'original' };
  const plan = { ...sourcePlan, events: [], observations: [observation] };
  const baseline = buildReconciliationPlan({ sourcePlan: plan, existing: [] }).actions[0].desired;
  const current = [{ external_ref: row.external_ref, id: 'existing-id', kind: 'observation',
    source_file: 'source.xlsx', source_sheet: 'DATA', record: baseline }];
  const checkpoints = [{ external_ref: row.external_ref, record_id: 'existing-id', kind: 'observation',
    source_file: 'source.xlsx', source_sheet: 'DATA', record_fingerprint: recordFingerprint(baseline),
    source_fingerprint: recordFingerprint(baseline) }];
  for (const [field, value] of [['occurred_at', '2026-10-19T13:00:00+12:00'],
    ['plate', 'XYZ789'], ['officer_id', 'officer-2']]) {
    const changed = { ...plan, observations: [{ ...observation, [field]: value }] };
    const result = buildReconciliationPlan({ sourcePlan: changed, existing: current, checkpoints }).actions[0];
    assert.equal(result.operation, 'hold');
    assert.equal(result.reason, 'observation_mirror_correction_requires_review');
  }
  const notesOnly = { ...plan, observations: [{ ...observation, officer_notes: 'corrected' }] };
  assert.equal(buildReconciliationPlan({ sourcePlan: notesOnly, existing: current, checkpoints }).actions[0].operation, 'update');
});

test('unversioned same-source differences go to governed correction; unkeyed rows, changed source identity, and duplicate keys are held', async () => {
  const { buildReconciliationPlan, sourcePlan, existing } = await fixture();
  sourcePlan.events[0].payload.comments = 'different';
  const corrected = buildReconciliationPlan({ sourcePlan, existing }).actions[0];
  assert.equal(corrected.operation, 'legacy_correct');
  assert.equal(corrected.record_id, 'existing-id');
  const observationPlan = { ...sourcePlan, events: [], observations: [{ ...sourcePlan.events[0], plate: 'ABC123' }] };
  const observationRecord = buildReconciliationPlan({ sourcePlan: observationPlan, existing: [] }).actions[0].desired;
  const observationExisting = [{ ...existing[0], kind: 'observation',
    record: { ...observationRecord, officer_notes: 'different' } }];
  assert.equal(buildReconciliationPlan({ sourcePlan: observationPlan, existing: observationExisting }).actions[0].operation,
    'legacy_correct');
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

async function sourceVersions() {
  const { sourcePlan } = await fixture();
  sourcePlan.provider_organization_id = 'provider-one';
  sourcePlan.source_sha256 = 'a'.repeat(64);
  sourcePlan.events[0].payload.source_sha256 = sourcePlan.source_sha256;
  sourcePlan.manifest = { target_client_organization_id: 'client-one', source_profile: 'test_patrol',
    client_code: 'TEST', import_configuration_sha256: 'configuration-one' };
  const current = structuredClone(sourcePlan);
  current.source_sha256 = 'b'.repeat(64);
  current.events[0].payload.source_sha256 = current.source_sha256;
  return { previous: sourcePlan, current };
}

test('source comparison identifies edited contents by job key, not workbook hash or row position', async () => {
  const { compareSourcePlans } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { previous, current } = await sourceVersions();
  current.events[0].payload.source_row = 900;
  current.events[0].payload.derivative_sha256 = 'changed-derivative';
  assert.equal(compareSourcePlans(current, previous).summary.unchanged, 1);
  current.events[0].payload.comments = 'source correction';
  const result = compareSourcePlans(current, previous);
  assert.equal(result.summary.updated, 1);
  assert.deepEqual(result.actions[0].changed_fields, ['source_values.comments']);
  assert.notEqual(result.actions[0].source_fingerprint, result.actions[0].previous_source_fingerprint);
});

test('a source-place conflict remains a hold rather than appearing as a removed row', async () => {
  const { compareSourcePlans } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { previous, current } = await sourceVersions();
  const ref = current.events[0].external_ref;
  current.events = [];
  current.unresolved_places = [{ name: null, reason: 'conflicting_place_fields', source_rows: [9] }];
  current.source_holds = [{ external_ref: ref, kind: 'event', source_row: 9, reason: 'conflicting_place_fields' }];
  const result = compareSourcePlans(current, previous);
  assert.equal(result.summary.hold, 1);
  assert.equal(result.summary.missing, 0);
  assert.deepEqual(result.actions.map(action => [action.external_ref, action.operation, action.reason]),
    [[ref, 'hold', 'conflicting_place_fields']]);
});

test('first source snapshot is a baseline, not evidence that an FCM record may be overwritten', async () => {
  const { compareSourcePlans } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { current } = await sourceVersions();
  const result = compareSourcePlans(current);
  assert.equal(result.baseline_established, false);
  assert.equal(result.summary.baseline, 1);
  assert.equal(result.summary.updated, 0);
  assert.equal(result.summary.added, 0);
});

test('source additions and missing rows are distinguished without automatic deletion', async () => {
  const { compareSourcePlans } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { previous, current } = await sourceVersions();
  current.events[0].external_ref = 'rm_patrol_import:TEST:43';
  current.events[0].payload.job_number = '43';
  const result = compareSourcePlans(current, previous);
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.missing, 1);
  assert.deepEqual(result.deletes, []);
});

test('source comparisons reject scope changes and hold duplicates, kind changes, and changed parsing configuration', async () => {
  const { compareSourcePlans } = await import('../services/document-source-worker/reconcile-plan.mjs');
  for (const field of ['source_file', 'source_sheet', 'provider_organization_id']) {
    const { previous, current } = await sourceVersions();
    current[field] = 'another-source';
    assert.throws(() => compareSourcePlans(current, previous), /same workbook/);
  }
  for (const field of ['target_client_organization_id', 'source_profile', 'client_code']) {
    const { previous, current } = await sourceVersions();
    current.manifest[field] = 'another-scope';
    assert.throws(() => compareSourcePlans(current, previous), /same workbook/);
  }
  const { previous, current } = await sourceVersions();
  current.manifest.import_configuration_sha256 = 'changed-configuration';
  assert.equal(compareSourcePlans(current, previous).actions[0].reason, 'import_configuration_changed');
  current.manifest.import_configuration_sha256 = previous.manifest.import_configuration_sha256;
  current.observations = current.events;
  current.events = [];
  assert.equal(compareSourcePlans(current, previous).actions[0].reason, 'record_kind_changed');
  current.events = current.observations;
  current.observations = [];
  current.events.push(structuredClone(current.events[0]));
  assert.equal(compareSourcePlans(current, previous).actions[0].reason, 'ambiguous_record_key');
});

test('changed parsed contents with an unchanged workbook version cannot claim a source edit', async () => {
  const { compareSourcePlans } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { previous, current } = await sourceVersions();
  current.source_sha256 = previous.source_sha256;
  current.events[0].payload.source_sha256 = current.source_sha256;
  current.events[0].payload.comments = 'different parser output';
  assert.equal(compareSourcePlans(current, previous).actions[0].reason, 'source_version_not_advanced');
});

test('status, entity type, and measured distance participate in reconciliation', async () => {
  for (const [field, value] of [['status', 'closed'], ['observed_entity_type', 'staff'], ['distance_km', 12.5]]) {
    const { buildReconciliationPlan, sourcePlan, existing, checkpoints } = await fixture();
    sourcePlan.events[0][field] = value;
    const result = buildReconciliationPlan({ sourcePlan, existing, checkpoints });
    assert.equal(result.actions[0].operation, 'update', field);
    assert.equal(result.actions[0].desired[field], value);
  }
});

test('checkpoints cannot authorize changes to a different record or source identity', async () => {
  for (const [field, value] of [['record_id', 'replacement-record'], ['kind', 'observation'],
    ['source_file', 'other.xlsx'], ['source_sheet', 'other']]) {
    const { buildReconciliationPlan, sourcePlan, existing, checkpoints } = await fixture();
    checkpoints[0][field] = value;
    sourcePlan.events[0].payload.comments = 'corrected';
    const result = buildReconciliationPlan({ sourcePlan, existing, checkpoints });
    assert.equal(result.actions[0].reason, 'checkpoint_identity_mismatch', field);
  }
});

test('duplicate checkpoints are held rather than trusting the last one', async () => {
  const { buildReconciliationPlan, sourcePlan, existing, checkpoints } = await fixture();
  checkpoints.push(structuredClone(checkpoints[0]));
  assert.equal(buildReconciliationPlan({ sourcePlan, existing, checkpoints }).actions[0].reason, 'ambiguous_checkpoint');
});

test('missing keys and invalid distances never produce insert candidates', async () => {
  const { buildReconciliationPlan, sourcePlan } = await fixture();
  for (const value of [-1, 'not-a-number', Infinity]) {
    sourcePlan.events[0].distance_km = value;
    assert.equal(buildReconciliationPlan({ sourcePlan, existing: [] }).actions[0].reason, 'invalid_source_distance');
  }
  delete sourcePlan.events[0].external_ref;
  assert.equal(buildReconciliationPlan({ sourcePlan, existing: [] }).actions[0].reason, 'stable_source_job_required');
});

test('nullable managed fields are normalized consistently across rows', async () => {
  const { previewReconciliation } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { sourcePlan } = await fixture();
  sourcePlan.manifest = { target_client_organization_id: 'client-one' };
  sourcePlan.events.push({ ...structuredClone(sourcePlan.events[0]), external_ref: 'rm_patrol_import:TEST:43' });
  sourcePlan.events[1].payload.optional_field = 'present on another row';
  const result = previewReconciliation(sourcePlan, {
    organization_id: 'client-one', observations: [],
    events: [{
      organization_id: 'client-one', id: 'existing-id', external_ref: sourcePlan.events[0].external_ref,
      occurred_at: sourcePlan.events[0].occurred_at, zone_id: 'test-zone',
      event_type: 'camera_activation', payload: sourcePlan.events[0].payload,
    }],
  });

  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.summary.insert, 1);
});

test('linked baseline reads are provider/client-scoped and bounded to exact incoming references', async () => {
  const { loadLinkedBaseline } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { sourcePlan } = await fixture();
  const provider = '10000000-0000-4000-8000-000000000001';
  const client = '10000000-0000-4000-8000-000000000002';
  sourcePlan.manifest = { target_client_organization_id: client };
  sourcePlan.events = Array.from({ length: 401 }, (_, i) => ({
    ...sourcePlan.events[0], external_ref: `rm_patrol_import:TEST:${i}`,
  }));
  const queries = [];
  const baseline = await loadLinkedBaseline(sourcePlan, provider, async sql => {
    queries.push(sql);
    if (sql.includes('AS scope')) return [{ scope: { authorized: true, eligible_officer_ids: ['active-officer'] } }];
    return [{ activity: { observations: [], events: [] } }];
  });
  assert.equal(queries.length, 4);
  assert.ok(queries[0].includes(provider));
  assert.ok(queries.every(sql => sql.includes(client)));
  const sizes = queries.slice(1).map(sql => JSON.parse(sql.split('$refs$')[1]).length);
  assert.deepEqual(sizes, [200, 200, 1]);
  assert.deepEqual(baseline.eligible_officer_ids, ['active-officer']);
  assert.equal(baseline.organization_id, client);
});

test('linked baseline refuses missing authority, malformed responses, and invalid scope', async () => {
  const { loadLinkedBaseline } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const { sourcePlan } = await fixture();
  const provider = '10000000-0000-4000-8000-000000000001';
  sourcePlan.manifest = { target_client_organization_id: '10000000-0000-4000-8000-000000000002' };
  await assert.rejects(loadLinkedBaseline(sourcePlan, 'not-a-uuid', async () => assert.fail('must not query')), /organization IDs/);
  sourcePlan.provider_organization_id = 'another-provider';
  await assert.rejects(loadLinkedBaseline(sourcePlan, provider, async () => assert.fail('must not query')), /provider does not match/);
  delete sourcePlan.provider_organization_id;
  await assert.rejects(loadLinkedBaseline(sourcePlan, provider, async () => [{ scope: { authorized: false } }]), /patrol agreement/);
  await assert.rejects(loadLinkedBaseline(sourcePlan, provider, async sql => sql.includes('AS scope')
    ? [{ scope: { authorized: true, eligible_officer_ids: [] } }] : []), /Incomplete linked activity/);
  sourcePlan.events[0].external_ref = 'arbitrary_reference';
  await assert.rejects(loadLinkedBaseline(sourcePlan, provider, async () => assert.fail('must not query')), /patrol import reference/);
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