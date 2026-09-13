-- Module place-policy summary: combines module enablement, module rules,
-- jurisdiction rules, and event place coverage in one read-only summary.
CREATE OR REPLACE VIEW public.module_place_policy_summary
WITH (security_invoker = true)
AS
WITH latest_module_rules AS (
  SELECT DISTINCT ON (mrs.organization_id, mrs.module_key)
    mrs.organization_id,
    mrs.module_key,
    mrs.id AS module_rule_set_id,
    mrs.name AS module_rule_set_name,
    mrs.evidence_requirements,
    mrs.approval_policy,
    mrs.report_template_code,
    mrs.created_at
  FROM public.module_rule_sets mrs
  ORDER BY mrs.organization_id, mrs.module_key, mrs.created_at DESC
),
latest_jurisdiction_rules AS (
  SELECT DISTINCT ON (jrs.organization_id, jrs.module_key)
    jrs.organization_id,
    jrs.module_key,
    jrs.id AS jurisdiction_rule_set_id,
    jrs.name AS jurisdiction_rule_set_name,
    jrs.jurisdiction_name,
    jrs.rules AS jurisdiction_rules,
    jrs.created_at
  FROM public.jurisdiction_rule_sets jrs
  ORDER BY jrs.organization_id, jrs.module_key, jrs.created_at DESC
)
SELECT
  om.organization_id,
  om.module_key,
  om.enabled,
  lmr.module_rule_set_id,
  lmr.module_rule_set_name,
  lmr.evidence_requirements,
  lmr.approval_policy,
  lmr.report_template_code,
  ljr.jurisdiction_rule_set_id,
  ljr.jurisdiction_rule_set_name,
  ljr.jurisdiction_name,
  ljr.jurisdiction_rules,
  mepm.dominant_anchor_kind,
  mepm.total_event_count,
  mepm.unresolved_event_count,
  mepm.checkpoint_event_count,
  mepm.site_event_count,
  mepm.zone_event_count,
  CASE
    WHEN om.enabled = false THEN 'disabled'
    WHEN mepm.unresolved_event_count > 0 THEN 'needs_reconciliation'
    WHEN mepm.dominant_anchor_kind IS NULL THEN 'no_place_coverage'
    ELSE 'ready'
  END AS policy_status
FROM public.organization_modules om
LEFT JOIN latest_module_rules lmr
  ON lmr.organization_id = om.organization_id AND lmr.module_key = om.module_key
LEFT JOIN latest_jurisdiction_rules ljr
  ON ljr.organization_id = om.organization_id AND ljr.module_key = om.module_key
LEFT JOIN public.module_event_place_matrix mepm
  ON mepm.organization_id = om.organization_id AND mepm.module_key = om.module_key
ORDER BY om.organization_id, om.module_key;

COMMENT ON VIEW public.module_place_policy_summary IS
  'Read-only module policy summary combining feature enablement, module rules, jurisdiction rules, and current place anchor coverage for reconciliation and geofence policy design.';

REVOKE ALL ON public.module_place_policy_summary FROM anon;
GRANT SELECT ON public.module_place_policy_summary TO authenticated, service_role;
