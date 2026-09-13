create or replace view public.module_event_place_matrix
with (security_invoker = true)
as
with module_catalog as (
  select om.organization_id, om.module_key, om.enabled,
    (select mrs.name from public.module_rule_sets mrs where mrs.organization_id = om.organization_id and mrs.module_key = om.module_key order by mrs.created_at desc limit 1) as rule_set_name,
    (select jrs.name from public.jurisdiction_rule_sets jrs where jrs.organization_id = om.organization_id and jrs.module_key = om.module_key order by jrs.created_at desc limit 1) as jurisdiction_rule_set_name
  from public.organization_modules om
), anchor_counts as (
  select p.organization_id, p.module_key, p.anchor_kind, count(*) as event_count
  from public.house_event_anchor_projection p
  where p.module_key is not null
  group by p.organization_id, p.module_key, p.anchor_kind
), module_anchor_summary as (
  select organization_id, module_key, anchor_kind, max(event_count) as event_count
  from anchor_counts
  group by organization_id, module_key, anchor_kind
)
select mc.organization_id, mc.module_key, mc.enabled, mc.rule_set_name, mc.jurisdiction_rule_set_name,
  case when mc.module_key is null then 'unsupported'
       when exists (select 1 from public.house_event_anchor_projection p where p.organization_id = mc.organization_id and p.module_key = mc.module_key and p.anchor_kind = 'checkpoint') then 'checkpoint'
       when exists (select 1 from public.house_event_anchor_projection p where p.organization_id = mc.organization_id and p.module_key = mc.module_key and p.anchor_kind = 'site') then 'site'
       when exists (select 1 from public.house_event_anchor_projection p where p.organization_id = mc.organization_id and p.module_key = mc.module_key and p.anchor_kind = 'zone') then 'zone'
       when exists (select 1 from public.house_event_anchor_projection p where p.organization_id = mc.organization_id and p.module_key = mc.module_key and p.anchor_kind = 'house') then 'house'
       else 'unresolved' end as dominant_anchor_kind,
  coalesce((select sum(mas.event_count) from module_anchor_summary mas where mas.organization_id = mc.organization_id and mas.module_key = mc.module_key),0) as total_event_count,
  coalesce((select sum(case when mas.anchor_kind = 'unresolved' then mas.event_count else 0 end) from module_anchor_summary mas where mas.organization_id = mc.organization_id and mas.module_key = mc.module_key),0) as unresolved_event_count,
  coalesce((select sum(case when mas.anchor_kind = 'checkpoint' then mas.event_count else 0 end) from module_anchor_summary mas where mas.organization_id = mc.organization_id and mas.module_key = mc.module_key),0) as checkpoint_event_count,
  coalesce((select sum(case when mas.anchor_kind = 'site' then mas.event_count else 0 end) from module_anchor_summary mas where mas.organization_id = mc.organization_id and mas.module_key = mc.module_key),0) as site_event_count,
  coalesce((select sum(case when mas.anchor_kind = 'zone' then mas.event_count else 0 end) from module_anchor_summary mas where mas.organization_id = mc.organization_id and mas.module_key = mc.module_key),0) as zone_event_count
from module_catalog mc
order by mc.organization_id, mc.module_key;

grant select on public.module_event_place_matrix to authenticated, service_role;
