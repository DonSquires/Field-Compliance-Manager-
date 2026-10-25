import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

function logicalRow(row, kind, managedSourceFields = Object.keys(row.payload ?? {})) {
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
    status: kind === 'event' ? row.status ?? null : null,
    observed_entity_type: kind === 'event' ? row.observed_entity_type ?? null : null,
    distance_km: row.distance_km === null || row.distance_km === undefined ? null : Number(row.distance_km),
    officer_notes: kind === 'observation' ? row.officer_notes ?? null : null,
    source_values: Object.fromEntries(managedSourceFields.filter(key => ![
      'source_sha256', 'derivative_sha256', 'source_row',
    ].includes(key)).map(key => [key, row.payload?.[key] ?? null])),
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
    status: row.status,
    observed_entity_type: row.observed_entity_type,
    distance_km: row.distance_km,
    officer_notes: row.officer_notes,
    payload: sourceValues,
  };
  return {
    id: row.id, kind, external_ref: candidate.external_ref,
    source_file: payload.source_file ?? null, source_sheet: payload.source_sheet ?? null,
    source_row: payload.source_row === undefined || payload.source_row === null ? null : Number(payload.source_row),
    record: logicalRow(candidate, kind),
  };
}

// Fields that make two patrol events the same visit outcome (time, place, officer, kind, issue and narrative).
function visitIdentity(record, shiftMs = 0, withStatus = true) {
  const instant = Date.parse(record.occurred_at);
  return JSON.stringify([Number.isFinite(instant) ? instant - shiftMs : record.occurred_at, record.zone_id, record.site_id,
    record.officer_id, record.event_type, withStatus ? record.status ?? null : '*',
    String(record.source_values?.comments ?? '').trim()]);
}

const DART_UPDATE_FIELDS = ['location_raw', 'reserve_raw', 'source_category', 'comments', 'patroller_raw', 'plates_found'];

function validateDartUpdatePlan(sourcePlan, sheetUpdatePlan) {
  if (!sheetUpdatePlan) return;
  if (sheetUpdatePlan.mode !== 'plan' || !Array.isArray(sheetUpdatePlan.events)
    || sheetUpdatePlan.observations?.length !== 0 || sheetUpdatePlan.proposals?.length !== 0
    || sourcePlan.source_sheet !== '2025' || sheetUpdatePlan.source_sheet !== 'Update 251215'
    || sourcePlan.source_file !== sheetUpdatePlan.source_file
    || sourcePlan.source_sha256 !== sheetUpdatePlan.source_sha256
    || sourcePlan.provider_organization_id !== sheetUpdatePlan.provider_organization_id
    || sourcePlan.manifest?.target_client_organization_id !== sheetUpdatePlan.manifest?.target_client_organization_id
    || sourcePlan.manifest?.source_profile !== sheetUpdatePlan.manifest?.source_profile) {
    throw new Error('DART Update rows require a matching 2025 canonical plan and an Update 251215 plan');
  }
}

// A source row whose job also appears, identically, in the canonical worksheet is a copy of that visit.
function canonicalCopies(sourcePlan, canonicalPlan) {
  const copies = new Map();
  if (!canonicalPlan) return copies;
  if (canonicalPlan.mode !== 'plan' || !Array.isArray(canonicalPlan.events)
    || canonicalPlan.manifest?.target_client_organization_id !== sourcePlan.manifest?.target_client_organization_id
    || canonicalPlan.source_sheet === sourcePlan.source_sheet) {
    throw new Error('The canonical plan must be a different worksheet for the same client');
  }
  const managed = [...new Set([...sourcePlan.events, ...canonicalPlan.events].flatMap(row => Object.keys(row.payload ?? {})))];
  const canonicalByJob = new Map();
  for (const row of canonicalPlan.events) {
    const job = row.payload?.job_number;
    if (job) canonicalByJob.set(job, canonicalByJob.has(job) ? null : row);
  }
  for (const row of sourcePlan.events) {
    const canonical = row.payload?.job_number ? canonicalByJob.get(row.payload.job_number) : undefined;
    if (canonical === undefined) continue;
    const same = canonical !== null
      && visitIdentity(logicalRow(row, 'event', managed)) === visitIdentity(logicalRow(canonical, 'event', managed));
    copies.set(row.external_ref, same ? canonical.external_ref : null);
  }
  return copies;
}

// Existing records from another worksheet of the same workbook that repeat a planned visit exactly once.
function sheetCopyActions(copies, incoming, managedSourceFields, supersededRefs, sheetUpdatePlan = null, canonicalActions = []) {
  const byVisit = new Map();
  // A visit-level copy (no issue status) stands for every job row of that visit; it links to the first job.
  const byVisitAnyIssue = new Map();
  const jobOrder = row => Number(row.payload?.job_number) || Number.MAX_SAFE_INTEGER;
  for (const { row, kind } of incoming) {
    if (kind !== 'event') continue;
    const record = logicalRow(row, kind, managedSourceFields);
    const key = visitIdentity(record);
    byVisit.set(key, byVisit.has(key) ? null : row.external_ref);
    const anyKey = visitIdentity(record, 0, false);
    const first = byVisitAnyIssue.get(anyKey);
    if (!first || jobOrder(row) < jobOrder(first)) byVisitAnyIssue.set(anyKey, row);
  }
  const match = (record, shiftMs) => record.status === null
    ? byVisitAnyIssue.get(visitIdentity(record, shiftMs, false))?.external_ref
    : byVisit.get(visitIdentity(record, shiftMs));
  const copyActions = copies.filter(copy => !supersededRefs.has(copy.external_ref)).map(copy => {
    // Pre-fix imports stored New Zealand daylight-time rows one hour late; the server re-verifies the shift.
    const exact = match(copy.record, 0);
    const canonicalRef = exact !== undefined ? exact : match(copy.record, 3600000);
    const action = { external_ref: copy.external_ref, kind: 'event', record_id: copy.id, source_sheet: copy.source_sheet };
    if (canonicalRef) return { ...action, operation: 'supersede', canonical_external_ref: canonicalRef };
    return { ...action, operation: 'hold', reason: canonicalRef === null ? 'ambiguous_canonical_visit' : 'canonical_visit_not_found' };
  });
  if (!sheetUpdatePlan) return copyActions;

  const updateRowsByNumber = new Map();
  const duplicateUpdateRows = new Set();
  for (const row of sheetUpdatePlan.events) {
    const sourceRow = Number(row.payload?.source_row);
    if (!Number.isInteger(sourceRow) || sourceRow < 1 || updateRowsByNumber.has(sourceRow)) {
      duplicateUpdateRows.add(sourceRow);
    } else {
      updateRowsByNumber.set(sourceRow, row);
    }
  }
  const groups = new Map();
  for (const action of copyActions) {
    if (action.operation !== 'supersede') continue;
    const rows = groups.get(action.canonical_external_ref) ?? [];
    rows.push(action);
    groups.set(action.canonical_external_ref, rows);
  }
  const canonicalRows = new Map(incoming
    .filter(({ kind }) => kind === 'event')
    .map(({ row }) => [row.external_ref, row]));
  const canonicalActionsByRef = new Map(canonicalActions.map(action => [action.external_ref, action]));
  const copiesByRef = new Map(copies.map(copy => [copy.external_ref, copy]));
  const updateManagedFields = [...new Set(sheetUpdatePlan.events.flatMap(row => Object.keys(row.payload ?? {})))];

  return copyActions.map(action => {
    if (action.operation !== 'supersede') return action;
    if (groups.get(action.canonical_external_ref)?.length !== 1) {
      return { ...action, operation: 'hold', reason: 'ambiguous_canonical_visit' };
    }
    const copy = copiesByRef.get(action.external_ref);
    const sourceRow = Number(copy?.source_row);
    if (!Number.isInteger(sourceRow) || duplicateUpdateRows.has(sourceRow)) {
      return { ...action, operation: 'hold', reason: 'ambiguous_update_source_row' };
    }
    const updateRow = updateRowsByNumber.get(sourceRow);
    if (!updateRow || updateRow.payload?.source_file !== sheetUpdatePlan.source_file
      || updateRow.payload?.source_sha256 !== sheetUpdatePlan.source_sha256
      || updateRow.payload?.source_sheet !== sheetUpdatePlan.source_sheet) {
      return { ...action, operation: 'hold', reason: 'update_source_row_not_found' };
    }
    if (typeof updateRow.payload?.location_raw !== 'string' || !updateRow.payload.location_raw.trim()) {
      return { ...action, operation: 'hold', reason: 'update_location_missing' };
    }
    const canonicalAction = canonicalActionsByRef.get(action.canonical_external_ref);
    if (!canonicalAction || !['legacy_correct', 'unchanged'].includes(canonicalAction.operation)) {
      return { ...action, operation: 'hold', reason: canonicalAction?.reason ?? 'canonical_source_not_safe' };
    }
    const canonicalRow = canonicalRows.get(action.canonical_external_ref);
    if (!canonicalRow) return { ...action, operation: 'hold', reason: 'canonical_source_row_missing' };
    const updatePatch = Object.fromEntries(DART_UPDATE_FIELDS.filter(field => updateRow.payload?.[field] !== null
      && updateRow.payload?.[field] !== undefined && updateRow.payload?.[field] !== '')
      .map(field => [field, updateRow.payload[field]]));
    // The canonical keeps its 2025 source identity; this is what FCM will hold once the Update overlay applies.
    const patchedCanonical = { ...canonicalRow, payload: { ...canonicalRow.payload, ...updatePatch } };
    return {
      ...action,
      external_ref: action.canonical_external_ref,
      operation: 'update_and_supersede',
      record_id: canonicalAction.record_id,
      source_fingerprint: canonicalAction.source_fingerprint,
      record_fingerprint: recordFingerprint(logicalRow(patchedCanonical, 'event', managedSourceFields)),
      canonical_desired: canonicalRow,
      copy_external_ref: action.external_ref,
      copy_record_id: action.record_id,
      update_external_ref: updateRow.external_ref,
      update_source_fingerprint: recordFingerprint(logicalRow(updateRow, 'event', updateManagedFields)),
      update_desired: updateRow,
      update_patch: updatePatch,
    };
  });
}

