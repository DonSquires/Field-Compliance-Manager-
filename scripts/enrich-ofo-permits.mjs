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
 *   --plan            read the workbook and report what would be sent (aggregates only).
 *   --apply           call the RPC per permit (rolled back unless --commit).
 *   --repair-holders  complete or separate permit holders the booking import recorded by
 *                     surname alone, using the full name the extract gives for each permit,
 *                     then bring in the extract's permits not yet on file (rolled back
 *                     unless --commit). Never guesses: a name must extend the recorded
 *                     name, and any step whose outcome differs from the plan is held.
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

async function linkedCli() {
  const { cliQuery: rawQuery } = await import('../services/document-source-worker/reconcile-plan.mjs');
  return (sql) => {
    try { return rawQuery(sql); } catch (error) {
      const text = String(error.stderr || '') + String(error.stdout || '') + String(error.message);
      if (process.env.PERMIT_IMPORT_ERROR_LOG) writeFileSync(outsideRepo(process.env.PERMIT_IMPORT_ERROR_LOG, 'error log'), text);
      throw new Error(redact(text.split('\n').find((line) => /ERROR|error:/i.test(line)) ?? 'query failed').slice(0, 300));
    }
  };
}

async function runApply({ plan, source, commit, report }) {
  const cliQuery = await linkedCli();
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

export const nameWords = (value) => String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// Mirrors public.normalize_person_name: "Mary-Jane Smith" and "Maryjane Smith" are the same name.
const nameKey = (value) => nameWords(value).join('');
/** Mirrors public.person_name_extends: the recorded name is the trailing part of a longer full name. */
export function nameExtends(recorded, full) {
  const r = nameWords(recorded);
  const f = nameWords(full);
  return r.length > 0 && r.length < f.length && r.every((word, index) => f[f.length - r.length + index] === word);
}
const emailOf = (value) => String(value ?? '').trim().toLowerCase() || null;
const byPermitNumber = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const preferredSpelling = (names) => {
  const counts = tally(names, (name) => name);
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))[0];
};

/** Predict what public.import_person_permit(..., p_create_holder => true) and its follow-up will do. */
function predictNewPermit(people, permit) {
  const email = emailOf(permit.contact_email);
  if (!nameKey(permit.holder_name)) return { expected: 'held_holder_not_resolved' };
  const using = email ? [...people.values()].filter((person) => person.permits.some((held) => held.email === email)) : [];
  const exact = using.filter((person) => nameKey(person.name) === nameKey(permit.holder_name));
  if (exact.length > 1) return { expected: 'held_holder_not_resolved' };
  if (exact.length === 1) return { expected: 'permit_email_and_name', person: exact[0] };
  const surname = using.filter((person) => nameExtends(person.name, permit.holder_name));
  if (surname.length > 1) return { expected: 'held_holder_not_resolved' };
  if (surname.length === 1) {
    const holder = surname[0];
    const sameEmail = holder.permits.filter((held) => held.email === email).length + 1;
    return { expected: 'permit_email_and_surname', person: holder,
      expected_follow_up: sameEmail === holder.permits.length + 1 ? 'name_completed' : 'split' };
  }
  if (nameWords(permit.holder_name).length < 2) return { expected: 'held_holder_not_resolved' };
  return { expected: 'created_holder' };
}

/**
 * Plan the owner-approved repair of permit holders recorded by surname alone.
 *
 * The booking import merged applicants by surname and email. The OFO extract names
 * the holder of each permit, so a record's permits are grouped by that full name:
 * a group whose name extends the recorded name is attributable. A permit missing
 * from the extract joins a group only when exactly one group shares its email.
 * When every permit is accounted for, the largest group keeps the record and its
 * name is completed in place (after the other groups move out); otherwise each
 * attributable group moves to a person of its own and the record stays as it is.
 * Permits in the extract but not on file then come in through the import, which
 * links them by email and name, by email and surname (then completes that name), or
 * creates the named holder. Every step carries its predicted outcome so the
 * database rolls back any step that would behave differently.
 */
