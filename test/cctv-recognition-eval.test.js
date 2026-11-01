'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const evaluatorPromise = import('../scripts/cctv-recognition-eval.mjs');

test('synthetic recognition fixture computes reviewed precision, plate exact match and identity fragmentation', async () => {
  const { evaluateFixture } = await evaluatorPromise;
  const rows = [
    { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p1', predicted_cluster_id: 'a' },
    { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p1', predicted_cluster_id: 'a' },
    { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p2', predicted_cluster_id: 'b' },
    { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p3', predicted_cluster_id: 'c' },
    { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p3', predicted_cluster_id: 'd' },
    { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p4', predicted_cluster_id: 'c' },
    { entity_kind: 'person', review_state: 'rejected' },
    { entity_kind: 'vehicle', review_state: 'accepted', candidate_plate: 'ABC-123', reviewed_plate: 'ABC123' },
    { entity_kind: 'vehicle', review_state: 'accepted', candidate_plate: 'ABCI23', reviewed_plate: 'ABC123' },
    { entity_kind: 'vehicle', review_state: 'rejected', candidate_plate: 'WXY789', reviewed_plate: 'WXY789' },
    { entity_kind: 'vehicle', review_state: 'unreviewed' },
    { entity_kind: 'animal', review_state: 'accepted' },
    { entity_kind: 'animal', review_state: 'uncertain' },
  ];
  const report = evaluateFixture(rows);
  assert.equal(report.scope, 'synthetic_fixture_only');
  assert.deepEqual(report.reviewed_precision.person, {
    accepted: 6, rejected: 1, inconclusive: 0, pending: 0, decided: 7,
    precision: 0.8571, precision_lower_bound: 0.4869,
  });
  assert.deepEqual(report.reviewed_precision.animal, {
    accepted: 1, rejected: 0, inconclusive: 1, pending: 0, decided: 1,
    precision: 1, precision_lower_bound: 0.2065,
  });
  assert.equal(report.plate_exact_match.labeled_reads, 3);
  assert.equal(report.plate_exact_match.exact_matches, 2);
  assert.equal(report.plate_exact_match.exact_match_rate, 0.6667);
  assert.equal(report.plate_exact_match.character_accuracy, 0.9444);
  assert.deepEqual(report.person_identity, {
    status: 'measured_on_labeled_fixture',
    ground_truth_entities: 4,
    predicted_clusters: 4,
    split_entities: 1,
    merged_clusters: 1,
    clusters_per_ground_truth: 1,
  });
});

test('empty fixtures report uncalibrated or unavailable metrics rather than invented accuracy', async () => {
  const { evaluateFixture } = await evaluatorPromise;
  const report = evaluateFixture([]);
  assert.equal(report.reviewed_precision.vehicle.precision, null);
  assert.equal(report.reviewed_precision.vehicle.precision_lower_bound, null);
  assert.equal(report.plate_exact_match.status, 'not_available');
  assert.equal(report.person_identity.status, 'not_available');
});

test('live aggregation is tenant-scoped and emits no observation-level fields', async () => {
  const { fetchLiveSummary } = await evaluatorPromise;
  let request;
  const report = await fetchLiveSummary({
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'fixture-secret',
    organizationId: '00000000-0000-4000-8000-000000000001',
    since: '2026-10-01T00:00:00Z',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        organization_id: '00000000-0000-4000-8000-000000000001',
        since: '2026-10-01T00:00:00Z',
        calibration_minimum_decisions: 30,
        groups: [
          { entity_kind: 'vehicle', engine_version: 'cctv-engine-v2', detector_model: 'detector-a', review_basis: 'temporal_consensus', confidence_band: '0.85-1.00', accepted: 27, rejected: 3, inconclusive: 2, pending: 5, calibrated: true },
          { entity_kind: 'vehicle', engine_version: 'legacy', detector_model: 'detector-b', review_basis: 'single_frame_high_confidence', confidence_band: '0.70-0.84', accepted: 2, rejected: 3, inconclusive: 0, pending: 1, calibrated: false },
        ],
        missed_detections: [{ entity_kind: 'vehicle', engine_version: 'cctv-engine-v2', open: 1, confirmed_missed: 2, not_missed: 1 }],
      }));
    },
  });
  assert.equal(request.url, 'https://example.supabase.co/rest/v1/rpc/cctv_accuracy_summary');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    p_organization_id: '00000000-0000-4000-8000-000000000001',
    p_since: '2026-10-01T00:00:00Z',
  });
  assert.equal(request.options.redirect, 'error');
  assert.equal(report.scope, 'single_organization_aggregate');
  assert.equal(report.reviewed_precision_by_kind.vehicle.accepted, 29);
  assert.equal(report.reviewed_precision_by_kind.vehicle.rejected, 6);
  assert.equal(report.reviewed_precision_by_kind.vehicle.decided, 35);
  assert.equal(report.reviewed_precision_by_kind.vehicle.calibrated_groups, 1);
  assert.equal(report.missed_detection_reports.recall, null);
  assert.equal(report.plate_exact_match.status, 'not_available');
  assert.equal(report.person_identity.status, 'not_available');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /fixture-secret|candidate_plate|thumbnail/);
  assert.equal(report.organization_id, undefined);
});

test('live mode rejects missing scope, invalid time and HTTP failures explicitly', async () => {
  const { fetchLiveSummary } = await evaluatorPromise;
  await assert.rejects(() => fetchLiveSummary({
    supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'secret', organizationId: 'not-a-uuid',
  }), /organization-id.*UUID/);
  await assert.rejects(() => fetchLiveSummary({
    supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'secret',
    organizationId: '00000000-0000-4000-8000-000000000001', since: '2026-10-01',
  }), /explicit timezone/);
  await assert.rejects(() => fetchLiveSummary({
    supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'secret',
    organizationId: '00000000-0000-4000-8000-000000000001',
    fetchImpl: async () => new Response('denied', { status: 403 }),
  }), /HTTP 403/);
});
