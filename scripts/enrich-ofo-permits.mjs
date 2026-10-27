#!/usr/bin/env node
/**
 * Enrich R&M's forest access permits from OneFortyOne's "Permit Extract OFO.xlsx".
 *
 * The booking-system CSV seeded permit numbers, holders, contact details and some
 * plates. The OFO extract adds what officers need in the field: permit dates,
 * forest areas, activities, hunting season, firearm/chainsaw/key answers,
 * conditions, the address on the application and every listed vehicle.
 *
 * Every row goes through the governed public.import_person_permit RPC: replay-safe
 * by permit number, fill-only (recorded values are never overwritten; differences
 * are counted), a permit's holder is never changed, and a permit not yet on file is
 * attached only to the single existing permit holder whose application email and
 * name both agree - otherwise it is held for a person to decide.
 *
 *   --plan   read the workbook and report what would be sent (aggregates only).
 *   --apply  call the RPC per permit (rolled back unless --commit).
 *
 * Plans and reports hold personal information and must live outside the repository.
 * Nothing is sent to an external service.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.RM_DOCUMENTS_ROOT || 'C:/Users/squir/R & M Security and Investigations/RemSec - Documents';
const SOURCE_RELATIVE = 'HABITAT - RAMS/Permit Extract OFO.xlsx';
const RM_ORGANIZATION_ID = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const OFO_ORGANIZATION_ID = 'c48c1aaf-236b-417c-bbce-938c151662d6';
const IMPORT_ACTOR_ID = 'f1c00000-0000-4000-8000-000000000001';

const PLATE_AHEAD = String.raw`[A-Z0-9]{2,7}\s*(?:\([^)]*\)\s*)?[A-Z][a-z]`;
const VEHICLE_SPLIT = new RegExp(`,(?=\\s*${PLATE_AHEAD})`);
const LEADING_PLATE = /^([A-Z0-9]{2,7})(?=\s*(?:\([^)]*\)\s*)?[A-Z][a-z])/;

const clean = (value) => {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  return text === '' ? null : text;
};
const oneLine = (value) => clean(value)?.replace(/\s+/g, ' ') ?? null;

/**
 * Applicants type each vehicle as plate, make, model and colour with no separator
 * ("ABC123Toyota Hilux, white"), several to a cell. A segment that does not start
 * with a plate followed by a capitalised make is reported, never guessed.
 */
export function parseOfoVehicles(text) {
  const source = oneLine(text);
  if (!source) return { vehicles: [], unparsed: 0 };
  const vehicles = [];
  let unparsed = 0;
  for (const segment of source.split(VEHICLE_SPLIT).map((part) => part.trim()).filter(Boolean)) {
    const plate = LEADING_PLATE.exec(segment)?.[1];
    if (!plate) { unparsed += 1; continue; }
    const rest = segment.slice(plate.length).trim().replace(/^\([^)]*\)\s*/, '');
    const comma = rest.indexOf(',');
    const description = (comma >= 0 ? rest.slice(0, comma) : rest).trim();
    const [make, ...model] = description.split(/\s+/).filter(Boolean);
    vehicles.push({
      plate,
      make: make ?? null,
      model: model.length ? model.join(' ') : null,
      colour: comma >= 0 ? clean(rest.slice(comma + 1)) : null,
    });
  }
  return { vehicles, unparsed };
}

