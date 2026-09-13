create or replace view public.module_place_policy_summary
with (security_invoker = true)
as
with latest_module_rules as (
  select distinct on (mrs.organization_id, mrs.module_key)
    mrs.organization_id,
    mrs.module_key,
    mrs.id as module_rule_set_id,
    mrs.name as module_rule_set_name,
    mrs.evidence_requirements,
    mrs.approval_policy,
    mrs.report_template_code,
    mrs.created_at
  from public.module_rule_sets mrs
  order by mrs.organization_id, mrs.module_key, mrs.created_at desc
), latest_jurisdiction_rules as (
  select distinct on (jrs.organization_id, jrs.module_key)
    jrs.organization_id,
    jrs.module_key,
    jrs.id as jurisdiction_rule_set_id,
    jrs.name as jurisdiction_rule_set_name,
    jrs.jurisdiction_name,
    jrs.rules as jurisdiction_rules,
    jrs.created_at
  from public.jurisdiction_rule_sets jrs
  order by jrs.organization_id, jrs.module_key, jrs.created_at desc
)
select om.organization_id, om.module_key, om.enabled,
  lmr.module_rule_set_id, lmr.module_rule_set_name, lmr.evidence_requirements,
  lmr.approval_policy, lmr.report_template_code,
  ljr.jurisdiction_rule_set_id, ljr.jurisdiction_rule_set_name, ljr.jurisdiction_name,
  ljr.jurisdiction_rules,
  mepm.dominant_anchor_kind, mepm.total_event_count, mepm.unresolved_event_count,
  mepm.checkpoint_event_count, mepm.site_event_count, mepm.zone_event_count,
  case when om.enabled = false then 'disabled'
       when mepm.unresolved_event_count > 0 then 'needs_reconciliation'
       when mepm.dominant_anchor_kind is null then 'no_place_coverage'
       else 'ready' end as policy_status
from public.organization_modules om
left join latest_module_rules lmr on lmr.organization_id = om.organization_id and lmr.module_key = om.module_key
left join latest_jurisdiction_rules ljr on ljr.organization_id = om.organization_id and ljr.module_key = om.module_key
left join public.module_event_place_matrix mepm on mepm.organization_id = om.organization_id and mepm.module_key = om.module_key
order by om.organization_id, om.module_key;

grant select on public.module_place_policy_summary to authenticated, service_role;
