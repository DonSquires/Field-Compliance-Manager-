create or replace view public.house_event_anchor_projection
with (security_invoker = true)
as
select
  'location_events'::text as source_table, e.id as event_id, e.organization_id,
  e.module_key, e.event_type, e.occurred_at, e.checkpoint_id, e.client_site_id,
  e.zone_id, coalesce(z.location_id, s.location_id) as location_id,
  case when e.checkpoint_id is not null then 'checkpoint' when e.client_site_id is not null then 'site' when e.zone_id is not null then 'zone' when coalesce(z.location_id, s.location_id) is not null then 'house' else 'unresolved' end as anchor_kind,
  case when e.checkpoint_id is null and e.client_site_id is null and e.zone_id is null then 'no_checkpoint_site_or_zone' when coalesce(z.location_id, s.location_id) is null then 'facet_has_no_house_link' else null end as unresolved_reason
from public.location_events e
left join public.client_sites s on s.id=e.client_site_id
left join public.location_zones z on z.id=e.zone_id
union all
select
  'observations', o.id, o.organization_id, o.module_key, 'observation', o.observed_at,
  null, o.site_id, o.zone_id, coalesce(o.location_id, z.location_id, s.location_id),
  case when o.site_id is not null then 'site' when o.zone_id is not null then 'zone' when coalesce(o.location_id, z.location_id, s.location_id) is not null then 'house' else 'unresolved' end,
  case when o.site_id is null and o.zone_id is null and o.location_id is null then 'no_site_zone_or_house' when coalesce(o.location_id, z.location_id, s.location_id) is null then 'facet_has_no_house_link' else null end
from public.observations o
left join public.client_sites s on s.id=o.site_id
left join public.location_zones z on z.id=o.zone_id
union all
select
  'noise_assessments', n.id, n.organization_id, 'noise_control', 'noise_assessment', n.assessed_at,
  null, n.site_id, null, n.location_id,
  case when n.site_id is not null then 'site' when n.location_id is not null then 'house' else 'unresolved' end,
  case when n.site_id is null and n.location_id is null then 'no_site_or_house' when n.location_id is null then 'site_has_no_house_link' else null end
from public.noise_assessments n
union all
select
  'dispatch_jobs', d.id, d.organization_id, d.module_key, d.job_type, d.created_at,
  null, d.client_site_id, null, s.location_id,
  case when d.client_site_id is not null then 'site' when s.location_id is not null then 'house' else 'unresolved' end,
  case when d.client_site_id is null and s.location_id is null then 'no_site_or_house' when s.location_id is null then 'site_has_no_house_link' else null end
from public.dispatch_jobs d
left join public.client_sites s on s.id=d.client_site_id;

grant select on public.house_event_anchor_projection to authenticated, service_role;
