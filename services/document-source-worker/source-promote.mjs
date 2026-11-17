import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasSourceFinancialValues } from '../../scripts/patrol-source-financial-hold.mjs';
import {
  acquireSourceLock, acknowledgeSourceVersion, holdSourceVersion, isHeldVersion, loadSyncState, pendingSourceVersions,
  photoSourcePaths, runSourceScan, saveSyncState,
} from './source-sync.mjs';
import { MAX_NEW_PLACES_PER_SHEET, MAX_REVIEWED_PLACES, placeOverlay, placeRegistrationSql, placesToRegister } from './source-places.mjs';
import {
  buildCaptureGroups, captureCsv, captureSheet, captureVersion, chunkCaptureGroups, MAX_CAPTURE_BATCHES, validatePhotoCaptures,
} from './source-captures.mjs';

export const newPlaceLimit = map => map.max_new_places_per_sheet ?? MAX_NEW_PLACES_PER_SHEET;
export { acquireSourceLock };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CODE = /^[A-Z0-9_-]{1,40}$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKBOOK_FOLDER = 'Patrol Log Entries/All Log Spreadsheets/';

export function validateSourceMap(map) {
  if (map?.version !== 1 || !UUID.test(map.provider_organization_id ?? '')
    || !/^[a-z0-9_-]+$/.test(map.classification_profile ?? '') || !map.workbooks || typeof map.workbooks !== 'object') {
    throw new Error('The patrol source map is invalid');
  }
  const limit = map.max_new_rows_per_sheet;
  if (!Number.isInteger(limit) || limit < 0 || limit > 5000) throw new Error('max_new_rows_per_sheet must be 0-5000');
  if (map.max_new_places_per_sheet !== undefined
    && (!Number.isInteger(map.max_new_places_per_sheet) || map.max_new_places_per_sheet < 0 || map.max_new_places_per_sheet > MAX_REVIEWED_PLACES)) {
    throw new Error(`max_new_places_per_sheet must be 0-${MAX_REVIEWED_PLACES}`);
  }
  if (map.non_place_terms !== undefined && (!Array.isArray(map.non_place_terms)
    || !map.non_place_terms.every(term => typeof term === 'string' && /^[\p{L}\p{N}/ .-]{1,20}$/u.test(term)))) {
    throw new Error('non_place_terms must be short words');
  }
  const namespaces = new Set();
  const sheetsByCode = new Map();
  for (const [workbook, entry] of Object.entries(map.workbooks)) {
    if (entry.hold) {
      if (!/^[a-z0-9_]{1,80}$/.test(entry.hold) || entry.sheets) throw new Error(`${workbook}: a held workbook needs one reason code and no sheets`);
      continue;
    }
    if (!Array.isArray(entry.sheets) || !entry.sheets.length) throw new Error(`${workbook}: map at least one sheet or hold it`);
    for (const sheet of entry.sheets) {
      if (typeof sheet.sheet !== 'string' || !sheet.sheet || !Number.isInteger(sheet.header_row) || sheet.header_row < 1
        || !CODE.test(sheet.client_code ?? '') || !UUID.test(sheet.client_organization_id ?? '')
        || !/^[a-z0-9-]+-zone-map\.json$/.test(sheet.zone_map ?? '')) {
        throw new Error(`${workbook}: sheet mapping is incomplete`);
      }
      if (sheet.place_name_suffix !== undefined
        && (typeof sheet.place_name_suffix !== 'string' || !/^[\p{L}\p{N}&' .-]{1,40}$/u.test(sheet.place_name_suffix))) {
        throw new Error(`${workbook}: place_name_suffix must be a short client label`);
      }
      for (const [key, name] of Object.entries(sheet.place_aliases ?? {})) {
        if (!/^[\p{L}\p{N}/ .-]{1,20}$/u.test(key) || typeof name !== 'string' || !/^[\p{L}\p{N}&'(),/ .-]{3,80}$/u.test(name)) {
          throw new Error(`${workbook}: place alias ${key} must name one place`);
        }
      }
      if (sheet.new_namespace !== undefined && sheet.new_namespace !== true) {
        throw new Error(`${workbook}: new_namespace may only be true`);
      }
      for (const [position, alias] of Object.entries(sheet.column_aliases ?? {})) {
        if (!/^[1-9][0-9]{0,2}$/.test(position) || typeof alias?.source_header !== 'string'
          || typeof alias.alias !== 'string' || !alias.alias.trim()
          || (alias.preserve_source === true) === (alias.require_empty === true)) {
          throw new Error(`${workbook}: column alias ${position} must name its exact header and one handling rule`);
        }
      }
      // One namespace per sheet: a shared code would make two sheets overwrite each other's rows.
      if (namespaces.has(sheet.client_code)) throw new Error(`Client code ${sheet.client_code} is mapped twice`);
      namespaces.add(sheet.client_code);
      sheetsByCode.set(sheet.client_code, sheet);
    }
  }
  validatePhotoCaptures(map.photo_captures, sheetsByCode);
  return map;
}

export function workbookEntry(relativePath, map) {
  if (!relativePath.startsWith(WORKBOOK_FOLDER)) return null;
  return map.workbooks[relativePath.slice(WORKBOOK_FOLDER.length)] ?? { hold: 'workbook_not_mapped' };
}

// Legacy corrections are a one-time provenance adoption of rows imported before source tracking;
// the server corrects only known legacy artifacts, so only genuinely new or changed rows count here.
const changedRows = requested => (requested?.inserts ?? 0) + (requested?.updates ?? 0);

function conflictingPlaceHold(plan, label, places) {
  const conflicts = (plan.unresolved_places ?? []).filter(place => place.reason === 'conflicting_place_fields');
  if (!conflicts.length) return null;
  if (conflicts.some(place => !Array.isArray(place.source_rows) || !place.source_rows.length
    || place.source_rows.some(row => !Number.isInteger(row) || row < 1))) {
    throw new Error(`${label.client_code}: conflicting places require source row numbers`);
  }
  const sourceRows = conflicts.flatMap(place => place.source_rows);
  return { ...label, status: 'held', reason: 'conflicting_place_fields',
    conflicting_rows: sourceRows.length, source_rows: sourceRows.slice(0, 50), ...(places ? { places } : {}) };
}

function syncReviewHold(sync, label, conflictHold) {
  if (conflictHold) return conflictHold;
  const reasons = sync?.plan_hold_reasons ?? {};
  for (const reason of ['source_financial_values_require_review', 'source_place_difference_requires_review', 'legacy_place_difference_requires_review',
    'observation_mirror_correction_requires_review',
    'unresolved_source_place', 'one_resolved_place_required']) {
    if (reasons[reason] > 0) return { ...label, status: 'held', reason };
  }
  if (['corrections', 'supersedes', 'dart_updates'].some(operation => sync?.requested?.[operation] > 0)) {
    return { ...label, status: 'held', reason: 'source_correction_path_requires_review' };
  }
  if (sync?.status === 'source_rows_held' || sync?.plan_summary?.hold > 0
    || Object.values(reasons).some(count => count > 0)
    || Object.values(sync?.summary?.hold_reasons ?? {}).some(count => count > 0)) {
    return { ...label, status: 'held', reason: 'source_rows_need_review' };
  }
  return null;
}

function heldRows(sync, plan) {
  const rows = [...(sync?.plan_hold_samples ?? [])].slice(0, 50);
  const sourceRows = new Map([...(plan?.observations ?? []), ...(plan?.events ?? [])]
    .map(row => [row.external_ref, row.payload?.source_row]));
  for (const result of sync?.results ?? []) {
    if (result.outcome !== 'held') continue;
    if (rows.length >= 50) break;
    const sourceRow = sourceRows.get(result.external_ref);
    rows.push({ phase: result.phase, external_ref: result.external_ref,
      ...(result.record_id ? { record_id: result.record_id } : {}),
      ...(Number.isInteger(sourceRow) && sourceRow > 0 ? { source_row: sourceRow } : {}),
      reason: result.detail });
  }
  return rows;
}

function registrationNeedsReview(places, receipts) {
  return receipts.length !== places.length || places.some(place => {
    const matches = receipts.filter(receipt => receipt?.name === place.name);
    return matches.length !== 1 || !['created', 'existing'].includes(matches[0].status)
      || !matches[0].zone_id || !matches[0].agreement_linked;
  });
}

// Promotes one sheet through place preview and governed sync. Returns null if the source changed.
export async function promoteSheet({ version, sheet, map, exportPlan, syncPlan, namespaceEventCount, registerPlaces, commit,
  beforeWrite = async () => {} }) {
  const label = { sheet: sheet.sheet, client_code: sheet.client_code };
  const freshPlan = plan => {
    if (plan?.mode !== 'plan' || plan.source_sha256 !== version.sha256) return false;
    if (plan.manifest?.client_code !== sheet.client_code
      || plan.manifest?.target_client_organization_id !== sheet.client_organization_id) {
      throw new Error(`${sheet.client_code}: exported plan does not match its mapping`);
    }
    return true;
  };
  let plan = await exportPlan({ version, sheet, map });
  if (!freshPlan(plan)) return null;
  let conflictHold = conflictingPlaceHold(plan, label);
  if (plan.financial_source_present
    || [...(plan.observations ?? []), ...(plan.events ?? []), ...(plan.proposals ?? [])].some(hasSourceFinancialValues)) {
    return conflictHold ?? { ...label, status: 'held', reason: 'source_financial_values_require_review' };
  }
  let places;
  let placeRegistration;
  const withConflictContext = async operation => {
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === 'object') {
        if (conflictHold) error.sourcePlaceHold = conflictHold;
      }
      throw error;
    }
  };
  // A reviewed new client starts with no history, so only an explicit mapping flag lets its
  // empty namespace through; an existing client's code must already have live events.
  if (!sheet.new_namespace && !(await withConflictContext(() => namespaceEventCount(sheet)))) {
    return { ...label, status: 'held', reason: 'namespace_unproven', ...(conflictHold ? { place_conflicts: conflictHold } : {}) };
  }
  const newPlaces = placesToRegister(plan, sheet);
  if (newPlaces.length > newPlaceLimit(map)) {
    return { ...label, status: 'held', reason: 'new_place_volume_review', new_places: newPlaces.map(place => place.name),
      ...(conflictHold ? { place_conflicts: conflictHold } : {}) };
  }
  if (newPlaces.length && registerPlaces) {
    places = await withConflictContext(() => registerPlaces({ version, sheet, map, places: newPlaces, commit: false }));
    if (!Array.isArray(places)) throw new Error(`${sheet.client_code}: place registration returned no receipts`);
    placeRegistration = 'preview';
    if (registrationNeedsReview(newPlaces, places)) return { ...label, status: 'held', reason: 'place_registration_review',
      places, place_registration: placeRegistration, ...(conflictHold ? { place_conflicts: conflictHold } : {}) };
    const overlay = placeOverlay(newPlaces, places);
    if (Object.keys(overlay).length) {
      plan = await withConflictContext(() => exportPlan({ version, sheet, map, placeOverlay: overlay }));
      if (!freshPlan(plan)) return null;
      conflictHold = conflictingPlaceHold(plan, label, places) ?? conflictHold;
    }
  } else if (newPlaces.length) {
    places = newPlaces.map(place => ({ name: place.name, status: 'not_registered' }));
    placeRegistration = 'not_registered';
  }
  const previewSync = async planningOnly => {
    try {
      return await withConflictContext(() => syncPlan({ sourcePlan: plan, commit: false, planningOnly }));
    } catch (error) {
      if (serverRefusal(error) !== 'server_refused:this_source_and_import_configuration_already_has_a_closed_review_batch') throw error;
      const hold = syncReviewHold(error.sourceSyncReport, label, conflictHold);
      if (hold) {
        const rows = heldRows(error.sourceSyncReport, plan);
        return { outcome: { ...hold, already_batched: true, ...(error.sourceSyncReport?.plan_hold_reasons
          ? { row_holds: error.sourceSyncReport.plan_hold_reasons } : {}),
        ...(rows.length ? { held_rows: rows } : {}),
        ...(places ? { places, place_registration: placeRegistration } : {}) } };
      }
      return { outcome: { ...label, status: 'unchanged', reason: 'already_batched_for_this_version',
        ...(places ? { places, place_registration: placeRegistration } : {}) } };
    }
  };
  const provisional = placeRegistration === 'preview' && places.some(place => place.status === 'created' || place.coverage_added);
  const preview = await previewSync(provisional);
  if (preview.outcome) {
    if (newPlaces.length && preview.outcome.status !== 'held') {
      return { ...label, status: 'held', reason: 'new_places_require_review',
        ...(places ? { places, place_registration: placeRegistration } : {}) };
    }
    return preview.outcome;
  }
  const reviewRows = heldRows(preview, plan);
  const summary = { plan: preview.plan_summary, requested: preview.requested, row_holds: preview.plan_hold_reasons,
    ...(reviewRows.length ? { held_rows: reviewRows } : {}),
    preview_result: preview.summary, ...(preview.server_validation ? { server_validation: preview.server_validation } : {}),
    ...(places ? { places, place_registration: placeRegistration } : {}) };
  const previewHold = syncReviewHold(preview, label, conflictHold);
  if (changedRows(preview.requested) > map.max_new_rows_per_sheet) {
    return { ...label, status: 'held', reason: 'change_volume_review', ...summary,
      ...(previewHold ? { source_review: previewHold } : {}) };
  }
  if (previewHold) return { ...previewHold, ...summary };
  if (newPlaces.length) return { ...label, status: 'held', reason: 'new_places_require_review', ...summary };
  if (!commit) return { ...label, status: 'previewed', ...summary };
  if (preview.status === 'no_source_changes' || preview.status === 'source_rows_held') {
    return { ...label, status: 'unchanged', ...summary };
  }
  try {
    await beforeWrite({ ...label, phase: 'source_sync', place_registration: placeRegistration });
    const applied = await withConflictContext(() => syncPlan({ sourcePlan: plan, commit: true }));
    const hold = previewHold ?? syncReviewHold(applied, label, conflictHold);
    if (hold) {
      const rows = heldRows(applied, plan);
      return { ...hold, batch_id: applied.batch_id, ...summary,
        ...(applied.committed ? { partial_commit: true } : {}),
        row_holds: applied.plan_hold_reasons ?? summary.row_holds,
        ...(rows.length ? { held_rows: rows } : {}), result: applied.summary };
    }
    return { ...label, status: 'applied', batch_id: applied.batch_id, ...summary, result: applied.summary };
  } catch (error) {
    if (!/already synced/.test(error?.message ?? '')) throw error;
    const hold = syncReviewHold(error.sourceSyncReport, label, conflictHold);
    if (hold) return { ...hold, ...summary, retry: 'already_synced_review' };
    return { ...label, status: 'held', reason: 'already_synced_review', ...summary };
  }
}

export async function promoteWorkbookVersion({ version, map, commit, ...deps }) {
  const base = { source_relative_path: version.relative_path, source_sha256: version.sha256 };
  const entry = workbookEntry(version.relative_path, map);
  if (entry.hold) return { ...base, status: 'held', reason: entry.hold, sheets: [] };
  const sheets = [];
  for (const sheet of entry.sheets) {
    const outcome = await promoteSheet({ version, sheet, map, commit: false, ...deps });
    if (!outcome) return { ...base, status: 'stale', reason: 'source_changed_during_promotion', sheets };
    sheets.push(outcome);
  }
  const held = sheets.find(sheet => sheet.status === 'held');
  if (held) return { ...base, status: 'held', reason: `sheet_${held.reason}`, sheets };
  if (!commit) return { ...base, status: 'previewed', sheets };
  const appliedSheets = [];
  for (const sheet of entry.sheets) {
    let outcome;
    try {
      outcome = await promoteSheet({ version, sheet, map, commit: true, ...deps,
        beforeWrite: async details => deps.beforeWrite?.({ ...details,
          completed_sheets: appliedSheets.filter(item => item.status === 'applied').map(item => item.client_code),
          batch_ids: appliedSheets.map(item => item.batch_id).filter(Boolean),
        }),
      });
    } catch (error) {
      if (error && typeof error === 'object') {
        const partialCommit = appliedSheets.some(item => item.status === 'applied' || item.place_registration === 'applied' || item.partial_commit)
          || error.sourceSyncReport?.committed === true || error.sourceRegistrationStatus === 'applied';
        const possibleCommit = partialCommit || error.sourceSyncWriteAttempted === true || error.sourceRegistrationStatus === 'applying';
        if (possibleCommit) error.sourcePromotionProgress = {
          partial_commit: partialCommit, partial_commit_possible: !partialCommit,
          completed_sheets: appliedSheets.filter(item => item.status === 'applied').map(item => item.client_code),
          batch_ids: [...appliedSheets.map(item => item.batch_id), error.sourceSyncReport?.batch_id,
            error.sourceSyncReport?.dart_update_batch_id].filter(Boolean),
          current_sheet: sheet.client_code,
        };
      }
      throw error;
    }
    if (!outcome || outcome.status === 'stale') {
      if (outcome) appliedSheets.push(outcome);
      const partialCommit = appliedSheets.some(item => item.status === 'applied' || item.place_registration === 'applied' || item.partial_commit);
      return { ...base, status: partialCommit ? 'held' : 'stale',
        reason: partialCommit ? 'partial_commit_review' : 'source_changed_during_promotion',
        ...(partialCommit ? { interruption: 'source_changed_during_promotion' } : {}),
        partial_commit: partialCommit, sheets: appliedSheets };
    }
    appliedSheets.push(outcome);
    if (outcome.status === 'held') return { ...base, status: 'held', reason: `sheet_${outcome.reason}`,
      partial_commit: appliedSheets.some(item => item.status === 'applied' || item.place_registration === 'applied' || item.partial_commit), sheets: appliedSheets };
  }
  const batches = appliedSheets.filter(sheet => sheet.batch_id).map(sheet => sheet.batch_id);
  return { ...base, status: 'applied', receipt_id: batches.length ? `batches:${batches.join(',')}` : `unchanged:${version.sha256}`,
    inserted: appliedSheets.reduce((total, sheet) => total + (sheet.status === 'applied' ? sheet.requested?.inserts ?? 0 : 0), 0),
    sheets: appliedSheets };
}

// Photos are promoted name-first: listing, metadata, and filename matching never read file bytes,
// because most of the R&M photo library is cloud-only and reading it would download all of it.
// Only a photo that uniquely matches one record is read, attached, and given a receipt keyed by
// its size and modified time, so an unchanged photo is never re-read.
export async function promotePhotos({ entries, receipts = {}, attachmentIntents = {}, captureIntents = {}, captureReceipts = {},
  classify, attach, commit, limit, writeDisabledReason = null, captureGroupHold = () => null,
  beforeWrite = async () => {}, prepareWrite = async () => {}, afterWrite = async () => {} }) {
  const results = [];
  const nextReceipts = { ...receipts };
  const pendingAttachments = { ...attachmentIntents };
  let attachments = 0;
  for (const entry of entries) {
    const base = { source_relative_path: entry.relative_path };
    const key = `${entry.size_bytes}:${entry.modified_at}`;
    const recoveryReason = captureIntents[entry.relative_path] ? 'possible_partial_photo_capture_review'
      : pendingAttachments[entry.relative_path] ? 'possible_partial_photo_attachment_review' : null;
    if (recoveryReason) {
      results.push({ ...base, status: 'held', reason: recoveryReason });
      continue;
    }
    if (nextReceipts[entry.relative_path]?.key === key) {
      results.push({ ...base, status: 'unchanged' });
      continue;
    }
    const match = await classify(entry.relative_path);
    if (match.status === 'privileged') {
      results.push({ ...base, status: 'ignored', reason: 'privileged_nzta_record' });
      continue;
    }
    // Owner ruling: photos outside the structured "YYMMDD HHMM[SS] [rego]" naming are ignored.
    if (match.status === 'unnamed' || match.status === 'unsupported') {
      results.push({ ...base, status: 'ignored', reason: match.status === 'unnamed' ? 'filename_not_structured' : 'unsupported_image_type' });
      continue;
    }
    const groupHold = captureGroupHold(entry, match);
    if (groupHold) {
      results.push({ ...base, status: 'held', reason: groupHold });
      continue;
    }
    if (match.status === 'unmatched' && commit && writeDisabledReason) {
      results.push({ ...base, status: 'held', reason: writeDisabledReason });
      continue;
    }
    if (match.status === 'unmatched' && Object.keys(pendingAttachments).length) {
      results.push({ ...base, status: 'held', reason: 'unresolved_attachment_blocks_capture_review' });
      continue;
    }
    if (match.status !== 'matched') {
      const reason = { unmatched: captureReceipts[entry.relative_path]
        ? 'captured_photo_record_not_found_review' : 'no_exact_record_match', ambiguous: 'ambiguous_record_match',
        missing: 'source_missing' }[match.status];
      results.push({ ...base, status: 'held', reason: reason ?? 'unclassified',
        ...(reason === 'no_exact_record_match' && match.parsed ? { parsed: match.parsed } : {}) });
      continue;
    }
    if (!commit) {
      results.push({ ...base, status: 'previewed', match_type: match.row.matchType });
      continue;
    }
    if (writeDisabledReason) {
      results.push({ ...base, status: 'held', reason: writeDisabledReason });
      continue;
    }
    if (attachments >= limit) {
      results.push({ ...base, status: 'deferred', reason: 'photo_limit_reached' });
      continue;
    }
    attachments += 1;
    await beforeWrite({ entry, row: match.row, key });
    pendingAttachments[entry.relative_path] = true;
    let outcome;
    try {
      outcome = await attach({ ...match.row, fileInfo: entry, onPrepared: details => prepareWrite({ entry, ...details }) });
      if (!outcome?.held && (!/^[a-f0-9]{64}$/i.test(outcome?.sha256 ?? '')
        || typeof outcome?.storage_path !== 'string' || !outcome.storage_path
        || (outcome.retained_duplicate_upload && (typeof outcome.retained_storage_path !== 'string' || !outcome.retained_storage_path)))) {
        throw new Error('Photo attachment returned an incomplete receipt');
      }
    } catch (error) {
      results.push({ ...base, status: 'held', reason: 'possible_partial_photo_attachment_review', error: describeError(error) });
      continue;
    }
    if (outcome.held) {
      if (outcome.no_write === true) {
        await afterWrite({ entry, receipt: null });
        delete pendingAttachments[entry.relative_path];
      }
      results.push({ ...base, status: 'held',
        reason: outcome.no_write === true ? outcome.held : 'possible_partial_photo_attachment_review',
        ...(outcome.no_write === true ? {} : { interruption: outcome.held }) });
      continue;
    }
    const retainedUploads = nextReceipts[entry.relative_path]?.retained_uploads ?? [];
    if (!Array.isArray(retainedUploads)) throw new Error('Invalid retained photo upload state');
    const nextRetainedUploads = [...retainedUploads];
    if (outcome.retained_duplicate_upload && !nextRetainedUploads.some(item =>
      item.sha256 === outcome.sha256 && item.storage_path === outcome.retained_storage_path)) {
      nextRetainedUploads.push({ sha256: outcome.sha256, storage_path: outcome.retained_storage_path });
    }
    const receipt = { key, sha256: outcome.sha256, receipt_id: `evidence:${outcome.storage_path}`,
      ...(nextRetainedUploads.length ? { retained_uploads: nextRetainedUploads } : {}) };
    await afterWrite({ entry, receipt });
    nextReceipts[entry.relative_path] = receipt;
    delete pendingAttachments[entry.relative_path];
    results.push({ ...base, status: 'applied', reused: outcome.reused, already_linked: outcome.already_linked });
  }
  return { results, receipts: nextReceipts };
}

function captureMapping(map) {
  const config = map.photo_captures;
  const sheets = new Map(Object.values(map.workbooks).flatMap(entry => entry.sheets ?? [])
    .map(sheet => [sheet.client_code, sheet]));
  const clients = config.clients.map(client => ({ ...client,
    client_organization_id: sheets.get(client.profile_code).client_organization_id }));
  return { config, sheets, clients };
}

// Turns unmatched structured photos into camera-capture rows, one governed batch per client chunk.
// Returns the photos whose capture row now exists, so the caller can attach them straight away.
export async function promoteCaptures({ photos, map, deps, commit, maxBatches, minuteOrganizations,
  beforeWrite = async () => {}, afterWrite = async () => {} }) {
  const { config, sheets, clients } = captureMapping(map);
  const { groups, holds, ignored } = buildCaptureGroups(photos, { ...config, clients }, { minuteOrganizations });
  const batches = [];
  const captured = [];
  const limits = { maxRows: Math.min(config.max_rows_per_batch, map.max_new_rows_per_sheet), maxPlaces: newPlaceLimit(map) };
  for (const client of clients) {
    const own = groups.filter(group => group.capture_code === client.capture_code);
    for (const chunk of chunkCaptureGroups(own, limits)) {
      const photosInChunk = chunk.reduce((total, group) => total + group.photos.length, 0);
      if (batches.length >= maxBatches) {
        batches.push({ client_code: client.capture_code, status: 'deferred', reason: 'capture_batch_limit_reached',
          rows: chunk.length, photos: photosInChunk });
        continue;
      }
      const version = captureVersion(client, captureCsv(chunk, config), config);
      const paths = chunk.flatMap(group => group.photos);
      let writeAttempted = false;
      let outcome;
      try {
        outcome = await promoteSheet({ version, sheet: captureSheet(client, sheets.get(client.profile_code), config), map,
          commit, ...deps, beforeWrite: async details => {
            await beforeWrite({ version, client, groups: chunk, details });
            writeAttempted = true;
          } });
      } catch (error) {
        const refusal = serverRefusal(error);
        outcome = { client_code: client.capture_code,
          ...(writeAttempted ? { status: 'held', reason: 'possible_partial_photo_capture_review' }
            : refusal ? { status: 'held', reason: refusal } : { status: 'error' }),
          error: describeError(error) };
      }
      if (writeAttempted && outcome?.status === 'applied' && outcome.batch_id) {
        await afterWrite({ version, client, groups: chunk, outcome });
      } else if (writeAttempted && outcome?.reason !== 'possible_partial_photo_capture_review') {
        outcome = { ...outcome, status: 'held', reason: 'possible_partial_photo_capture_review',
          ...(outcome?.reason ? { interruption: outcome.reason } : {}) };
      }
      batches.push({ ...(outcome ?? { client_code: client.capture_code, status: 'stale' }), rows: chunk.length,
        photos: photosInChunk, source_sha256: version.sha256 });
      if (outcome?.status === 'applied') captured.push(...paths);
    }
  }
  return { batches, holds, ignored, captured };
}

export async function listPhotoEntries(root) {
  const entries = [];
  for (const relativePath of await photoSourcePaths(root)) {
    try {
      const info = await lstat(path.join(root, ...relativePath.split('/')));
      entries.push({ relative_path: relativePath, size_bytes: info.size, modified_at: info.mtime.toISOString() });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO'].includes(error.code)) throw error;
    }
  }
  return entries;
}

function cliErrorMessage(error) {
  try {
    return String(JSON.parse(String(error?.stdout ?? '')).error?.message ?? '');
  } catch {
    return '';
  }
}

// A RAISE from a governed RPC is a deliberate business-rule refusal: it will not pass on retry,
// so it becomes a visible hold. Anything else (network, timeout) stays retryable.
export function serverRefusal(error) {
  const match = /ERROR:\s+P0001:\s+([^\\\n]+)/.exec(cliErrorMessage(error) || String(error?.message ?? ''));
  if (!match) return null;
  return `server_refused:${match[1].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 90)}`;
}

function describeError(error) {
  const cli = cliErrorMessage(error);
  if (cli) return cli.replace(/^unexpected status \d+:\s*/, '').slice(0, 300);
  const lines = String(error?.stderr ?? '').split('\n').map(line => line.trim())
    .filter(line => line && !/new version of Supabase CLI|We recommend updating|supabase\.com\/docs|^Initialising/i.test(line));
  const detail = lines.find(line => /error|failed|denied|timeout|exceed/i.test(line)) ?? lines.at(-1);
  return String(detail ?? error?.message ?? 'unknown failure').split('\n')[0].slice(0, 300);
}

function tally(results) {
  const counts = {};
  for (const result of results) {
    const key = result.reason ? `${result.status}:${result.reason}` : result.status;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// Held capture folders, largest first, so a person can map a new client label in the source map.
function heldFolders(holds) {
  const counts = new Map();
  for (const hold of holds) {
    const key = `${hold.reason}:${hold.source_relative_path.replaceAll('\\', '/').split('/')[1] ?? ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 40));
}

function mergeRecovery(previousHold, current) {
  const previous = previousHold?.recovery ?? {};
  const merged = (name, values) => {
    const all = [...new Set([...(previous[name] ?? []), ...values].filter(Boolean))];
    return { values: all.slice(0, 50), truncated: Boolean(previous[`${name}_truncated`]) || all.length > 50 };
  };
  const sheets = merged('completed_sheets', current.completed_sheets ?? []);
  const batches = merged('batch_ids', current.batch_ids ?? []);
  const versions = merged('source_versions', [previousHold?.sha256, current.source_sha256]);
  return {
    partial_commit: Boolean(previous.partial_commit || current.partial_commit),
    partial_commit_possible: Boolean(previous.partial_commit_possible || current.partial_commit_possible),
    completed_sheets: sheets.values, batch_ids: batches.values, source_versions: versions.values,
    ...(sheets.truncated ? { completed_sheets_truncated: true } : {}),
    ...(batches.truncated ? { batch_ids_truncated: true } : {}),
    ...(versions.truncated ? { source_versions_truncated: true } : {}),
    ...((current.current_sheet || previous.current_sheet) ? { current_sheet: current.current_sheet ?? previous.current_sheet } : {}),
    ...((current.write_phase || previous.write_phase) ? { write_phase: current.write_phase ?? previous.write_phase } : {}),
  };
}

// Applies results to scanner state: applied receipts acknowledge, holds are recorded, previews and
// stale versions stay pending untouched.
export function recordOutcomes(state, results, { archiveRecovery = true } = {}) {
  let next = state;
  for (const result of results) {
    const previousHold = next.files[result.source_relative_path]?.hold;
    if (result.status === 'applied') {
      next = acknowledgeSourceVersion(next, result.source_relative_path, result);
      if (archiveRecovery && previousHold?.recovery) {
        const file = next.files[result.source_relative_path];
        const history = [...(file.recovery_history ?? []), {
          ...mergeRecovery(previousHold, result), resolved_at: new Date().toISOString(), receipt_id: result.receipt_id,
        }];
        next = { ...next, files: { ...next.files, [result.source_relative_path]: {
          ...file, recovery_history: history.slice(-20),
          ...(file.recovery_history_truncated || history.length > 20 ? { recovery_history_truncated: true } : {}),
        } } };
      }
    } else if (result.status === 'held') {
      next = holdSourceVersion(next, result.source_relative_path, { sha256: result.source_sha256, reason: result.reason });
      if (result.partial_commit || result.partial_commit_possible || previousHold?.recovery) {
        const file = next.files[result.source_relative_path];
        const completedSheets = result.completed_sheets
          ?? (result.sheets ?? []).filter(sheet => sheet.status === 'applied').map(sheet => sheet.client_code);
        const batches = result.batch_ids ?? (result.sheets ?? []).filter(sheet => sheet.batch_id).map(sheet => sheet.batch_id);
        next = { ...next, files: { ...next.files, [result.source_relative_path]: {
          ...file, hold: { ...file.hold, recovery: mergeRecovery(previousHold, {
            ...result, completed_sheets: completedSheets, batch_ids: batches,
          }) },
        } } };
      }
    }
  }
  return next;
}

export async function runPromotion({ root, statePath, map, deps, commit = false, includePhotos = false,
  recheckHolds = false, confirmPartialReviewed = false, photoLimit = 500, settleMs, only = null,
  listPhotos = listPhotoEntries, captureBatches = null }) {
  if (confirmPartialReviewed) {
    const selected = only ? Object.keys(map.workbooks)
      .filter(name => `${WORKBOOK_FOLDER}${name}`.toLowerCase().includes(only.toLowerCase())) : [];
    if (!commit || !recheckHolds || includePhotos || selected.length !== 1) {
      throw new Error('--confirm-partial-reviewed requires --commit --recheck-holds --only to select exactly one mapped workbook without photos');
    }
  }
  const lockPath = `${statePath}.lock`;
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const lock = await acquireSourceLock(lockPath);
  try {
    // Workbooks only: photos are never hashed by the scanner (see promotePhotos).
    const scan = await runSourceScan({ root, statePath, includePhotos: false, settleMs, sourceLock: lock });
    let state = await loadSyncState(statePath);
    const pending = pendingSourceVersions(state).filter(version => {
      const file = state.files[version.relative_path];
      if (file?.hold?.recovery) return recheckHolds && (!commit || confirmPartialReviewed);
      return recheckHolds || !isHeldVersion(file);
    });
    const workbooks = [];
    for (const version of pending.filter(item => item.relative_path.startsWith(WORKBOOK_FOLDER)
      && (!only || item.relative_path.toLowerCase().includes(only.toLowerCase())))) {
      let result;
      let writeIntent;
      const startedWithRecovery = Boolean(state.files[version.relative_path]?.hold?.recovery);
      try {
        result = await promoteWorkbookVersion({ version, map, commit, ...deps, beforeWrite: async details => {
          const previousHold = state.files[version.relative_path]?.hold;
          writeIntent = mergeRecovery(previousHold, {
            partial_commit: details.completed_sheets.length > 0 || details.place_registration === 'applied',
            partial_commit_possible: true, completed_sheets: details.completed_sheets, batch_ids: details.batch_ids,
            current_sheet: details.client_code, write_phase: details.phase, source_sha256: version.sha256,
          });
          state = holdSourceVersion(state, version.relative_path, {
            sha256: version.sha256, reason: 'possible_partial_commit_review',
          });
          const file = state.files[version.relative_path];
          state = { ...state, files: { ...state.files, [version.relative_path]: {
            ...file, hold: { ...file.hold, recovery: writeIntent },
          } } };
          await saveSyncState(statePath, state);
        } });
      } catch (error) {
        const refusal = serverRefusal(error);
        const recovery = error?.sourcePromotionProgress ?? writeIntent;
        const recoveryReason = recovery?.partial_commit ? 'partial_commit_review'
          : recovery?.partial_commit_possible ? 'possible_partial_commit_review' : null;
        result = { source_relative_path: version.relative_path, source_sha256: version.sha256,
          ...(recoveryReason ? { status: 'held', reason: recoveryReason }
            : refusal ? { status: 'held', reason: refusal } : { status: 'error' }), error: describeError(error),
          ...(error?.sourcePlaceHold ? { place_conflicts: error.sourcePlaceHold } : {}),
          ...(recovery ?? {}) };
      }
      workbooks.push(result);
      if (commit) {
        state = recordOutcomes(state, [result], { archiveRecovery: startedWithRecovery });
        await saveSyncState(statePath, state);
      }
    }
    let photos = [];
    let captures = null;
    if (includePhotos) {
      const entries = await listPhotos(root);
      const captureConfig = map.photo_captures?.enabled ? captureMapping(map) : null;
      const photoWriteOptions = () => {
        const groupKey = item => `${item.client_code}:${item.log_number}`;
        const minuteKey = item => `${item.client_organization_id}:${item.minute_key}`;
        const pending = Object.values(state.photo_capture_intents ?? {});
        const captured = Object.values(state.photo_capture_receipts ?? {});
        const pendingGroups = new Set(pending.filter(item => item.log_number).map(groupKey));
        const capturedGroups = new Set(captured.filter(item => item.log_number).map(groupKey));
        const pendingMinutes = new Set(pending.filter(item => item.client_organization_id && item.minute_key).map(minuteKey));
        const capturedMinutes = new Set(captured.filter(item => item.client_organization_id && item.minute_key).map(minuteKey));
        return {
          attachmentIntents: state.photo_attachment_intents ?? {},
          captureIntents: state.photo_capture_intents ?? {},
          captureReceipts: state.photo_capture_receipts ?? {},
          captureGroupHold: (entry, match) => {
            if (!pendingGroups.size && !capturedGroups.size) return null;
            const parsed = match.parsed ?? match.row?.parsed;
            if (!parsed) return null;
            if (match.row?.organizationId && pendingMinutes.has(`${match.row.organizationId}:${parsed.minuteKey}`)) {
              return 'possible_partial_photo_capture_review';
            }
            if (!captureConfig) return null;
            const { groups } = buildCaptureGroups([{ relative_path: entry.relative_path, parsed }],
              { ...captureConfig.config, clients: captureConfig.clients });
            if (!groups.length) return null;
            const group = groups[0];
            const key = `${group.capture_code}:${group.log_number}`;
            const minute = `${group.client.client_organization_id}:${group.minute_key}`;
            if (pendingGroups.has(key) || pendingMinutes.has(minute)) return 'possible_partial_photo_capture_review';
            if (match.status === 'unmatched' && (capturedGroups.has(key) || capturedMinutes.has(minute))) {
              return 'captured_photo_record_not_found_review';
            }
            return null;
          },
          beforeWrite: async ({ entry, row, key }) => {
            state = { ...state, photo_attachment_intents: { ...state.photo_attachment_intents,
              [entry.relative_path]: { key, organization_id: row.organizationId, record_id: row.observationId,
                record_kind: row.recordKind ?? 'observation', started_at: new Date().toISOString() } } };
            await saveSyncState(statePath, state);
          },
          prepareWrite: async ({ entry, sha256, storage_path: storagePath }) => {
            if (!/^[a-f0-9]{64}$/i.test(sha256 ?? '') || typeof storagePath !== 'string' || !storagePath) {
              throw new Error('Invalid prepared photo attachment');
            }
            const intent = state.photo_attachment_intents?.[entry.relative_path];
            if (!intent) throw new Error('Photo attachment intent is missing');
            const hash = sha256.toLowerCase();
            const conflict = Object.entries(state.photo_attachment_intents)
              .find(([relativePath, candidate]) => relativePath !== entry.relative_path
                && candidate.sha256 === hash);
            state = { ...state, photo_attachment_intents: { ...state.photo_attachment_intents,
              [entry.relative_path]: { ...intent, sha256: hash, storage_path: storagePath,
                ...(conflict ? { conflicting_source: conflict[0] } : {}) } } };
            await saveSyncState(statePath, state);
            if (conflict) throw new Error('Photo matches another unresolved attachment');
          },
          afterWrite: async ({ entry, receipt }) => {
            const intents = { ...state.photo_attachment_intents };
            delete intents[entry.relative_path];
            state = { ...state, photo_attachment_intents: intents,
              ...(receipt ? { photo_receipts: { ...state.photo_receipts, [entry.relative_path]: receipt } } : {}) };
            await saveSyncState(statePath, state);
          },
        };
      };
      const captureWriteOptions = {
        beforeWrite: async ({ version, client, groups, details }) => {
          const intents = { ...state.photo_capture_intents };
          for (const group of groups) {
            for (const relativePath of group.photos) {
              intents[relativePath] = { source_sha256: version.sha256, client_code: client.capture_code,
                client_organization_id: client.client_organization_id, minute_key: group.minute_key, log_number: group.log_number,
                write_phase: details.phase, started_at: intents[relativePath]?.started_at ?? new Date().toISOString() };
            }
          }
          state = { ...state, photo_capture_intents: intents };
          await saveSyncState(statePath, state);
        },
        afterWrite: async ({ version, client, groups, outcome }) => {
          const intents = { ...state.photo_capture_intents };
          const receipts = { ...state.photo_capture_receipts };
          for (const group of groups) {
            for (const relativePath of group.photos) {
              delete intents[relativePath];
              receipts[relativePath] = { source_sha256: version.sha256, client_code: client.capture_code,
                client_organization_id: client.client_organization_id, minute_key: group.minute_key,
                log_number: group.log_number, batch_id: outcome.batch_id };
            }
          }
          state = { ...state, photo_capture_intents: intents, photo_capture_receipts: receipts };
          await saveSyncState(statePath, state);
        },
      };
      let photoDeps = await deps.photoDeps({ commit });
      try {
        const outcome = await promotePhotos({ entries, receipts: state.photo_receipts ?? {}, commit, limit: photoLimit,
          ...photoDeps, ...photoWriteOptions() });
        photos = outcome.results;
        const batches = captureBatches ?? map.photo_captures?.max_batches_per_run ?? 0;
        if (map.photo_captures?.enabled && batches > 0) {
          const unmatched = photos.filter(item => item.reason === 'no_exact_record_match' && item.parsed)
            .map(item => ({ relative_path: item.source_relative_path, parsed: item.parsed }));
          captures = await promoteCaptures({ photos: unmatched, map, deps, commit, maxBatches: batches,
            minuteOrganizations: photoDeps.minuteOrganizations, ...captureWriteOptions });
          const capturedPaths = new Set(captures.captured);
          const remaining = photoLimit - photos.filter(item => item.status === 'applied').length;
          if (commit && capturedPaths.size && remaining > 0) {
            // The new rows are only visible to a fresh index, so the attach step reloads its targets.
            await photoDeps.close?.();
            photoDeps = await deps.photoDeps({ commit });
            const attached = await promotePhotos({ entries: entries.filter(entry => capturedPaths.has(entry.relative_path)),
              receipts: state.photo_receipts ?? {}, commit, limit: remaining, ...photoDeps, ...photoWriteOptions() });
            const byPath = new Map(attached.results.map(item => [item.source_relative_path, item]));
            photos = photos.map(item => byPath.get(item.source_relative_path) ?? item);
          }
        }
      } finally {
        await photoDeps.close?.();
      }
    }
    const photoReview = new Map();
    for (const relativePath of Object.keys(state.photo_attachment_intents ?? {})) {
      photoReview.set(`possible_partial_photo_attachment_review:${relativePath}`, { source_relative_path: relativePath,
        reason: 'possible_partial_photo_attachment_review' });
    }
    for (const relativePath of Object.keys(state.photo_capture_intents ?? {})) {
      photoReview.set(`possible_partial_photo_capture_review:${relativePath}`, { source_relative_path: relativePath,
        reason: 'possible_partial_photo_capture_review' });
    }
    for (const item of photos) {
      if (['possible_partial_photo_attachment_review', 'possible_partial_photo_capture_review',
        'captured_photo_record_not_found_review', 'unresolved_attachment_blocks_capture_review'].includes(item.reason)) {
        photoReview.set(`${item.reason}:${item.source_relative_path}`, { source_relative_path: item.source_relative_path,
          reason: item.reason, ...(item.interruption ? { interruption: item.interruption } : {}) });
      }
    }
    return {
      mode: commit ? 'apply' : 'dry_run',
      scan,
      workbooks: workbooks.map(({ sheets, ...result }) => ({ ...result, sheets })),
      photos: { counts: tally(photos), sample_matches: photos.filter(item => ['previewed', 'applied'].includes(item.status))
        .slice(0, 20).map(item => item.source_relative_path),
      review_required: [...photoReview.values()].slice(0, 50), review_required_total: photoReview.size,
      retained_uploads_for_review: Object.values(state.photo_receipts ?? {})
        .reduce((total, receipt) => total + (receipt.retained_uploads?.length ?? 0), 0) },
      ...(captures ? { captures: { batches: captures.batches, holds: tally(captures.holds.map(hold => ({ status: 'held', ...hold }))),
        held_folders: heldFolders(captures.holds), ignored_before_floor: captures.ignored ?? 0,
        captured_photos: captures.captured.length } } : {}),
      remaining_pending: pendingSourceVersions(state).length,
      direct_finance_writes: 0,
    };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function runNode(args) {
  return execFileSync(process.execPath, args, {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Calls one governed RPC as the configured import identity inside a single transaction.
// Returns the supabase-js { data, error } shape so callers treat it like a signed-in client.
export async function importActorRpc(query, actorId, name, args) {
  if (!/^[a-z_]+$/.test(name) || !/^[0-9a-f-]{36}$/i.test(actorId)) throw new Error('Invalid governed RPC call');
  const json = JSON.stringify(args);
  if (json.includes('$rpc_args$')) throw new Error('RPC arguments must not contain their SQL delimiter');
  const named = Object.keys(args).map(key => {
    if (!/^p_[a-z0-9_]+$/.test(key)) throw new Error(`Invalid RPC argument ${key}`);
    // Schema convention: *_id parameters are uuid and *_at parameters are timestamptz.
    const type = key.endsWith('_id') ? 'uuid' : key.endsWith('_at') ? 'timestamptz' : 'text';
    return `${key} => (SELECT (a->>'${key}')::${type} FROM args)`;
  });
  try {
    const rows = query(`BEGIN;
set local request.jwt.claim.sub = '${actorId}';
WITH args AS (SELECT $rpc_args$${json}$rpc_args$::jsonb AS a)
SELECT to_jsonb(public.${name}(${named.join(', ')})) AS result;
COMMIT;`);
    return { data: rows?.[0]?.result ?? null, error: null };
  } catch (error) {
    return { data: null, error: { message: describeError(error) } };
  }
}

export async function linkedDeps({ root, map }) {
  const { cliQuery, linkedQuery, runSourceSync } = await import('./reconcile-plan.mjs');
  const exportArgs = ({ version, sheet, overlay, input }) => [
    path.join(REPO_ROOT, 'scripts', 'import-patrol-log.mjs'), '--export-plan', '--use-supabase-cli',
    ...input,
    '--org-id', sheet.client_organization_id, '--provider-org-id', map.provider_organization_id,
    '--client-code', sheet.client_code, '--classification-profile', map.classification_profile,
    '--zone-map-file', path.join(REPO_ROOT, 'scripts', 'data', 'zone-maps', sheet.zone_map),
    '--source-label', path.posix.basename(version.relative_path), '--source-hash', version.sha256,
    // Live rows were imported with narratives by owner choice, so the identity must match;
    // their workshop proposals are never created automatically (evidenceOnly below).
    '--include-narratives',
    ...(sheet.column_aliases ? ['--source-column-aliases', JSON.stringify(sheet.column_aliases)] : []),
    ...(map.non_place_terms ? ['--non-place-terms', JSON.stringify(map.non_place_terms)] : []),
    ...(sheet.place_aliases ? ['--place-aliases', JSON.stringify(sheet.place_aliases)] : []),
    ...(overlay ? ['--place-overlay', JSON.stringify(overlay)] : []),
  ];
  return {
    exportPlan: async ({ version, sheet, placeOverlay: overlay }) => {
      if (!version.csv) {
        return JSON.parse(runNode(exportArgs({ version, sheet, overlay, input: [
          '--xlsx', path.join(root, ...version.relative_path.split('/')),
          '--sheet', sheet.sheet, '--header-row', String(sheet.header_row)] })));
      }
      // Camera-capture batches are generated rows, written to a private temporary file for the exporter.
      const folder = await mkdtemp(path.join(tmpdir(), 'fcm-captures-'));
      const csvPath = path.join(folder, 'captures.csv');
      try {
        await writeFile(csvPath, version.csv, { mode: 0o600 });
        return JSON.parse(runNode(exportArgs({ version, sheet, overlay,
          input: ['--csv', csvPath, '--source-sheet', sheet.sheet] })));
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    registerPlaces: async ({ version, sheet, places, commit }) => {
      const actors = linkedQuery(`SELECT import_actor_id FROM public.import_source_profiles
        WHERE organization_id='${map.provider_organization_id}'::uuid AND profile_code='rm_patrol_log' AND active;`);
      const actorId = actors?.length === 1 ? actors[0].import_actor_id : null;
      if (!/^[0-9a-f-]{36}$/i.test(actorId ?? '')) throw new Error('The R&M source profile has no configured import identity');
      return cliQuery(placeRegistrationSql({ actorId, providerId: map.provider_organization_id,
        clientId: sheet.client_organization_id, places, commit, limit: newPlaceLimit(map),
        source: { file: path.posix.basename(version.relative_path), sheet: sheet.sheet, sha256: version.sha256 } })) ?? [];
    },
    namespaceEventCount: async sheet => {
      const rows = linkedQuery(`SELECT count(*)::integer AS n FROM public.location_events
        WHERE organization_id='${sheet.client_organization_id}'::uuid
          AND external_ref LIKE 'rm_patrol_import:${sheet.client_code}:%';`);
      return rows?.[0]?.n ?? 0;
    },
    syncPlan: ({ sourcePlan, commit, planningOnly }) => runSourceSync({ sourcePlan, providerOrganizationId: map.provider_organization_id,
      readQuery: linkedQuery, writeQuery: cliQuery, commit, planningOnly, evidenceOnly: true }),
    photoDeps: async () => {
      const { createClient } = await import('@supabase/supabase-js');
      const photo = await import('../../scripts/import-approved-rm-vehicle-history.mjs');
      const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceRole } = process.env;
      if (!url || !serviceRole) throw new Error('Supabase URL and service role are required for scoped photo matching');
      const service = createClient(url, serviceRole, { auth: { persistSession: false } });
      const organizationIds = await photo.loadVisibleOrganizationIds(service, map.provider_organization_id);
      const { byMinute, eventsByMinute } = await photo.loadTargets(service, organizationIds, { includePatrolEvents: true });
      return {
        writeDisabledReason: 'photo_import_requires_private_staging',
        classify: relativePath => photo.classifyPhoto(relativePath, root, byMinute, null, eventsByMinute),
        attach: async () => { throw new Error('Photo import writes require private staging and governed recovery'); },
        minuteOrganizations: minuteKey => new Set([...(byMinute.get(minuteKey) ?? []), ...(eventsByMinute.get(minuteKey) ?? [])]
          .map(target => target.organization_id)),
      };
    },
  };
}

async function main() {
  const argument = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const root = argument('--root') ?? process.env.DOCUMENT_SOURCE_ROOT?.trim();
  const statePath = argument('--state') ?? process.env.SOURCE_SYNC_STATE_PATH?.trim();
  const reportPath = argument('--report');
  if (!root || !statePath || !reportPath || path.extname(reportPath).toLowerCase() !== '.json') {
    throw new Error('Use --root <R&M documents> --state <scanner state json> --report <report json> [--commit] [--photos] [--recheck-holds] [--confirm-partial-reviewed --only <workbook>] [--photo-limit n] [--capture-batches n] [--only <workbook name fragment> [--max-new-rows n]]');
  }
  const photoLimit = Number(argument('--photo-limit') ?? 500);
  if (!Number.isInteger(photoLimit) || photoLimit < 0 || photoLimit > 5000) throw new Error('--photo-limit must be 0-5000');
  const mapPath = argument('--map') ?? path.join(REPO_ROOT, 'services', 'document-source-worker', 'rm-patrol-source-map.json');
  const map = validateSourceMap(JSON.parse(await readFile(mapPath, 'utf8')));
  // One-off, owner-approved catch-ups only: raises the reviewed per-sheet change limit for this run.
  const maxNewRows = argument('--max-new-rows');
  if (maxNewRows !== undefined) {
    const limit = Number(maxNewRows);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('--max-new-rows must be 1-2000');
    const only = argument('--only')?.toLowerCase();
    const selected = only ? Object.keys(map.workbooks)
      .filter(name => `${WORKBOOK_FOLDER}${name}`.toLowerCase().includes(only)) : [];
    if (selected.length !== 1) {
      throw new Error(`--max-new-rows requires --only to select exactly one mapped workbook (matched ${selected.length})`);
    }
    map.max_new_rows_per_sheet = limit;
  }
  const captureArgument = argument('--capture-batches');
  const captureBatches = captureArgument === undefined ? null : Number(captureArgument);
  if (captureBatches !== null && (!Number.isInteger(captureBatches) || captureBatches < 0 || captureBatches > MAX_CAPTURE_BATCHES)) {
    throw new Error(`--capture-batches must be 0-${MAX_CAPTURE_BATCHES}`);
  }
  const report = await runPromotion({ root, statePath: path.resolve(statePath), map, deps: await linkedDeps({ root, map }),
    commit: process.argv.includes('--commit'), includePhotos: process.argv.includes('--photos'),
    recheckHolds: process.argv.includes('--recheck-holds'), confirmPartialReviewed: process.argv.includes('--confirm-partial-reviewed'),
    photoLimit, only: argument('--only') ?? null, captureBatches });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ mode: report.mode, scan: report.scan,
    workbooks: tally(report.workbooks), photos: report.photos.counts,
    ...(report.captures ? { captures: tally(report.captures.batches), captured_photos: report.captures.captured_photos } : {}),
    remaining_pending: report.remaining_pending }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`Source promotion failed: ${describeError(error)}`);
    process.exitCode = 1;
  });
}