const list = (value) => {
  const items = (oneLine(value) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : null;
};
const yesNo = (value, yes, no) => {
  const text = oneLine(value)?.toLowerCase();
  if (!text) return { value: null, unknown: false };
  if (yes.test(text)) return { value: true, unknown: false };
  if (no.test(text)) return { value: false, unknown: false };
  return { value: null, unknown: true };
};
// Excel stores the calendar date at midnight; ExcelJS returns it as that instant in UTC.
const isoDate = (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : null);
const phone = (value) => {
  if (typeof value === 'number') {
    const digits = String(value);
    // A NZ number typed into a numeric cell loses its leading zero (e.g. 211234567).
    return /^[2-9]\d{6,9}$/.test(digits) ? `0${digits}` : digits;
  }
  return oneLine(value);
};

/** Map one worksheet row (keyed by header) to the RPC's permit payload plus local issues. */
export function mapOfoRow(row) {
  const get = (header) => row[header.toLowerCase()];
  const issues = [];
  const permitNumber = oneLine(get('Permit Description'));
  if (!permitNumber || !/^\d{3,10}$/.test(permitNumber)) issues.push('permit_number_unreadable');
  const { vehicles, unparsed } = parseOfoVehicles(get('Vehicles'));
  if (unparsed) issues.push('vehicle_text_unparsed');
  const firearm = yesNo(get('Valid Firearm License'), /\byes\b/, /\bno\b/);
  if (firearm.unknown) issues.push('firearm_answer_unrecognised');
  const chainsaw = yesNo(get('Chainsaw Safety Equipment'), /^y(es)?$/, /^no?$/);
  if (chainsaw.unknown) issues.push('chainsaw_answer_unrecognised');
  const dateFrom = isoDate(get('Date From'));
  const dateTo = isoDate(get('Finishing'));
  if (dateFrom && dateTo && dateTo < dateFrom) issues.push('finishes_before_start');
  const address = ['Address 1', 'Address 2', 'Suburb', 'City', 'Postcode']
    .map((header) => oneLine(get(header))).filter(Boolean).join(', ');
  const permit = {
    permit_number: permitNumber,
    holder_name: oneLine(get('Permit holder')),
    contact_email: oneLine(get('Email'))?.toLowerCase() ?? null,
    contact_phone: phone(get('Phone Mobile')) ?? phone(get('Phone Home')),
    address_text: address || null,
    permit_type: oneLine(get('Permit Type')),
    applicant_type: oneLine(get('Applicant Type')),
    company_name: oneLine(get('Company Name')),
    forest_areas: list(get('Forest Areas')),
    activities: list(get('Forest Activities')),
    hunting_season: oneLine(get('Hunting Season')),
    date_from: dateFrom,
    date_to: dateTo,
    firearm_licence_valid: firearm.value,
    firearm_licence_number: oneLine(get('Valid Firearm Number')),
    chainsaw_safety_equipment: chainsaw.value,
    // OFO's own question: any recorded key/Lockvue arrangement means access was issued.
    keys_issued: oneLine(get('Keys Issued')) ? true : null,
    conditions: clean(get('Permit Conditions')),
    vehicles,
  };
  for (const key of Object.keys(permit)) if (permit[key] === null) delete permit[key];
  return { permit, issues, unparsed_vehicles: unparsed };
}

const cellValue = (cell) => {
  if (cell === null || cell === undefined || cell instanceof Date || typeof cell !== 'object') return cell ?? null;
  if ('result' in cell) return cell.result ?? null;
  if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text).join('');
  if ('text' in cell) return typeof cell.text === 'object' ? cellValue(cell.text) : cell.text;
  return null;
};

export async function readOfoWorkbook(file) {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets.find((candidate) => /active permits/i.test(candidate.name)) ?? workbook.worksheets[0];
  const values = [];
  sheet.eachRow({ includeEmpty: false }, (row) => values.push(row.values.slice(1).map(cellValue)));
  const [header = [], ...rows] = values;
  const keys = header.map((name) => (name == null ? null : String(name).trim().toLowerCase()));
  return {
    rows: rows.map((cells) => Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? null]).filter(([key]) => key))),
    modified: workbook.modified instanceof Date ? workbook.modified.toISOString() : null,
  };
}

const tally = (rows, pick) => rows.reduce((counts, row) => {
  for (const key of [pick(row)].flat()) counts[key ?? 'none'] = (counts[key ?? 'none'] ?? 0) + 1;
  return counts;
}, {});