export function buildReconciliationPlan({ sourcePlan, existing, checkpoints = [], eligibleOfficerIds,
  supersededRefs = [], canonicalPlan = null, sheetCopies = [], sheetUpdatePlan = null }) {
  if (sourcePlan?.mode !== 'plan' || !Array.isArray(sourcePlan.observations) || !Array.isArray(sourcePlan.events)
    || !Array.isArray(existing) || !Array.isArray(checkpoints) || !Array.isArray(supersededRefs)
    || !Array.isArray(sheetCopies)) throw new Error('Validated source plan and existing rows are required');
  validateDartUpdatePlan(sourcePlan, sheetUpdatePlan);
  const superseded = new Set(supersededRefs);
  const copiesOfCanonical = canonicalCopies(sourcePlan, canonicalPlan);
  const byKey = new Map();
  const duplicateExisting = new Set();
  for (const row of existing) {
    if (byKey.has(row.external_ref)) duplicateExisting.add(row.external_ref);
    byKey.set(row.external_ref, row);
  }
  const checkpointByKey = new Map();
  const duplicateCheckpoints = new Set();
  for (const checkpoint of checkpoints) {
    if (checkpointByKey.has(checkpoint.external_ref)) duplicateCheckpoints.add(checkpoint.external_ref);
    checkpointByKey.set(checkpoint.external_ref, checkpoint);
  }
  const eligibleOfficers = eligibleOfficerIds === undefined ? null : new Set(eligibleOfficerIds);
  const incoming = [
    ...sourcePlan.observations.map(row => ({ row, kind: 'observation' })),
    ...sourcePlan.events.map(row => ({ row, kind: 'event' })),
  ];
  const counts = new Map();
  for (const { row } of incoming) counts.set(row.external_ref, (counts.get(row.external_ref) ?? 0) + 1);
  const managedSourceFields = [...new Set(incoming.flatMap(({ row }) => Object.keys(row.payload ?? {})))];
  const actions = [];
  for (const { row, kind } of incoming) {
    const current = byKey.get(row.external_ref);
    const checkpoint = checkpointByKey.get(row.external_ref);
    const desired = logicalRow(row, kind, managedSourceFields);
    const sourceFingerprint = recordFingerprint(desired);
    const action = { external_ref: row.external_ref, kind, source_fingerprint: sourceFingerprint };
    const legacy = Boolean(current && !checkpoint && current.kind === kind && current.source_file === null && current.source_sheet === null);
    if (superseded.has(row.external_ref)) {
      actions.push({ ...action, operation: 'superseded' });
      continue;
    }
    if (copiesOfCanonical.has(row.external_ref)) {
      const canonicalRef = copiesOfCanonical.get(row.external_ref);
      if (!canonicalRef) actions.push({ ...action, operation: 'hold', reason: 'canonical_job_differs', ...(current ? { record_id: current.id } : {}) });
      else if (current) actions.push({ ...action, operation: 'supersede', record_id: current.id, canonical_external_ref: canonicalRef });
      else actions.push({ ...action, operation: 'canonical_copy', canonical_external_ref: canonicalRef });
      continue;
    }
    let reason = null;
    if (typeof row.external_ref !== 'string' || !row.external_ref.trim() || !row.payload?.job_number) reason = 'stable_source_job_required';
    else if (Boolean(row.zone_id) === Boolean(row.site_id)) reason = 'one_resolved_place_required';
    else if (desired.distance_km !== null && (!Number.isFinite(desired.distance_km) || desired.distance_km < 0)) reason = 'invalid_source_distance';
    else if (desired.officer_id && eligibleOfficers && !eligibleOfficers.has(desired.officer_id)) reason = 'source_staff_not_active_for_provider';
    else if (row.payload.source_file !== sourcePlan.source_file || row.payload.source_sha256 !== sourcePlan.source_sha256
      || row.payload.source_sheet !== sourcePlan.source_sheet) reason = 'source_provenance_mismatch';
    else if (counts.get(row.external_ref) > 1 || duplicateExisting.has(row.external_ref)) reason = 'ambiguous_record_key';
    else if (duplicateCheckpoints.has(row.external_ref)) reason = 'ambiguous_checkpoint';
    else if (current && !legacy && (current.kind !== kind || current.source_file !== row.payload.source_file
      || current.source_sheet !== row.payload.source_sheet)) reason = 'existing_source_identity_mismatch';
    else if (checkpoint && !current) reason = 'previously_linked_record_missing';
    else if (current && checkpoint && (checkpoint.record_id !== current.id || checkpoint.kind !== kind
      || checkpoint.source_file !== row.payload.source_file || checkpoint.source_sheet !== row.payload.source_sheet)) reason = 'checkpoint_identity_mismatch';
    else if (current && checkpoint && (typeof checkpoint.record_matches_state_after === 'boolean'
      ? !checkpoint.record_matches_state_after
      : checkpoint.record_fingerprint !== recordFingerprint(current.record))) reason = 'fcm_record_changed_since_last_sync';
    if (reason) {
      actions.push({ ...action, operation: 'hold', reason, ...(current ? { record_id: current.id } : {}) });
    } else if (!current) {
      actions.push({ ...action, operation: 'insert', desired });
    } else if (recordFingerprint(current.record) === sourceFingerprint) {
      actions.push({ ...action, operation: 'unchanged', record_id: current.id,
        ...(checkpoint ? {} : { baseline_required: true }) });
    } else if (legacy && kind === 'event') {
      // Pre-provenance import: the server corrects only known legacy artifacts and holds anything else.
      actions.push({ ...action, operation: 'legacy_correct', record_id: current.id, desired });
    } else if (!checkpoint) {
      actions.push({ ...action, operation: 'hold', reason: 'initial_difference_requires_review', record_id: current.id });
    } else if (checkpoint.source_fingerprint === sourceFingerprint) {
      // Persisted state is authoritative when storage rounded a source number or applied an overlay.
      if (checkpoint.record_matches_state_after === true || checkpoint.record_fingerprint !== checkpoint.source_fingerprint) {
        actions.push({ ...action, operation: 'unchanged', record_id: current.id,
          ...(checkpoint.record_fingerprint !== checkpoint.source_fingerprint ? { update_overlay: true } : {}) });
      } else {
        actions.push({ ...action, operation: 'hold', reason: 'source_and_record_checkpoint_disagree', record_id: current.id });
      }
    } else if (checkpoint.record_fingerprint !== checkpoint.source_fingerprint) {
      actions.push({ ...action, operation: 'hold', reason: 'update_overlay_review_required', record_id: current.id });
    } else {
      actions.push({ ...action, operation: 'update', record_id: current.id,
        prior_source_fingerprint: checkpoint.source_fingerprint,
        expected_record_fingerprint: checkpoint.record_fingerprint, desired });
    }
  }
  const copyActions = sheetCopyActions(sheetCopies, incoming, managedSourceFields, superseded, sheetUpdatePlan, actions);
  const pairedTargets = new Set(copyActions.filter(action => action.operation === 'update_and_supersede')
    .map(action => action.external_ref));
  if (pairedTargets.size) {
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      if (pairedTargets.has(actions[index].external_ref)) actions.splice(index, 1);
    }
  }
  actions.push(...copyActions);
  const summary = { insert: 0, update: 0, unchanged: 0, hold: 0, baseline_required: 0 };
  for (const action of actions) {
    summary[action.operation] = (summary[action.operation] ?? 0) + 1;
    if (action.baseline_required) summary.baseline_required += 1;
  }
  return { source_sha256: sourcePlan.source_sha256, summary, actions, deletes: [] };
}

