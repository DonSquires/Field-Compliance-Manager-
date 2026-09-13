-- Governing app-facing contract: each UI module resolves the effective context
-- with one read-only call. This is the external contract for officers, admins,
-- and reporting screens across multi-jurisdiction operations.
CREATE OR REPLACE VIEW public.module_context_contract
WITH (security_invoker = true)
AS
SELECT
  om.organization_id,
  om.module_key,
  om.enabled,
  rar.dominant_anchor_kind,
  rar.active_zone_id,
  rar.active_site_id,
  rar.active_location_id,
  rar.governing_jurisdiction_id,
  rar.governing_jurisdiction_name,
  rar.module_rule_set_id,
  rar.module_rule_set_name,
  rar.evidence_requirements,
  rar.approval_policy,
  rar.report_template_code,
  rar.jurisdiction_rule_set_id,
  rar.jurisdiction_rule_set_name,
  rar.jurisdiction_name,
  rar.jurisdiction_rules,
  rar.resolution_status,
  rar.effective_rules,
  rar.policy_status
FROM public.organization_modules om
LEFT JOIN public.resolve_active_rules(
  om.organization_id,
  om.module_key,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  now()
) rar
  ON rar.organization_id = om.organization_id
 AND rar.module_key = om.module_key
ORDER BY om.organization_id, om.module_key;

COMMENT ON VIEW public.module_context_contract IS
  'App-facing module context contract: one read-only view returning the live effective rule, place anchor, and policy status for each enabled module. This is the UI contract that all screens should consume instead of re-deriving org-only policy.';

REVOKE ALL ON public.module_context_contract FROM anon;
GRANT SELECT ON public.module_context_contract TO authenticated, service_role;