export function buildPermitPlan(rows, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const mapped = rows.map(mapOfoRow);
  const seen = new Map();
  for (const row of mapped) seen.set(row.permit.permit_number, (seen.get(row.permit.permit_number) ?? 0) + 1);
  const permits = [];
  const held = [];
  for (const row of mapped) {
    const duplicate = seen.get(row.permit.permit_number) > 1;
    const blocking = row.issues.filter((issue) => issue === 'permit_number_unreadable' || issue === 'finishes_before_start');
    if (duplicate) blocking.push('permit_number_repeated_in_file');
    (blocking.length ? held : permits).push({ ...row, reasons: blocking });
  }
  const p = permits.map((row) => row.permit);
  return {
    summary: {
      rows: rows.length,
      permits: permits.length,
      held: held.length,
      held_reasons: tally(held, (row) => row.reasons),
      issues: tally(mapped.filter((row) => row.issues.length), (row) => row.issues),
      with_dates: p.filter((permit) => permit.date_from && permit.date_to).length,
      in_date_today: p.filter((permit) => permit.date_from <= today && permit.date_to >= today).length,
      with_vehicles: p.filter((permit) => permit.vehicles.length).length,
      vehicles: p.reduce((sum, permit) => sum + permit.vehicles.length, 0),
      vehicle_segments_unparsed: mapped.reduce((sum, row) => sum + row.unparsed_vehicles, 0),
      with_areas: p.filter((permit) => permit.forest_areas).length,
      with_activities: p.filter((permit) => permit.activities).length,
      with_address: p.filter((permit) => permit.address_text).length,
      with_conditions: p.filter((permit) => permit.conditions).length,
      firearm_licence_valid: tally(p, (permit) => String(permit.firearm_licence_valid ?? 'not_answered')),
      with_firearm_licence_number: p.filter((permit) => permit.firearm_licence_number).length,
      keys_issued: p.filter((permit) => permit.keys_issued).length,
    },
    permits: p,
    held: held.map((row) => ({ permit_number: row.permit.permit_number ?? null, reasons: row.reasons })),
  };
}

const dollarQuote = (json, tag) => {
  if (json.includes(`$${tag}$`)) throw new Error('Permit data must not contain its SQL delimiter');
  return `$${tag}$${json}$${tag}$::jsonb`;
};
const CLAIMS = `set local request.jwt.claim.sub = '${IMPORT_ACTOR_ID}';
set local request.jwt.claims = '{"sub":"${IMPORT_ACTOR_ID}","role":"authenticated"}';`;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** One savepoint per permit so a held or failed row never stops the rest. */
export function permitsSql(permits, { sourceDocument, sourceSha256, sourceCheckedAt }) {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) throw new Error('A SHA-256 source hash is required');
  return `CREATE TEMP TABLE IF NOT EXISTS permit_import_results (permit_number text, outcome text, match_basis text,
  fields_filled jsonb, fields_differing jsonb, holder_name_differs boolean, vehicles_linked integer, vehicles_created integer,
  vehicles_already_linked integer, vehicles_invalid integer, error text);
DO $permits$
DECLARE
  v_row jsonb;
  v_result jsonb;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(permits), 'permit_rows')}) LOOP
    BEGIN
      v_result := public.import_person_permit('${RM_ORGANIZATION_ID}'::uuid, '${OFO_ORGANIZATION_ID}'::uuid, v_row,
        ${literal(sourceDocument)}, '${sourceSha256}', ${sourceCheckedAt ? `${literal(sourceCheckedAt)}::timestamptz` : 'NULL'});
      INSERT INTO permit_import_results VALUES (v_row->>'permit_number', v_result->>'outcome', v_result->>'match_basis',
        v_result->'fields_filled', v_result->'fields_differing', (v_result->>'holder_name_differs')::boolean,
        (v_result->>'vehicles_linked')::integer, (v_result->>'vehicles_created')::integer,
        (v_result->>'vehicles_already_linked')::integer, (v_result->>'vehicles_invalid')::integer, NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO permit_import_results (permit_number, outcome, error) VALUES (v_row->>'permit_number',
        CASE WHEN SQLERRM LIKE 'Permit holder not resolved%' THEN 'held_holder_not_resolved'
             WHEN SQLERRM LIKE 'Permit holder conflict%' THEN 'held_holder_conflict'
             WHEN SQLERRM LIKE 'Permit client conflict%' THEN 'held_client_conflict' ELSE 'error' END,
        left(SQLERRM, 200));
    END;
  END LOOP;
END
$permits$;`;
}

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
// Database errors can quote input values; console summaries carry only their shape.
const redact = (message) => String(message ?? '').replace(/"[^"]*"/g, '"…"').replace(/\d{3,}/g, '#');

