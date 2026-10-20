import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function recordFingerprint(record) {
  return createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');
}

function logicalRow(row, kind) {
  const instant = new Date(row.occurred_at);
  if (!Number.isFinite(instant.getTime())) throw new Error('A valid source timestamp is required');
  return {
    kind,
    external_ref: row.external_ref,
    occurred_at: instant.toISOString(),
    zone_id: row.zone_id ?? null,
    site_id: row.site_id ?? null,
    officer_id: kind === 'observation' ? row.officer_id ?? null : row.observed_entity_id ?? null,
    plate: kind === 'observation' ? row.plate ?? null : null,
    event_type: kind === 'event' ? row.event_type ?? null : null,
    officer_notes: kind === 'observation' ? row.officer_notes ?? null : null,
    source_values: Object.fromEntries(Object.entries(row.payload ?? {}).filter(([key]) => ![
      'source_sha256', 'derivative_sha256', 'source_row',
    ].includes(key))),
  };
}

export function normalizeExistingActivity(row, kind, managedSourceFields) {
  if (!['observation', 'event'].includes(kind) || !Array.isArray(managedSourceFields)) {
    throw new Error('An activity kind and managed source fields are required');
  }
  const payload = kind === 'observation' ? row.external_refs?.import ?? {} : row.payload ?? {};
  const sourceValues = Object.fromEntries(managedSourceFields.map(key => [key, payload[key] ?? null]));
  const candidate = {
    external_ref: kind === 'observation' ? row.external_refs?.external_ref : row.external_ref,
    occurred_at: kind === 'observation' ? row.observed_at : row.occurred_at,
    zone_id: row.zone_id,
    site_id: kind === 'observation' ? row.site_id : row.client_site_id,
    officer_id: row.officer_id,
    observed_entity_id: row.observed_entity_id,
    plate: row.plate_number,
    event_type: row.event_type,
    officer_notes: row.officer_notes,
    payload: sourceValues,
  };
  return {
    id: row.id, kind, external_ref: candidate.external_ref,
    source_file: payload.source_file ?? null, source_sheet: payload.source_sheet ?? null,
    record: logicalRow(candidate, kind),
  };
}

