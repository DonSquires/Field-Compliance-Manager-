import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acknowledgeSourceVersion, holdSourceVersion, isHeldVersion, loadSyncState, pendingSourceVersions,
  photoSourcePaths, runSourceScan, saveSyncState,
} from './source-sync.mjs';
import { MAX_NEW_PLACES_PER_SHEET, MAX_REVIEWED_PLACES, placeOverlay, placeRegistrationSql, placesToRegister } from './source-places.mjs';
import {
  buildCaptureGroups, captureCsv, captureSheet, captureVersion, chunkCaptureGroups, MAX_CAPTURE_BATCHES, validatePhotoCaptures,
} from './source-captures.mjs';

export const newPlaceLimit = map => map.max_new_places_per_sheet ?? MAX_NEW_PLACES_PER_SHEET;

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

// Promotes one workbook version. Every mapped sheet is previewed first; a sheet is committed only
// when its namespace is proven live and its change volume is within the reviewed limit.
// Promotes one sheet of one source version through preview, place registration and the governed
// sync. Returns null when the source changed while it was being exported.
export async function promoteSheet({ version, sheet, map, exportPlan, syncPlan, namespaceEventCount, registerPlaces, commit }) {
  const label = { sheet: sheet.sheet, client_code: sheet.client_code };
  const freshPlan = plan => plan?.mode === 'plan' && plan.source_sha256 === version.sha256;
  let plan = await exportPlan({ version, sheet, map });
  if (!freshPlan(plan)) return null;
  if (plan.manifest?.client_code !== sheet.client_code
    || plan.manifest?.target_client_organization_id !== sheet.client_organization_id) {
    throw new Error(`${sheet.client_code}: exported plan does not match its mapping`);
  }
  // A reviewed new client starts with no history, so only an explicit mapping flag lets its
  // empty namespace through; an existing client's code must already have live events.
  if (!sheet.new_namespace && !(await namespaceEventCount(sheet))) {
    return { ...label, status: 'held', reason: 'namespace_unproven' };
  }
  const newPlaces = placesToRegister(plan, sheet);
  let places;
  if (newPlaces.length > newPlaceLimit(map)) {
    return { ...label, status: 'held', reason: 'new_place_volume_review', new_places: newPlaces.map(place => place.name) };
  }
  if (newPlaces.length && registerPlaces) {
    // Preview rolls the registration back, so it reports what would be created without creating it.
    places = await registerPlaces({ version, sheet, map, places: newPlaces, commit });
    // Preview rolls back creations and new coverage links, so it can only resolve places that were
    // already registered and covered before this run.
    const overlay = placeOverlay(newPlaces, commit ? places
      : places.filter(place => place.status === 'existing' && place.agreement_linked && !place.coverage_added));
    if (Object.keys(overlay).length) {
      plan = await exportPlan({ version, sheet, map, placeOverlay: overlay });
      if (!freshPlan(plan)) return null;
    }
  } else if (newPlaces.length) {
    places = newPlaces.map(place => ({ name: place.name, status: 'not_registered' }));
  }
  let preview;
  try {
    preview = await syncPlan({ sourcePlan: plan, commit: false });
  } catch (error) {
    // The batch key is the source hash plus import configuration, so a closed batch means this
    // exact sheet version was already promoted (e.g. before a sibling sheet was held).
    if (serverRefusal(error) !== 'server_refused:this_source_and_import_configuration_already_has_a_closed_review_batch') throw error;
    return { ...label, status: 'unchanged', reason: 'already_batched_for_this_version', ...(places ? { places } : {}) };
  }
  const summary = { plan: preview.plan_summary, requested: preview.requested, row_holds: preview.plan_hold_reasons,
    preview_result: preview.summary, ...(places ? { places } : {}) };
  if (changedRows(preview.requested) > map.max_new_rows_per_sheet) {
    return { ...label, status: 'held', reason: 'change_volume_review', ...summary };
  }
  if (!commit) return { ...label, status: 'previewed', ...summary };
  if (preview.status === 'no_source_changes' || preview.status === 'source_rows_held') {
    return { ...label, status: 'unchanged', ...summary };
  }
  try {
    const applied = await syncPlan({ sourcePlan: plan, commit: true });
    return { ...label, status: 'applied', batch_id: applied.batch_id, ...summary, result: applied.summary };
  } catch (error) {
    if (!/already synced/.test(error?.message ?? '')) throw error;
    return { ...label, status: 'held', reason: 'already_synced_review', ...summary };
  }
}