export function previewReconciliation(sourcePlan, baseline, { canonicalPlan = null, sheetUpdatePlan = null } = {}) {
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
  const sheetCopies = (baseline.sheet_copies ?? []).map(row => {
    if (row.organization_id !== organizationId) throw new Error('Baseline row is outside the selected client');
    return normalizeExistingActivity(row, 'event', managedFields);
  });
  return buildReconciliationPlan({ sourcePlan, existing, checkpoints: baseline.checkpoints ?? [],
    eligibleOfficerIds: baseline.eligible_officer_ids, supersededRefs: baseline.superseded_refs ?? [],
    canonicalPlan, sheetCopies, sheetUpdatePlan,
  });
}

function changedRecordFields(before, after) {
  const fields = Object.keys(after).filter(key => key !== 'source_values'
    && recordFingerprint(before[key] ?? null) !== recordFingerprint(after[key] ?? null));
  for (const key of new Set([...Object.keys(before.source_values), ...Object.keys(after.source_values)])) {
    if (recordFingerprint(before.source_values[key] ?? null) !== recordFingerprint(after.source_values[key] ?? null)) {
      fields.push(`source_values.${key}`);
    }
  }
  return fields.sort();
}

export function compareSourcePlans(sourcePlan, previousSourcePlan = null) {
  const validate = plan => {
    if (!plan?.source_file || !plan.provider_organization_id || !/^[a-f0-9]{64}$/i.test(plan.source_sha256 ?? '')
      || !plan.manifest?.target_client_organization_id || !plan.manifest?.source_profile) {
      throw new Error('Source comparison requires workbook provenance, client scope, and source profile');
    }
    return buildReconciliationPlan({ sourcePlan: plan, existing: [] });
  };
  const currentValidation = validate(sourcePlan);
  const previousValidation = previousSourcePlan ? validate(previousSourcePlan) : null;
  if (previousSourcePlan && [
    sourcePlan.source_file !== previousSourcePlan.source_file,
    sourcePlan.provider_organization_id !== previousSourcePlan.provider_organization_id,
    sourcePlan.source_sheet !== previousSourcePlan.source_sheet,
    sourcePlan.manifest.target_client_organization_id !== previousSourcePlan.manifest.target_client_organization_id,
    sourcePlan.manifest.source_profile !== previousSourcePlan.manifest.source_profile,
    sourcePlan.manifest.client_code !== previousSourcePlan.manifest.client_code,
  ].some(Boolean)) {
    throw new Error('Source comparison must use the same workbook, worksheet, provider, client, profile, and key namespace');
  }
  const rows = plan => [
    ...plan.observations.map(row => ({ row, kind: 'observation' })),
    ...plan.events.map(row => ({ row, kind: 'event' })),
  ];
  const currentRows = rows(sourcePlan);
  const previousRows = previousSourcePlan ? rows(previousSourcePlan) : [];
  const managedFields = [...new Set([...currentRows, ...previousRows].flatMap(({ row }) => Object.keys(row.payload ?? {})))];
  const indexed = entries => new Map(entries.map(({ row, kind }) => [row.external_ref, logicalRow(row, kind, managedFields)]));
  const current = indexed(currentRows);
  const previous = indexed(previousRows);
  const currentHolds = new Map(currentValidation.actions.filter(action => action.operation === 'hold')
    .map(action => [action.external_ref, action.reason]));
  const previousHolds = new Map((previousValidation?.actions ?? []).filter(action => action.operation === 'hold')
    .map(action => [action.external_ref, action.reason]));
  const actions = [];
  for (const [externalRef, record] of current) {
    const before = previous.get(externalRef);
    const action = { external_ref: externalRef, kind: record.kind, source_fingerprint: recordFingerprint(record) };
    let reason = currentHolds.get(externalRef) ?? previousHolds.get(externalRef) ?? null;
    if (!reason && before && before.kind !== record.kind) reason = 'record_kind_changed';
    if (!reason && previousSourcePlan && sourcePlan.manifest.import_configuration_sha256
      !== previousSourcePlan.manifest.import_configuration_sha256) reason = 'import_configuration_changed';
    if (!reason && before && sourcePlan.source_sha256 === previousSourcePlan.source_sha256
      && recordFingerprint(before) !== action.source_fingerprint) reason = 'source_version_not_advanced';
    if (reason) {
      actions.push({ ...action, operation: 'hold', reason });
    } else if (!previousSourcePlan) {
      actions.push({ ...action, operation: 'baseline' });
    } else if (!before) {
      actions.push({ ...action, operation: 'added' });
    } else if (recordFingerprint(before) === action.source_fingerprint) {
      actions.push({ ...action, operation: 'unchanged' });
    } else {
      actions.push({ ...action, operation: 'updated', previous_source_fingerprint: recordFingerprint(before),
        changed_fields: changedRecordFields(before, record) });
    }
  }
  for (const [externalRef, record] of previous) {
    if (!current.has(externalRef)) {
      actions.push({ external_ref: externalRef, kind: record.kind, operation: 'missing',
        reason: 'missing_from_current_plan', previous_source_fingerprint: recordFingerprint(record) });
    }
  }
  const summary = { baseline: 0, added: 0, updated: 0, unchanged: 0, missing: 0, hold: 0 };
  for (const action of actions) summary[action.operation] += 1;
  return {
    source_sha256: sourcePlan.source_sha256, previous_source_sha256: previousSourcePlan?.source_sha256 ?? null,
    baseline_established: Boolean(previousSourcePlan), summary, actions, deletes: [],
  };
}

