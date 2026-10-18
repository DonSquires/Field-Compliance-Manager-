#!/usr/bin/env node
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildPatrolFinanceRows,
  resolveProfileMappings,
} from './lib/patrol-finance-import.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const apply = args.includes('--apply');
const localOnly = args.includes('--local-only');
const projectRef = process.env.SUPABASE_PROJECT_REF;
const derivativePath = flag('--derivative');
const providerOrganizationId = flag('--provider-org-id');
const clientOrganizationId = flag('--client-org-id');
const clientCode = flag('--client-code');
const serviceAgreementId = flag('--agreement-id');
const classificationProfile = flag('--classification-profile');
const zoneMapPath = flag('--zone-map-file');

if (!derivativePath || !providerOrganizationId || !clientOrganizationId || !clientCode || !serviceAgreementId || !classificationProfile || !zoneMapPath) {
  console.error('Usage: --derivative <json> --provider-org-id <uuid> --client-org-id <uuid> --client-code <code> --agreement-id <uuid> --classification-profile <code> --zone-map-file <json> [--apply]');
  process.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!UUID.test(providerOrganizationId) || !UUID.test(clientOrganizationId) || !UUID.test(serviceAgreementId)) {
  console.error('--provider-org-id, --client-org-id, and --agreement-id must be UUIDs');
  process.exit(1);
}
if (!/^[a-z0-9_-]+$/.test(classificationProfile)) throw new Error('--classification-profile must contain only lowercase letters, numbers, underscores, or hyphens');

const derivative = JSON.parse(readFileSync(derivativePath, 'utf8'));
const zoneMap = JSON.parse(readFileSync(zoneMapPath, 'utf8'));
if (derivative.format !== 'fcm_patrol_workbook_derivative_v1') {
  throw new Error('Unsupported patrol derivative format');
}
if (!/^[a-f0-9]{64}$/.test(derivative.source_sha256) || !/^[a-f0-9]{64}$/.test(derivative.derivative_sha256)) {
  throw new Error('Derivative source hashes are invalid');
}
const canonicalBody = { ...derivative };
delete canonicalBody.derivative_sha256;
const calculatedDerivativeHash = createHash('sha256')
  .update(JSON.stringify(canonicalBody, Object.keys(canonicalBody).sort()))
  .digest('hex');
// The exporter hashes a recursively sorted compact payload. Rebuild that exact shape.
const recursivelySorted = (value) => Array.isArray(value)
  ? value.map(recursivelySorted)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, recursivelySorted(item)]))
    : value;
const exactDerivativeHash = createHash('sha256')
  .update(JSON.stringify(recursivelySorted(canonicalBody)))
  .digest('hex');
if (exactDerivativeHash !== derivative.derivative_sha256) {
  throw new Error(`Derivative hash mismatch (${calculatedDerivativeHash.slice(0, 12)} / ${exactDerivativeHash.slice(0, 12)})`);
}

const resolvedMappings = resolveProfileMappings(derivative.headers);
const { rows, summary } = buildPatrolFinanceRows({
  derivative,
  clientCode,
  providerOrganizationId,
  clientOrganizationId,
  serviceAgreementId,
  zoneMap,
});
if (rows.length === 0) throw new Error('The derivative contains no positive job or travel cost components');
if (localOnly) {
  console.log(JSON.stringify({ mode: 'local_preview', summary }, null, 2));
  process.exit(0);
}