export function planHolderRepair(holders, permits) {
  const workbook = new Map(permits.filter((permit) => permit.permit_number).map((permit) => [permit.permit_number, permit]));
  const records = new Map();
  for (const row of holders) {
    const record = records.get(row.canonical_person_id) ?? { id: row.canonical_person_id, name: row.display_name, permits: [] };
    record.permits.push({ number: row.permit_number, email: emailOf(row.contact_email) });
    records.set(row.canonical_person_id, record);
  }
  const categories = {};
  const bump = (key) => { categories[key] = (categories[key] ?? 0) + 1; };
  const attributions = [];
  for (const record of records.values()) {
    const evidence = record.permits.filter((permit) => nameKey(workbook.get(permit.number)?.holder_name));
    if (!evidence.length) { bump(nameWords(record.name).length < 2 ? 'no_evidence_surname_only' : 'no_evidence_full_name'); continue; }
    const groups = new Map();
    for (const permit of evidence) {
      const spelling = oneLine(workbook.get(permit.number).holder_name);
      const group = groups.get(nameKey(spelling)) ?? { key: nameKey(spelling), spellings: [], permits: [], emails: new Set() };
      group.spellings.push(spelling);
      group.permits.push(permit.number);
      if (permit.email) group.emails.add(permit.email);
      groups.set(group.key, group);
    }
    for (const group of groups.values()) {
      group.full_name = preferredSpelling(group.spellings);
      group.state = group.key === nameKey(record.name) ? 'already_named'
        : nameExtends(record.name, group.full_name) ? 'attributable' : 'name_does_not_extend';
    }
    const leftover = [];
    for (const permit of record.permits) {
      if (evidence.includes(permit)) continue;
      const using = [...groups.values()].filter((group) => permit.email && group.emails.has(permit.email));
      if (using.length === 1 && using[0].state === 'attributable') using[0].permits.push(permit.number);
      else leftover.push(permit.number);
    }
    for (const group of groups.values()) if (group.state !== 'attributable') leftover.push(...group.permits);
    const attributable = [...groups.values()].filter((group) => group.state === 'attributable');
    if (!attributable.length) {
      bump([...groups.values()].every((group) => group.state === 'already_named') ? 'already_named' : 'name_does_not_extend');
      continue;
    }
    for (const group of attributable) group.permits.sort(byPermitNumber);
    const keep = leftover.length ? null
      : [...attributable].sort((a, b) => b.permits.length - a.permits.length || byPermitNumber(a.permits[0], b.permits[0]))[0];
    for (const group of attributable.filter((candidate) => candidate !== keep)) {
      attributions.push({ canonical_person_id: record.id, full_name: group.full_name, permit_numbers: group.permits, expected: 'split' });
    }
    if (keep) attributions.push({ canonical_person_id: record.id, full_name: keep.full_name, permit_numbers: keep.permits, expected: 'name_completed' });
    bump(keep ? (attributable.length > 1 ? 'split_then_completed' : 'completed') : 'split_record_kept_surname');
  }

  // Replay the attributions on a copy of the snapshot to predict each new permit.
  const people = new Map([...records.values()].map((record) => [record.id, { name: record.name, permits: [...record.permits] }]));
  const split = (from, name, numbers) => {
    const moving = from.permits.filter((permit) => numbers.includes(permit.number));
    from.permits = from.permits.filter((permit) => !numbers.includes(permit.number));
    people.set(`planned:${people.size}`, { name, permits: moving });
  };
  for (const step of attributions) {
    const person = people.get(step.canonical_person_id);
    if (step.expected === 'split') split(person, step.full_name, step.permit_numbers);
    else person.name = step.full_name;
  }
  const onFile = new Set(holders.map((row) => row.permit_number));
  const newPermits = [];
  for (const permit of permits) {
    if (!permit.permit_number || onFile.has(permit.permit_number)) continue;
    const prediction = predictNewPermit(people, permit);
    newPermits.push({ permit, expected: prediction.expected, expected_follow_up: prediction.expected_follow_up ?? null });
    const held = { number: permit.permit_number, email: emailOf(permit.contact_email) };
    if (prediction.expected === 'created_holder') people.set(`planned:${people.size}`, { name: permit.holder_name, permits: [held] });
    else if (prediction.person) {
      prediction.person.permits.push(held);
      if (prediction.expected_follow_up === 'name_completed') prediction.person.name = permit.holder_name;
      else if (prediction.expected_follow_up === 'split') {
        split(prediction.person, permit.holder_name, prediction.person.permits.filter((p) => p.email === held.email).map((p) => p.number));
      }
    }
  }
  return {
    attributions,
    new_permits: newPermits,
    summary: {
      holders: records.size,
      categories,
      splits: attributions.filter((step) => step.expected === 'split').length,
      completions: attributions.filter((step) => step.expected === 'name_completed').length,
      permits_attributed: attributions.reduce((sum, step) => sum + step.permit_numbers.length, 0),
      new_permits: tally(newPermits, (step) => step.expected),
      new_permit_follow_ups: tally(newPermits.filter((step) => step.expected_follow_up), (step) => step.expected_follow_up),
    },
  };
}

