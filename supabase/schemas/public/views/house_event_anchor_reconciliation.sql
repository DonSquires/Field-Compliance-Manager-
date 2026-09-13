create or replace view public.house_event_anchor_reconciliation
with (security_invoker = true)
as
select
  p.*,
  case when p.source_table <> 'location_events' or p.checkpoint_id is null then 'not_applicable'
    when cp.id is null then 'invalid_missing_checkpoint'
    when cp.organization_id is distinct from p.organization_id then 'invalid_organization'
    when cp.client_site_id is not null and p.client_site_id = cp.client_site_id and p.zone_id is null then 'valid'
    when cp.zone_id is not null and p.zone_id = cp.zone_id and p.client_site_id is null then 'valid'
    else 'invalid_facet_mismatch' end as checkpoint_consistency,
  case when p.source_table = 'location_events' and p.checkpoint_id is not null and (
    cp.id is null or cp.organization_id is distinct from p.organization_id
    or (cp.client_site_id is not null and (p.client_site_id is distinct from cp.client_site_id or p.zone_id is not null))
    or (cp.zone_id is not null and (p.zone_id is distinct from cp.zone_id or p.client_site_id is not null))
  ) then 'checkpoint_facet_mismatch' else p.unresolved_reason end as reconciliation_reason
from public.house_event_anchor_projection p
left join public.location_events e on p.source_table='location_events' and e.id=p.event_id
left join public.patrol_checkpoints cp on cp.id=e.checkpoint_id;

grant select on public.house_event_anchor_reconciliation to authenticated, service_role;
