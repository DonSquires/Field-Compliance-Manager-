#!/usr/bin/env node
/*
 * Parses a raw R&M patrol-log CSV (exported via .tmp-xlsx-to-csv.ps1 from the
 * client's raw DATA sheet) into a resolved JSON batch, then imports it:
 *   - Rows with a resolvable officer (Patroller matches a known R&M
 *     user_profiles.display_name) AND a plate (Reg column, or extracted from
 *     Comments) go to `public.observations` (vehicle-plate-sighting table).
 *   - Everything else (literal "Camera", unresolved patroller names, no
 *     plate) goes to `public.location_events`.
 * Idempotent: every row is keyed by `rm_patrol_import:{client_code}:{Job}` as
 * external_ref/external_refs so a re-run does not duplicate.
 *
 *   node scripts/import-patrol-log.mjs --csv <path> --org-id <uuid> --client-code <code>
 *     --provider-org-id <uuid> --classification-profile <code>
 *     --zone-map-file <path-to-json> [--source-label <file>] [--source-hash <sha256>]
 *     [--source-sheet <sheet>] [--source-first-row <number>] [--include-narratives]
 *     [--use-supabase-cli] [--dry-run|--apply]
 *
 * Database access: SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE (never printed), or an existing
 * linked Supabase CLI session selected explicitly with --use-supabase-cli.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ExcelJS from 'exceljs';
import { classifyPatrolWork } from './patrol-work-classifier.mjs';
import { buildChargeCatalog, composeChargeCode } from './patrol-charge-code.mjs';
import { materialsUsed } from './patrol-materials.mjs';
import { buildPatrolImportProposals } from './patrol-import-proposals.mjs';
import { aucklandInstantFromLocalParts } from './rm-photo-matcher.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const mode = args.includes('--apply') ? 'apply' : 'dry-run';
const exportPlan = args.includes('--export-plan');
if (exportPlan && args.includes('--apply')) { console.error('--export-plan cannot be combined with --apply'); process.exit(1); }
const includeNarratives = args.includes('--include-narratives');
const useSupabaseCli = args.includes('--use-supabase-cli');
const projectRef = process.env.SUPABASE_PROJECT_REF;
const csvPath = flag('--csv');
const xlsxPath = flag('--xlsx');
const sheetName = flag('--sheet');
const headerRow = flag('--header-row') === null ? null : Number(flag('--header-row'));
const workbookInput = Boolean(xlsxPath);
const inputPath = xlsxPath ?? csvPath;
if (xlsxPath && !exportPlan) { console.error('--xlsx is currently supported for --export-plan only'); process.exit(1); }
const orgId = flag('--org-id');
const providerOrgId = flag('--provider-org-id');
const clientCode = flag('--client-code');
const zoneMapFile = flag('--zone-map-file');
const sourceLabel = flag('--source-label');
const sourceHash = flag('--source-hash');
const sourceSheet = flag('--source-sheet') ?? sheetName;
const sourceFirstRow = Number(flag('--source-first-row') ?? (workbookInput && headerRow ? headerRow + 1 : 2));
const classificationProfile = flag('--classification-profile');
const sourceColumnAliases = JSON.parse(flag('--source-column-aliases') ?? '{}');
const importContextFile = flag('--import-context');
const zoneMap = zoneMapFile ? JSON.parse(readFileSync(zoneMapFile, 'utf8')) : JSON.parse(flag('--zone-map') ?? '{}');
const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.FIELD_COMPLIANCE_CODESPACE;
if (importContextFile && !exportPlan) { console.error('--import-context is only allowed with --export-plan'); process.exit(1); }
if (!exportPlan || !importContextFile) {
  if (!token && !useSupabaseCli) { console.error('SUPABASE_ACCESS_TOKEN (or FIELD_COMPLIANCE_CODESPACE) or --use-supabase-cli is required'); process.exit(1); }
  if (!projectRef && !useSupabaseCli) { console.error('SUPABASE_PROJECT_REF is required unless --use-supabase-cli is used'); process.exit(1); }
}
if (Boolean(csvPath) === Boolean(xlsxPath) || !inputPath || !orgId || !providerOrgId || !clientCode || !classificationProfile) {
  console.error('Choose exactly one of --csv <path> or --xlsx <path> --sheet <name> --header-row <number>, then supply --org-id, --provider-org-id, --client-code, --classification-profile, and --zone-map-file');
  process.exit(1);
}
if (workbookInput && (!sheetName || !Number.isInteger(headerRow) || headerRow < 1)) {
  console.error('--xlsx plan mode requires an exact --sheet name and positive --header-row');
  process.exit(1);
}
for (const [name, value] of Object.entries({ 'org-id': orgId, 'provider-org-id': providerOrgId })) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) { console.error(`--${name} must be a UUID`); process.exit(1); }
}
if (!/^[a-z0-9_-]+$/i.test(clientCode)) { console.error('--client-code must contain only letters, numbers, underscores, or hyphens'); process.exit(1); }
if (sourceHash && !/^[a-f0-9]{64}$/i.test(sourceHash)) { console.error('--source-hash must be a SHA-256 hex digest'); process.exit(1); }
if (!Number.isInteger(sourceFirstRow) || sourceFirstRow < 1) { console.error('--source-first-row must be a positive integer'); process.exit(1); }
if (!/^[a-z0-9_-]+$/.test(classificationProfile)) { console.error('--classification-profile must contain only lowercase letters, numbers, underscores, or hyphens'); process.exit(1); }

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

function workbookCellText(cell) {
  const value = cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return cell.text ?? '';
  return String(value);
}

async function readWorkbookSheet(bytes, name, firstRow) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const worksheet = workbook.getWorksheet(name);
  if (!worksheet) throw new Error(`Selected worksheet was not found: ${name}`);
  if (firstRow > worksheet.rowCount) throw new Error(`Header row ${firstRow} is outside worksheet ${name}`);
  const table = [];
  for (let rowNumber = firstRow; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = Array.from({ length: worksheet.columnCount }, (_, index) => workbookCellText(row.getCell(index + 1)));
    table.push(values);
  }
  if (!table[0]?.some(value => value.trim())) throw new Error(`Selected header row ${firstRow} is empty in worksheet ${name}`);
  return table;
}

function parseNzDate(dateStr, timeStr) {
  const trimmed = (dateStr ?? '').trim();
  let y, mo, d;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const iso = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.exec(trimmed);
  if (m) { [, d, mo, y] = m; }
  else if (iso) { [, y, mo, d] = iso; }
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
  let hh = 0, mm = 0, ss = 0;
  const rawTime = (timeStr ?? '').trim();
  const isoTime = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(rawTime);
  const t = rawTime.replace(/\.\d+$/, '');
  if (isoTime) [hh, mm, ss] = isoTime.slice(1).map(Number);
  else if (/^0(?:[.]\d+)?$/.test(rawTime)) {
    const seconds = Math.round(Number(rawTime) * 86_400);
    hh = Math.floor(seconds / 3_600);
    mm = Math.floor(seconds % 3_600 / 60);
    ss = seconds % 60;
  } else if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t)) {
    const parts = t.split(':').map(Number);
    [hh, mm] = parts;
    ss = parts[2] ?? 0;
  }
  else if (/^\d{3,4}$/.test(t)) {
    const padded = t.padStart(4, '0');
    hh = Number(padded.slice(0, 2));
    mm = Number(padded.slice(2, 4));
  } else if (t) return null;
  return aucklandInstantFromLocalParts(Number(y), Number(mo), Number(d), hh, mm, ss)?.replace('.000Z', 'Z') ?? null;
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

function importedNumber(value) {
  const normalized = String(value ?? '').replace(/[$,\s]/g, '');
  return /^-?[0-9]+([.][0-9]+)?$/.test(normalized) ? Number(normalized) : null;
}

const NZ_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

// Elapsed minutes come from the timestamp parseNzDate already normalised, so every time format it
// accepts (HH:mm, HH:mm:ss, Excel fractions, ISO) is usable; a blank time cell stays unknown.
function elapsedMinutes(occurredAt, rawTime) {
  if (!occurredAt || !String(rawTime ?? '').trim()) return null;
  const ms = Date.parse(occurredAt);
  return Number.isFinite(ms) ? ms / 60_000 : null;
}

// Each patrol day opens with a "Start" row (trip odometer reset). Where a sheet row's formulas
// skip that Start row and subtract the previous day's closing row, the leg comes out negative.
// Recompute the leg against the Start row, keeping the sheet's own hourly and per-km rates.
function startRowLeg(source, start) {
  if (source.kms === null || source.kms >= 0 || !start || source.odometer === null || start.odometer === null) return null;
  const kms = source.odometer - start.odometer;
  const minutes = source.minutes !== null && start.minutes !== null ? source.minutes - start.minutes : null;
  if (kms < 0 || minutes === null || minutes < 0) return null;
  const hours = minutes / 60;
  const hourRate = source.hours && source.jobCost !== null ? source.jobCost / source.hours : null;
  const kmRate = source.kms && source.travelCost !== null ? source.travelCost / source.kms : null;
  const jobCost = hourRate !== null && Number.isFinite(hourRate) ? hours * hourRate : null;
  const travelCost = kmRate !== null && Number.isFinite(kmRate) ? Math.round(kms * kmRate * 100) / 100 : null;
  return { kms, hours, jobCost, travelCost, totalCost: jobCost !== null && travelCost !== null ? jobCost + travelCost : null };
}

function runCliQuery(query) {
  const tempDir = mkdtempSync(join(tmpdir(), 'fcm-patrol-import-'));
  const sqlFile = join(tempDir, 'query.sql');
  try {
    writeFileSync(sqlFile, query, 'utf8');
    const cliPath = join(process.cwd(), 'node_modules', 'supabase', 'dist', 'supabase.js');
    const cliArgs = [cliPath, 'db', 'query', '--linked', '--output-format', 'json', '--file', sqlFile];
    if (projectRef) cliArgs.splice(4, 0, '--project-ref', projectRef);
    const output = execFileSync(process.execPath, cliArgs, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const result = JSON.parse(output);
    if (!Array.isArray(result.rows)) throw new Error('Supabase CLI returned no query rows');
    return result.rows;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseImportContextRows(rows) {
  const sourceProfile = rows.find((row) => row.record_type === 'source_profile')?.payload ?? null;
  const personAliases = Object.fromEntries(rows.filter((row) => row.record_type === 'person_alias').map((row) => [row.payload.alias_norm, row.payload.user_profile_id]));
  const classificationRules = rows.filter((row) => row.record_type === 'classification_rule').map((row) => row.payload);
  const chargeCatalogRows = rows.filter((row) => row.record_type === 'charge_catalog').map((row) => row.payload);
  if (!sourceProfile || sourceProfile.parser !== 'csv' || typeof sourceProfile.column_mappings !== 'object' || typeof sourceProfile.target_mappings !== 'object') throw new Error(`No active CSV source profile is configured for ${classificationProfile}`);
  if (Object.keys(personAliases).length === 0) throw new Error(`No person aliases are configured for ${classificationProfile}`);
  if (classificationRules.length === 0) throw new Error(`No classification rules are configured for ${classificationProfile}`);
  return { sourceProfile, personAliases, classificationRules, chargeCatalogRows };
}

async function loadImportContext() {
  if (importContextFile) {
    const context = JSON.parse(readFileSync(importContextFile, 'utf8').replace(/^\uFEFF/, ''));
    if (context.provider_organization_id !== providerOrgId || context.source_profile !== classificationProfile || !Array.isArray(context.rows)) {
      throw new Error('Local import context must match the selected provider and source profile');
    }
    return parseImportContextRows(context.rows);
  }
  const profile = classificationProfile.replace(/'/g, "''");
  const query = `SELECT * FROM (
SELECT 'source_profile' AS record_type,
  jsonb_build_object('parser', profile.parser, 'column_mappings', profile.column_mappings, 'target_mappings', profile.target_mappings, 'import_actor_id', profile.import_actor_id) AS payload
FROM public.import_source_profiles profile
WHERE profile.organization_id = '${providerOrgId}'::uuid
  AND profile.profile_code = '${profile}'
  AND profile.active
UNION ALL
SELECT 'person_alias' AS record_type,
       jsonb_build_object('alias_norm', alias.alias_norm, 'user_profile_id', alias.user_profile_id) AS payload
FROM public.import_person_aliases alias
WHERE alias.organization_id = '${providerOrgId}'::uuid
  AND alias.source_profile = '${profile}'
  AND alias.active
UNION ALL
SELECT 'classification_rule',
       jsonb_build_object(
         'id', rule.id,
         'target_code_id', code.id,
         'target_code_type', code.code_type,
         'target_code', code.code,
         'target_external_refs', code.external_refs,
         'conditions', rule.conditions,
         'priority', rule.priority,
         'active', rule.active
       )
FROM public.import_value_classification_rules rule
JOIN public.reference_codes code ON code.id = rule.target_code_id
WHERE rule.organization_id = '${providerOrgId}'::uuid
  AND rule.source_profile = '${profile}'
  AND rule.active
  AND code.is_active
UNION ALL
SELECT 'charge_catalog',
       jsonb_build_object('id', code.id, 'code_type', code.code_type, 'code', code.code, 'external_refs', code.external_refs)
FROM public.reference_codes code
WHERE code.organization_id = '${providerOrgId}'::uuid
  AND code.code_type IN ('charge_source', 'charge_subject', 'charge_issue', 'charge_code')
  AND code.is_active
) records
ORDER BY record_type,
  coalesce((payload->>'priority')::integer, 0),
  coalesce(payload->>'alias_norm', payload->>'id', '');`;
  if (useSupabaseCli) return parseImportContextRows(runCliQuery(query));
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Import context lookup failed: ${text.slice(0, 1200)}`);
  const rows = JSON.parse(text);
  return parseImportContextRows(rows);
}

const { sourceProfile, personAliases, classificationRules, chargeCatalogRows } = await loadImportContext();
const chargeCatalog = buildChargeCatalog(chargeCatalogRows);
const actorId = sourceProfile.import_actor_id;
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(actorId ?? '')) throw new Error(`Source profile ${classificationProfile} has no valid import actor`);
const importConfigurationHash = createHash('sha256')
  .update(JSON.stringify({ sourceProfile, personAliases, classificationRules, sourceColumnAliases, ...(chargeCatalogRows.length ? { chargeCatalogRows } : {}) }))
  .digest('hex');

const sourceBytes = readFileSync(inputPath);
const raw = workbookInput ? null : sourceBytes.toString('utf8');
const table = workbookInput
  ? await readWorkbookSheet(sourceBytes, sheetName, headerRow)
  : parseCsv(raw).filter((r) => r.length > 1);
const derivativeInput = workbookInput ? JSON.stringify(table) : raw;
const derivativeHash = createHash('sha256').update(derivativeInput).digest('hex');
const effectiveSourceHash = sourceHash ?? createHash('sha256').update(sourceBytes).digest('hex');
const effectiveSourceLabel = sourceLabel ?? basename(inputPath);
// Header cells sometimes carry a leading BOM and/or extra/embedded whitespace (e.g. NCC's
// "24hr\nTime", Taylors' "Log  no" with a double space) - normalize both before matching.
const header = table[0].map((h) => h.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim());
const headerLower = header.map((h) => h.toLowerCase());
const schemaHeaders = [...header];
for (const [position, mapping] of Object.entries(sourceColumnAliases)) {
  const index = Number(position) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= header.length
    || mapping?.source_header !== header[index] || typeof mapping.alias !== 'string' || !mapping.alias.trim()
    || (mapping.require_empty !== true && mapping.preserve_source !== true)) {
    console.error('Source column aliases must identify an exact unused or source-only column');
    process.exit(1);
  }
  if (mapping.require_empty === true && table.slice(1).some(row => String(row[index] ?? '').trim())) {
    console.error(`Source column ${position} is no longer empty; mapping review is required`);
    process.exit(1);
  }
  schemaHeaders[index] = mapping.alias.trim();
}
if (Object.keys(sourceColumnAliases).length && new Set(schemaHeaders).size !== schemaHeaders.length) {
  console.error('Source column aliases do not resolve every duplicate header');
  process.exit(1);
}
const pick = (...candidates) => { for (const name of candidates) { const i = headerLower.indexOf(name.toLowerCase()); if (i !== -1) return i; } return -1; };
const mapped = (logicalField) => {
  const aliases = sourceProfile.column_mappings[logicalField] ?? [];
  if (!Array.isArray(aliases)) throw new Error(`Source profile ${classificationProfile} has invalid aliases for ${logicalField}`);
  return pick(...aliases);
};
const col = {
  job: mapped('job'), patroller: mapped('patroller'), date: mapped('date'), time: mapped('time'),
  reserve: mapped('reserve'), location: mapped('location'), comments: mapped('comments'), registration: mapped('registration'),
  jobTime: mapped('job_time'), jobKms: mapped('job_km'), workSource: mapped('source'), subject: mapped('subject'), issue: mapped('issue'), actionBy: mapped('action_by'),
  jobCost: mapped('job_cost'), travelCost: mapped('travel_cost'), totalCost: mapped('total_cost'),
  odometer: mapped('odometer'), actionNotes: mapped('action_notes'), lastActionDate: mapped('action_date'), closedBy: mapped('closed_by'),
};
for (const requiredField of ['job', 'patroller', 'date']) {
  if (col[requiredField] < 0) throw new Error(`Source profile ${classificationProfile} could not resolve required ${requiredField} header`);
}

const observationsBatch = [];
const eventsBatch = [];
const proposalsBatch = [];
const seenExternalRefs = new Set();
const unresolvedAliasValues = new Set();
const classificationCounts = { work_subject: {}, work_activity: {}, biosecurity_species: {}, equipment_type: {}, material_type: {} };
const chargeCodeCounts = {};
const costEvidenceTotals = { job_cost: 0, travel_cost: 0, total_cost: 0, rows: 0 };
let skipped = 0;
let skippedNoZone = 0;
let skippedDuplicate = 0;
let unresolvedAliasRows = 0;
let previousDated = null;
let startLegCorrections = 0;
let dayResetKmCorrections = 0;

for (const [rowIndex, r] of table.slice(1).entries()) {
  const job = (r[col.job] ?? '').trim();
  const patroller = (r[col.patroller] ?? '').trim();
  const occurredAt = parseNzDate(r[col.date], r[col.time]);
  if (!occurredAt) { skipped += 1; continue; } // header/blank/summary rows with no real date
  const day = NZ_DAY.format(new Date(occurredAt));
  const sourceKms = importedNumber(r[col.jobKms]);
  const odometer = importedNumber(r[col.odometer]);
  const minutes = elapsedMinutes(occurredAt, r[col.time]);
  const startRow = previousDated?.day === day && previousDated.start ? previousDated : null;
  const leg = startRowLeg({ kms: sourceKms, odometer, minutes, hours: importedNumber(r[col.jobTime]),
    jobCost: importedNumber(r[col.jobCost]), travelCost: importedNumber(r[col.travelCost]) }, startRow);
  if (leg) startLegCorrections += 1;
  const dayResetKms = !leg && sourceKms !== null && sourceKms < 0 && odometer !== null
    && previousDated && previousDated.day !== day ? odometer : null;
  if (dayResetKms !== null) dayResetKmCorrections += 1;
  const jobKms = leg ? leg.kms : dayResetKms !== null ? dayResetKms : sourceKms;
  const kmCorrection = sourceKms !== null && sourceKms < 0 && (leg || dayResetKms !== null)
    ? (leg ? 'formula_skipped_start_row' : 'trip_odometer_day_reset') : null;
  previousDated = { day, odometer, minutes, sourceRow: sourceFirstRow + rowIndex, start: (r[col.comments] ?? '').trim().toLowerCase() === 'start' };
  const locationText = (r[col.location] ?? '').trim();
  const reserveCode = col.reserve !== -1 ? (r[col.reserve] ?? '').trim() : '';
  // Reserve code (when the sheet has one) is the stable join key; free-text Location is the fallback
  // for rows where Reserve is blank, or for sheets that only ever had a single Location column.
  // A zone-map entry is normally a bare zone UUID string; some clients (e.g. Taylors) also have
  // commercial client_sites, not just residential/patrol zones - those entries are written as
  // { "site_id": "<uuid>" } instead, so a single map can resolve to either place type.
  const resolved = (reserveCode ? zoneMap[reserveCode] : null) ?? zoneMap[locationText] ?? null;
  const zoneId = typeof resolved === 'string' ? resolved : null;
  const siteId = resolved && typeof resolved === 'object' ? resolved.site_id ?? null : null;
  const comments = (r[col.comments] ?? '').trim();
  // Reg column sometimes holds several plates separated by commas/slashes/spaces
  // (e.g. "ACZ755, DAB364, DGY148") - split first, validate each token's shape,
  // rather than stripping separators and concatenating them into one string.
  const regTokens = (r[col.registration] ?? '').toUpperCase().split(/[,;/\s]+/).map((t) => t.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const regPlates = regTokens.filter((t) => PLATE_SHAPE_RE.test(t));
  const plates = regPlates.length ? regPlates : extractPlates(comments);
  const primaryPlate = plates[0] ?? null;
  const isCamera = /^camera$/i.test(patroller);
  const workClassification = classifyPatrolWork({ subject: r[col.subject], issue: r[col.issue], description: comments, source: col.workSource === -1 ? null : r[col.workSource] }, classificationRules);
  const chargeCode = composeChargeCode({ source: col.workSource === -1 ? null : r[col.workSource], subject: r[col.subject], issue: r[col.issue] }, chargeCatalog);
  const { material_type_detail_fields: materialDetailFields, ...workCodes } = workClassification;
  const materials = materialsUsed(workCodes.material_type_code, materialDetailFields, comments);
  // Some rows record TWO officers on a joint patrol, separated by a newline/comma in one cell
  // (e.g. "Colin Eathorne\nWade Sutherland-Berkett") - take the first name that resolves to a
  // known officer rather than requiring the whole raw cell to match a single known name exactly.
  const patrollerNames = patroller.split(/[\n,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const officerId = !isCamera ? patrollerNames.map((name) => personAliases[name]).find(Boolean) ?? null : null;
  if (!isCamera && patrollerNames.length > 0 && !officerId) {
    unresolvedAliasRows += 1;
    patrollerNames.forEach((name) => unresolvedAliasValues.add(name));
  }
  const externalRef = `rm_patrol_import:${clientCode}:${job || createHash('md5').update(occurredAt + locationText + comments).digest('hex').slice(0, 8)}`;
  if (seenExternalRefs.has(externalRef)) {
    skippedDuplicate += 1;
    continue;
  }
  seenExternalRefs.add(externalRef);
  const payload = {
    source: 'rm_patrol_log_import', client_code: clientCode, job_number: job || null,
    source_file: effectiveSourceLabel, source_sha256: effectiveSourceHash, derivative_sha256: derivativeHash,
    source_sheet: sourceSheet || null, source_row: sourceFirstRow + rowIndex,
    location_raw: locationText, reserve_raw: reserveCode || null,
    reg_raw: (r[col.registration] ?? '').trim() || null, plates_found: plates,
    job_time_hours: leg ? String(leg.hours) : r[col.jobTime] || null,
    job_kms: leg ? String(leg.kms) : dayResetKms !== null ? String(dayResetKms) : r[col.jobKms] || null,
    ...(kmCorrection ? {
      job_kms_source_value: (r[col.jobKms] ?? '').trim() || null,
      job_kms_correction: kmCorrection,
    } : {}),
    job_cost: leg ? leg.jobCost : importedNumber(r[col.jobCost]),
    travel_cost: leg ? leg.travelCost : importedNumber(r[col.travelCost]),
    total_cost: leg ? leg.totalCost : importedNumber(r[col.totalCost]),
    ...(leg ? { source_leg_correction: {
      rule: 'formula_skipped_start_row', start_source_row: startRow.sourceRow,
      job_time_hours: r[col.jobTime] || null, job_kms: r[col.jobKms] || null, job_cost: importedNumber(r[col.jobCost]),
      travel_cost: importedNumber(r[col.travelCost]), total_cost: importedNumber(r[col.totalCost]),
    } } : {}), source_category: (r[col.workSource] ?? '').trim() || null,
    classification_profile: classificationProfile,
    travel_odometer: (r[col.odometer] ?? '').trim() || null,
    distance_source: col.jobKms === -1 ? null : kmCorrection ?? 'source_job_km',
    distance_source_column: col.jobKms === -1 ? null : header[col.jobKms],
    odometer_source_column: col.odometer === -1 ? null : header[col.odometer],
    ...(includeNarratives ? {
      patroller_raw: patroller || null,
      comments: comments || null,
      subject: (r[col.subject] ?? '').trim() || null,
      issue: (r[col.issue] ?? '').trim() || null,
      action_by: (r[col.actionBy] ?? '').trim() || null,
      action_notes: (r[col.actionNotes] ?? '').trim() || null,
      last_action_date: (r[col.lastActionDate] ?? '').trim() || null,
      closed_by: (r[col.closedBy] ?? '').trim() || null,
      ...(Object.values(sourceColumnAliases).some(mapping => mapping.preserve_source === true) ? {
        source_only_columns: Object.fromEntries(Object.entries(sourceColumnAliases)
          .filter(([, mapping]) => mapping.preserve_source === true)
          .map(([position, mapping]) => [position, { source_header: mapping.source_header, alias: mapping.alias,
            value: r[Number(position) - 1] ?? '',
          }])),
      } : {}),
    } : {}),
    ...workCodes,
    ...chargeCode,
    ...(materials.length ? { materials_used: materials } : {}),
  };

  for (const type of Object.keys(classificationCounts)) {
    const code = workCodes[`${type}_code`];
    if (code) classificationCounts[type][code] = (classificationCounts[type][code] ?? 0) + 1;
  }
  if (chargeCode.charge_code_status) chargeCodeCounts[chargeCode.charge_code_status] = (chargeCodeCounts[chargeCode.charge_code_status] ?? 0) + 1;
  if ([payload.job_cost, payload.travel_cost, payload.total_cost].some((value) => typeof value === 'number')) {
    costEvidenceTotals.rows += 1;
    for (const field of ['job_cost', 'travel_cost', 'total_cost']) costEvidenceTotals[field] += Number(payload[field] ?? 0);
  }

  let evidenceRecordType = null;
  if (officerId && primaryPlate) {
    observationsBatch.push({ external_ref: externalRef, occurred_at: occurredAt, zone_id: zoneId, site_id: siteId, officer_id: officerId, plate: primaryPlate, officer_notes: includeNarratives ? comments || null : null, distance_km: jobKms, payload });
    evidenceRecordType = 'observations';
  } else if (zoneId || siteId) {
    eventsBatch.push({
      external_ref: externalRef, occurred_at: occurredAt, zone_id: zoneId, site_id: siteId,
      event_type: isCamera ? 'camera_activation' : (officerId ? 'patrol_visit' : 'patrol_log_unattributed'),
      observed_entity_type: officerId ? 'staff' : null, observed_entity_id: officerId,
      status: includeNarratives ? (r[col.issue] || '').trim() || null : null, distance_km: jobKms, payload,
    });
    evidenceRecordType = 'location_events';
  } else {
    // location_events requires client_site_id XOR zone_id (no placeless events) -
    // a row whose Location text doesn't resolve to a seeded zone or site has nowhere
    // valid to attach; skip rather than force/guess a place.
    skippedNoZone += 1;
  }
  if (includeNarratives) {
    proposalsBatch.push(...buildPatrolImportProposals({
      externalRef,
      evidenceRecordType: evidenceRecordType ?? 'source_row',
      providerOrganizationId: providerOrgId,
      clientOrganizationId: orgId,
      clientCode,
      occurredAt,
      zoneId,
      siteId,
      officerId,
      payload,
    }));
  }
}

if (!exportPlan) console.log(`Parsed ${table.length - 1} rows (${skipped} skipped: no date; ${skippedNoZone} skipped: no resolvable zone via Reserve/Location; ${skippedDuplicate} skipped: duplicate external reference): ${observationsBatch.length} -> observations, ${eventsBatch.length} -> location_events`);
const missingOptionalMappings = Object.entries(col).filter(([, index]) => index < 0).map(([field]) => field);
const proposalCounts = proposalsBatch.reduce((counts, proposal) => ({ ...counts, [proposal.target_type]: (counts[proposal.target_type] ?? 0) + 1 }), {});
const dryRunReceipt = {
  source_profile: classificationProfile,
  source_sha256: effectiveSourceHash,
  derivative_sha256: derivativeHash,
  parsed_rows: table.length - 1,
  evidence: { observations: observationsBatch.length, location_events: eventsBatch.length },
  classifications: classificationCounts,
  charge_codes: chargeCodeCounts,
  electronic_lock_rows: classificationCounts.work_subject.electronic_lock ?? 0,
  physical_lock_rows: classificationCounts.work_subject.physical_lock ?? 0,
  work_order_candidates: proposalsBatch.filter((proposal) => proposal.target_type === 'workshop_work_order').length,
  cost_evidence: costEvidenceTotals,
  proposals: proposalCounts,
  unresolved_alias_count: unresolvedAliasValues.size,
  unresolved_alias_rows: unresolvedAliasRows,
  unresolved_optional_mappings: missingOptionalMappings,
  include_narratives: includeNarratives,
  proposal_generation: includeNarratives ? 'enabled' : 'disabled_pending_explicit_narrative_review',
  direct_workshop_writes: 0,
  direct_finance_writes: 0,
};
if (!exportPlan) console.log(JSON.stringify(dryRunReceipt));

const resolvedMappings = Object.entries(sourceProfile.target_mappings).flatMap(([logicalField, target]) => {
  const sourceIndex = mapped(logicalField);
  if (sourceIndex < 0 || !target?.target_entity) return [];
  return [{
    logical_field: logicalField,
    source_column: schemaHeaders[sourceIndex],
    target_entity: target.target_entity,
    target_field: target.target_field ?? null,
  }];
});
const importIdempotencyKey = `${classificationProfile}:${clientCode}:${effectiveSourceHash}:${derivativeHash}:${sourceSheet ?? ''}:${importConfigurationHash}`;
const importManifest = {
  idempotency_key: importIdempotencyKey,
  source_profile: classificationProfile,
  import_configuration_sha256: importConfigurationHash,
  derivative_sha256: derivativeHash,
  target_client_organization_id: orgId,
  client_code: clientCode,
  source_sheet: sourceSheet ?? null,
  expected_proposal_count: proposalsBatch.length,
  include_narratives: includeNarratives,
  direct_workshop_writes: 0,
  direct_finance_writes: 0,
};
const importSchema = {
  headers: schemaHeaders,
  ...(Object.keys(sourceColumnAliases).length ? { original_headers: header, source_column_aliases: sourceColumnAliases } : {}),
  mappings: resolvedMappings.map((mapping) => ({
    source: mapping.source_column,
    target: `${mapping.target_entity}.${mapping.target_field ?? ''}`.replace(/[.]$/, ''),
    confidence: 'configured',
  })),
  resolved_mappings: resolvedMappings,
};
const batchDefinition = {
  provider_organization_id: providerOrgId,
  client_organization_id: orgId,
  batch_name: `${clientCode} field-evidence enrichment`,
  source_file: effectiveSourceLabel,
  source_sha256: effectiveSourceHash,
  parser: sourceProfile.parser,
  manifest: importManifest,
  schema: importSchema,
  row_count: table.length - 1,
  duplicate_count: skippedDuplicate,
  unresolved_count: skippedNoZone + unresolvedAliasRows,
};
if (exportPlan) {
  console.log(JSON.stringify({
    mode: 'plan',
    batch: batchDefinition,
    provider_organization_id: providerOrgId,
    source_file: effectiveSourceLabel,
    source_sha256: effectiveSourceHash,
    source_sheet: sourceSheet || null,
    manifest: importManifest,
    schema: importSchema,
    counts: { rows: table.length - 1, skipped, unresolved: skippedNoZone, duplicates: skippedDuplicate,
      ...(startLegCorrections ? { start_row_leg_corrections: startLegCorrections } : {}),
      ...(dayResetKmCorrections ? { day_reset_km_corrections: dayResetKmCorrections } : {}) },
    observations: observationsBatch,
    events: eventsBatch,
    proposals: proposalsBatch,
  }));
  process.exit(0);
}

async function managementQuery(query, operation) {
  if (useSupabaseCli) return runCliQuery(query);
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} failed: ${text.slice(0, 3000)}`);
  return JSON.parse(text);
}

async function ensureImportBatch() {
  const json = JSON.stringify(batchDefinition);
  if (json.includes('$batch$')) throw new Error('batch data must not contain the $batch$ delimiter');
  const result = await managementQuery(`BEGIN;
set local request.jwt.claim.sub = '${actorId}';
WITH input AS (SELECT $batch$${json}$batch$::jsonb AS data)
SELECT batch.id
FROM input
CROSS JOIN LATERAL public.begin_patrol_import_batch(
  p_provider_organization_id => (input.data->>'provider_organization_id')::uuid,
  p_client_organization_id => (input.data->>'client_organization_id')::uuid,
  p_batch_name => input.data->>'batch_name',
  p_source_file => input.data->>'source_file',
  p_source_sha256 => input.data->>'source_sha256',
  p_parser => input.data->>'parser',
  p_manifest_json => input.data->'manifest',
  p_schema_json => input.data->'schema',
  p_row_count => (input.data->>'row_count')::integer,
  p_duplicate_count => (input.data->>'duplicate_count')::integer,
  p_unresolved_count => (input.data->>'unresolved_count')::integer
) batch;
COMMIT;`, 'Import batch staging');
  if (!result[0]?.id) throw new Error('Import batch staging returned no batch id');
  return result[0].id;
}

async function finalizeImportBatch(batchId, receipt) {
  const json = JSON.stringify({ batch_id: batchId, receipt });
  if (json.includes('$receipt$')) throw new Error('receipt must not contain the $receipt$ delimiter');
  await managementQuery(`BEGIN;
set local request.jwt.claim.sub = '${actorId}';
WITH input AS (SELECT $receipt$${json}$receipt$::jsonb AS data)
SELECT batch.id
FROM input
CROSS JOIN LATERAL public.finalize_patrol_import_batch(
  (input.data->>'batch_id')::uuid,
  input.data->'receipt'
) batch;
COMMIT;`, 'Import batch finalization');
}

// Large logs (thousands of rows, verbose free-text comments) can produce a combined JSON
// payload the Management API rejects as "request entity too large" in one request - chunk
// both batches into fixed-size slices and run one transaction per chunk, summing results.
const CHUNK_SIZE = 300;
function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
const obsChunks = chunk(observationsBatch, CHUNK_SIZE);
const evtChunks = chunk(eventsBatch, CHUNK_SIZE);
const proposalChunks = chunk(proposalsBatch, CHUNK_SIZE);
const totalChunks = Math.max(obsChunks.length, evtChunks.length, proposalChunks.length, 1);

async function runChunk(obsSlice, evtSlice, proposalSlice, batchId) {
  const data = {
    org_id: orgId,
    provider_org_id: providerOrgId,
    client_code: clientCode,
    batch_id: batchId,
    batch: batchDefinition,
    observations: obsSlice,
    events: evtSlice,
    proposals: proposalSlice,
  };
  const json = JSON.stringify(data);
  if (json.includes('$json$')) throw new Error('data must not contain the $json$ delimiter');
  const rows = await managementQuery(`BEGIN;
set local request.jwt.claim.sub = '${actorId}';
WITH input AS (SELECT $json$${json}$json$::jsonb AS data),
batch AS (
  SELECT input.data,
    coalesce(
      nullif(input.data->>'batch_id', '')::uuid,
      (public.begin_patrol_import_batch(
        p_provider_organization_id => (input.data->'batch'->>'provider_organization_id')::uuid,
        p_client_organization_id => (input.data->'batch'->>'client_organization_id')::uuid,
        p_batch_name => input.data->'batch'->>'batch_name',
        p_source_file => input.data->'batch'->>'source_file',
        p_source_sha256 => input.data->'batch'->>'source_sha256',
        p_parser => input.data->'batch'->>'parser',
        p_manifest_json => input.data->'batch'->'manifest',
        p_schema_json => input.data->'batch'->'schema',
        p_row_count => (input.data->'batch'->>'row_count')::integer,
        p_duplicate_count => (input.data->'batch'->>'duplicate_count')::integer,
        p_unresolved_count => (input.data->'batch'->>'unresolved_count')::integer
      )).id
    ) AS id
  FROM input
)
SELECT staged.*
FROM batch
CROSS JOIN LATERAL public.stage_patrol_import_chunk(
  p_batch_id => batch.id,
  p_provider_organization_id => (batch.data->>'provider_org_id')::uuid,
  p_client_organization_id => (batch.data->>'org_id')::uuid,
  p_observations => batch.data->'observations',
  p_events => batch.data->'events',
  p_proposals => batch.data->'proposals'
) staged;
${mode === 'apply' ? 'COMMIT;' : 'ROLLBACK;'}`, 'Patrol import chunk');
  return rows[0];
}

const batchId = mode === 'apply' ? await ensureImportBatch() : null;
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
  const proposalSlice = proposalChunks[i] ?? [];
  if (!obsSlice.length && !evtSlice.length && !proposalSlice.length) continue;
  console.log(`chunk ${i + 1}/${totalChunks}: ${obsSlice.length} observations, ${evtSlice.length} events, ${proposalSlice.length} proposals`);
  const row = await runChunk(obsSlice, evtSlice, proposalSlice, batchId);
  for (const key of Object.keys(totals)) totals[key] += Number(row[key] ?? 0);
}
if (mode === 'apply') await finalizeImportBatch(batchId, { ...dryRunReceipt, ...totals });
console.log(`${mode}: ${clientCode} patrol log import`);
console.log(JSON.stringify(totals));
