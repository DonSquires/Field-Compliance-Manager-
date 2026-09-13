create or replace view public.module_rule_index_view
with (security_invoker = true)
as
select om.organization_id, om.module_key, om.enabled,
  mrs.id as module_rule_set_id, mrs.name as module_rule_set_name, mrs.evidence_requirements,
  mrs.approval_policy, mrs.report_template_code,
  jrs.id as jurisdiction_rule_set_id, jrs.name as jurisdiction_rule_set_name,
  jrs.jurisdiction_name, jrs.rules as jurisdiction_rules,
  z.id as zone_id, z.site_id, z.location_id, z.organization_id as zone_organization_id,
  coalesce(z.jurisdiction_rule_set_id, jrs.id) as active_rule_set_id,
  case when z.id is not null then 'zone'
       when cs.id is not null then 'site'
       else 'organization' end as place_scope
from public.organization_modules om
left join public.module_rule_sets mrs on mrs.organization_id = om.organization_id and mrs.module_key = om.module_key
left join public.jurisdiction_rule_sets jrs on jrs.organization_id = om.organization_id and jrs.module_key = om.module_key
left join public.location_zones z on z.organization_id = om.organization_id and z.module_key = om.module_key
left join public.client_sites cs on cs.organization_id = om.organization_id and cs.site_type is not null
order by om.organization_id, om.module_key, z.id;

grant select on public.module_rule_index_view to authenticated, service_role;
