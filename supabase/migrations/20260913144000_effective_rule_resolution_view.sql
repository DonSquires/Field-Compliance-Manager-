-- Read-only effective rule resolution summary. This is the multi-jurisdiction,
-- multi-organization equivalent of the legacy Freedom Camping setup: place-first,
-- jurisdiction-driven rule selection, then module/contract scope, without
-- mutating history.
CREATE OR REPLACE VIEW public.effective_rule_resolution_view
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
    mrs.report_template_code
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
    jrs.rules AS jurisdiction_rules
  FROM public.jurisdiction_rule_sets jrs
  ORDER BY jrs.organization_id, jrs.module_key, jrs.created_at DESC
)
SELECT
  om.organization_id,
  om.module_key,
  om.enabled,
  mepm.dominant_anchor_kind,
  mepm.total_event_count,
  mepm.unresolved_event_count,
  lmr.module_rule_set_id,
  lmr.module_rule_set_name,
  lmr.evidence_requirements,
  lmr.approval_policy,
  lmr.report_template_code,
  ljr.jurisdiction_rule_set_id,
  ljr.jurisdiction_rule_set_name,
  ljr.jurisdiction_name,
  ljr.jurisdiction_rules,
  CASE
    WHEN om.enabled = false THEN 'disabled'
    WHEN mepm.unresolved_event_count > 0 THEN 'needs_reconciliation'
    WHEN lmr.module_rule_set_id IS NULL THEN 'missing_module_rule_set'
    WHEN ljr.jurisdiction_rule_set_id IS NULL THEN 'missing_jurisdiction_rule_set'
    ELSE 'effective_rules_ready'
  END AS effective_policy_status
FROM public.organization_modules om
LEFT JOIN latest_module_rules lmr
  ON lmr.organization_id = om.organization_id AND lmr.module_key = om.module_key
LEFT JOIN latest_jurisdiction_rules ljr
  ON ljr.organization_id = om.organization_id AND ljr.module_key = om.module_key
LEFT JOIN public.module_event_place_matrix mepm
  ON mepm.organization_id = om.organization_id AND mepm.module_key = om.module_key
ORDER BY om.organization_id, om.module_key;

COMMENT ON VIEW public.effective_rule_resolution_view IS
  'Read-only effective rule resolution summary for multi-jurisdiction providers: geofence + module + jurisdiction + agreement context, without mutating historical events.';

REVOKE ALL ON public.effective_rule_resolution_view FROM anon;
GRANT SELECT ON public.effective_rule_resolution_view TO authenticated, service_role;
