/*
 * Imports legacy Nelson noise calls as pending dispatch work. Each resolved
 * location is created by create_dispatch_intake_job, never inserted directly.
 *
 * Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN
 *
 * SUPABASE_ACCESS_TOKEN is a short-lived, explicitly supplied Supabase
 * management token for this one-off seed operation. It is never a browser,
 * Edge Function, or user-login credential.
 */
const { createHash } = require('node:crypto');

const PROJECT_ID = 'dotczcyyzgabmtmnglqj';
const PROVIDER_ID = '0a44987e-3556-469a-8274-7f5af1594f5c';
const AGREEMENT_ID = 'c7e29b21-baff-484e-97f8-eb4438332b4e';
const ACTOR_ID = '5ff766bf-8e08-4cd8-8db1-3fca176f81d7';
const LEGACY_FILE = '3d1cb623-c56d-48c9-8a83-b8e7c776685f.csv';

function csvRows(text) {
  const rows = [];
  let cell = '', row = [], quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && text[index + 1] === '"' && quoted) { cell += char; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map((valuesRow) => Object.fromEntries(headers.map((header, index) => [header, valuesRow[index] ?? ''])));
}

function requestId(value) {
  const hash = createHash('md5').update(`legacy-noise:${value}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

function sourceAddress(comments) {
  const text = comments.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const street = String.raw`\d+[A-Za-z]?(?:\s*\/\s*\d+[A-Za-z]?)?\s+[A-Za-z0-9.' -]{2,45}?\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Crescent|Cres|Place|Pl|Heights|Hts|Way|Lane|Ln|Terrace|Tce|Highway|Hwy)\b`;
  const targeted = new RegExp(`IN\\s+REGARDS?\\s+TO\\s+(${street})`, 'i').exec(text)?.[1]
    ?? new RegExp(`NOISE\\s+(?:COMING\\s+)?FROM\\s+(${street})`, 'i').exec(text)?.[1]
    ?? new RegExp(`FROM\\s+(${street})`, 'i').exec(text)?.[1];
  const fallback = new RegExp(`(${street})`, 'i').exec(text)?.[1];
  const address = (targeted ?? fallback)?.replace(/\s*\/\s*/g, '/').trim();
  return address ? `${address}, Nelson, New Zealand` : null;
}

async function resolveAddress(query) {
  const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/linz-lookup`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'address_autocomplete', q: query, max: 1 }),
  });
  if (!response.ok) throw new Error(`LINZ lookup failed: ${await response.text()}`);
  return (await response.json()).candidates?.[0] ?? null;
}

function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }

async function createDispatch(row, source, location) {
  const request = requestId(row['Despatch No.'] || row['Alarm Docket No.']);
  const summary = `${row['Despatch Comments'] || ''}`.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const followUp = `${row['Follow-up Info.'] || ''}`.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const briefing = `[Legacy Noise Control import | dispatch ${row['Despatch No.'] || 'unknown'} | ${row['Alarm Response Date/Time'] || 'date unavailable'}] ${summary}${followUp ? `\nPrevious attendance: ${followUp}` : ''}`;
  const query = `begin;
set local request.jwt.claim.sub = '${ACTOR_ID}';
select * from public.create_dispatch_intake_job(
  '${PROVIDER_ID}', '${AGREEMENT_ID}', '${request}', 'noise_control', 'high', 15,
  ${sqlString(location.label)}, ${sqlString(location.label)}, ${Number(location.lat)}, ${Number(location.lng)},
  null, ${sqlString(briefing)}, null
);
commit;`;
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function score(value, label) {
  return Number(new RegExp(`${label}\\s*(\\d+)`, 'i').exec(value)?.[1] ?? 0);
}

function historicalAssessmentTime(row) {
  const date = /\d{2}\/\d{2}\/\d{4}/.exec(row['Alarm Response Date/Time'] || '')?.[0];
  const time = /^\d{2}:\d{2}/.exec(row['On-site Date/Time'] || '')?.[0]
    ?? /\d{2}:\d{2}$/.exec(row['Alarm Response Date/Time'] || '')?.[0];
  return date && time ? `to_timestamp('${date} ${time}', 'DD/MM/YYYY HH24:MI') AT TIME ZONE 'Pacific/Auckland'` : 'now()';
}

async function createHistoricalAssessment(row, location, siteId) {
  const followUp = `${row['Follow-up Info.'] || ''}`.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const comments = `${row['Despatch Comments'] || ''}`.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const volume = Math.min(4, score(followUp, '(?:SOUND|VOLUME)'));
  const tone = Math.min(2, Number(/TONE\s*(\d+)/i.exec(followUp)?.[1] ?? 0));
  const time = Math.min(4, Math.max(1, Number(/TIME\s*(\d+)/i.exec(followUp)?.[1] ?? 1)));
  const action = /(?:END\s+(?:ISSUED|#?\d+)|EXCESSIVE NOISE DIRECTION)/i.test(`${comments} ${followUp}`) ? 'direction_notice' : /(?:WARNED|VERBAL WARNING)/i.test(followUp) ? 'verbal_warning' : 'no_action';
  const endNumber = /END\s*#?\s*(\d+)/i.exec(`${comments} ${followUp}`)?.[1] ?? null;
  const request = requestId(`assessment:${row['Despatch No.'] || row['Alarm Docket No.']}`);
  const externalRefs = JSON.stringify({ legacy_dispatch_no: row['Despatch No.'] || null, legacy_docket_no: row['Alarm Docket No.'] || null });
  const query = `insert into public.noise_assessments(
    organization_id, officer_user_id, officer_id, officer_name, client_request_id, site_id, source,
    noise_source, noise_source_address, assessment_location, action_taken, action,
    scene_description, assessed_at, volume_score, time_score, tone_score, matrix_total,
    end_number, follow_up_required, status, review_status, hs_checklist_completed,
    assessment_gps_lat, assessment_gps_lng, noise_source_gps_lat, noise_source_gps_lng, external_refs
  ) select
    '${PROVIDER_ID}', '${ACTOR_ID}', '${ACTOR_ID}', 'Legacy contract officer', '${request}', '${siteId}', 'legacy_import',
    'Noise complaint', ${sqlString(location.label)}, ${sqlString(location.label)}, '${action}', '${action}',
    ${sqlString(followUp || comments)}, ${historicalAssessmentTime(row)}, ${volume}, ${time}, ${tone}, ${volume + time + tone},
    ${endNumber ? sqlString(endNumber) : 'null'}, ${action !== 'no_action'}, 'completed', 'closed', true,
    ${Number(location.lat)}, ${Number(location.lng)}, ${Number(location.lat)}, ${Number(location.lng)}, ${sqlString(externalRefs)}::jsonb
  where not exists (select 1 from public.noise_assessments where organization_id = '${PROVIDER_ID}' and client_request_id = '${request}');`;
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function main() {
  for (const variable of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN']) {
    if (!process.env[variable]) throw new Error(`${variable} is required`);
  }
  const csvResponse = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/Logo/${LEGACY_FILE}`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!csvResponse.ok) throw new Error(`Unable to fetch legacy CSV: ${await csvResponse.text()}`);

  const rows = csvRows(await csvResponse.text()).filter((row) => row['Bureau ID'] && !row['Bureau ID'].startsWith('Despatch Zone'));
  let created = 0, existing = 0, assessments = 0, skipped = 0;
  for (const row of rows) {
    const source = sourceAddress(`${row['Despatch Comments'] || ''} ${row['Follow-up Info.'] || ''}`);
    if (!source) { skipped += 1; console.warn(`Skipped ${row['Despatch No.']}: no source address`); continue; }
    try {
      const location = await resolveAddress(source);
      if (!location) { skipped += 1; console.warn(`Skipped ${row['Despatch No.']}: unresolved ${source}`); continue; }
      const result = await createDispatch(row, source, location);
      if (result[0]?.created) created += 1; else existing += 1;
      await createHistoricalAssessment(row, location, result[0]?.client_site_id);
      assessments += 1;
      console.log(`${result[0]?.created ? 'Created' : 'Existing'} ${row['Despatch No.']} -> ${location.label}`);
    } catch (error) {
      skipped += 1;
      console.warn(`Skipped ${row['Despatch No.']}: ${error.message}`);
    }
  }
  console.log(JSON.stringify({ processed: rows.length, created, existing, assessments, skipped }));
}

main().catch((error) => { console.error(error); process.exit(1); });