'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const exerciseUrl = pathToFileURL(path.join(root, 'scripts/atlas-exercise-evidence.mjs')).href;
const calibrationUrl = pathToFileURL(path.join(root, 'scripts/perception-calibration-report.mjs')).href;

test('tool routing is parsed from the conductor, not duplicated by hand', async () => {
  const { parseToolRouting, TOOL_ROUTING_SOURCE } = await import(exerciseUrl);
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(root, TOOL_ROUTING_SOURCE), 'utf8');
  const routing = parseToolRouting(source);

  assert.equal(routing.query_records, 'bob-query-records');
  assert.equal(routing.sql_read, 'bob-sql-read');
  assert.equal(routing.query_atlas, 'bob-query-atlas');
  // Conductor-inline tools must resolve to the conductor itself, never to an
  // edge function that does not exist.
  assert.equal(routing.understand_documents, 'onspace-ai-chat');
  assert.equal(routing.confirm_import, 'onspace-ai-chat');
  assert.equal(routing.cancel_builder_job, 'onspace-ai-chat');
  assert.ok(Object.keys(routing).length >= 40);
});

test('exercise is claimed only where an invocation receipt resolves to a capability', async () => {
  const { buildExercisePlan } = await import(exerciseUrl);

  const capabilities = [
    { id: 'a', entity_type: 'edge_function', entity_name: 'bob-query-records', present: true, wired: true, exercised: null },
    { id: 'b', entity_type: 'table', entity_name: 'observations', present: true, wired: true, exercised: null },
    { id: 'c', entity_type: 'table', entity_name: 'never_called', present: true, wired: true, exercised: null },
    { id: 'd', entity_type: 'edge_function', entity_name: 'already', present: true, wired: true, exercised: true },
  ];

  const plan = buildExercisePlan(capabilities, [
    { sourceId: 'bob_tool_invocation', basis: 'b', entityType: 'edge_function', key: 'query_records', at: '2026-01-02T00:00:00Z', candidateNames: ['bob-query-records'] },
    { sourceId: 'bob_tool_invocation', basis: 'b', entityType: 'edge_function', key: 'query_records', at: '2026-01-01T00:00:00Z', candidateNames: ['bob-query-records'] },
    { sourceId: 'audited_table_write', basis: 'a', entityType: 'table', key: 'observations', at: '2026-01-03T00:00:00Z', candidateNames: ['observations'] },
    { sourceId: 'bob_tool_invocation', basis: 'b', entityType: 'edge_function', key: 'ghost_tool', at: '2026-01-04T00:00:00Z', candidateNames: [] },
    { sourceId: 'bob_tool_invocation', basis: 'b', entityType: 'edge_function', key: 'already', at: '2026-01-05T00:00:00Z', candidateNames: ['already'] },
  ]);

  const names = plan.exercised.map((entry) => entry.entity_name).sort();
  assert.deepEqual(names, ['already', 'bob-query-records', 'observations']);

  // A wired capability with no invocation receipt is never claimed as exercised.
  assert.equal(plan.exercised.some((entry) => entry.entity_name === 'never_called'), false);

  const queryRecords = plan.exercised.find((entry) => entry.entity_name === 'bob-query-records');
  assert.equal(queryRecords.invocations, 2);
  assert.equal(queryRecords.first_seen_at, '2026-01-01T00:00:00Z');
  assert.equal(queryRecords.last_seen_at, '2026-01-02T00:00:00Z');

  // Evidence that resolves to nothing is surfaced, not silently discarded.
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].key, 'ghost_tool');

  // Already-true rows are not rewritten, so replay is idempotent.
  assert.deepEqual(plan.pending_writes.map((entry) => entry.entity_name).sort(), ['bob-query-records', 'observations']);
});

test('calibration refuses an accuracy claim below the reviewed-sample floor', async () => {
  const { summarize, MIN_REVIEWED_SAMPLE } = await import(calibrationUrl);

  const envelopes = [{ id: 'e1', domain: 'cctv_alpr' }];
  const fields = [
    { id: 'f1', envelope_id: 'e1', field_key: 'vehicle.plate_number', authority_state: 'human_approved', raw_confidence: 0.99, calibrated_confidence: null },
    { id: 'f2', envelope_id: 'e1', field_key: 'vehicle.plate_number', authority_state: 'superseded', raw_confidence: 0.98, calibrated_confidence: null },
    { id: 'f3', envelope_id: 'e1', field_key: 'vehicle.plate_number', authority_state: 'candidate', raw_confidence: 0.5, calibrated_confidence: null },
  ];
  const reviews = [
    { field_id: 'f1', decision: 'approve' },
    { field_id: 'f2', decision: 'supersede' },
  ];

  const report = summarize({ envelopes, fields, reviews });

  assert.equal(report.totals.candidates, 3);
  assert.equal(report.totals.reviewed, 2);
  assert.equal(report.totals.overturned, 1);
  assert.equal(report.totals.overturn_rate, 0.5);
  assert.equal(report.totals.sample_sufficient, false);
  assert.equal(report.production_accuracy_claim_supported, false);
  assert.ok(MIN_REVIEWED_SAMPLE >= 30);

  // Uncalibrated confidence must be named as a blocker.
  assert.ok(report.blockers.some((line) => /calibrated confidence/i.test(line)));
  assert.ok(report.blockers.some((line) => line.includes('cctv_alpr')));

  const field = report.fields.find((row) => row.field_key === 'vehicle.plate_number');
  assert.equal(field.claim, 'indicative_only_small_sample');
  assert.equal(field.calibrated, false);
});

test('an unreviewed domain reports no review rather than implied success', async () => {
  const { summarize } = await import(calibrationUrl);

  const report = summarize({
    envelopes: [{ id: 'e1', domain: 'smoke_photo' }],
    fields: [{ id: 'f1', envelope_id: 'e1', field_key: 'smoke.visible_source', authority_state: 'candidate', raw_confidence: 0.7, calibrated_confidence: null }],
    reviews: [],
  });

  assert.equal(report.totals.reviewed, 0);
  assert.equal(report.totals.overturn_rate, null);
  assert.equal(report.fields[0].claim, 'no_human_review_yet');
  assert.equal(report.production_accuracy_claim_supported, false);
});
