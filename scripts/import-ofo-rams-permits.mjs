// Seeds person_permits / person_permit_vehicles from the current RAMS booking export
// (HABITAT - RAMS/Bookings-rmsecurity/users (new list).csv). Follows the
// scripts/seed-forestry-sector-rm.mjs convention: dry-run reports counts and does not write;
// apply runs in one transaction per row batch and is idempotent on (organization_id, permit_number).
//
// Usage:
//   FIELD_COMPLIANCE_CODESPACE=<sbp_ PAT> node scripts/import-ofo-rams-permits.mjs --dry-run <path-to-csv>
//   FIELD_COMPLIANCE_CODESPACE=<sbp_ PAT> node scripts/import-ofo-rams-permits.mjs --apply <path-to-csv>
import fs from 'node:fs';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;

const mode = process.argv[2];
const csvPath = process.argv[3];
if (!['--dry-run', '--apply'].includes(mode) || !csvPath) {
  console.error('Usage: node scripts/import-ofo-rams-permits.mjs --dry-run|--apply <path-to-csv>');
  process.exit(1);
}
if (mode === '--apply' && !TOKEN) { console.error('FIELD_COMPLIANCE_CODESPACE is required for --apply'); process.exit(1); }

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 1200)}`);
  return text ? JSON.parse(text) : [];
}

const lit = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const litArr = (arr) => (!arr || arr.length === 0 ? 'null' : `array[${arr.map(lit).join(',')}]::text[]`);

// --- quote-aware CSV parsing (fields may contain commas inside double quotes) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const header = rows[0];
  return rows.slice(1).filter((r) => r.some((v) => v.trim() !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// "GBK600 : Toyota Landcruiser Prado,NQQ779 : Toyota Hilux (note)" -> multiple vehicles.
// A comma only starts a new vehicle when what follows looks like PLATE :  — otherwise it's
// part of the current vehicle's own description (e.g. "PBB943 : Toyota Hilux, silver").
function parseVehicles(raw) {
  if (!raw || !raw.trim()) return [];
  const parts = raw.split(/,(?=\s*[A-Za-z0-9]{2,8}\s*:)/);
  const out = [];
  for (const part of parts) {
    const m = part.trim().match(/^([A-Za-z0-9]{2,8})\s*(?:\(.*?\))?\s*:\s*(.+)$/);
    if (!m) continue;
    const plate = m[1].toUpperCase();
    const desc = m[2].trim();
    // "Toyota Hilux, white" or "Toyota Hilux (Taylors Contracting vehicle)" -> make/model/colour best-effort
    const descNoParen = desc.replace(/\([^)]*\)/g, '').trim();
    const [makeModel, colour] = descNoParen.split(',').map((s) => s?.trim()).filter(Boolean);
    const [make, ...modelParts] = (makeModel ?? '').split(' ');
    out.push({ plate, make: make || null, model: modelParts.join(' ') || null, colour: colour || null });
  }
  return out;
}

function parseNzDate(s) {
  const m = (s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const raw = fs.readFileSync(csvPath, 'utf8');
const rows = parseCsv(raw);
console.log(`parsed ${rows.length} data rows from ${csvPath}`);

const records = rows.map((r) => {
  const holderName = `${r['first name'] ?? ''} ${r['last name'] ?? ''}`.trim();
  const [permitNumberRaw, ...typeParts] = (r['username'] ?? '').split(':');
  const permitNumber = permitNumberRaw?.trim();
  const permitType = typeParts.join(':').trim() || null;
  const position = (r['position'] ?? '').toUpperCase();
  const firearmValid = position.includes('YES') ? true : position.includes('NO') ? false : null;
  const statusRaw = (r['status'] ?? '').toLowerCase();
  const status = ['active', 'expired', 'revoked', 'suspended'].includes(statusRaw) ? statusRaw : 'active';
  return {
    holderName,
    permitNumber,
    permitType,
    applicantType: r['groups'] || null,
    contactEmail: r['email'] || null,
    contactPhone: r['phone'] || null,
    firearmLicenceValid: firearmValid,
    status,
    complianceCheckedAt: parseNzDate(r['date created']),
    vehicles: parseVehicles(r['organization']),
  };
}).filter((rec) => rec.holderName && rec.permitNumber);

console.log(`${records.length} rows have a holder name and permit number (of ${rows.length})`);
const totalVehicles = records.reduce((n, r) => n + r.vehicles.length, 0);
console.log(`${totalVehicles} vehicle entries parsed across all permits`);
const unparsedVehicleRows = records.filter((r) => r.vehicles.length === 0 && rows.find((row) => row['username'] === `${r.permitNumber} : ${r.permitType}`)?.organization);
if (unparsedVehicleRows.length) {
  console.log(`WARNING: ${unparsedVehicleRows.length} rows had a non-empty vehicle column that parsed to zero vehicles — review these:`);
  for (const r of unparsedVehicleRows.slice(0, 10)) console.log(`  - permit ${r.permitNumber} (${r.holderName})`);
}

if (mode === '--dry-run') {
  console.log('\n--- sample (first 5) ---');
  console.log(JSON.stringify(records.slice(0, 5), null, 2));
  console.log('\nDry run only — no writes made. Re-run with --apply to import.');
  process.exit(0);
}

// --apply
const orgRows = await sql(`select id, name from public.organizations where name in ('R & M Security and Investigations', 'OneFortyOne New Zealand') or name ilike '%R & M Security%' or name ilike '%OneFortyOne%'`);
const rmOrg = orgRows.find((o) => /r\s*&\s*m security/i.test(o.name));
const ofoOrg = orgRows.find((o) => /onefortyone/i.test(o.name));
if (!rmOrg) throw new Error('Could not resolve R & M Security organization_id — check organizations table');
if (!ofoOrg) throw new Error('Could not resolve OneFortyOne organization_id — check organizations table');
console.log(`issuing org (R&M): ${rmOrg.id}\nclient org (OFO): ${ofoOrg.id}`);

let created = 0, skipped = 0, vehiclesLinked = 0;
for (const rec of records) {
  let permitId;
  const existing = await sql(`select id from public.person_permits where organization_id = ${lit(rmOrg.id)} and permit_number = ${lit(rec.permitNumber)}`);
  if (existing.length) {
    permitId = existing[0].id;
    skipped++;
  } else {
    const personRows = await sql(`select id from public.canonical_people where normalized_name = ${lit(rec.holderName.trim().toLowerCase())}`);
    let personId = personRows[0]?.id;
    if (!personId) {
      const inserted = await sql(`insert into public.canonical_people (canonical_key, display_name, normalized_name, review_state, status) values (${lit('person:import:' + rec.holderName.trim().toLowerCase().replace(/\s+/g, '-'))}, ${lit(rec.holderName)}, ${lit(rec.holderName.trim().toLowerCase())}, 'draft', 'active') returning id`);
      personId = inserted[0].id;
    }

    const permitRows = await sql(`
    insert into public.person_permits (
      organization_id, client_organization_id, canonical_person_id, permit_number, permit_type,
      applicant_type, contact_email, contact_phone, firearm_licence_valid, status,
      compliance_checked_at, compliance_source, source_document
    ) values (
      ${lit(rmOrg.id)}, ${lit(ofoOrg.id)}, ${lit(personId)}, ${lit(rec.permitNumber)}, ${lit(rec.permitType)},
      ${lit(rec.applicantType)}, ${lit(rec.contactEmail)}, ${lit(rec.contactPhone)}, ${rec.firearmLicenceValid === null ? 'null' : rec.firearmLicenceValid}, ${lit(rec.status)},
      ${rec.complianceCheckedAt ? lit(rec.complianceCheckedAt) : 'null'}, 'import', ${lit('HABITAT - RAMS/Bookings-rmsecurity/users (new list).csv')}
    ) returning id`);
    permitId = permitRows[0].id;
    created++;
  }

  // Vehicle linking always runs, even for an already-existing permit, so a partial
  // run that failed mid-vehicle-loop can be safely re-applied to completion.
  for (const v of rec.vehicles) {
    const vehRows = await sql(`select id from public.canonical_vehicles where plate_number = ${lit(v.plate)}`);
    let vehicleId = vehRows[0]?.id;
    if (!vehicleId) {
      const insertedV = await sql(`insert into public.canonical_vehicles (plate_number, make, model, colour, compliance_source, compliance_checked_at) values (${lit(v.plate)}, ${lit(v.make)}, ${lit(v.model)}, ${lit(v.colour)}, 'canonical', ${rec.complianceCheckedAt ? lit(rec.complianceCheckedAt) : 'now()'}) returning id`);
      vehicleId = insertedV[0].id;
    }
    await sql(`insert into public.person_permit_vehicles (organization_id, permit_id, canonical_vehicle_id) values (${lit(rmOrg.id)}, ${lit(permitId)}, ${lit(vehicleId)}) on conflict (permit_id, canonical_vehicle_id) do nothing`);
    vehiclesLinked++;
  }
}

await sql(`insert into public.audit_log (organization_id, action, target_table, metadata) values (${lit(rmOrg.id)}, 'import_ofo_rams_permits', 'person_permits', ${lit(JSON.stringify({ source: 'HABITAT - RAMS/Bookings-rmsecurity/users (new list).csv', created, skipped, vehiclesLinked }))}::jsonb)`);
console.log(`\ncreated ${created} permits, skipped ${skipped} (already imported), linked ${vehiclesLinked} vehicle associations`);
