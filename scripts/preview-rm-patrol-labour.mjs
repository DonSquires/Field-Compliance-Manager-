#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHistoricalPatrolLabourReport, isCalendarDate } from './lib/historical-patrol-labour.mjs';

const PROVIDER = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function labourSnapshotSql(from, to) {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw new Error('A valid inclusive date window is required');
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout='90s';
WITH clients AS (
  SELECT DISTINCT client_organization_id AS id FROM public.service_agreements
  WHERE provider_organization_id='${PROVIDER}'::uuid
), raw AS (
  SELECT 'event'::text AS kind,e.id,e.organization_id AS client_id,
    CASE WHEN e.observed_entity_type='staff' THEN e.observed_entity_id END AS officer_id,
    e.occurred_at AS happened_at,e.external_ref,e.payload AS payload
  FROM public.location_events e JOIN clients c ON c.id=e.organization_id
  WHERE e.source='rm_patrol_log_import'
  UNION ALL
  SELECT 'observation',o.id,o.organization_id,o.officer_id,o.observed_at,
    o.external_refs->>'external_ref',o.external_refs->'import'
  FROM public.observations o JOIN clients c ON c.id=o.organization_id
  WHERE o.external_refs->'import'->>'source'='rm_patrol_log_import'
), scoped AS (
  SELECT raw.*,(happened_at AT TIME ZONE 'Pacific/Auckland')::date AS work_date
  FROM raw
), normalized AS (
  SELECT r.kind,r.id,r.client_id,r.officer_id,r.work_date::text,r.external_ref,
    to_char(r.happened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS happened_at,
    r.payload->>'patroller_raw' AS patroller_raw,
    r.payload->>'job_time_hours' AS hours,r.payload->>'job_number' AS job_number,
    coalesce(v.source_file,r.payload->>'source_file') AS source_file,
    coalesce(v.source_sha256,r.payload->>'source_sha256') AS source_sha256,
    coalesce(v.source_sheet,r.payload->>'source_sheet') AS source_sheet,
    coalesce(v.source_row::text,r.payload->>'source_row') AS source_row,
    v.id AS version_id,v.version_no,
    EXISTS(SELECT 1 FROM public.user_profiles p WHERE p.id=r.officer_id
      AND (p.organization_id='${PROVIDER}'::uuid OR p.employer_organization_id='${PROVIDER}'::uuid)) AS officer_in_provider,
    coalesce(r.payload->>'patroller_raw' ~* '\\mand\\M|[&+,/]',false) AS crew_review_required,
    coalesce(r.payload::text ~* 'engineer|manufactur',false) AS engineering_review_required,
    coalesce(r.payload::text ~* 'digger|excavat',false) AS equipment_review_required,
    CASE WHEN v.id IS NOT NULL THEN
      public.patrol_source_record_state(r.kind,r.id) IS DISTINCT FROM v.state_after
      ELSE split_part(r.external_ref,':',2) IN ('DART2025','DART2026') END AS source_review_required
  FROM scoped r
  LEFT JOIN public.patrol_import_record_versions v ON v.provider_organization_id='${PROVIDER}'::uuid
    AND v.client_organization_id=r.client_id AND v.record_kind=r.kind AND v.record_id=r.id AND v.is_current
  WHERE r.work_date BETWEEN '${from}'::date AND '${to}'::date
)
SELECT jsonb_build_object(
  'as_of',(now() AT TIME ZONE 'Pacific/Auckland')::date,
  'from','${from}','to','${to}','provider_organization_id','${PROVIDER}',
  'source_record_count',(SELECT count(*) FROM normalized),
  'records',coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY kind,id) FROM normalized n),'[]'::jsonb),
  'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'display_name',p.display_name) ORDER BY p.id)
    FROM public.user_profiles p JOIN public.staff_profiles s ON s.id=p.id
    WHERE (p.organization_id='${PROVIDER}'::uuid OR p.employer_organization_id='${PROVIDER}'::uuid)
      AND p.role IN ('officer','admin_officer','admin','master')
      AND p.display_name !~* 'automation|human test|relief officer'),'[]'::jsonb),
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'display_name',p.display_name) ORDER BY p.id)
    FROM public.user_profiles p
    WHERE (p.organization_id='${PROVIDER}'::uuid OR p.employer_organization_id='${PROVIDER}'::uuid)
      AND NOT EXISTS (SELECT 1 FROM public.staff_profiles s WHERE s.id=p.id)
      AND p.display_name !~* 'automation|human test'),'[]'::jsonb),
  'existing_labour_slots',(SELECT count(*) FROM public.roster_slots s
    WHERE s.organization_id='${PROVIDER}'::uuid AND s.external_refs->>'source'='rm_patrol_log_labour'),
  'outside_window',(SELECT jsonb_build_object(
    'before',count(*) FILTER(WHERE work_date<'${from}'::date),
    'after',count(*) FILTER(WHERE work_date>'${to}'::date),
    'future',count(*) FILTER(WHERE work_date>(now() AT TIME ZONE 'Pacific/Auckland')::date),
    'missing_date',count(*) FILTER(WHERE work_date IS NULL)) FROM scoped),
  'historical_assignments',(SELECT count(*) FROM public.roster_assignments a
    WHERE a.organization_id='${PROVIDER}'::uuid AND a.specific_date BETWEEN '${from}'::date AND '${to}'::date
    AND a.external_refs->>'source' IN ('rm_forestry_roster_history','rm_patrol_log_roster_evidence')),
  'patrol_pay_code_count',(SELECT count(*) FROM public.reference_codes c
    WHERE c.organization_id='${PROVIDER}'::uuid AND c.code_type='pay_item' AND c.code='FORESTRY-PATROL' AND c.is_active)
) AS snapshot;
ROLLBACK;`;
}

export function runLinkedSql(sql, prefix = 'fcm-labour-read-') {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    const sqlFile = path.join(temporaryDirectory, 'query.sql');
    writeFileSync(sqlFile, sql, { mode: 0o600 });
    const output = execFileSync(process.execPath, [
      path.join(root, 'node_modules', 'supabase', 'dist', 'supabase.js'),
      'db', 'query', '--linked', '--output-format', 'json', '--file', sqlFile,
    ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output);
  } finally {
    rmSync(temporaryDirectory, { recursive: true });
  }
}

/** Reads the live snapshot (read-only transaction) and plans it. */
export function loadLabourReport(from, to) {
  const result = runLinkedSql(labourSnapshotSql(from, to));
  const snapshot = (Array.isArray(result) ? result : result?.rows)?.[0]?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.records)
    || snapshot.records.length !== snapshot.source_record_count) {
    throw new Error('The linked read returned no complete snapshot');
  }
  const { records, staff, accounts, ...scope } = snapshot;
  return { ...buildHistoricalPatrolLabourReport({ records, staff, accounts, asOf: snapshot.as_of }), scope };
}

export function assertPrivateOutput(outputPath) {
  const relative = path.relative(realpathSync(root), realpathSync(path.dirname(outputPath)));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('The report contains staff/date/hour evidence: use an existing private directory outside the repository');
  }
}

export function main(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--from', '--to', '--output'].includes(key) || !args[index + 1] || values[key]) {
      throw new Error('Usage: --from YYYY-MM-DD --to YYYY-MM-DD --output <private file outside the repository>; read-only, no --apply');
    }
    values[key] = args[index + 1];
  }
  labourSnapshotSql(values['--from'], values['--to']);
  if (!values['--output']) throw new Error('--output is required for the private report');
  const outputPath = path.resolve(values['--output']);
  assertPrivateOutput(outputPath);
  const report = loadLabourReport(values['--from'], values['--to']);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ mode: 'read_only', ...report.summary, source_fingerprint: report.source_fingerprint,
    scope: report.scope, writes_requested: 0 }, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`Historical labour preview failed: ${error.message}`);
    process.exitCode = 1;
  }
}