export async function loadLinkedBaseline(sourcePlan, providerOrganizationId, query, { copySheets = [] } = {}) {
  const clientId = sourcePlan?.manifest?.target_client_organization_id;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (!uuid.test(clientId ?? '') || !uuid.test(providerOrganizationId ?? '')) {
    throw new Error('Valid provider and client organization IDs are required');
  }
  if (!Array.isArray(copySheets) || copySheets.some(sheet => typeof sheet !== 'string' || !sheet.trim()
    || sheet === sourcePlan?.source_sheet)) {
    throw new Error('Copy worksheets must be named and differ from the source worksheet');
  }
  if (sourcePlan.provider_organization_id && sourcePlan.provider_organization_id !== providerOrganizationId) {
    throw new Error('Source plan provider does not match the selected provider');
  }
  if (sourcePlan.mode !== 'plan' || !Array.isArray(sourcePlan.observations) || !Array.isArray(sourcePlan.events)) {
    throw new Error('A validated source plan is required');
  }
  const keys = [...new Set([...sourcePlan.observations, ...sourcePlan.events].map(row => row.external_ref))];
  if (keys.some(key => typeof key !== 'string' || !/^rm_patrol_import:[a-z0-9_-]+:.{1,160}$/i.test(key))) {
    throw new Error('Every source row requires a bounded patrol import reference');
  }
  const scope = await query(`SELECT jsonb_build_object(
    'authorized', EXISTS(SELECT 1 FROM public.service_agreements a
      JOIN public.service_agreement_modules m ON m.service_agreement_id=a.id AND m.module_key='patrol' AND m.enabled
      WHERE a.provider_organization_id='${providerOrganizationId}'::uuid
        AND a.client_organization_id='${clientId}'::uuid AND a.agreement_type='operational'
        AND (a.starts_on IS NULL OR a.starts_on<=current_date) AND (a.ends_on IS NULL OR a.ends_on>=current_date)),
    'eligible_officer_ids', (SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM public.user_profiles
      WHERE deactivated_at IS NULL AND (organization_id='${providerOrganizationId}'::uuid
        OR employer_organization_id='${providerOrganizationId}'::uuid)),
    'sync_history', to_regclass('public.patrol_import_record_versions') IS NOT NULL,
    'supersede_history', to_regclass('public.location_events_superseded') IS NOT NULL) AS scope;`);
  if (scope?.[0]?.scope?.authorized !== true || !Array.isArray(scope[0].scope.eligible_officer_ids)) {
    throw new Error('A current provider/client patrol agreement and staff snapshot are required');
  }
  const syncHistory = scope[0].scope.sync_history === true;
  const supersedeHistory = scope[0].scope.supersede_history === true;
  const baseline = { organization_id: clientId, observations: [], events: [],
    eligible_officer_ids: scope[0].scope.eligible_officer_ids, checkpoints: [], sync_history: syncHistory,
    superseded_refs: [], sheet_copies: [] };
  // Compare the full persisted state just as the update RPC does; source fingerprints can
  // retain unrounded numbers while database columns store a fixed numeric precision.
  const checkpointSql = (syncHistory ? `,
        'checkpoints', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'external_ref',v.external_ref,'record_id',v.record_id,'kind',v.record_kind,
          'source_file',v.source_file,'source_sheet',v.source_sheet,'source_fingerprint',v.source_fingerprint,
          'record_fingerprint',coalesce(to_jsonb(v)->>'record_fingerprint',v.source_fingerprint),
          'record_matches_state_after',public.patrol_source_record_state(v.record_kind,v.record_id)
            IS NOT DISTINCT FROM v.state_after)),'[]'::jsonb)
          FROM public.patrol_import_record_versions v JOIN requested r ON v.external_ref=r.ref
          WHERE v.client_organization_id='${clientId}'::uuid
            AND v.provider_organization_id='${providerOrganizationId}'::uuid AND v.is_current)` : '')
    + (supersedeHistory ? `,
        'superseded', (SELECT coalesce(jsonb_agg(s.external_ref),'[]'::jsonb)
          FROM public.location_events_superseded s JOIN requested r ON s.external_ref=r.ref
          WHERE s.client_organization_id='${clientId}'::uuid)` : '');
  for (let offset = 0; offset < keys.length; offset += 200) {
    const encodedKeys = JSON.stringify(keys.slice(offset, offset + 200));
    if (encodedKeys.includes('$refs$')) throw new Error('Invalid import reference delimiter');
    const rows = await query(`WITH requested AS (SELECT jsonb_array_elements_text($refs$${encodedKeys}$refs$::jsonb) AS ref)
      SELECT jsonb_build_object(
        'observations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id',o.id,'organization_id',o.organization_id,'observed_at',o.observed_at,
          'zone_id',o.zone_id,'site_id',o.site_id,'officer_id',o.officer_id,
          'plate_number',o.plate_number,'officer_notes',o.officer_notes,
          'distance_km',o.distance_km,'external_refs',o.external_refs)),'[]'::jsonb)
          FROM public.observations o JOIN requested r ON o.external_refs->>'external_ref'=r.ref
          WHERE o.organization_id='${clientId}'::uuid),
        'events', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id',e.id,'organization_id',e.organization_id,'external_ref',e.external_ref,
          'occurred_at',e.occurred_at,'zone_id',e.zone_id,'client_site_id',e.client_site_id,
          'observed_entity_id',e.observed_entity_id,'observed_entity_type',e.observed_entity_type,
          'event_type',e.event_type,'status',e.status,'distance_km',e.distance_km,'payload',e.payload)),'[]'::jsonb)
          FROM public.location_events e JOIN requested r ON e.external_ref=r.ref
          WHERE e.organization_id='${clientId}'::uuid)${checkpointSql}) AS activity;`);
    if (rows?.length !== 1 || !Array.isArray(rows[0].activity?.observations) || !Array.isArray(rows[0].activity?.events)
      || (syncHistory && !Array.isArray(rows[0].activity?.checkpoints))
      || (supersedeHistory && !Array.isArray(rows[0].activity?.superseded))) {
      throw new Error('Incomplete linked activity response; no reconciliation plan was produced');
    }
    baseline.observations.push(...rows[0].activity.observations);
    baseline.events.push(...rows[0].activity.events);
    baseline.superseded_refs.push(...(rows[0].activity.superseded ?? []));
    for (const checkpoint of rows[0].activity.checkpoints ?? []) {
      baseline.checkpoints.push({ ...checkpoint, record_fingerprint: checkpoint.record_fingerprint ?? checkpoint.source_fingerprint });
    }
  }
  if (copySheets.length) {
    const filter = quoted('copy', { source_file: sourcePlan.source_file, sheets: copySheets });
    const rows = await query(`WITH f AS (SELECT ${filter}::jsonb AS v)
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',e.id,'organization_id',e.organization_id,'external_ref',e.external_ref,
        'occurred_at',e.occurred_at,'zone_id',e.zone_id,'client_site_id',e.client_site_id,
        'observed_entity_id',e.observed_entity_id,'observed_entity_type',e.observed_entity_type,
        'event_type',e.event_type,'status',e.status,'distance_km',e.distance_km,'payload',e.payload)),'[]'::jsonb) AS copies
      FROM public.location_events e CROSS JOIN f
      WHERE e.organization_id='${clientId}'::uuid AND e.source='rm_patrol_log_import'
        AND e.payload->>'source_file' = f.v->>'source_file'
        AND e.payload->>'source_sheet' IN (SELECT jsonb_array_elements_text(f.v->'sheets'));`);
    if (rows?.length !== 1 || !Array.isArray(rows[0].copies)) {
      throw new Error('Incomplete worksheet copy response; no reconciliation plan was produced');
    }
    baseline.sheet_copies = rows[0].copies;
  }
  return baseline;
}

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// Groups each new, baseline, or edited row with the proposals derived from it, so a row and
// its dependent review items always travel in the same governed transaction.
export function buildSyncChunks(sourcePlan, plan, { chunkSize = 200, sheetUpdatePlan = null, includeProposals = true } = {}) {
  if (sourcePlan?.mode !== 'plan' || !Array.isArray(plan?.actions) || plan.source_sha256 !== sourcePlan.source_sha256) {
    throw new Error('A reconciliation plan for this source version is required');
  }
  validateDartUpdatePlan(sourcePlan, sheetUpdatePlan);
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) throw new Error('Sync chunk size must be 1-500 rows');
  const sourceRows = new Map();
  for (const [kind, rows] of [['observation', sourcePlan.observations], ['event', sourcePlan.events]]) {
    for (const row of rows) sourceRows.set(row.external_ref, { kind, row });
  }
  const updateSourceRows = new Map((sheetUpdatePlan?.events ?? []).map(row => [row.external_ref, row]));
  const proposalsByRef = new Map();
  for (const proposal of includeProposals ? sourcePlan.proposals ?? [] : []) {
    const list = proposalsByRef.get(proposal.source_record_key) ?? [];
    list.push(proposal);
    proposalsByRef.set(proposal.source_record_key, list);
  }
  const units = [];
  const pairedKeys = new Set();
  for (const action of plan.actions) {
    if (action.operation === 'update_and_supersede') {
      const canonical = sourceRows.get(action.external_ref);
      const update = updateSourceRows.get(action.update_external_ref);
      if (!canonical || canonical.kind !== 'event' || !update || !action.copy_external_ref || !action.copy_record_id
        || !action.update_source_fingerprint || !/^[a-f0-9]{64}$/.test(action.record_fingerprint ?? '')
        || !action.update_patch?.location_raw) {
        throw new Error('A DART Update row must map to one canonical event and one existing source copy');
      }
      // One-to-one across the whole run, not just within one chunk: a collision group never reaches the server.
      for (const key of [`canonical:${action.external_ref}`, `copy:${action.copy_external_ref}`, `update:${update.external_ref}`]) {
        if (pairedKeys.has(key)) throw new Error('A DART Update pairing repeats a canonical event, copy, or Update row');
        pairedKeys.add(key);
      }
      const correction = { kind: 'event', external_ref: action.external_ref, record_id: action.record_id,
        source_fingerprint: action.source_fingerprint, desired: action.canonical_desired ?? canonical.row };
      units.push({
        correction,
        dartUpdate: {
          canonical: correction,
          copy_external_ref: action.copy_external_ref,
          copy_record_id: action.copy_record_id,
          update_external_ref: update.external_ref,
          update_source_fingerprint: action.update_source_fingerprint,
          record_fingerprint: action.record_fingerprint,
          update_desired: update,
          update_patch: action.update_patch,
        },
        proposals: [],
      });
      continue;
    }
    if (action.operation === 'supersede') {
      const source = sourceRows.get(action.external_ref);
      if (action.kind !== 'event' || !action.canonical_external_ref || (source && source.kind !== 'event')) continue;
      units.push({ supersede: { kind: 'event', external_ref: action.external_ref,
        canonical_external_ref: action.canonical_external_ref,
        ...(source ? { source_fingerprint: action.source_fingerprint, desired: source.row } : {}) }, proposals: [] });
      continue;
    }
    const source = sourceRows.get(action.external_ref);
    if (!source || source.kind !== action.kind) continue;
    const item = { kind: action.kind, external_ref: action.external_ref,
      source_fingerprint: action.source_fingerprint, desired: source.row };
    if (action.operation === 'insert') {
      units.push({ insert: source, baseline: { ...item, record_id: null },
        proposals: proposalsByRef.get(action.external_ref) ?? [] });
    } else if (action.operation === 'unchanged' && action.baseline_required) {
      units.push({ baseline: { ...item, record_id: action.record_id }, proposals: [] });
    } else if (action.operation === 'update') {
      units.push({ update: { ...item, record_id: action.record_id, prior_source_fingerprint: action.prior_source_fingerprint },
        proposals: proposalsByRef.get(action.external_ref) ?? [] });
    } else if (action.operation === 'legacy_correct') {
      units.push({ correction: { ...item, record_id: action.record_id },
        proposals: proposalsByRef.get(action.external_ref) ?? [] });
    }
  }
  const chunks = [];
  for (let offset = 0; offset < units.length; offset += chunkSize) {
    const slice = units.slice(offset, offset + chunkSize);
    const chunk = {
      observations: slice.filter(unit => unit.insert?.kind === 'observation').map(unit => unit.insert.row),
      events: slice.filter(unit => unit.insert?.kind === 'event').map(unit => unit.insert.row),
      proposals: slice.flatMap(unit => unit.proposals),
      baselines: slice.filter(unit => unit.baseline).map(unit => unit.baseline),
      updates: slice.filter(unit => unit.update).map(unit => unit.update),
      corrections: slice.filter(unit => unit.correction).map(unit => unit.correction),
      supersedes: slice.filter(unit => unit.supersede).map(unit => unit.supersede),
    };
    const dartUpdates = slice.filter(unit => unit.dartUpdate).map(unit => unit.dartUpdate);
    if (dartUpdates.length) chunk.dartUpdates = dartUpdates;
    chunks.push(chunk);
  }
  const sum = key => chunks.reduce((total, chunk) => total + (chunk[key]?.length ?? 0), 0);
  return {
    chunks,
    proposal_count: sum('proposals'),
    counts: { inserts: sum('observations') + sum('events'), baselines: sum('baselines'),
      updates: sum('updates'), proposals: sum('proposals'),
      ...(sum('corrections') ? { corrections: sum('corrections') } : {}),
      ...(sum('supersedes') ? { supersedes: sum('supersedes') } : {}),
      ...(sum('dartUpdates') ? { dart_updates: sum('dartUpdates') } : {}) },
  };
}

