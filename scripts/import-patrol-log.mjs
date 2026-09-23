#!/usr/bin/env node
/*
 * Parses a raw R&M patrol-log CSV (exported via .tmp-xlsx-to-csv.ps1 from the
 * client's raw DATA sheet) into a resolved JSON batch, then imports it:
 *   - Rows with a resolvable officer (Patroller matches a known R&M
 *     user_profiles.display_name) AND a plate (Reg column, or extracted from
 *     Comments) go to `public.observations` (vehicle-plate-sighting table).
 *   - Everything else (literal "Camera", unresolved patroller names, no
 *     plate) goes to `public.location_events` via create_location_event().
 * Idempotent: every row is keyed by `rm_patrol_import:{client_code}:{Job}` as
 * external_ref/external_refs so a re-run does not duplicate.
 *
 *   node scripts/import-patrol-log.mjs --csv <path> --org-id <uuid> --client-code <code>
 *     --zone-map-file <path-to-json> [--dry-run|--apply]
 *
 * Required: FIELD_COMPLIANCE_CODESPACE (Supabase management token; never printed).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PROJECT_REF = 'dotczcyyzgabmtmnglqj';
const PROVIDER_ORG_ID = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'; // R&M Security and Investigations
const ACTOR_ID = '1b02ab97-8611-40ab-a3a0-b5c74589db58';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const mode = args.includes('--apply') ? 'apply' : 'dry-run';
const csvPath = flag('--csv');
const orgId = flag('--org-id');
const clientCode = flag('--client-code');
const zoneMapFile = flag('--zone-map-file');
const zoneMap = zoneMapFile ? JSON.parse(readFileSync(zoneMapFile, 'utf8')) : JSON.parse(flag('--zone-map') ?? '{}');
const token = process.env.FIELD_COMPLIANCE_CODESPACE;
if (!token) { console.error('FIELD_COMPLIANCE_CODESPACE is required'); process.exit(1); }
if (!csvPath || !orgId || !clientCode) { console.error('Usage: --csv <path> --org-id <uuid> --client-code <code> --zone-map-file <path> [--dry-run|--apply]'); process.exit(1); }

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
  job: pick('Job', 'Log No'), patroller: pick('Patroller'), date: pick('Date'),
  time: pick('Time', '24hr Time'),
  reserve: pick('Reserve', 'CODE', 'Forest', 'Site'), // primary zone-code key when present (more stable than free-text Location)
  location: pick('Location'), // fallback zone key: free-text detail, or the only place column on non-council sheets
  comments: pick('Comments', 'Description/Comments'),
  reg: pick('Reg'),
  jobTime: pick('Job Time', 'Job Time NCC', 'Job Time OFO', 'Job Time TPFL'), jobKms: pick('Job KMs', 'Job Km NCC', 'Job kms', 'Job KM OFO', 'Job KM', 'Job KM TPFL'),
  issue: pick('Issue'), actionBy: pick('Action by', 'Action By'),
};

const observationsBatch = [];
const eventsBatch = [];
let skipped = 0;
let skippedNoZone = 0;

for (const r of table.slice(1)) {
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
  const payload = {
    source: 'rm_patrol_log_import', client_code: clientCode, job_number: job || null,
    patroller_raw: patroller, location_raw: locationText, reserve_raw: reserveCode || null, comments: comments || null,
    reg_raw: (r[col.reg] ?? '').trim() || null, plates_found: plates, job_time_hours: r[col.jobTime] || null,
    job_kms: r[col.jobKms] || null, issue: r[col.issue] || null, action_by: r[col.actionBy] || null,
  };

  if (officerId && primaryPlate) {
    observationsBatch.push({ external_ref: externalRef, occurred_at: occurredAt, zone_id: zoneId, site_id: siteId, officer_id: officerId, plate: primaryPlate, officer_notes: comments || null, payload });
  } else if (zoneId || siteId) {
    eventsBatch.push({
      external_ref: externalRef, occurred_at: occurredAt, zone_id: zoneId, site_id: siteId,
      event_type: isCamera ? 'camera_activation' : (officerId ? 'patrol_visit' : 'patrol_log_unattributed'),
      observed_entity_type: officerId ? 'staff' : null, observed_entity_id: officerId,
      status: (r[col.issue] || '').trim() || null, payload,
    });
  } else {
    // location_events requires client_site_id XOR zone_id (no placeless events) -
    // a row whose Location text doesn't resolve to a seeded zone or site has nowhere
    // valid to attach; skip rather than force/guess a place.
    skippedNoZone += 1;
  }
}

console.log(`Parsed ${table.length - 1} rows (${skipped} skipped: no date; ${skippedNoZone} skipped: no resolvable zone via Reserve/Location): ${observationsBatch.length} -> observations, ${eventsBatch.length} -> location_events`);

// Large logs (thousands of rows, verbose free-text comments) can produce a combined JSON
// payload the Management API rejects as "request entity too large" in one request - chunk
// both batches into fixed-size slices and run one transaction per chunk, summing results.
const CHUNK_SIZE = 300;
function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
const obsChunks = chunk(observationsBatch, CHUNK_SIZE);
const evtChunks = chunk(eventsBatch, CHUNK_SIZE);
const totalChunks = Math.max(obsChunks.length, evtChunks.length, 1);

async function runChunk(obsSlice, evtSlice) {
  const data = { org_id: orgId, client_code: clientCode, observations: obsSlice, events: evtSlice };
  const json = JSON.stringify(data);
  if (json.includes('$json$')) throw new Error('data must not contain the $json$ delimiter');
  const body = `
CREATE TEMP TABLE IF NOT EXISTS _import_counts (obs_inserted int, obs_skipped int, evt_inserted int, evt_skipped int);
DO $import$
DECLARE
  v_data jsonb := $json$${json}$json$::jsonb;
  v_org uuid := (v_data->>'org_id')::uuid;
  v_obs jsonb; v_evt jsonb; v_plate text; v_vehicle_id uuid; v_obs_count integer := 0; v_evt_count integer := 0; v_evt_skip integer := 0; v_obs_skip integer := 0;
BEGIN
  FOR v_obs IN SELECT * FROM jsonb_array_elements(v_data->'observations') LOOP
    IF EXISTS (SELECT 1 FROM public.observations WHERE organization_id = v_org AND external_refs->>'external_ref' = v_obs->>'external_ref') THEN
      v_obs_skip := v_obs_skip + 1; CONTINUE;
    END IF;
    v_plate := v_obs->>'plate';
    SELECT id INTO v_vehicle_id FROM public.canonical_vehicles WHERE upper(plate_number) = upper(v_plate) LIMIT 1;
    IF v_vehicle_id IS NULL THEN
      INSERT INTO public.canonical_vehicles (plate_number, compliance_source)
      VALUES (v_plate, 'canonical') RETURNING id INTO v_vehicle_id;
    END IF;
    INSERT INTO public.observations (organization_id, officer_id, plate_number, zone_id, site_id, observed_at, module_key, canonical_vehicle_id, officer_notes, plate_source, external_refs, distance_km)
    VALUES (v_org, (v_obs->>'officer_id')::uuid, v_plate, NULLIF(v_obs->>'zone_id','')::uuid, NULLIF(v_obs->>'site_id','')::uuid, (v_obs->>'occurred_at')::timestamptz, 'patrol', v_vehicle_id, v_obs->>'officer_notes', 'manual',
            jsonb_build_object('external_ref', v_obs->>'external_ref', 'import', v_obs->'payload'),
            CASE WHEN v_obs->'payload'->>'job_kms' ~ '^[0-9]+([.][0-9]+)?$' THEN (v_obs->'payload'->>'job_kms')::numeric ELSE NULL END);
    v_obs_count := v_obs_count + 1;
  END LOOP;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(v_data->'events') LOOP
    IF EXISTS (SELECT 1 FROM public.location_events WHERE organization_id = v_org AND external_ref = v_evt->>'external_ref') THEN
      v_evt_skip := v_evt_skip + 1; CONTINUE;
    END IF;
    PERFORM public.create_location_event(
      p_organization_id => v_org, p_event_type => v_evt->>'event_type', p_client_site_id => NULLIF(v_evt->>'site_id','')::uuid, p_zone_id => NULLIF(v_evt->>'zone_id','')::uuid,
      p_module_key => 'patrol', p_occurred_at => (v_evt->>'occurred_at')::timestamptz, p_status => v_evt->>'status',
      p_source => 'rm_patrol_log_import', p_external_ref => v_evt->>'external_ref', p_payload => v_evt->'payload',
      p_observed_entity_type => v_evt->>'observed_entity_type', p_observed_entity_id => NULLIF(v_evt->>'observed_entity_id','')::uuid,
      p_provider_organization_id => '${PROVIDER_ORG_ID}'::uuid, p_client_organization_id => v_org
    );
    -- create_location_event has no distance_km param (shared RPC, not extended for this) - set it directly after insert.
    IF v_evt->'payload'->>'job_kms' ~ '^[0-9]+([.][0-9]+)?$' THEN
      UPDATE public.location_events SET distance_km = (v_evt->'payload'->>'job_kms')::numeric
      WHERE organization_id = v_org AND external_ref = v_evt->>'external_ref';
    END IF;
    v_evt_count := v_evt_count + 1;
  END LOOP;

  RAISE NOTICE 'observations_inserted=% observations_skipped=% events_inserted=% events_skipped=%', v_obs_count, v_obs_skip, v_evt_count, v_evt_skip;
  INSERT INTO _import_counts VALUES (v_obs_count, v_obs_skip, v_evt_count, v_evt_skip);
END
$import$;
SELECT * FROM (SELECT obs_inserted, obs_skipped, evt_inserted, evt_skipped FROM _import_counts ORDER BY ctid DESC LIMIT 1) t;
`;
  const sql = `BEGIN;
set local request.jwt.claim.sub = '${ACTOR_ID}';
${body}${mode === 'apply' ? 'COMMIT;' : 'ROLLBACK;'}`;
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 3000));
  return JSON.parse(text)[0];
}

const totals = { obs_inserted: 0, obs_skipped: 0, evt_inserted: 0, evt_skipped: 0 };
for (let i = 0; i < totalChunks; i += 1) {
  const obsSlice = obsChunks[i] ?? [];
  const evtSlice = evtChunks[i] ?? [];
  if (!obsSlice.length && !evtSlice.length) continue;
  console.log(`chunk ${i + 1}/${totalChunks}: ${obsSlice.length} observations, ${evtSlice.length} events`);
  const row = await runChunk(obsSlice, evtSlice);
  for (const key of Object.keys(totals)) totals[key] += Number(row[key] ?? 0);
}
console.log(`${mode}: ${clientCode} patrol log import`);
console.log(JSON.stringify(totals));
