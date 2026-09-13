-- Read-only lookup view: active module rules indexed by module and governing
-- place context, matching the multi-jurisdiction service-provider model.
CREATE OR REPLACE VIEW public.module_rule_index_view
WITH (security_invoker = true)
AS
SELECT
  om.organization_id,
  om.module_key,
  om.enabled,
  mrs.id AS module_rule_set_id,
  mrs.name AS module_rule_set_name,
  mrs.evidence_requirements,
  mrs.approval_policy,
  mrs.report_template_code,
  jrs.id AS jurisdiction_rule_set_id,
  jrs.name AS jurisdiction_rule_set_name,
  jrs.jurisdiction_name,
  jrs.rules AS jurisdiction_rules,
  z.id AS zone_id,
  z.site_id,
  z.location_id,
  z.organization_id AS zone_organization_id,
  COALESCE(z.jurisdiction_rule_set_id, jrs.id) AS active_rule_set_id,
  CASE
    WHEN z.id IS NOT NULL THEN 'zone'
    WHEN cs.id IS NOT NULL THEN 'site'
    ELSE 'organization'
  END AS place_scope
FROM public.organization_modules om
LEFT JOIN public.module_rule_sets mrs
  ON mrs.organization_id = om.organization_id
 AND mrs.module_key = om.module_key
LEFT JOIN public.jurisdiction_rule_sets jrs
  ON jrs.organization_id = om.organization_id
 AND jrs.module_key = om.module_key
LEFT JOIN public.location_zones z
  ON z.organization_id = om.organization_id
 AND z.module_key = om.module_key
LEFT JOIN public.client_sites cs
  ON cs.organization_id = om.organization_id
 AND cs.site_type IS NOT NULL
ORDER BY om.organization_id, om.module_key, z.id;

COMMENT ON VIEW public.module_rule_index_view IS
  'Read-only lookup view for active module rule sets keyed by organization, module, and governing place context. This supports multi-jurisdiction service-provider rule resolution without hidden org assumptions.';

REVOKE ALL ON public.module_rule_index_view FROM anon;
GRANT SELECT ON public.module_rule_index_view TO authenticated, service_role;