export async function promoteWorkbookVersion({ version, map, commit, ...deps }) {
  const base = { source_relative_path: version.relative_path, source_sha256: version.sha256 };
  const entry = workbookEntry(version.relative_path, map);
  if (entry.hold) return { ...base, status: 'held', reason: entry.hold, sheets: [] };
  const sheets = [];
  for (const sheet of entry.sheets) {
    const outcome = await promoteSheet({ version, sheet, map, commit, ...deps });
    if (!outcome) return { ...base, status: 'stale', reason: 'source_changed_during_promotion', sheets };
    sheets.push(outcome);
  }
  const held = sheets.find(sheet => sheet.status === 'held');
  if (held) return { ...base, status: 'held', reason: `sheet_${held.reason}`, sheets };
  if (!commit) return { ...base, status: 'previewed', sheets };
  const batches = sheets.filter(sheet => sheet.batch_id).map(sheet => sheet.batch_id);
  return { ...base, status: 'applied', receipt_id: batches.length ? `batches:${batches.join(',')}` : `unchanged:${version.sha256}`,
    inserted: sheets.reduce((total, sheet) => total + (sheet.status === 'applied' ? sheet.requested?.inserts ?? 0 : 0), 0),
    sheets };
}

// Photos are promoted name-first: listing, metadata, and filename matching never read file bytes,
// because most of the R&M photo library is cloud-only and reading it would download all of it.
// Only a photo that uniquely matches one record is read, attached, and given a receipt keyed by
// its size and modified time, so an unchanged photo is never re-read.
export async function promotePhotos({ entries, receipts = {}, classify, attach, commit, limit }) {
  const results = [];
  const nextReceipts = { ...receipts };
  let attachments = 0;
  for (const entry of entries) {
    const base = { source_relative_path: entry.relative_path };
    const key = `${entry.size_bytes}:${entry.modified_at}`;
    if (receipts[entry.relative_path]?.key === key) {
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
    if (match.status !== 'matched') {
      const reason = { unmatched: 'no_exact_record_match', ambiguous: 'ambiguous_record_match',
        missing: 'source_missing' }[match.status];
      results.push({ ...base, status: 'held', reason: reason ?? 'unclassified',
        ...(match.status === 'unmatched' && match.parsed ? { parsed: match.parsed } : {}) });
      continue;
    }
    if (!commit) {
      results.push({ ...base, status: 'previewed', match_type: match.row.matchType });
      continue;
    }
    if (attachments >= limit) {
      results.push({ ...base, status: 'deferred', reason: 'photo_limit_reached' });
      continue;
    }
    attachments += 1;
    const outcome = await attach({ ...match.row, fileInfo: entry });
    if (outcome.held) {
      results.push({ ...base, status: 'held', reason: outcome.held });
      continue;
    }
    nextReceipts[entry.relative_path] = { key, sha256: outcome.sha256, receipt_id: `evidence:${outcome.storage_path}` };
    results.push({ ...base, status: 'applied', reused: outcome.reused, already_linked: outcome.already_linked });
  }
  return { results, receipts: nextReceipts };
}

// Turns unmatched structured photos into camera-capture rows, one governed batch per client chunk.
// Returns the photos whose capture row now exists, so the caller can attach them straight away.
export async function promoteCaptures({ photos, map, deps, commit, maxBatches, minuteOrganizations }) {
  const config = map.photo_captures;
  const sheets = new Map(Object.values(map.workbooks).flatMap(entry => entry.sheets ?? [])
    .map(sheet => [sheet.client_code, sheet]));
  const clients = config.clients.map(client => ({ ...client,
    client_organization_id: sheets.get(client.profile_code).client_organization_id }));
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
      let outcome;
      try {
        outcome = await promoteSheet({ version, sheet: captureSheet(client, sheets.get(client.profile_code), config), map,
          commit, ...deps });
      } catch (error) {
        const refusal = serverRefusal(error);
        outcome = { client_code: client.capture_code, ...(refusal ? { status: 'held', reason: refusal } : { status: 'error' }),
          error: describeError(error) };
      }
      batches.push({ ...(outcome ?? { client_code: client.capture_code, status: 'stale' }), rows: chunk.length,
        photos: photosInChunk, source_sha256: version.sha256 });
      if (outcome?.status === 'applied') captured.push(...chunk.flatMap(group => group.photos));
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

// Applies results to scanner state: applied receipts acknowledge, holds are recorded, previews and
// stale versions stay pending untouched.
export function recordOutcomes(state, results) {
  let next = state;
  for (const result of results) {
    if (result.status === 'applied') next = acknowledgeSourceVersion(next, result.source_relative_path, result);
    else if (result.status === 'held') {
      next = holdSourceVersion(next, result.source_relative_path, { sha256: result.source_sha256, reason: result.reason });
    }
  }
  return next;
}

const EMPTY_LOCK_STALE_MS = 10 * 60 * 1000;

const processAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// The lock records its owner's PID so a run killed mid-way (laptop restart, closed terminal) does
// not block every later scheduled run: a lock whose process is gone is reclaimed. A lock with no
// PID is only reclaimed once it is old enough that no live run can still be writing it.
export async function acquireSourceLock(lockPath, { isAlive = processAlive, now = Date.now } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(lockPath, 'wx');
      await lock.writeFile(String(process.pid));
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const [text, info] = await Promise.all([readFile(lockPath, 'utf8').catch(() => ''), lstat(lockPath).catch(() => null)]);
    const pid = Number.parseInt(text.trim(), 10);
    const stale = Number.isInteger(pid) && pid > 0
      ? !isAlive(pid)
      : Boolean(info) && now() - info.mtimeMs > EMPTY_LOCK_STALE_MS;
    if (!stale || attempt) break;
    await rm(lockPath, { force: true });
  }
  throw new Error('Another promotion run holds the source lock');
}

export async function runPromotion({ root, statePath, map, deps, commit = false, includePhotos = false,
  recheckHolds = false, photoLimit = 500, settleMs, only = null, listPhotos = listPhotoEntries, captureBatches = null }) {
  const lockPath = `${statePath}.lock`;
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const lock = await acquireSourceLock(lockPath);
  try {
    // Workbooks only: photos are never hashed by the scanner (see promotePhotos).
    const scan = await runSourceScan({ root, statePath, includePhotos: false, settleMs });
    let state = await loadSyncState(statePath);
    const pending = pendingSourceVersions(state)
      .filter(version => recheckHolds || !isHeldVersion(state.files[version.relative_path]));
    const workbooks = [];
    for (const version of pending.filter(item => item.relative_path.startsWith(WORKBOOK_FOLDER)
      && (!only || item.relative_path.toLowerCase().includes(only.toLowerCase())))) {
      let result;
      try {
        result = await promoteWorkbookVersion({ version, map, commit, ...deps });
      } catch (error) {
        const refusal = serverRefusal(error);
        // A failed workbook stays pending without a hold so the next run retries it.
        result = { source_relative_path: version.relative_path, source_sha256: version.sha256,
          ...(refusal ? { status: 'held', reason: refusal } : { status: 'error' }), error: describeError(error) };
      }
      workbooks.push(result);
      if (commit) {
        state = recordOutcomes(state, [result]);
        await saveSyncState(statePath, state);
      }
    }
    let photos = [];
    let captures = null;
    if (includePhotos) {
      const entries = await listPhotos(root);
      let photoDeps = await deps.photoDeps({ commit });
      try {
        const outcome = await promotePhotos({ entries, receipts: state.photo_receipts ?? {}, commit, limit: photoLimit,
          ...photoDeps });
        photos = outcome.results;
        if (commit) {
          state = { ...state, photo_receipts: outcome.receipts };
          await saveSyncState(statePath, state);
        }
        const batches = captureBatches ?? map.photo_captures?.max_batches_per_run ?? 0;
        if (map.photo_captures?.enabled && batches > 0) {
          const unmatched = photos.filter(item => item.reason === 'no_exact_record_match' && item.parsed)
            .map(item => ({ relative_path: item.source_relative_path, parsed: item.parsed }));
          captures = await promoteCaptures({ photos: unmatched, map, deps, commit, maxBatches: batches,
            minuteOrganizations: photoDeps.minuteOrganizations });
          const capturedPaths = new Set(captures.captured);
          const remaining = photoLimit - photos.filter(item => item.status === 'applied').length;
          if (commit && capturedPaths.size && remaining > 0) {
            // The new rows are only visible to a fresh index, so the attach step reloads its targets.
            await photoDeps.close?.();
            photoDeps = await deps.photoDeps({ commit });
            const attached = await promotePhotos({ entries: entries.filter(entry => capturedPaths.has(entry.relative_path)),
              receipts: state.photo_receipts ?? {}, commit, limit: remaining, ...photoDeps });
            const byPath = new Map(attached.results.map(item => [item.source_relative_path, item]));
            photos = photos.map(item => byPath.get(item.source_relative_path) ?? item);
            state = { ...state, photo_receipts: attached.receipts };
            await saveSyncState(statePath, state);
          }
        }
      } finally {
        await photoDeps.close?.();
      }
    }
    return {
      mode: commit ? 'apply' : 'dry_run',
      scan,
      workbooks: workbooks.map(({ sheets, ...result }) => ({ ...result, sheets })),
      photos: { counts: tally(photos), sample_matches: photos.filter(item => ['previewed', 'applied'].includes(item.status))
        .slice(0, 20).map(item => item.source_relative_path) },
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
    syncPlan: ({ sourcePlan, commit }) => runSourceSync({ sourcePlan, providerOrganizationId: map.provider_organization_id,
      readQuery: linkedQuery, writeQuery: cliQuery, commit, evidenceOnly: true }),
    photoDeps: async ({ commit }) => {
      const { createClient } = await import('@supabase/supabase-js');
      const photo = await import('../../scripts/import-approved-rm-vehicle-history.mjs');
      const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceRole } = process.env;
      if (!url || !serviceRole) throw new Error('Supabase URL and service role are required for scoped photo matching');
      const service = createClient(url, serviceRole, { auth: { persistSession: false } });
      // Attachments run as the source profile's configured import identity, the same governed
      // actor the record writer uses, so every evidence link carries that actor's audit receipt.
      let governed = null;
      if (commit) {
        const actors = linkedQuery(`SELECT import_actor_id FROM public.import_source_profiles
          WHERE organization_id='${map.provider_organization_id}'::uuid AND profile_code='rm_patrol_log' AND active;`);
        const actorId = actors?.length === 1 ? actors[0].import_actor_id : null;
        if (!/^[0-9a-f-]{36}$/i.test(actorId ?? '')) throw new Error('The R&M source profile has no configured import identity');
        governed = { storage: service.storage, rpc: async (name, args) => importActorRpc(cliQuery, actorId, name, args) };
      }
      const organizationIds = await photo.loadVisibleOrganizationIds(service, map.provider_organization_id);
      const { byMinute, eventsByMinute } = await photo.loadTargets(service, organizationIds, { includePatrolEvents: true });
      return {
        classify: relativePath => photo.classifyPhoto(relativePath, root, byMinute, null, eventsByMinute),
        attach: row => photo.attachMatchedPhoto(service, governed, row),
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
    throw new Error('Use --root <R&M documents> --state <scanner state json> --report <report json> [--commit] [--photos] [--recheck-holds] [--photo-limit n] [--capture-batches n] [--only <workbook name fragment> [--max-new-rows n]]');
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
    recheckHolds: process.argv.includes('--recheck-holds'), photoLimit, only: argument('--only') ?? null, captureBatches });
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
