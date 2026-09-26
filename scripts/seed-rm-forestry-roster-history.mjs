#!/usr/bin/env node
/* Parse the converted, dedicated R&M forestry roster into date-specific assignments.
 * Only the selected beat columns are read. Unknown cell values are reported, not guessed.
 * ATLAS CALLS: apply_historical_roster_assignment_import
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
const args = process.argv.slice(2);
const valueAfter = (flag) => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; };
const configPath = valueAfter('--config');
const markdownPath = valueAfter('--markdown');
const mode = args.includes('--apply') ? 'apply' : 'dry-run';
if (!configPath || !markdownPath) throw new Error('--config <json> and --markdown <converted roster.md> are required');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const lines = readFileSync(markdownPath, 'utf8').split(/\r?\n/);
const normalize = (value) => String(value ?? '').replace(/Â/g, '').replace(/\s+/g, ' ').trim();
const splitRow = (line) => line.slice(1, -1).split('|').map(normalize);
const headerLine = lines.find((line) => line.startsWith('| Date |'));
if (!headerLine) throw new Error('Roster header was not found');
const headerIndex = lines.indexOf(headerLine);
const header = splitRow(headerLine);

const monthNumber = new Map(['january','february','march','april','may','june','july','august','september','october','november','december'].map((month, index) => [month, index + 1]));
const parseDate = (value) => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/.exec(value);
  if (!named) return null;
  const month = monthNumber.get(named[2].toLowerCase());
  return month ? `${named[3]}-${String(month).padStart(2, '0')}-${String(Number(named[1])).padStart(2, '0')}` : null;
};

const beatColumns = config.beat_columns.map((beat) => {
  const index = header.findIndex((cell) => cell.toLowerCase().includes(beat.contains.toLowerCase()));
  if (index < 0) throw new Error(`Roster beat column not found: ${beat.contains}`);
  return { ...beat, index, sourceName: header[index] };
});
const aliases = Object.entries(config.officer_aliases);
const assignments = new Map();
const unresolved = new Map();
const routeCountsByOfficer = new Map();
const today = new Date().toISOString().slice(0, 10);

for (let lineIndex = headerIndex + 2; lineIndex < lines.length; lineIndex += 1) {
  if (!lines[lineIndex].startsWith('|')) continue;
  const cells = splitRow(lines[lineIndex]);
  const specificDate = parseDate(cells[0]);
  if (!specificDate) continue;
  for (const beat of beatColumns) {
    const rawValue = cells[beat.index];
    if (!rawValue || /^nan$/i.test(rawValue)) continue;
    const tokens = rawValue.toLowerCase().replace(/\band\b/g, '/').split(/[\/&,+]/).map((token) => token.trim()).filter(Boolean);
    const resolved = new Set();
    const unknown = [];
    for (const token of tokens) {
      const match = aliases.find(([alias]) => token === alias);
      if (match) resolved.add(match[1]); else unknown.push(token);
    }
    if (unknown.length) {
      const digest = createHash('sha256').update(rawValue).digest('hex');
      unresolved.set(digest, (unresolved.get(digest) ?? 0) + 1);
    }
    if (specificDate > today) continue;
    for (const officerId of resolved) {
      const sourceKey = ['rm_forestry_roster', config.source_sha256, specificDate, beat.route_code, beat.shift, officerId].join(':');
      const existing = assignments.get(sourceKey) ?? {
        source_key: sourceKey, officer_id: officerId, route_code: beat.route_code,
        specific_date: specificDate, shift: beat.shift, start_time: null, end_time: null,
        source_sheet: config.source_sheet, source_rows: [], beat_names: [], time_precision: 'date_only'
      };
      existing.source_rows.push(lineIndex - headerIndex);
      if (!existing.beat_names.includes(beat.sourceName)) existing.beat_names.push(beat.sourceName);
      assignments.set(sourceKey, existing);
      const routeCounts = routeCountsByOfficer.get(officerId) ?? new Map();
      routeCounts.set(beat.route_code, (routeCounts.get(beat.route_code) ?? 0) + 1);
      routeCountsByOfficer.set(officerId, routeCounts);
    }
  }
}

const fieldRouteByOfficer = {};
for (const [officerId, routeCounts] of routeCountsByOfficer) {
  const ranked = [...routeCounts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) throw new Error(`No majority route for officer ${officerId}`);
  fieldRouteByOfficer[officerId] = ranked[0][0];
}
const unresolvedValues = [...unresolved].sort((left, right) => right[1] - left[1]).map(([valueHash, count]) => ({ value_hash: valueHash, count }));
if (args.includes('--parse-only')) {
  const countsBy = (field) => Object.fromEntries([...new Set([...assignments.values()].map((item) => item[field]))].sort().map((value) => [value, [...assignments.values()].filter((item) => item[field] === value).length]));
  console.log(JSON.stringify({
    parsed_assignments: assignments.size,
    assignments_by_route: countsBy('route_code'),
    assignments_by_shift: countsBy('shift'),
    first_date: [...assignments.values()].map((item) => item.specific_date).sort()[0] ?? null,
    last_date: [...assignments.values()].map((item) => item.specific_date).sort().at(-1) ?? null,
    field_route_officer_count: Object.keys(fieldRouteByOfficer).length,
    unresolved_cell_count: unresolvedValues.reduce((sum, item) => sum + item.count, 0),
    unresolved_value_hashes: unresolvedValues.length
  }, null, 2));
  process.exit(0);
}
if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE is required');

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sourceCodes = config.field_source_codes.map((code) => `${quote(code)}::text`).join(',');
const batchSize = 250;
const chunks = [];
for (let index = 0; index < assignments.size; index += batchSize) chunks.push([...assignments.values()].slice(index, index + batchSize));
const chunkRequestId = (index) => {
  const digest = createHash('sha256').update(`${config.client_request_id}:${index}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
const totals = { dedicated_assignments_received: assignments.size, dedicated_assignments_inserted: 0, dedicated_assignments_skipped: 0, field_assignments_inserted: 0, prior_slots_removed: 0, prior_route_places_removed: 0, unresolved_values: unresolvedValues, chunks: chunks.length };
for (let index = 0; index < chunks.length; index += 1) {
  const chunk = chunks[index];
  const isFinalChunk = index === chunks.length - 1;
  const chunkSourceCodes = isFinalChunk ? sourceCodes : '';
  const chunkRoutes = isFinalChunk ? JSON.stringify(fieldRouteByOfficer) : '{}';
  const query = `BEGIN;
SET LOCAL request.jwt.claim.sub = ${quote(config.actor_user_id)};
SELECT public.apply_historical_roster_assignment_import(
  ${quote(chunkRequestId(index))}::uuid,
  ${quote(config.organization_id)}::uuid,
  ${quote(config.client_organization_id)}::uuid,
  ${quote(config.source_file)},
  ${quote(config.source_sha256)},
  ${quote(JSON.stringify(chunk))}::jsonb,
  ${quote(JSON.stringify(unresolvedValues))}::jsonb,
  ARRAY[${chunkSourceCodes}]::text[],
  ${quote(chunkRoutes)}::jsonb,
  ${config.remove_prior_projection === true && index === 0 ? 'true' : 'false'}
) AS receipt;
${mode === 'apply' ? 'COMMIT;' : 'ROLLBACK;'}
`;
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`chunk ${index + 1}/${chunks.length}: ${response.status}: ${body.slice(0, 1600)}`);
  const receipt = JSON.parse(body)[0]?.receipt ?? {};
  for (const key of ['dedicated_assignments_inserted', 'dedicated_assignments_skipped']) totals[key] += Number(receipt[key] ?? 0);
  totals.field_assignments_inserted += Number(receipt.field_assignments_inserted ?? 0);
  if (index === 0) {
    totals.prior_slots_removed = Number(receipt.prior_slots_removed ?? 0);
    totals.prior_route_places_removed = Number(receipt.prior_route_places_removed ?? 0);
  }
}
console.log(`${mode}: R&M forestry roster history`);
console.log(JSON.stringify({ route_by_officer: fieldRouteByOfficer, receipt: totals }, null, 2));