const chunkSize = 150;
const chunks = [];
for (let index = 0; index < rows.length; index += chunkSize) chunks.push(rows.slice(index, index + chunkSize));
const idempotencyKey = [
  'rm_patrol_finance_v1',
  derivative.source_file,
  derivative.source_sheet,
  derivative.source_sha256,
  derivative.derivative_sha256,
  clientOrganizationId,
  serviceAgreementId,
].join(':');
const manifest = {
  source_profile: classificationProfile,
  derivative_sha256: derivative.derivative_sha256,
  source_sheet: derivative.source_sheet,
  target_client_organization_id: clientOrganizationId,
  service_agreement_id: serviceAgreementId,
  idempotency_key: idempotencyKey,
  expected_proposal_count: 0,
  local_preview: summary,
};
const schema = {
  headers: derivative.headers,
  resolved_mappings: resolvedMappings,
  source_format: derivative.format,
};
const batchName = `patrol-finance-${derivative.source_file}-${derivative.source_sheet}`;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const encodedBatch = Buffer.from(JSON.stringify({ manifest, schema }), 'utf8').toString('base64');
const actorSetup = `
DO $actor$
DECLARE v_actor uuid;
BEGIN
  SELECT import_actor_id INTO v_actor FROM public.import_source_profiles
  WHERE organization_id=${quote(providerOrganizationId)}::uuid
    AND profile_code=${quote(classificationProfile)}
    AND active;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Active import profile with a configured actor is required'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
END
$actor$;`;
const beginBatch = (batchPayload = encodedBatch) => `
public.begin_patrol_import_batch(
  ${quote(providerOrganizationId)}::uuid,
  ${quote(clientOrganizationId)}::uuid,
  ${quote(batchName)},
  ${quote(derivative.source_file)},
  ${quote(derivative.source_sha256)},
  'xlsx_cached_values',
  (convert_from(decode(${quote(batchPayload)},'base64'),'utf8')::jsonb)->'manifest',
  (convert_from(decode(${quote(batchPayload)},'base64'),'utf8')::jsonb)->'schema',
  ${derivative.rows.length},
  ${summary.duplicate_external_refs},
  ${summary.quarantined}
)`;

