#!/usr/bin/env node
/*
 * Parses a raw R&M patrol-log CSV (exported via .tmp-xlsx-to-csv.ps1 from the
 * client's raw DATA sheet) into a governed review batch:
 *   - Rows with a resolvable officer (Patroller matches a known R&M
 *     user_profiles.display_name) AND a plate (Reg column, or extracted from
 *     Comments) go to `public.observations` (vehicle-plate-sighting table).
 *   - Everything else (literal "Camera", unresolved patroller names, no
 *     plate) goes to `public.location_events` via create_location_event().
 * Idempotent: the source/configuration identity freezes the review batch and
 * every row is keyed by `rm_patrol_import:{client_code}:{Job}`.
 *
 *   node scripts/import-patrol-log.mjs --csv <path> --org-id <uuid> --client-code <code>
 *     --zone-map-file <path-to-json> [--source-label <file>] [--source-hash <sha256>]
 *     [--source-sheet <sheet>] [--source-first-row <number>] [--dry-run|--apply]
 *
 * Required: FIELD_COMPLIANCE_CODESPACE (Supabase management token; never printed).
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const PROJECT_REF = 'dotczcyyzgabmtmnglqj';
const PROVIDER_ORG_ID = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'; // R&M Security and Investigations
const ACTOR_ID = 'f1c00000-0000-4000-8000-000000000001'; // Dedicated non-login import identity
const SOURCE_PROFILE = 'rm_patrol_log';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const mode = args.includes('--apply') ? 'apply' : 'dry-run';
const includeNarratives = args.includes('--include-narratives');
const useSupabaseCli = args.includes('--use-supabase-cli');
const csvPath = flag('--csv');
const orgId = flag('--org-id');
const clientCode = flag('--client-code');
const zoneMapFile = flag('--zone-map-file');
const sourceLabel = flag('--source-label');
const sourceHash = flag('--source-hash');
const sourceSheet = flag('--source-sheet');
const sourceFirstRow = Number(flag('--source-first-row') ?? 2);
const zoneMap = zoneMapFile ? JSON.parse(readFileSync(zoneMapFile, 'utf8')) : JSON.parse(flag('--zone-map') ?? '{}');
const token = process.env.FIELD_COMPLIANCE_CODESPACE;
if (mode === 'apply' && !token && !useSupabaseCli) { console.error('FIELD_COMPLIANCE_CODESPACE or --use-supabase-cli is required for --apply'); process.exit(1); }
if (!csvPath || !orgId || !clientCode) { console.error('Usage: --csv <path> --org-id <uuid> --client-code <code> --zone-map-file <path> [--dry-run|--apply]'); process.exit(1); }
if (sourceHash && !/^[a-f0-9]{64}$/i.test(sourceHash)) { console.error('--source-hash must be a SHA-256 hex digest'); process.exit(1); }
if (!/^[0-9a-f-]{36}$/i.test(orgId)) { console.error('--org-id must be a UUID'); process.exit(1); }
if (!Number.isInteger(sourceFirstRow) || sourceFirstRow < 1) { console.error('--source-first-row must be a positive integer'); process.exit(1); }

// R&M's own known officers (created 2026-09-23 on owner instruction). Extend
// this list as more real names are confirmed from other client files.
const KNOWN_OFFICERS = {
  'rob crawford': 'c1f730f2-efb2-4709-bf59-6437e3578bc3',
  'colin eathorne': '00a5c612-7fec-411c-a7bd-21e526c81cb9',
  'susan finigan': '0cb049df-fea2-4566-a2fb-30956064ead8',
  'evan garland': '9a354919-1240-4dac-a264-42857168611b',
  'marty lucas': '30cf4614-4c66-475c-929a-d9519e2061f4',
  'wade sutherland-berkett': '9e96c281-3dc1-449b-819f-57b61f91c739',
  'pete crawford': '8f705807-81d5-424e-910f-3c5d8d97b80e',
  'reuben stanfield': '19e1ab78-abe3-4ffe-a006-66a4fab56804',
  // Found in NCC's raw log (2026-09-23):
  'sally curtis': 'd65b59e3-9c21-45d4-968f-351ca6e319fe',
  'colin nelson': 'c8c102f0-bec6-4b03-a7a3-160f7a7585d1',
  'ash bremner': '822509e2-7bf0-4177-b895-d27034b30252',
  'dan douglas': '60b73649-ddae-4386-be6b-3d9243db625c',
  'dave porter': '5bd14029-b00b-4240-b42a-c739c168b6e4',
  'a goodall': '107e5596-a859-4fe7-900f-aa98b7f2147c',
  'glenn gribben': 'c844ff45-eaf6-439a-bc51-b6065a6acabd',
  // Found in TDC's raw log (2026-09-23). Don Squires already had an R&M-org profile
  // (role=master) from earlier in this project - reused rather than duplicated.
  'steve henery': '1a80c0eb-bfe9-4c75-b6d1-659b13b0bc75',
  'andrew curtis': 'a77d3dfd-9fb9-4543-9928-421b369aa847',
  'jacob lucas': 'a4c07cc6-530a-401d-8781-414f382ebe06',
  'deb crawford': '368b4d00-604b-47f9-9656-9471a0f8ee6e',
  'ken eccles': '3c25162f-d6dc-44c2-88b2-5607a322d7f9',
  'don squires': '08369a00-e2df-45d6-9e6b-6b3a6bede645',
  // Found in M&R's raw log (2026-09-23):
  'beau webster': '91e8e27b-1bc1-4e69-8d42-e8a816d853dc',
  // Found in STAND's raw log (2026-09-23) - "Deborah Crawford" is the same real
  // person as the already-known "Deb Crawford" (verified via existing profile).
  'deborah crawford': '368b4d00-604b-47f9-9656-9471a0f8ee6e',
  // Found in Private-Redvale-Merc's raw log (2026-09-23) - same person as
  // "wade sutherland-berkett" above, just spelled without the hyphen.
  'wade sutherland berkett': '9e96c281-3dc1-449b-819f-57b61f91c739',
  // Found in OFO's culling logs + confirmed via R&M's own historical staff roster
  // (RMSEC Forestry Staff Rosters/Roster.xlsx, "Steve"/"Sheryl" columns, 2026-09-24)
  // - profile-only records (no auth.users row), same pattern as the officers above.
  'steve savage': 'a9342300-f1c7-4402-8c2e-4de5689fda5a',
  'sheryl murray': 'ce9f16b8-bb7f-4e60-929a-64458fefb347',
  // PLACEHOLDER (2026-09-24) - real, substantial officer in the roster (~89
  // mentions, Jan-Dec 2023) with no surname found anywhere yet. Owner is
  // confirming the real name with the Crawfords; display_name "Waz Waz" and
  // this key are a stand-in - update both (and re-run any imports keyed on
  // this name) once the real name is known.
  'waz': 'ee7ded2c-f2b4-4ac3-bd8c-2cc376d94331',
};

function parseCsv(text) {
  const rows = [];
  let cell = '', row = [], quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' && text[i + 1] === '"' && quoted) { cell += '"'; i += 1; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseNzDate(dateStr, timeStr) {
  const trimmed = (dateStr ?? '').trim();
  let y, mo, d;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (m) { [, d, mo, y] = m; }
  else if (/^\d{4,6}$/.test(trimmed)) {
    // Value2-based CSV export (fast bulk COM read, no cell-by-cell .Text formatting)
    // returns dates as raw Excel serial numbers instead of a dd/mm/yyyy string -
    // Excel's epoch is 1899-12-30, i.e. serial 25569 == 1970-01-01 (Unix epoch).
    const dt = new Date((Number(trimmed) - 25569) * 86400 * 1000);
    y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  } else return null;
  if (Number(y) < 2000 || Number(y) > new Date().getUTCFullYear()) return null;
  const calendarDate = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (calendarDate.getUTCFullYear() !== Number(y) || calendarDate.getUTCMonth() !== Number(mo) - 1 || calendarDate.getUTCDate() !== Number(d)) return null;
  let hh = '00', mm = '00';
  const t = (timeStr ?? '').trim().replace(/\.\d+$/, '');
  if (/^\d{3,4}$/.test(t)) { const padded = t.padStart(4, '0'); hh = padded.slice(0, 2); mm = padded.slice(2, 4); }
  if (Number(hh) > 23) hh = '00';
  if (Number(mm) > 59) mm = '00';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${hh}:${mm}:00+12:00`;
}

// NZ plate shapes: 2-3 letters + 2-4 digits, or 1-3 digits + 2-3 letters (older/personalised).
const PLATE_SHAPE_RE = /^([A-Z]{2,3}\d{2,4}|\d{1,3}[A-Z]{2,3})$/;
const PLATE_RE = /\b([A-Z]{2,3}\d{2,4}|\d{1,3}[A-Z]{2,3})\b/g;
function extractPlates(text) {
  if (!text) return [];
  const found = new Set();
  for (const m of text.toUpperCase().matchAll(PLATE_RE)) {
    if (m[1].length >= 4 && m[1].length <= 6) found.add(m[1]);
  }
  return [...found];
}

const raw = readFileSync(csvPath, 'utf8');
const computedSourceHash = createHash('sha256').update(raw).digest('hex');
if (sourceHash && sourceHash.toLowerCase() !== computedSourceHash) {
  console.error('--source-hash does not match the CSV bytes');
  process.exit(1);
}
const immutableSourceHash = computedSourceHash;
const immutableSourceLabel = sourceLabel || basename(csvPath);
const immutableSourceSheet = sourceSheet || 'DATA';
const table = parseCsv(raw).filter((r) => r.length > 1);
// Header cells sometimes carry a leading BOM and/or extra/embedded whitespace (e.g. NCC's
// "24hr\nTime", Taylors' "Log  no" with a double space) - normalize both before matching.
const header = table[0].map((h) => h.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim());
const headerLower = header.map((h) => h.toLowerCase());
// Different clients' raw sheets use different header text (and casing) for the same logical
// column (confirmed: DOC uses Location/Comments/Job Time/Job KMs; NCC uses a separate Reserve
// code + Location detail, "24hr Time", "Description/Comments", "Job Time NCC"; Taylors uses
// "Log  no"/"Action By") - matching is case-insensitive, first candidate found wins.
const pick = (...candidates) => { for (const name of candidates) { const i = headerLower.indexOf(name.toLowerCase()); if (i !== -1) return i; } return -1; };
const col = {
  job: pick('Job', 'Log No', 'Logno'), patroller: pick('Patroller'), date: pick('Date'),
  time: pick('Time', '24hr Time'),
  reserve: pick('Reserve', 'CODE', 'Forest', 'Site'), // primary zone-code key when present (more stable than free-text Location)
  location: pick('Location'), // fallback zone key: free-text detail, or the only place column on non-council sheets
  comments: pick('Comments', 'Description/Comments'),
  reg: pick('Reg', 'Numbers'),
  jobTime: pick('Job Time', 'Job Time NCC', 'Job Time OFO', 'Job Time TPFL'), jobKms: pick('Job KMs', 'Job Km NCC', 'Job kms', 'Job KM OFO', 'Job KM', 'Job KM TPFL'),
  issue: pick('Issue'), actionBy: pick('Action by', 'Action By'),
  actionNotes: pick('Action / Notes', 'Action Notes'), lastActionDate: pick('Last Action Date'), closedBy: pick('Closed By'),
};

const observationsBatch = [];
const eventsBatch = [];
const seenExternalRefs = new Set();
let skipped = 0;
let skippedNoZone = 0;
let skippedDuplicate = 0;

for (const [rowIndex, r] of table.slice(1).entries()) {
  const job = (r[col.job] ?? '').trim();
  const patroller = (r[col.patroller] ?? '').trim();
  const occurredAt = parseNzDate(r[col.date], r[col.time]);
  if (!occurredAt) { skipped += 1; continue; } // header/blank/summary rows with no real date
  const locationText = (r[col.location] ?? '').trim();
  const reserveCode = col.reserve !== -1 ? (r[col.reserve] ?? '').trim() : '';
  // Reserve code (when the sheet has one) is the stable join key; free-text Location is the fallback
  // for rows where Reserve is blank, or for sheets that only ever had a single Location column.
  // A zone-map entry is normally a bare zone UUID string; some clients (e.g. Taylors) also have
  // commercial client_sites, not just residential/patrol zones - those entries are written as
  // { "site_id": "<uuid>" } instead, so a single map can resolve to either place type.
  const resolved = (reserveCode && zoneMap[reserveCode]) ?? zoneMap[locationText] ?? null;
  const zoneId = typeof resolved === 'string' ? resolved : null;
  const siteId = resolved && typeof resolved === 'object' ? resolved.site_id ?? null : null;
  const comments = (r[col.comments] ?? '').trim();
  // Reg column sometimes holds several plates separated by commas/slashes/spaces
  // (e.g. "ACZ755, DAB364, DGY148") - split first, validate each token's shape,
  // rather than stripping separators and concatenating them into one string.
  const regTokens = (r[col.reg] ?? '').toUpperCase().split(/[,;/\s]+/).map((t) => t.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const regPlates = regTokens.filter((t) => PLATE_SHAPE_RE.test(t));
  const plates = regPlates.length ? regPlates : extractPlates(comments);
  const primaryPlate = plates[0] ?? null;
  const isCamera = /^camera$/i.test(patroller);
  // Some rows record TWO officers on a joint patrol, separated by a newline/comma in one cell
  // (e.g. "Colin Eathorne\nWade Sutherland-Berkett") - take the first name that resolves to a
  // known officer rather than requiring the whole raw cell to match a single known name exactly.
  const patrollerNames = patroller.split(/[\n,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const officerId = !isCamera ? patrollerNames.map((n) => KNOWN_OFFICERS[n]).find(Boolean) ?? null : null;
  const externalRef = `rm_patrol_import:${clientCode}:${job || createHash('md5').update(occurredAt + locationText + comments).digest('hex').slice(0, 8)}`;
  if (seenExternalRefs.has(externalRef)) {
    skippedDuplicate += 1;
    continue;
  }
  seenExternalRefs.add(externalRef);
  const payload = {
    source: 'rm_patrol_log_import', client_code: clientCode, job_number: job || null,
    source_file: immutableSourceLabel, source_sha256: immutableSourceHash,
    source_sheet: immutableSourceSheet, source_row: sourceFirstRow + rowIndex,
    classification_profile: SOURCE_PROFILE,
    job_kms: r[col.jobKms] || null,
    ...(includeNarratives ? {
      comments: comments || null,
      issue: (r[col.issue] ?? '').trim() || null,
      action_by: (r[col.actionBy] ?? '').trim() || null,
      action_notes: (r[col.actionNotes] ?? '').trim() || null,
      last_action_date: (r[col.lastActionDate] ?? '').trim() || null,
      closed_by: (r[col.closedBy] ?? '').trim() || null,
    } : {}),
  };

  if (officerId && primaryPlate) {
    observationsBatch.push({ external_ref: externalRef, occurred_at: occurredAt, zone_id: zoneId, site_id: siteId, officer_id: officerId, plate: primaryPlate, officer_notes: includeNarratives ? comments || null : null, distance_km: r[col.jobKms] || null, payload });
  } else if (zoneId || siteId) {
    eventsBatch.push({
      external_ref: externalRef, occurred_at: occurredAt, zone_id: zoneId, site_id: siteId,
      event_type: isCamera ? 'camera_activation' : (officerId ? 'patrol_visit' : 'patrol_log_unattributed'),
      observed_entity_type: officerId ? 'staff' : null, observed_entity_id: officerId,
      distance_km: r[col.jobKms] || null, payload,
    });
  } else {
    // location_events requires client_site_id XOR zone_id (no placeless events) -
    // a row whose Location text doesn't resolve to a seeded zone or site has nowhere
    // valid to attach; skip rather than force/guess a place.
    skippedNoZone += 1;
  }
}

console.log(`Parsed ${table.length - 1} rows (${skipped} skipped: no date; ${skippedNoZone} skipped: no resolvable zone via Reserve/Location; ${skippedDuplicate} skipped: duplicate external reference): ${observationsBatch.length} -> observations, ${eventsBatch.length} -> location_events`);

const CHUNK_SIZE = 300;
function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
const derivativeHash = createHash('sha256').update(JSON.stringify({ observations: observationsBatch, events: eventsBatch })).digest('hex');
for (const row of [...observationsBatch, ...eventsBatch]) row.payload.derivative_sha256 = derivativeHash;
const obsChunks = chunk(observationsBatch, CHUNK_SIZE);
const evtChunks = chunk(eventsBatch, CHUNK_SIZE);
const totalChunks = Math.max(obsChunks.length, evtChunks.length, 1);

async function runSql(sql) {
  if (useSupabaseCli) {
    const tempDir = mkdtempSync(join(tmpdir(), 'fcm-patrol-import-'));
    const sqlFile = join(tempDir, 'chunk.sql');
    try {
      writeFileSync(sqlFile, sql, 'utf8');
      const cliPath = join(process.cwd(), 'node_modules', 'supabase', 'dist', 'supabase.js');
      const output = execFileSync(process.execPath, [cliPath, 'db', 'query', '--linked', '--output-format', 'json', '--file', sqlFile], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      const result = JSON.parse(output);
      if (!Array.isArray(result.rows) || result.rows.length === 0) throw new Error('Supabase CLI returned no import counts');
      return result.rows[result.rows.length - 1];
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 3000));
  return JSON.parse(text)[0];
}

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

const manifest = {
  idempotency_key: createHash('sha256').update(`${PROVIDER_ORG_ID}:${orgId}:${immutableSourceHash}:${derivativeHash}`).digest('hex'),
  source_profile: SOURCE_PROFILE,
  target_client_organization_id: orgId,
  derivative_sha256: derivativeHash,
  expected_proposal_count: 0,
  include_narratives: includeNarratives,
};
const schema = {
  headers: header,
  resolved_mappings: header.map((sourceColumn) => ({
    source_column: sourceColumn,
    target_entity: 'patrol_import_source',
    target_field: sourceColumn.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
  })),
};

if (mode === 'dry-run') {
  console.log(JSON.stringify({
    mode,
    source_file: immutableSourceLabel,
    source_sha256: immutableSourceHash,
    derivative_sha256: derivativeHash,
    row_count: table.length - 1,
    duplicate_count: skippedDuplicate,
    unresolved_count: skippedNoZone,
    observation_candidates: observationsBatch.length,
    event_candidates: eventsBatch.length,
    proposed_consequential_writes: 0,
    next_status_on_apply: 'needs_review',
  }));
  process.exit(0);
}

const beginData = encodedJson({
  provider_organization_id: PROVIDER_ORG_ID,
  client_organization_id: orgId,
  batch_name: `${clientCode} patrol log - ${immutableSourceLabel}`,
  source_file: immutableSourceLabel,
  source_sha256: immutableSourceHash,
  parser: 'scripts/import-patrol-log.mjs',
  manifest,
  schema,
  row_count: table.length - 1,
  duplicate_count: skippedDuplicate,
  unresolved_count: skippedNoZone,
});
const beginRow = await runSql(`
BEGIN;
SET LOCAL request.jwt.claim.sub = '${ACTOR_ID}';
WITH args AS (SELECT convert_from(decode('${beginData}','base64'),'UTF8')::jsonb AS value)
SELECT row_to_json(batch) AS batch
FROM args, LATERAL public.begin_patrol_import_batch(
  (value->>'provider_organization_id')::uuid,
  (value->>'client_organization_id')::uuid,
  value->>'batch_name',
  value->>'source_file',
  value->>'source_sha256',
  value->>'parser',
  value->'manifest',
  value->'schema',
  (value->>'row_count')::integer,
  (value->>'duplicate_count')::integer,
  (value->>'unresolved_count')::integer
) batch;
COMMIT;`);
const batch = beginRow?.batch ?? beginRow?.rows?.[0]?.batch;
if (!batch?.id) throw new Error('Governed import batch creation was not confirmed');

const totals = {
  obs_inserted: 0,
  obs_matched: 0,
  evt_inserted: 0,
  evt_matched: 0,
  proposal_candidates: 0,
  proposals_inserted: 0,
  proposals_existing: 0,
};
for (let i = 0; i < totalChunks; i += 1) {
  const obsSlice = obsChunks[i] ?? [];
  const evtSlice = evtChunks[i] ?? [];
  if (!obsSlice.length && !evtSlice.length) continue;
  console.log(`chunk ${i + 1}/${totalChunks}: ${obsSlice.length} observations, ${evtSlice.length} events`);
  const chunkData = encodedJson({ batch_id: batch.id, observations: obsSlice, events: evtSlice, proposals: [] });
  const row = await runSql(`
BEGIN;
SET LOCAL request.jwt.claim.sub = '${ACTOR_ID}';
WITH args AS (SELECT convert_from(decode('${chunkData}','base64'),'UTF8')::jsonb AS value)
SELECT staged.*
FROM args, LATERAL public.stage_patrol_import_chunk(
  (value->>'batch_id')::uuid,
  '${PROVIDER_ORG_ID}'::uuid,
  '${orgId}'::uuid,
  value->'observations',
  value->'events',
  value->'proposals'
) staged;
COMMIT;`);
  const staged = row?.rows?.[0] ?? row;
  if (!staged) throw new Error(`Governed staging result was not returned for chunk ${i + 1}`);
  for (const key of Object.keys(totals)) totals[key] += Number(staged[key] ?? 0);
}

const receipt = {
  ...totals,
  source_sha256: immutableSourceHash,
  derivative_sha256: derivativeHash,
  direct_workshop_writes: 0,
  direct_finance_writes: 0,
};
const finalizeData = encodedJson({ batch_id: batch.id, receipt });
const finalRow = await runSql(`
BEGIN;
SET LOCAL request.jwt.claim.sub = '${ACTOR_ID}';
WITH args AS (SELECT convert_from(decode('${finalizeData}','base64'),'UTF8')::jsonb AS value)
SELECT row_to_json(batch) AS batch
FROM args, LATERAL public.finalize_patrol_import_batch(
  (value->>'batch_id')::uuid,
  value->'receipt'
) batch;
COMMIT;`);
const finalized = finalRow?.batch ?? finalRow?.rows?.[0]?.batch;
if (finalized?.status !== 'needs_review') throw new Error('Governed import batch did not reach needs_review');
console.log(`apply: ${clientCode} patrol log staged for human review`);
console.log(JSON.stringify({ batch_id: batch.id, status: finalized.status, ...totals }));