function quoted(tag, value) {
  const json = JSON.stringify(value);
  if (json.includes(`$${tag}$`)) throw new Error('Sync data must not contain its SQL delimiter');
  return `$${tag}$${json}$${tag}$`;
}

export function buildSyncChunkSql({ actorId, providerOrganizationId, clientOrganizationId, batchId = null, batch,
  dartUpdateBatchId = null, dartUpdateBatch = null, chunk, commit, previewMigrationSql = '' }) {
  if (![actorId, providerOrganizationId, clientOrganizationId].every(id => UUID_PATTERN.test(id ?? ''))
    || (batchId !== null && !UUID_PATTERN.test(batchId))
    || (dartUpdateBatchId !== null && !UUID_PATTERN.test(dartUpdateBatchId))) throw new Error('Valid sync identities are required');
  if (commit && previewMigrationSql) throw new Error('A preview migration can only be used in a rolled-back dry run');
  if (!batchId && !batch?.manifest?.idempotency_key) throw new Error('A sync batch definition is required');
  if (chunk.dartUpdates?.length && !dartUpdateBatchId && !dartUpdateBatch?.manifest?.idempotency_key) {
    throw new Error('DART Update actions require their source worksheet batch');
  }
  const provider = `'${providerOrganizationId}'::uuid`;
  const client = `'${clientOrganizationId}'::uuid`;
  const data = { batch_id: batchId, batch: batch ?? null, observations: chunk.observations, events: chunk.events,
    proposals: chunk.proposals, baselines: chunk.baselines, updates: chunk.updates,
    corrections: chunk.corrections ?? [], supersedes: chunk.supersedes ?? [],
    dart_update_batch_id: dartUpdateBatchId, dart_update_batch: dartUpdateBatch ?? null,
    dart_updates: chunk.dartUpdates ?? [] };
  const dartUpdateBatchSql = chunk.dartUpdates?.length ? `
create temp table fcm_dart_update_input on commit drop as
  select data->'dart_update_batch' as batch, nullif(data->>'dart_update_batch_id','')::uuid as batch_id
  from fcm_sync_input;
update fcm_dart_update_input set batch_id = coalesce(batch_id, (public.begin_patrol_import_batch(
  p_provider_organization_id => ${provider},
  p_client_organization_id => ${client},
  p_batch_name => batch->>'batch_name',
  p_source_file => batch->>'source_file',
  p_source_sha256 => batch->>'source_sha256',
  p_parser => batch->>'parser',
  p_manifest_json => batch->'manifest',
  p_schema_json => batch->'schema',
  p_row_count => (batch->>'row_count')::integer,
  p_duplicate_count => (batch->>'duplicate_count')::integer,
  p_unresolved_count => (batch->>'unresolved_count')::integer)).id);` : '';
  const dartUpdatePhaseSql = chunk.dartUpdates?.length ? `
insert into fcm_sync_result
select 'dart_update', applied.*
from fcm_sync_input input
cross join fcm_dart_update_input dart_batch
cross join lateral public.apply_dart_patrol_source_updates_and_supersede(
  input.batch_id, dart_batch.batch_id, ${provider}, ${client}, input.data->'dart_updates') applied
where jsonb_array_length(input.data->'dart_updates') > 0;` : '';
  const dartUpdateBatchResult = chunk.dartUpdates?.length
    ? '(select batch_id from fcm_dart_update_input)' : 'null::uuid';
  return `BEGIN;
${previewMigrationSql}
set local request.jwt.claim.sub = '${actorId}';
create temp table fcm_sync_input on commit drop as select ${quoted('sync', data)}::jsonb as data, null::uuid as batch_id;
update fcm_sync_input set batch_id = coalesce(nullif(data->>'batch_id','')::uuid, (public.begin_patrol_import_batch(
  p_provider_organization_id => ${provider},
  p_client_organization_id => ${client},
  p_batch_name => data->'batch'->>'batch_name',
  p_source_file => data->'batch'->>'source_file',
  p_source_sha256 => data->'batch'->>'source_sha256',
  p_parser => data->'batch'->>'parser',
  p_manifest_json => data->'batch'->'manifest',
  p_schema_json => data->'batch'->'schema',
  p_row_count => (data->'batch'->>'row_count')::integer,
  p_duplicate_count => (data->'batch'->>'duplicate_count')::integer,
  p_unresolved_count => (data->'batch'->>'unresolved_count')::integer)).id);
${dartUpdateBatchSql}
create temp table fcm_sync_result(phase text, external_ref text, record_id uuid, outcome text, detail text) on commit drop;
insert into fcm_sync_result(phase, outcome, detail)
select 'stage', 'staged', to_jsonb(staged)::text
from fcm_sync_input input
cross join lateral public.stage_patrol_import_chunk(input.batch_id, ${provider}, ${client},
  input.data->'observations', input.data->'events', input.data->'proposals') staged
where jsonb_array_length(input.data->'observations') + jsonb_array_length(input.data->'events')
  + jsonb_array_length(input.data->'proposals') > 0;
insert into fcm_sync_result
select 'baseline', adopted.*
from fcm_sync_input input
cross join lateral public.adopt_patrol_source_baseline(input.batch_id, ${provider}, ${client}, (
  select coalesce(jsonb_agg(item || jsonb_build_object('record_id', coalesce(nullif(item->>'record_id',''),
    case item->>'kind'
      when 'event' then (select event.id::text from public.location_events event
        where event.organization_id = ${client} and event.external_ref = item->>'external_ref')
      else (select observation.id::text from public.observations observation
        where observation.organization_id = ${client} and observation.external_refs->>'external_ref' = item->>'external_ref')
    end))), '[]'::jsonb)
  from jsonb_array_elements(input.data->'baselines') item)) adopted
where jsonb_array_length(input.data->'baselines') > 0;
insert into fcm_sync_result
select 'update', applied.*
from fcm_sync_input input
cross join lateral public.apply_patrol_source_updates(input.batch_id, ${provider}, ${client}, input.data->'updates') applied
where jsonb_array_length(input.data->'updates') > 0;
insert into fcm_sync_result
select 'correction', corrected.*
from fcm_sync_input input
cross join lateral public.correct_legacy_patrol_source_records(input.batch_id, ${provider}, ${client},
  input.data->'corrections') corrected
where jsonb_array_length(input.data->'corrections') > 0;
insert into fcm_sync_result
select 'supersede', archived.*
from fcm_sync_input input
cross join lateral public.supersede_duplicate_patrol_events(input.batch_id, ${provider}, ${client},
  input.data->'supersedes') archived
where jsonb_array_length(input.data->'supersedes') > 0;
${dartUpdatePhaseSql}
select (select batch_id from fcm_sync_input) as batch_id, ${dartUpdateBatchResult} as dart_update_batch_id,
  (select coalesce(jsonb_agg(to_jsonb(result)), '[]'::jsonb) from fcm_sync_result result) as results;
${commit ? 'COMMIT;' : 'ROLLBACK;'}`;
}