const cliPath = join(process.cwd(), 'node_modules', 'supabase', 'dist', 'supabase.js');
function runQuery(sql, operation) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'fcm-patrol-finance-'));
  const sqlFile = join(temporaryDirectory, 'stage.sql');
  try {
    writeFileSync(sqlFile, sql, 'utf8');
    const cliArguments = [
      cliPath,
      'db',
      'query',
      '--linked',
      '--output-format',
      'json',
      '--file',
      sqlFile,
    ];
    if (projectRef) cliArguments.splice(4, 0, '--project-ref', projectRef);
    const output = execFileSync(process.execPath, cliArguments, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(output).rows ?? [];
  } catch (error) {
    const detail = error?.stdout || error?.stderr || error?.message || String(error);
    throw new Error(`${operation} failed: ${String(detail).slice(0, 3000)}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function stageChunkSql(chunk, batchReference, commit) {
  const encodedChunk = Buffer.from(JSON.stringify(chunk), 'utf8').toString('base64');
  return `
BEGIN;
${actorSetup}
CREATE TEMP TABLE fcm_patrol_stage_receipt ON COMMIT DROP AS
WITH batch AS (SELECT ${batchReference} AS row),
staged AS (
  SELECT public.stage_patrol_finance_cost_rows(
    (batch.row).id,
    ${quote(providerOrganizationId)}::uuid,
    ${quote(clientOrganizationId)}::uuid,
    ${quote(serviceAgreementId)}::uuid,
    convert_from(decode(${quote(encodedChunk)},'base64'),'utf8')::jsonb
  ) AS result, (batch.row).id AS batch_id
  FROM batch
)
SELECT result,batch_id FROM staged;
SELECT jsonb_build_object(
  'stage',staged.result,
  'mapping_reviews',(SELECT count(*) FROM public.file_import_mapping_reviews WHERE batch_id=staged.batch_id),
  'aggregate_totals',(
    SELECT coalesce(jsonb_object_agg(summary.aggregate_key,summary.total),'{}'::jsonb)
    FROM (
      SELECT aggregate_key,round(sum(amount),2) AS total
      FROM public.file_import_finance_cost_rows
      WHERE batch_id=staged.batch_id AND status='eligible'
      GROUP BY aggregate_key
    ) summary
  ),
  'quarantine_reasons',(
    SELECT coalesce(jsonb_object_agg(summary.quarantine_reason,summary.total),'{}'::jsonb)
    FROM (
      SELECT quarantine_reason,count(*) AS total
      FROM public.file_import_finance_cost_rows
      WHERE batch_id=staged.batch_id AND status='quarantined'
      GROUP BY quarantine_reason
    ) summary
  )
) AS receipt
FROM fcm_patrol_stage_receipt staged;
${commit ? 'COMMIT;' : 'ROLLBACK;'}
`;
}

if (!apply) {
  const totals = { inserted: 0, existing: 0, eligible: 0, quarantined: 0, eligible_total: 0 };
  const aggregateTotals = new Map();
  const quarantineReasons = new Map();
  let mappingReviews = 0;
  for (const [index, chunk] of chunks.entries()) {
    const receipt = runQuery(stageChunkSql(chunk, beginBatch(), false), `Rollback preview chunk ${index + 1}/${chunks.length}`)[0]?.receipt;
    if (!receipt?.stage) throw new Error(`Rollback preview chunk ${index + 1}/${chunks.length} returned no receipt`);
    for (const key of ['inserted', 'existing', 'eligible', 'quarantined']) totals[key] += Number(receipt.stage[key] ?? 0);
    totals.eligible_total += Number(receipt.stage.eligible_total ?? 0);
    mappingReviews = Math.max(mappingReviews, Number(receipt.mapping_reviews ?? 0));
    for (const [key, value] of Object.entries(receipt.aggregate_totals ?? {})) {
      aggregateTotals.set(key, Number((Number(aggregateTotals.get(key) ?? 0) + Number(value)).toFixed(2)));
    }
    for (const [key, value] of Object.entries(receipt.quarantine_reasons ?? {})) {
      quarantineReasons.set(key, Number(quarantineReasons.get(key) ?? 0) + Number(value));
    }
  }
  console.log(JSON.stringify({
    mode: 'rollback_preview',
    local: summary,
    server: {
      status: 'rolled_back',
      chunks: chunks.length,
      mapping_reviews: mappingReviews,
      finance_source_rows: totals.inserted,
      existing_rows: totals.existing,
      eligible_rows: totals.eligible,
      quarantined_rows: totals.quarantined,
      proposal_count: aggregateTotals.size,
      eligible_total: Number(totals.eligible_total.toFixed(2)),
      aggregate_totals: Object.fromEntries(aggregateTotals),
      quarantine_reasons: Object.fromEntries(quarantineReasons),
    },
  }, null, 2));
  process.exit(0);
}

const batchRows = runQuery(`BEGIN;${actorSetup}SELECT (${beginBatch()}).id;COMMIT;`, 'Begin persistent finance review batch');
const batchId = batchRows[0]?.id;
if (!UUID.test(batchId ?? '')) throw new Error('Begin persistent finance review batch returned no batch id');
let lastStage = null;
for (const [index, chunk] of chunks.entries()) {
  try {
    lastStage = runQuery(
      stageChunkSql(chunk, `(SELECT * FROM public.file_import_batches WHERE id=${quote(batchId)}::uuid)`, true),
      `Persistent staging chunk ${index + 1}/${chunks.length} for batch ${batchId}`,
    )[0]?.receipt;
  } catch (error) {
    throw new Error(`${error.message}. Batch ${batchId} remains in staging and can be resumed safely.`);
  }
}
const finalized = runQuery(`
BEGIN;
${actorSetup}
WITH finalized AS (
  SELECT public.finalize_patrol_import_batch(
    ${quote(batchId)}::uuid,
    jsonb_build_object(
      'finance_source_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=${quote(batchId)}::uuid),
      'eligible_finance_source_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=${quote(batchId)}::uuid AND status='eligible'),
      'quarantined_finance_source_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=${quote(batchId)}::uuid AND status='quarantined'),
      'proposal_candidates',(SELECT count(*) FROM public.file_import_row_proposals WHERE batch_id=${quote(batchId)}::uuid),
      'eligible_total',(SELECT coalesce(round(sum(amount),2),0) FROM public.file_import_finance_cost_rows WHERE batch_id=${quote(batchId)}::uuid AND status='eligible'),
      'direct_workshop_writes',0,
      'direct_finance_writes',0
    )
  ) AS batch
)
SELECT jsonb_build_object(
  'batch_id',(finalized.batch).id,
  'status',(finalized.batch).status,
  'source_file',(finalized.batch).source_file,
  'source_sheet',(finalized.batch).manifest_json->>'source_sheet',
  'mapping_reviews',(SELECT count(*) FROM public.file_import_mapping_reviews WHERE batch_id=(finalized.batch).id),
  'finance_source_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=(finalized.batch).id),
  'eligible_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=(finalized.batch).id AND status='eligible'),
  'quarantined_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=(finalized.batch).id AND status='quarantined'),
  'proposal_count',(SELECT count(*) FROM public.file_import_row_proposals WHERE batch_id=(finalized.batch).id),
  'eligible_total',(SELECT coalesce(round(sum(amount),2),0) FROM public.file_import_finance_cost_rows WHERE batch_id=(finalized.batch).id AND status='eligible')
) AS receipt
FROM finalized;
COMMIT;
`, `Finalize persistent finance review batch ${batchId}`)[0]?.receipt;
if (!finalized) throw new Error(`Finalize persistent finance review batch ${batchId} returned no receipt`);
console.log(JSON.stringify({ mode: 'staged_for_review', local: summary, server: finalized }, null, 2));