const HELD_OUTCOME = `CASE WHEN SQLERRM LIKE 'Permit holder not resolved%' THEN 'held_holder_not_resolved'
             WHEN SQLERRM LIKE 'Permit holder name conflict%' THEN 'held_name_conflict'
             WHEN SQLERRM LIKE 'Permit holder is shared%' THEN 'held_shared_person'
             WHEN SQLERRM LIKE 'Permit holder conflict%' THEN 'held_holder_conflict'
             WHEN SQLERRM LIKE 'Permit client conflict%' THEN 'held_client_conflict'
             WHEN SQLERRM LIKE 'Unexpected repair outcome%' THEN 'held_unexpected_outcome' ELSE 'error' END`;

/** One savepoint per step; a step whose outcome differs from the plan is rolled back and held. */
export function holderRepairSql(repair, { sourceDocument, sourceSha256, sourceCheckedAt }) {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) throw new Error('A SHA-256 source hash is required');
  const source = `${literal(sourceDocument)}, '${sourceSha256}'`;
  return `CREATE TEMP TABLE IF NOT EXISTS holder_repair_results (step text, permit_number text, outcome text, match_basis text,
  expected text, follow_up text, permits_moved integer, error text);
DO $repair$
DECLARE
  v_step jsonb;
  v_result jsonb;
  v_follow jsonb;
BEGIN
  FOR v_step IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(repair.attributions), 'attributions')}) LOOP
    BEGIN
      v_result := public.attribute_permit_holder('${RM_ORGANIZATION_ID}'::uuid, (v_step->>'canonical_person_id')::uuid,
        v_step->>'full_name', ARRAY(SELECT jsonb_array_elements_text(v_step->'permit_numbers')), ${source}, false);
      IF v_result->>'outcome' NOT IN (v_step->>'expected', 'unchanged') THEN
        RAISE EXCEPTION 'Unexpected repair outcome: %', v_result->>'outcome';
      END IF;
      INSERT INTO holder_repair_results VALUES ('attribute', v_step->'permit_numbers'->>0, v_result->>'outcome', NULL,
        v_step->>'expected', NULL, (v_result->>'permits_moved')::integer, NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO holder_repair_results (step, permit_number, outcome, expected, error)
      VALUES ('attribute', v_step->'permit_numbers'->>0, ${HELD_OUTCOME}, v_step->>'expected', left(SQLERRM, 200));
    END;
  END LOOP;
  FOR v_step IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(repair.new_permits), 'new_permits')}) LOOP
    BEGIN
      v_follow := NULL;
      v_result := public.import_person_permit('${RM_ORGANIZATION_ID}'::uuid, '${OFO_ORGANIZATION_ID}'::uuid, v_step->'permit',
        ${source}, ${sourceCheckedAt ? `${literal(sourceCheckedAt)}::timestamptz` : 'NULL'}, NULL, true);
      IF v_result->>'match_basis' IS DISTINCT FROM v_step->>'expected' THEN
        RAISE EXCEPTION 'Unexpected repair outcome: %', v_result->>'match_basis';
      END IF;
      IF v_result->>'match_basis' = 'permit_email_and_surname' THEN
        v_follow := public.attribute_permit_holder('${RM_ORGANIZATION_ID}'::uuid, (v_result->>'canonical_person_id')::uuid,
          v_step->'permit'->>'holder_name', ARRAY[v_step->'permit'->>'permit_number'], ${source}, true);
        IF v_follow->>'outcome' IS DISTINCT FROM v_step->>'expected_follow_up' THEN
          RAISE EXCEPTION 'Unexpected repair outcome: %', v_follow->>'outcome';
        END IF;
      END IF;
      INSERT INTO holder_repair_results VALUES ('import', v_step->'permit'->>'permit_number', v_result->>'outcome',
        v_result->>'match_basis', v_step->>'expected', v_follow->>'outcome', (v_follow->>'permits_moved')::integer, NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO holder_repair_results (step, permit_number, outcome, expected, error)
      VALUES ('import', v_step->'permit'->>'permit_number', ${HELD_OUTCOME}, v_step->>'expected', left(SQLERRM, 200));
    END;
  END LOOP;
END
$repair$;`;
}