export function summarizeSyncResults(results) {
  const summary = { staged: { obs_inserted: 0, evt_inserted: 0, proposals_inserted: 0 }, baseline: {}, update: {},
    correction: {}, supersede: {}, dart_update: {}, hold_reasons: {} };
  for (const result of results) {
    if (result.phase === 'stage') {
      const staged = JSON.parse(result.detail);
      for (const key of Object.keys(summary.staged)) summary.staged[key] += Number(staged[key] ?? 0);
      continue;
    }
    summary[result.phase][result.outcome] = (summary[result.phase][result.outcome] ?? 0) + 1;
    if (result.outcome === 'held') {
      const reason = `${result.phase}:${result.detail}`;
      summary.hold_reasons[reason] = (summary.hold_reasons[reason] ?? 0) + 1;
    }
  }
  return summary;
}

// Applies one workbook version: new rows are staged, matching rows get a source baseline, and
// edited rows update FCM through the governed RPCs. Removed rows are never deleted.
export async function runSourceSync({ sourcePlan, providerOrganizationId, readQuery, writeQuery, commit = false,
  previewMigrationSql = '', attempt = 1, chunkSize = 200, canonicalPlan = null, copySheets = [], sheetUpdatePlan = null,
  evidenceOnly = false }) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Sync attempt must be a positive integer');
  const batch = sourcePlan?.batch;
  const clientId = sourcePlan?.manifest?.target_client_organization_id;
  if (!batch?.manifest?.idempotency_key || batch.source_sha256 !== sourcePlan.source_sha256
    || batch.provider_organization_id !== providerOrganizationId || batch.client_organization_id !== clientId
    || batch.manifest.source_profile !== sourcePlan.manifest.source_profile) {
    throw new Error('The source plan must carry the importer batch definition for this provider, client, and workbook version');
  }
  if (!/^[a-z0-9_]{1,80}$/i.test(batch.manifest.source_profile)) throw new Error('Invalid source profile code');
  validateDartUpdatePlan(sourcePlan, sheetUpdatePlan);
  if (sheetUpdatePlan && !copySheets.includes(sheetUpdatePlan.source_sheet)) {
    throw new Error('DART Update reconciliation must load the approved worksheet copies');
  }
  if (sheetUpdatePlan && (!sheetUpdatePlan.batch?.manifest?.idempotency_key
    || sheetUpdatePlan.batch.source_sha256 !== sheetUpdatePlan.source_sha256
    || sheetUpdatePlan.batch.provider_organization_id !== providerOrganizationId
    || sheetUpdatePlan.batch.client_organization_id !== clientId
    || sheetUpdatePlan.batch.manifest.source_profile !== sheetUpdatePlan.manifest.source_profile)) {
    throw new Error('The DART Update plan must carry its own importer batch definition');
  }
  const baseline = await loadLinkedBaseline(sourcePlan, providerOrganizationId, readQuery, { copySheets });
  if (!baseline.sync_history && !previewMigrationSql) throw new Error('Source row sync is not installed in this database');
  if (canonicalPlan && (canonicalPlan.mode !== 'plan' || !Array.isArray(canonicalPlan.events)
    || canonicalPlan.manifest?.target_client_organization_id !== clientId
    || canonicalPlan.source_sheet === sourcePlan.source_sheet)) {
    throw new Error('The canonical plan must be a different validated worksheet plan for the same client');
  }
  const plan = previewReconciliation(sourcePlan, baseline, { canonicalPlan, sheetUpdatePlan });
  const { chunks, proposal_count: proposalCount, counts } = buildSyncChunks(sourcePlan, plan, {
    chunkSize, sheetUpdatePlan, includeProposals: !sheetUpdatePlan && !evidenceOnly,
  });
  const planHoldReasons = {};
  for (const action of plan.actions) {
    if (action.operation === 'hold') planHoldReasons[action.reason] = (planHoldReasons[action.reason] ?? 0) + 1;
  }
  const idleStatus = plan.summary.hold ? 'source_rows_held' : 'no_source_changes';
  const report = { mode: commit ? 'apply' : 'dry_run', committed: false, attempt, plan_summary: plan.summary,
    plan_hold_reasons: planHoldReasons,
    requested: counts, batch_id: null, results: [] };
  if (!chunks.length && !commit) return { ...report, status: idleStatus, summary: summarizeSyncResults([]) };

  const actorRows = await readQuery(`SELECT import_actor_id FROM public.import_source_profiles
    WHERE organization_id='${providerOrganizationId}'::uuid AND profile_code='${batch.manifest.source_profile}' AND active;`);
  const actorId = actorRows?.length === 1 ? actorRows[0].import_actor_id : null;
  if (!UUID_PATTERN.test(actorId ?? '')) throw new Error('The source profile has no configured import identity');

  const syncKey = `row_sync:${attempt}:${batch.manifest.idempotency_key}`;
  const syncBatch = {
    ...batch,
    batch_name: `${batch.batch_name} - source row sync`,
    manifest: { ...batch.manifest, idempotency_key: syncKey, expected_proposal_count: proposalCount,
      sync_mode: 'source_row_sync', direct_workshop_writes: 0, direct_finance_writes: 0 },
  };
  const dartUpdateSyncKey = sheetUpdatePlan
    ? `dart_update:${attempt}:${sheetUpdatePlan.batch.manifest.idempotency_key}` : null;
  const dartUpdateBatch = sheetUpdatePlan ? {
    ...sheetUpdatePlan.batch,
    batch_name: `${sheetUpdatePlan.batch.batch_name} - canonical source update`,
    manifest: { ...sheetUpdatePlan.batch.manifest, idempotency_key: dartUpdateSyncKey,
      expected_proposal_count: 0, sync_mode: 'source_row_update', direct_workshop_writes: 0, direct_finance_writes: 0 },
  } : null;
  let batchId = null;
  let dartUpdateBatchId = null;
  if (commit) {
    const existing = await readQuery(`SELECT id, status FROM public.file_import_batches
      WHERE organization_id='${providerOrganizationId}'::uuid
        AND manifest_json->>'idempotency_key'=(${quoted('key', syncKey)}::jsonb #>> '{}');`);
    if (existing?.length && existing[0].status !== 'staging') {
      throw new Error('This workbook version was already synced; resolve held rows and re-run with the next --attempt');
    }
    batchId = existing?.[0]?.id ?? null;
    if (dartUpdateBatch) {
      const existingUpdate = await readQuery(`SELECT id, status FROM public.file_import_batches
        WHERE organization_id='${providerOrganizationId}'::uuid
          AND manifest_json->>'idempotency_key'=(${quoted('key', dartUpdateSyncKey)}::jsonb #>> '{}');`);
      if (existingUpdate?.length && existingUpdate[0].status !== 'staging') {
        throw new Error('This DART Update version was already synced; resolve held rows and re-run with the next --attempt');
      }
      dartUpdateBatchId = existingUpdate?.[0]?.id ?? null;
    }
  }
  // Both receipts close in one transaction, so paired writes can never be left without their
  // Update receipt; a re-run with no remaining changes still closes batches left in staging.
  const finalizeBatches = async (results, recovered) => {
    const summary = summarizeSyncResults(results);
    const marker = recovered ? { receipt_recovered: true } : {};
    const statements = [];
    if (batchId) {
      const receipt = { direct_workshop_writes: 0, direct_finance_writes: 0, source_row_sync: summary, ...marker };
      statements.push(`SELECT batch.id FROM public.finalize_patrol_import_batch('${batchId}'::uuid, ${quoted('receipt', receipt)}::jsonb) batch;`);
    }
    if (dartUpdateBatchId) {
      const updateReceipt = { direct_workshop_writes: 0, direct_finance_writes: 0,
        source_row_update: { dart_update: summary.dart_update }, ...marker };
      statements.push(`SELECT batch.id FROM public.finalize_patrol_import_batch('${dartUpdateBatchId}'::uuid, ${quoted('update_receipt', updateReceipt)}::jsonb) batch;`);
    }
    if (!statements.length) return;
    await writeQuery(`BEGIN;
set local request.jwt.claim.sub = '${actorId}';
${statements.join('\n')}
COMMIT;`);
  };
  if (!chunks.length) {
    if (!batchId && !dartUpdateBatchId) return { ...report, status: idleStatus, summary: summarizeSyncResults([]) };
    await finalizeBatches([], true);
    return { ...report, committed: true, batch_id: batchId, dart_update_batch_id: dartUpdateBatchId,
      status: 'receipt_recovered', summary: summarizeSyncResults([]) };
  }
  const results = [];
  for (const chunk of chunks) {
    const rows = await writeQuery(buildSyncChunkSql({ actorId, providerOrganizationId, clientOrganizationId: clientId,
      batchId, batch: batchId ? null : syncBatch,
      dartUpdateBatchId: chunk.dartUpdates?.length ? dartUpdateBatchId : null,
      dartUpdateBatch: chunk.dartUpdates?.length && !dartUpdateBatchId ? dartUpdateBatch : null,
      chunk, commit, previewMigrationSql }));
    if (rows?.length !== 1 || !Array.isArray(rows[0].results)) throw new Error('Sync chunk returned no outcome; later chunks were not sent');
    if (commit) {
      batchId = rows[0].batch_id;
      if (chunk.dartUpdates?.length) dartUpdateBatchId = rows[0].dart_update_batch_id;
    }
    results.push(...rows[0].results);
  }
  if (commit) await finalizeBatches(results, false);
  return { ...report, committed: commit, batch_id: batchId, dart_update_batch_id: dartUpdateBatchId,
    status: 'completed', summary: summarizeSyncResults(results), results };
}

