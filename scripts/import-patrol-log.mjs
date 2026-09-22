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
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((dateStr ?? '').trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  let hh = '00', mm = '00';
  const t = (timeStr ?? '').trim().replace(/\.\d+$/, '');
  if (/^\d{3,4}$/.test(t)) { const padded = t.padStart(4, '0'); hh = padded.slice(0, 2); mm = padded.slice(2, 4); }
  if (Number(hh) > 23) hh = '00';
  if (Number(mm) > 59) mm = '00';
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${hh}:${mm}:00+12:00`;
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
const header = table[0];
const idx = (name) => header.indexOf(name);
const col = { job: idx('Job'), patroller: idx('Patroller'), date: idx('Date'), time: idx('Time'), location: idx('Location'), comments: idx('Comments'), reg: idx('Reg'), jobTime: idx('Job Time'), jobKms: idx('Job KMs'), issue: idx('Issue'), actionBy: idx('Action by') };

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
  const zoneId = zoneMap[locationText] ?? null;
  const comments = (r[col.comments] ?? '').trim();
  // Reg column sometimes holds several plates separated by commas/slashes/spaces
  // (e.g. "ACZ755, DAB364, DGY148") - split first, validate each token's shape,
  // rather than stripping separators and concatenating them into one string.
  const regTokens = (r[col.reg] ?? '').toUpperCase().split(/[,;/\s]+/).map((t) => t.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const regPlates = regTokens.filter((t) => PLATE_SHAPE_RE.test(t));
  const plates = regPlates.length ? regPlates : extractPlates(comments);
  const primaryPlate = plates[0] ?? null;
  const isCamera = /^camera$/i.test(patroller);
  const officerId = !isCamera ? KNOWN_OFFICERS[patroller.toLowerCase()] ?? null : null;
  const externalRef = `rm_patrol_import:${clientCode}:${job || createHash('md5').update(occurredAt + locationText + comments).digest('hex').slice(0, 8)}`;
  const payload = {
    source: 'rm_patrol_log_import', client_code: clientCode, job_number: job || null,
    patroller_raw: patroller, location_raw: locationText, comments: comments || null,
    reg_raw: (r[col.reg] ?? '').trim() || null, plates_found: plates, job_time_hours: r[col.jobTime] || null,
    job_kms: r[col.jobKms] || null, issue: r[col.issue] || null, action_by: r[col.actionBy] || null,
  };

  if (officerId && primaryPlate) {
    observationsBatch.push({ external_ref: externalRef, occurred_at: occurredAt, zone_id: zoneId, officer_id: officerId, plate: primaryPlate, officer_notes: comments || null, payload });
  } else if (zoneId) {
    eventsBatch.push({
      external_ref: externalRef, occurred_at: occurredAt, zone_id: zoneId,
      event_type: isCamera ? 'camera_activation' : (officerId ? 'patrol_visit' : 'patrol_log_unattributed'),
      observed_entity_type: officerId ? 'staff' : null, observed_entity_id: officerId,
      status: (r[col.issue] || '').trim() || null, payload,
    });
  } else {
    // location_events requires client_site_id XOR zone_id (no placeless events) -
    // a row whose Location text doesn't resolve to a seeded zone has nowhere
    // valid to attach; skip rather than force/guess a zone.
    skippedNoZone += 1;
  }
}

console.log(`Parsed ${table.length - 1} rows (${skipped} skipped: no date; ${skippedNoZone} skipped: no resolvable zone for "${'Location'}"): ${observationsBatch.length} -> observations, ${eventsBatch.length} -> location_events`);

const data = { org_id: orgId, client_code: clientCode, observations: observationsBatch, events: eventsBatch };
const json = JSON.stringify(data);
if (json.includes('$json$')) throw new Error('data must not contain the $json$ delimiter');

const body = `
CREATE TEMP TABLE _import_counts (obs_inserted int, obs_skipped int, evt_inserted int, evt_skipped int);
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
    INSERT INTO public.observations (organization_id, officer_id, plate_number, zone_id, observed_at, module_key, canonical_vehicle_id, officer_notes, plate_source, external_refs)
    VALUES (v_org, (v_obs->>'officer_id')::uuid, v_plate, NULLIF(v_obs->>'zone_id','')::uuid, (v_obs->>'occurred_at')::timestamptz, 'patrol', v_vehicle_id, v_obs->>'officer_notes', 'manual',
            jsonb_build_object('external_ref', v_obs->>'external_ref', 'import', v_obs->'payload'));
    v_obs_count := v_obs_count + 1;
  END LOOP;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(v_data->'events') LOOP
    IF EXISTS (SELECT 1 FROM public.location_events WHERE organization_id = v_org AND external_ref = v_evt->>'external_ref') THEN
      v_evt_skip := v_evt_skip + 1; CONTINUE;
    END IF;
    PERFORM public.create_location_event(
      p_organization_id => v_org, p_event_type => v_evt->>'event_type', p_zone_id => NULLIF(v_evt->>'zone_id','')::uuid,
      p_module_key => 'patrol', p_occurred_at => (v_evt->>'occurred_at')::timestamptz, p_status => v_evt->>'status',
      p_source => 'rm_patrol_log_import', p_external_ref => v_evt->>'external_ref', p_payload => v_evt->'payload',
      p_observed_entity_type => v_evt->>'observed_entity_type', p_observed_entity_id => NULLIF(v_evt->>'observed_entity_id','')::uuid,
      p_provider_organization_id => '${PROVIDER_ORG_ID}'::uuid, p_client_organization_id => v_org
    );
    v_evt_count := v_evt_count + 1;
  END LOOP;

  RAISE NOTICE 'observations_inserted=% observations_skipped=% events_inserted=% events_skipped=%', v_obs_count, v_obs_skip, v_evt_count, v_evt_skip;
  INSERT INTO _import_counts VALUES (v_obs_count, v_obs_skip, v_evt_count, v_evt_skip);
END
$import$;
SELECT * FROM _import_counts;
`;

const sql = `BEGIN;
set local request.jwt.claim.sub = '${ACTOR_ID}';
${body}${mode === 'apply' ? 'COMMIT;' : 'ROLLBACK;'}`;
const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }),
});
const text = await response.text();
if (!response.ok) { console.error(`${mode}: failed`, text.slice(0, 3000)); process.exit(1); }
console.log(`${mode}: ${clientCode} patrol log import`);
console.log(text.slice(0, 1000));