export function summariseResults(results, { mode, planned }) {
  const count = (pick) => tally(results, pick);
  return {
    mode, planned,
    outcomes: count((row) => row.outcome),
    match_basis: count((row) => row.match_basis),
    fields_filled: count((row) => row.fields_filled ?? []),
    fields_differing: count((row) => row.fields_differing ?? []),
    holder_name_differs: results.filter((row) => row.holder_name_differs).length,
    vehicles: ['vehicles_linked', 'vehicles_created', 'vehicles_already_linked', 'vehicles_invalid']
      .reduce((totals, key) => ({ ...totals, [key]: results.reduce((sum, row) => sum + (row[key] ?? 0), 0) }), {}),
    errors: tally(results.filter((row) => row.outcome === 'error'), (row) => redact(row.error)),
  };
}

async function runApply({ plan, source, commit, report }) {
  const { cliQuery: rawQuery } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const cliQuery = (sql) => {
    try { return rawQuery(sql); } catch (error) {
      const text = String(error.stderr || '') + String(error.stdout || '') + String(error.message);
      if (process.env.PERMIT_IMPORT_ERROR_LOG) writeFileSync(outsideRepo(process.env.PERMIT_IMPORT_ERROR_LOG, 'error log'), text);
      throw new Error(redact(text.split('\n').find((line) => /ERROR|error:/i.test(line)) ?? 'query failed').slice(0, 300));
    }
  };
  const read = `SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]') AS out FROM permit_import_results r;`;
  const results = [];
  for (const batch of chunk(plan.permits, 40)) {
    const sql = permitsSql(batch, source);
    results.push(...cliQuery(`BEGIN;\n${CLAIMS}\n${sql}\n${read}\n${commit ? 'COMMIT' : 'ROLLBACK'};`)[0].out);
    console.log(`${commit ? 'applied' : 'checked'} ${results.length}/${plan.permits.length}`);
  }
  const summary = summariseResults(results, { mode: commit ? 'committed' : 'dry_run_rolled_back', planned: plan.permits.length });
  if (report) writeFileSync(outsideRepo(report, 'apply report'), JSON.stringify({ summary, results, held_in_plan: plan.held }, null, 2));
  return summary;
}

const isWithinRepo = (file) => {
  const relative = path.relative(path.resolve('.'), path.resolve(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
function outsideRepo(file, label) {
  if (isWithinRepo(file)) throw new Error(`The ${label} holds personal information and must live outside the repository`);
  return file;
}
const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

async function main() {
  const file = argument('--source') ?? path.join(BASE, SOURCE_RELATIVE);
  const workbook = await readOfoWorkbook(file);
  const plan = buildPermitPlan(workbook.rows);
  const source = {
    sourceDocument: SOURCE_RELATIVE,
    sourceSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    sourceCheckedAt: workbook.modified,
  };
  if (process.argv.includes('--plan')) {
    if (argument('--output')) writeFileSync(outsideRepo(argument('--output'), 'plan'), JSON.stringify({ source, ...plan }, null, 2));
    console.log(JSON.stringify({ source: { ...source, sourceSha256: source.sourceSha256.slice(0, 16) }, ...plan.summary }, null, 2));
    return;
  }
  if (process.argv.includes('--apply')) {
    console.log(JSON.stringify(await runApply({ plan, source, commit: process.argv.includes('--commit'), report: argument('--report') }), null, 2));
    return;
  }
  throw new Error('Choose --plan or --apply');
}

if (process.argv[1]?.endsWith('enrich-ofo-permits.mjs')) {
  main().catch((error) => { console.error(redact(error.message)); process.exit(1); });
}