const HOLDER_SNAPSHOT = `SELECT permit.permit_number, permit.canonical_person_id::text AS canonical_person_id, person.display_name,
  lower(trim(permit.contact_email)) AS contact_email
FROM public.person_permits permit
JOIN public.canonical_people person ON person.id = permit.canonical_person_id
WHERE permit.organization_id = '${RM_ORGANIZATION_ID}' AND person.status = 'active' AND person.merged_into_id IS NULL
ORDER BY permit.permit_number`;
const HOLDER_AGGREGATES = `SELECT count(DISTINCT permit.canonical_person_id) AS holders,
  count(DISTINCT permit.canonical_person_id) FILTER (WHERE cardinality(array_remove(
    regexp_split_to_array(lower(coalesce(person.display_name, '')), '[^a-z0-9]+'), '')) < 2) AS surname_only_holders,
  count(*) AS permits
FROM public.person_permits permit
JOIN public.canonical_people person ON person.id = permit.canonical_person_id
WHERE permit.organization_id = '${RM_ORGANIZATION_ID}'`;

export function summariseHolderRepair(results, { mode, planned, before, after }) {
  const of = (step) => results.filter((row) => row.step === step);
  return {
    mode, planned, before, after,
    attributions: tally(of('attribute'), (row) => row.outcome),
    permits_moved: results.reduce((sum, row) => sum + (row.permits_moved ?? 0), 0),
    new_permits: tally(of('import'), (row) => (row.match_basis ? `${row.outcome}:${row.match_basis}` : row.outcome)),
    follow_ups: tally(of('import').filter((row) => row.follow_up), (row) => row.follow_up),
    unexpected: results.filter((row) => row.outcome === 'held_unexpected_outcome').length,
    errors: tally(results.filter((row) => row.outcome === 'error'), (row) => redact(row.error)),
  };
}

async function runHolderRepair({ plan, source, commit, report }) {
  const cliQuery = await linkedCli();
  const holders = cliQuery(`BEGIN READ ONLY;\n${HOLDER_SNAPSHOT};\nROLLBACK;`);
  const before = cliQuery(`BEGIN READ ONLY;\n${HOLDER_AGGREGATES};\nROLLBACK;`)[0];
  const repair = planHolderRepair(holders, plan.permits);
  const read = `SELECT jsonb_build_object('results', coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM holder_repair_results r), '[]'::jsonb),
  'after', (SELECT to_jsonb(a) FROM (${HOLDER_AGGREGATES}) a)) AS out;`;
  console.log(`checked plan: ${repair.attributions.length} attributions, ${repair.new_permits.length} new permits`);
  const { results, after } = cliQuery(`BEGIN;\n${CLAIMS}\n${holderRepairSql(repair, source)}\n${read}\n${commit ? 'COMMIT' : 'ROLLBACK'};`)[0].out;
  const summary = summariseHolderRepair(results, {
    mode: commit ? 'committed' : 'dry_run_rolled_back', planned: repair.summary, before, after,
  });
  if (report) writeFileSync(outsideRepo(report, 'repair report'), JSON.stringify({ summary, repair, results }, null, 2));
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
  if (process.argv.includes('--repair-holders')) {
    console.log(JSON.stringify(await runHolderRepair({ plan, source, commit: process.argv.includes('--commit'), report: argument('--report') }), null, 2));
    return;
  }
  throw new Error('Choose --plan, --apply or --repair-holders');
}

if (process.argv[1]?.endsWith('enrich-ofo-permits.mjs')) {
  main().catch((error) => { console.error(redact(error.message)); process.exit(1); });
}