function cliQuery(sql) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fcm-reconcile-'));
  try {
    const input = path.join(directory, 'query.sql');
    writeFileSync(input, sql, { mode: 0o600 });
    const cli = path.resolve('node_modules', 'supabase', 'dist', 'supabase.js');
    const result = JSON.parse(execFileSync(process.execPath, [cli, 'db', 'query', '--linked', '--file', input, '--output-format', 'json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    if (!Array.isArray(result.rows)) throw new Error('Linked query returned no rows');
    return result.rows;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function linkedQuery(sql) {
  return cliQuery(`BEGIN READ ONLY;\n${sql}\nROLLBACK;`);
}

async function runApply(argument) {
  if (!['--source-plan', '--output', '--provider-org-id'].every(name => process.argv.includes(name) && argument(name))) {
    throw new Error('Use --apply --source-plan <json> --provider-org-id <uuid> --output <local report json> [--commit] [--evidence-only] [--attempt <n>] [--canonical-plan <json>] [--sheet-update-plan <json>] [--supersede-copies-sheet <sheet>]');
  }
  const commit = process.argv.includes('--commit');
  const previewMigration = process.argv.includes('--preview-migration') ? argument('--preview-migration') : null;
  if (commit && previewMigration) throw new Error('--preview-migration is only allowed for a rolled-back dry run');
  const attempt = process.argv.includes('--attempt') ? Number(argument('--attempt')) : 1;
  const output = path.resolve(argument('--output'));
  const inputFlags = ['--source-plan', '--canonical-plan', '--sheet-update-plan', '--preview-migration'];
  const inputPaths = inputFlags.filter(flag => process.argv.includes(flag)).map(flag => {
    if (!argument(flag)) throw new Error(`${flag} requires an input path`);
    return path.resolve(argument(flag));
  });
  const samePath = input => process.platform === 'win32'
    ? input.toLowerCase() === output.toLowerCase()
    : input === output;
  if (path.extname(output).toLowerCase() !== '.json' || inputPaths.some(samePath)) {
    throw new Error('The report must be a separate JSON file, never an input or source workbook');
  }
  const sourcePlan = JSON.parse((await readFile(argument('--source-plan'), 'utf8')).replace(/^\uFEFF/, ''));
  const canonicalPlan = process.argv.includes('--canonical-plan')
    ? JSON.parse((await readFile(argument('--canonical-plan'), 'utf8')).replace(/^\uFEFF/, '')) : null;
  const sheetUpdatePlan = process.argv.includes('--sheet-update-plan')
    ? JSON.parse((await readFile(argument('--sheet-update-plan'), 'utf8')).replace(/^\uFEFF/, '')) : null;
  const copySheets = process.argv.flatMap((value, index) =>
    value === '--supersede-copies-sheet' ? [process.argv[index + 1]] : []);
  const previewMigrationSql = previewMigration ? await readFile(previewMigration, 'utf8') : '';
  const report = await runSourceSync({ sourcePlan, providerOrganizationId: argument('--provider-org-id'),
    readQuery: linkedQuery, writeQuery: cliQuery, commit, previewMigrationSql, attempt, canonicalPlan, copySheets, sheetUpdatePlan,
    evidenceOnly: process.argv.includes('--evidence-only') });
  await writeFile(output, JSON.stringify(report), { mode: 0o600 });
  console.log(JSON.stringify({ mode: report.mode, status: report.status, committed: report.committed,
    plan_summary: report.plan_summary, plan_hold_reasons: report.plan_hold_reasons,
    requested: report.requested, summary: report.summary }));
}

async function main() {
  const argument = name => process.argv[process.argv.indexOf(name) + 1];
  if (process.argv.includes('--apply')) return runApply(argument);
  const linked = process.argv.includes('--linked');
  if (!['--source-plan', '--output'].every(name => process.argv.includes(name) && argument(name))
    || linked === process.argv.includes('--baseline')
    || (linked && (!process.argv.includes('--provider-org-id') || !argument('--provider-org-id')))) {
    throw new Error('Use --source-plan <json> --output <local report json> and either --baseline <json> or --linked --provider-org-id <uuid>');
  }
  const output = path.resolve(argument('--output'));
  const inputs = [argument('--source-plan'), ...(linked ? [] : [argument('--baseline')]),
    ...['--canonical-plan', '--sheet-update-plan'].filter(flag => process.argv.includes(flag)).map(argument),
    ...(process.argv.includes('--previous-source-plan') ? [argument('--previous-source-plan')] : [])].map(value => path.resolve(value));
  const samePath = input => process.platform === 'win32' ? input.toLowerCase() === output.toLowerCase() : input === output;
  if (path.extname(output).toLowerCase() !== '.json' || inputs.some(samePath)) {
    throw new Error('The report must be a separate JSON file, never an input or source workbook');
  }
  const sourcePlan = JSON.parse((await readFile(argument('--source-plan'), 'utf8')).replace(/^\uFEFF/, ''));
  const canonicalPlan = process.argv.includes('--canonical-plan')
    ? JSON.parse((await readFile(argument('--canonical-plan'), 'utf8')).replace(/^\uFEFF/, '')) : null;
  const sheetUpdatePlan = process.argv.includes('--sheet-update-plan')
    ? JSON.parse((await readFile(argument('--sheet-update-plan'), 'utf8')).replace(/^\uFEFF/, '')) : null;
  const copySheets = process.argv.flatMap((value, index) =>
    value === '--supersede-copies-sheet' ? [process.argv[index + 1]] : []);
  if (sheetUpdatePlan && !copySheets.includes(sheetUpdatePlan.source_sheet)) {
    throw new Error('DART Update reconciliation must load the approved worksheet copies');
  }
  const baseline = linked
    ? await loadLinkedBaseline(sourcePlan, argument('--provider-org-id'), linkedQuery, { copySheets })
    : JSON.parse((await readFile(argument('--baseline'), 'utf8')).replace(/^\uFEFF/, ''));
  const result = previewReconciliation(sourcePlan, baseline, { canonicalPlan, sheetUpdatePlan });
  const previousSourcePlan = process.argv.includes('--previous-source-plan')
    ? JSON.parse((await readFile(argument('--previous-source-plan'), 'utf8')).replace(/^\uFEFF/, '')) : null;
  if (previousSourcePlan) result.source_changes = compareSourcePlans(sourcePlan, previousSourcePlan);
  await writeFile(output, JSON.stringify(result), { mode: 0o600 });
  const reasons = {};
  for (const action of result.actions) if (action.reason) reasons[action.reason] = (reasons[action.reason] ?? 0) + 1;
  console.log(JSON.stringify({ mode: 'preview', baseline: linked ? 'linked_read_only' : 'local',
    source_counts: sourcePlan.counts ?? null, source_changes: result.source_changes?.summary ?? null,
    summary: result.summary, hold_reasons: reasons, business_writes: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Reconciliation failed: ${String(error?.message ?? '').split('\n')[0].slice(0, 300)}`);
    process.exitCode = 1;
  });
}