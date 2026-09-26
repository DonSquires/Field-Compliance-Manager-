#!/usr/bin/env node
/*
 * Projects already-imported patrol events into completed roster history.
 * The source workbook is never opened: the governed database function reads
 * provenance-bearing location_events/observations and reports unresolved rows.
 *
 *   FIELD_COMPLIANCE_CODESPACE=<management-token> node scripts/seed-historical-patrol-roster.mjs \
 *     --config scripts/data/patrol-roster-projections/rm-ofo-forestry.json [--apply]
 */
import { readFileSync } from 'node:fs';

// ATLAS CALLS: project_historical_patrol_roster

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};
const mode = args.includes('--apply') ? 'apply' : 'dry-run';
const configPath = valueAfter('--config');

if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE is required');
if (!configPath) throw new Error('--config <projection.json> is required');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
for (const field of ['client_request_id', 'provider_organization_id', 'client_organization_id', 'actor_user_id']) {
  if (!UUID.test(config[field] ?? '')) throw new Error(`${field} must be a UUID`);
}
if (!Array.isArray(config.source_codes) || config.source_codes.length === 0) throw new Error('source_codes must not be empty');
if (!Array.isArray(config.routes) || config.routes.length === 0) throw new Error('routes must not be empty');

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sourceCodes = config.source_codes.map((code) => `${quote(code)}::text`).join(',');
const routes = quote(JSON.stringify(config.routes));
const query = `
BEGIN;
SET LOCAL request.jwt.claim.sub = ${quote(config.actor_user_id)};
SELECT public.project_historical_patrol_roster(
  ${quote(config.client_request_id)}::uuid,
  ${quote(config.provider_organization_id)}::uuid,
  ${quote(config.client_organization_id)}::uuid,
  ARRAY[${sourceCodes}],
  ${routes}::jsonb,
  ${config.link_missing_agreement_locations === true ? 'true' : 'false'}
) AS receipt;
${mode === 'apply' ? 'COMMIT;' : 'ROLLBACK;'}
`;

const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});
const body = await response.text();
if (!response.ok) throw new Error(`${response.status}: ${body.slice(0, 1200)}`);
const rows = body ? JSON.parse(body) : [];
console.log(`${mode}: historical patrol roster projection`);
console.log(JSON.stringify(rows[0]?.receipt ?? rows[0] ?? {}, null, 2));