export function buildReconciliationPlan({ sourcePlan, existing, checkpoints = [], eligibleOfficerIds }) {
  if (sourcePlan?.mode !== 'plan' || !Array.isArray(sourcePlan.observations) || !Array.isArray(sourcePlan.events)
    || !Array.isArray(existing) || !Array.isArray(checkpoints)) throw new Error('Validated source plan and existing rows are required');
  const byKey = new Map();
  const duplicateExisting = new Set();
  for (const row of existing) {
    if (byKey.has(row.external_ref)) duplicateExisting.add(row.external_ref);
    byKey.set(row.external_ref, row);
  }
  const checkpointByKey = new Map(checkpoints.map(row => [row.external_ref, row]));
  const eligibleOfficers = eligibleOfficerIds === undefined ? null : new Set(eligibleOfficerIds);
  const incoming = [
    ...sourcePlan.observations.map(row => ({ row, kind: 'observation' })),
    ...sourcePlan.events.map(row => ({ row, kind: 'event' })),
  ];
  const counts = new Map();
  for (const { row } of incoming) counts.set(row.external_ref, (counts.get(row.external_ref) ?? 0) + 1);
  const actions = [];
  for (const { row, kind } of incoming) {
    const current = byKey.get(row.external_ref);
    const checkpoint = checkpointByKey.get(row.external_ref);
    const desired = logicalRow(row, kind);
    const sourceFingerprint = recordFingerprint(desired);
    const action = { external_ref: row.external_ref, kind, source_fingerprint: sourceFingerprint };
    let reason = null;
    if (!row.payload?.job_number) reason = 'stable_source_job_required';
    else if (Boolean(row.zone_id) === Boolean(row.site_id)) reason = 'one_resolved_place_required';
    else if (desired.officer_id && eligibleOfficers && !eligibleOfficers.has(desired.officer_id)) reason = 'source_staff_not_active_for_provider';
    else if (row.payload.source_file !== sourcePlan.source_file || row.payload.source_sha256 !== sourcePlan.source_sha256
      || row.payload.source_sheet !== sourcePlan.source_sheet) reason = 'source_provenance_mismatch';
    else if (counts.get(row.external_ref) > 1 || duplicateExisting.has(row.external_ref)) reason = 'ambiguous_record_key';
    else if (current && (current.kind !== kind || current.source_file !== row.payload.source_file
      || current.source_sheet !== row.payload.source_sheet)) reason = 'existing_source_identity_mismatch';
    else if (checkpoint && !current) reason = 'previously_linked_record_missing';
    else if (current && checkpoint && checkpoint.record_fingerprint !== recordFingerprint(current.record)) reason = 'fcm_record_changed_since_last_sync';
    if (reason) {
      actions.push({ ...action, operation: 'hold', reason });
    } else if (!current) {
      actions.push({ ...action, operation: 'insert', desired });
    } else if (recordFingerprint(current.record) === sourceFingerprint) {
      actions.push({ ...action, operation: 'unchanged', record_id: current.id });
    } else if (!checkpoint) {
      actions.push({ ...action, operation: 'hold', reason: 'initial_difference_requires_review', record_id: current.id });
    } else if (checkpoint.source_fingerprint === sourceFingerprint) {
      actions.push({ ...action, operation: 'hold', reason: 'source_and_record_checkpoint_disagree', record_id: current.id });
    } else {
      actions.push({ ...action, operation: 'update', record_id: current.id,
        expected_record_fingerprint: checkpoint.record_fingerprint, desired });
    }
  }
  const summary = { insert: 0, update: 0, unchanged: 0, hold: 0 };
  for (const action of actions) summary[action.operation] += 1;
  return { source_sha256: sourcePlan.source_sha256, summary, actions, deletes: [] };
}

export function previewReconciliation(sourcePlan, baseline) {
  const organizationId = sourcePlan?.manifest?.target_client_organization_id;
  if (!organizationId || baseline?.organization_id !== organizationId
    || !Array.isArray(baseline.observations) || !Array.isArray(baseline.events)) {
    throw new Error('Source and baseline client organization must match');
  }
  const managedFields = [...new Set([...sourcePlan.observations, ...sourcePlan.events]
    .flatMap(row => Object.keys(row.payload ?? {})))];
  const existing = [];
  for (const [kind, rows] of [['observation', baseline.observations], ['event', baseline.events]]) {
    for (const row of rows) {
      if (row.organization_id !== organizationId) throw new Error('Baseline row is outside the selected client');
      existing.push(normalizeExistingActivity(row, kind, managedFields));
    }
  }
  return buildReconciliationPlan({ sourcePlan, existing, checkpoints: baseline.checkpoints ?? [],
    eligibleOfficerIds: baseline.eligible_officer_ids,
  });
}

async function main() {
  const argument = name => process.argv[process.argv.indexOf(name) + 1];
  if (!['--source-plan', '--baseline', '--output'].every(name => process.argv.includes(name) && argument(name))) {
    throw new Error('Use --source-plan <json> --baseline <json> --output <local report json>');
  }
  const sourcePlan = JSON.parse((await readFile(argument('--source-plan'), 'utf8')).replace(/^\uFEFF/, ''));
  const baseline = JSON.parse((await readFile(argument('--baseline'), 'utf8')).replace(/^\uFEFF/, ''));
  const result = previewReconciliation(sourcePlan, baseline);
  await writeFile(argument('--output'), JSON.stringify(result), { mode: 0o600 });
  const reasons = {};
  for (const action of result.actions) if (action.reason) reasons[action.reason] = (reasons[action.reason] ?? 0) + 1;
  console.log(JSON.stringify({ mode: 'preview', summary: result.summary, hold_reasons: reasons, business_writes: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Reconciliation preview failed; verify source, client scope, and local report paths'); process.exitCode = 1; });
}