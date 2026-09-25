#!/usr/bin/env node
/*
 * Configure R&M's accepted operational agreements for reviewed monthly reports.
 * This does not generate a report pack. The first approved period is September
 * 2026, generated only after that month closes.
 *
 *   FIELD_COMPLIANCE_CODESPACE=<sbp_ PAT> node scripts/configure-rm-monthly-reporting.mjs
 *   FIELD_COMPLIANCE_CODESPACE=<sbp_ PAT> node scripts/configure-rm-monthly-reporting.mjs --apply
 */

const PROJECT_REF = 'dotczcyyzgabmtmnglqj';
const PROVIDER_ID = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const PROVIDER_NAME = 'R & M Security and Investigation';
const ACTOR_EMAIL = 'don@ironeagle.co.nz';
const TEMPLATE_CODE = 'rm_monthly_accountability_v1';
const EXPECTED_AGREEMENTS = 17;
const FIRST_PERIOD_START = '2026-09-01';
const FIRST_PERIOD_END = '2026-09-30';
const GENERATE_NOT_BEFORE = '2026-10-01';

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';
const token = process.env.FIELD_COMPLIANCE_CODESPACE ?? process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error('FIELD_COMPLIANCE_CODESPACE or SUPABASE_ACCESS_TOKEN is required');
  process.exit(1);
}

const configuration = `
DO $configure$
DECLARE
  v_provider uuid;
  v_actor uuid;
  v_agreement_count integer;
  v_updated integer;
  v_pack_count_before integer;
  v_pack_count_after integer;
BEGIN
  SELECT id INTO STRICT v_provider
  FROM public.organizations
  WHERE id = '${PROVIDER_ID}'::uuid
    AND name = '${PROVIDER_NAME}'
    AND organization_type = 'service_provider'
    AND active;

  SELECT id INTO STRICT v_actor
  FROM public.user_profiles
  WHERE organization_id = v_provider
    AND email = '${ACTOR_EMAIL}'
    AND role IN ('grand_master', 'master', 'admin')
    AND deactivated_at IS NULL;

  IF NOT EXISTS (
    SELECT 1 FROM public.module_catalog
    WHERE module_key = 'client_reporting' AND active
  ) THEN
    RAISE EXCEPTION 'The canonical client_reporting module is not active';
  END IF;

  SELECT count(*) INTO v_agreement_count
  FROM public.service_agreements
  WHERE provider_organization_id = v_provider
    AND agreement_type = 'operational'
    AND invitation_status = 'accepted';

  IF v_agreement_count <> ${EXPECTED_AGREEMENTS} THEN
    RAISE EXCEPTION 'Expected ${EXPECTED_AGREEMENTS} accepted R&M operational agreements, found %', v_agreement_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.service_agreements
    WHERE provider_organization_id = v_provider
      AND agreement_type = 'operational'
      AND invitation_status = 'accepted'
      AND monthly_report_template_code IS NOT NULL
      AND monthly_report_template_code <> '${TEMPLATE_CODE}'
  ) THEN
    RAISE EXCEPTION 'An R&M agreement already uses a different monthly report template';
  END IF;

  SELECT count(*) INTO v_pack_count_before
  FROM public.monthly_report_packs
  WHERE organization_id = v_provider;

  INSERT INTO public.report_templates (
    organization_id, module_key, template_code, name, output_policy
  ) VALUES (
    v_provider,
    'client_reporting',
    '${TEMPLATE_CODE}',
    'R&M monthly accountability report',
    jsonb_build_object(
      'review_required', true,
      'delivery_preference', 'portal_if_client_login',
      'first_period_start', '${FIRST_PERIOD_START}',
      'first_period_end', '${FIRST_PERIOD_END}',
      'generate_not_before', '${GENERATE_NOT_BEFORE}',
      'configured_by', 'scripts/configure-rm-monthly-reporting.mjs'
    )
  )
  ON CONFLICT (organization_id, template_code)
  DO UPDATE SET
    module_key = EXCLUDED.module_key,
    name = EXCLUDED.name,
    output_policy = EXCLUDED.output_policy;

  UPDATE public.service_agreements
  SET client_portal_reports_enabled = true,
      monthly_report_template_code = '${TEMPLATE_CODE}'
  WHERE provider_organization_id = v_provider
    AND agreement_type = 'operational'
    AND invitation_status = 'accepted'
    AND (
      NOT client_portal_reports_enabled
      OR monthly_report_template_code IS DISTINCT FROM '${TEMPLATE_CODE}'
    );
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > ${EXPECTED_AGREEMENTS} THEN
    RAISE EXCEPTION 'Refusing unexpected agreement update count %', v_updated;
  END IF;

  IF v_updated > 0 THEN
    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_provider,
      v_actor,
      'rm_monthly_reporting_configured',
      'service_agreements',
      v_provider,
      jsonb_build_object(
        'agreement_count', v_agreement_count,
        'updated_count', v_updated,
        'template_code', '${TEMPLATE_CODE}',
        'delivery_preference', 'portal_if_client_login',
        'first_period_start', '${FIRST_PERIOD_START}',
        'first_period_end', '${FIRST_PERIOD_END}',
        'generate_not_before', '${GENERATE_NOT_BEFORE}',
        'report_packs_generated', false
      )
    );
  END IF;

  SELECT count(*) INTO v_pack_count_after
  FROM public.monthly_report_packs
  WHERE organization_id = v_provider;

  IF v_pack_count_after <> v_pack_count_before THEN
    RAISE EXCEPTION 'Configuration must not generate report packs';
  END IF;
END
$configure$;
`;

const summary = `
SELECT
  (SELECT count(*) FROM public.report_templates WHERE organization_id = '${PROVIDER_ID}'::uuid AND template_code = '${TEMPLATE_CODE}') AS templates,
  (SELECT count(*) FROM public.service_agreements WHERE provider_organization_id = '${PROVIDER_ID}'::uuid AND agreement_type = 'operational' AND invitation_status = 'accepted' AND monthly_report_template_code = '${TEMPLATE_CODE}') AS configured_agreements,
  (SELECT count(*) FROM public.monthly_report_packs WHERE organization_id = '${PROVIDER_ID}'::uuid) AS report_packs,
  (SELECT count(*) FROM public.audit_log WHERE organization_id = '${PROVIDER_ID}'::uuid AND action = 'rm_monthly_reporting_configured') AS audit_rows;
`;

const sql = `BEGIN;${configuration}${summary}${mode === 'apply' ? 'COMMIT;' : 'ROLLBACK;'}`;
const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await response.text();
if (!response.ok) {
  console.error(`${mode}: failed`, text.slice(0, 2000));
  process.exit(1);
}
const rows = JSON.parse(text);
console.log(`${mode}: ${TEMPLATE_CODE}`);
console.log(JSON.stringify(rows[0] ?? {}, null, 2));
