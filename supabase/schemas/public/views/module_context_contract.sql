create or replace view public.module_context_contract
with (security_invoker = true)
as
select om.organization_id, om.module_key, om.enabled,
  rar.dominant_anchor_kind, rar.active_zone_id, rar.active_site_id, rar.active_location_id,
  rar.governing_jurisdiction_id, rar.governing_jurisdiction_name,
  rar.module_rule_set_id, rar.module_rule_set_name, rar.evidence_requirements,
  rar.approval_policy, rar.report_template_code,
  rar.jurisdiction_rule_set_id, rar.jurisdiction_rule_set_name, rar.jurisdiction_name,
  rar.jurisdiction_rules, rar.resolution_status, rar.effective_rules, rar.policy_status
from public.organization_modules om
left join public.resolve_active_rules(
  om.organization_id,
  om.module_key,
  null,
  null,
  null,
  null,
  null,
  now()
) rar on rar.organization_id = om.organization_id and rar.module_key = om.module_key
order by om.organization_id, om.module_key;

grant select on public.module_context_contract to authenticated, service_role;
