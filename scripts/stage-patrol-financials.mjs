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

const chunkSize = 400;
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
const payload = Buffer.from(JSON.stringify({ chunks, manifest, schema, summary }), 'utf8').toString('base64');
const batchName = `patrol-finance-${derivative.source_file}-${derivative.source_sheet}`;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sql = `
BEGIN;
CREATE TEMP TABLE _patrol_finance_result(receipt jsonb);
DO $import$
DECLARE
  v_data jsonb:=convert_from(decode(${quote(payload)},'base64'),'utf8')::jsonb;
  v_batch public.file_import_batches%rowtype;
  v_actor uuid;
  v_chunk jsonb;
  v_stage jsonb;
  v_final public.file_import_batches%rowtype;
BEGIN
  SELECT import_actor_id INTO v_actor FROM public.import_source_profiles
  WHERE organization_id=${quote(providerOrganizationId)}::uuid
    AND profile_code=${quote(classificationProfile)}
    AND active;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Active import profile with a configured actor is required'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
  v_batch:=public.begin_patrol_import_batch(
    ${quote(providerOrganizationId)}::uuid,
    ${quote(clientOrganizationId)}::uuid,
    ${quote(batchName)},
    ${quote(derivative.source_file)},
    ${quote(derivative.source_sha256)},
    'xlsx_cached_values',
    v_data->'manifest',
    v_data->'schema',
    ${derivative.rows.length},
    ${summary.duplicate_external_refs},
    ${summary.quarantined}
  );
  FOR v_chunk IN SELECT * FROM jsonb_array_elements(v_data->'chunks') LOOP
    v_stage:=public.stage_patrol_finance_cost_rows(
      v_batch.id,
      ${quote(providerOrganizationId)}::uuid,
      ${quote(clientOrganizationId)}::uuid,
      ${quote(serviceAgreementId)}::uuid,
      v_chunk
    );
  END LOOP;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=v_batch.id;
  v_final:=public.finalize_patrol_import_batch(
    v_batch.id,
    jsonb_build_object(
      'finance_source_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=v_batch.id),
      'eligible_finance_source_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=v_batch.id AND status='eligible'),
      'quarantined_finance_source_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=v_batch.id AND status='quarantined'),
      'proposal_candidates',(SELECT count(*) FROM public.file_import_row_proposals WHERE batch_id=v_batch.id),
      'eligible_total',(SELECT coalesce(round(sum(amount),2),0) FROM public.file_import_finance_cost_rows WHERE batch_id=v_batch.id AND status='eligible'),
      'direct_workshop_writes',0,
      'direct_finance_writes',0
    )
  );
  INSERT INTO _patrol_finance_result
  SELECT jsonb_build_object(
    'batch_id',v_final.id,
    'status',v_final.status,
    'source_file',v_final.source_file,
    'source_sheet',v_final.manifest_json->>'source_sheet',
    'mapping_reviews',(SELECT count(*) FROM public.file_import_mapping_reviews WHERE batch_id=v_final.id),
    'finance_source_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=v_final.id),
    'eligible_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=v_final.id AND status='eligible'),
    'quarantined_rows',(SELECT count(*) FROM public.file_import_finance_cost_rows WHERE batch_id=v_final.id AND status='quarantined'),
    'proposal_count',(SELECT count(*) FROM public.file_import_row_proposals WHERE batch_id=v_final.id),
    'eligible_total',(SELECT coalesce(round(sum(amount),2),0) FROM public.file_import_finance_cost_rows WHERE batch_id=v_final.id AND status='eligible')
  );
END
$import$;
SELECT receipt FROM _patrol_finance_result;
${apply ? 'COMMIT;' : 'ROLLBACK;'}
`;

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'fcm-patrol-finance-'));
const sqlFile = join(temporaryDirectory, 'stage.sql');
try {
  writeFileSync(sqlFile, sql, 'utf8');
  const cliPath = join(process.cwd(), 'node_modules', 'supabase', 'dist', 'supabase.js');
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
  const parsed = JSON.parse(output);
  const receipt = parsed.rows?.[0]?.receipt;
  if (!receipt) throw new Error('Supabase CLI returned no staging receipt');
  console.log(JSON.stringify({
    mode: apply ? 'staged_for_review' : 'rollback_preview',
    local: summary,
    server: receipt,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
