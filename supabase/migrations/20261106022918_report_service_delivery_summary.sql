-- Supplementary service counts, not another copy of the activity ledger.
-- No officer prose, identities, GPS, handover, briefing or outcome text leaves
-- this projection. Client packs retain their existing review/Oracle/publication
-- gates. Maintenance/admin/gate checks and camera evidence are unchanged.
create or replace function public.report_service_delivery_summary(
  p_agreement_id uuid, p_from timestamptz, p_to timestamptz
) returns jsonb
language sql stable security definer set search_path = pg_catalog
as $function$
with agreement as materialized (
  select id, provider_organization_id, client_organization_id
  from public.service_agreements where id = p_agreement_id
), links as materialized (
  select l.id, l.site_id, l.zone_id
  from public.service_agreement_locations l
  where l.service_agreement_id = p_agreement_id and l.status = 'active'
), contracted_shifts as materialized (
  select s.id from public.shifts s join agreement a on a.provider_organization_id = s.organization_id
  where (exists (
    select 1 from public.service_agreement_modules am
    where am.id = s.service_agreement_module_id and am.service_agreement_id = a.id
  ) or exists (
    select 1 from public.shift_stops st
    join public.shift_stop_modules m on m.shift_stop_id = st.id
    join public.service_agreement_modules am on am.id = m.service_agreement_module_id
    where st.shift_id = s.id and am.service_agreement_id = a.id
      and m.organization_id = a.provider_organization_id
  )) and not exists (
    select 1 from public.shift_stops st
    join public.shift_stop_modules m on m.shift_stop_id = st.id
    join public.service_agreement_modules am on am.id = m.service_agreement_module_id
    where st.shift_id = s.id and am.service_agreement_id <> a.id
  )
), field_scope as materialized (
  select distinct on (coalesce(r.client_event_id, r.id))
    r.id, r.client_event_id, r.status, r.reviewed_at, r.reviewed_by, r.investigation_id,
    array(
      select duplicate.id from public.officer_field_reports duplicate
      where duplicate.organization_id = r.organization_id and duplicate.report_type = 'incident'
        and (duplicate.id = r.id or duplicate.client_event_id = r.client_event_id)
    ) as provenance_ids
  from public.officer_field_reports r
  join agreement a on a.provider_organization_id = r.organization_id
  where r.reported_at >= p_from and r.reported_at < p_to
    and r.report_type = 'incident'
    and exists (select 1 from links l where l.site_id = r.site_id or l.zone_id = r.zone_id)
    and (
      ((
        exists (
          select 1 from public.shifts s
          join public.service_agreement_modules am on am.id = s.service_agreement_module_id
          where s.id = r.shift_id and s.organization_id = a.provider_organization_id
            and am.service_agreement_id = a.id
        ) or exists (
          select 1 from public.shift_stops st
          join public.shift_stop_modules m on m.shift_stop_id = st.id
          join public.service_agreement_modules am on am.id = m.service_agreement_module_id
          where st.shift_id = r.shift_id and st.organization_id = a.provider_organization_id
            and m.organization_id = a.provider_organization_id and am.service_agreement_id = a.id
            and (st.site_id = r.site_id or st.zone_id = r.zone_id)
        )
      ) and not exists (
        select 1 from public.shift_stops st
        join public.shift_stop_modules m on m.shift_stop_id = st.id
        join public.service_agreement_modules am on am.id = m.service_agreement_module_id
        where st.shift_id = r.shift_id and am.service_agreement_id <> a.id
          and (st.site_id = r.site_id or st.zone_id = r.zone_id)
      ))
      or (r.shift_id is null and not exists (
        select 1 from public.service_agreement_locations other
        where other.status = 'active' and other.service_agreement_id <> a.id
          and (other.site_id = r.site_id or other.zone_id = r.zone_id)
      ))
    )
    and not exists (
      select 1 from public.incidents i
      where i.investigation_id = r.investigation_id and i.is_staff_sensitive
    )
  order by coalesce(r.client_event_id, r.id),
    (r.status in ('reviewed', 'closed') and r.reviewed_at is not null and r.reviewed_by is not null) desc,
    r.reported_at, r.id
), candidates as materialized (
  select 'reviewedReports'::text as kind, r.id, r.client_event_id,
    null::uuid as stop_id, r.investigation_id, r.provenance_ids
  from field_scope r
  where r.status in ('reviewed', 'closed') and r.reviewed_at is not null and r.reviewed_by is not null
  union all
  select 'completedDispatch', j.id, null::uuid, j.shift_stop_id, j.investigation_id, array[j.id]
  from public.dispatch_jobs j
  join agreement a on a.provider_organization_id = j.organization_id
  where j.status = 'completed' and j.completed_at >= p_from and j.completed_at < p_to
    and exists (select 1 from links l where l.site_id = j.client_site_id or l.zone_id = j.zone_id)
    and (j.service_agreement_id = a.id or (
      j.service_agreement_id is null and not exists (
        select 1 from public.service_agreement_locations other
        where other.status = 'active' and other.service_agreement_id <> a.id
          and (other.site_id = j.client_site_id or other.zone_id = j.zone_id)
      )
    ))
  union all
  select distinct 'completedStatic', st.id, null::uuid, st.id, null::uuid, array[st.id]
  from public.shift_stops st
  join agreement a on st.organization_id = a.provider_organization_id
  join public.shift_stop_modules m on m.shift_stop_id = st.id and m.organization_id = a.provider_organization_id
  join public.service_agreement_modules am on am.id = m.service_agreement_module_id and am.service_agreement_id = a.id
  join links l on l.id = m.service_agreement_location_id and (l.site_id = st.site_id or l.zone_id = st.zone_id)
  where m.module_key = 'static_guarding' and m.status = 'completed'
    and st.actual_departed_at >= p_from and st.actual_departed_at < p_to
    and exists (
      select 1 from public.shift_stop_actions act
      where act.shift_stop_module_id = m.id and act.organization_id = a.provider_organization_id
        and act.action_type = 'static_post_departed'
    )
), represented as (
  select c.*, exists (
    select 1 from public.location_events e
    join agreement a on e.organization_id in (a.provider_organization_id, a.client_organization_id)
    where e.occurred_at >= p_from and e.occurred_at < p_to
      and exists (select 1 from links l where l.site_id = e.client_site_id or l.zone_id = e.zone_id)
      and (
        (e.source in ('dispatch_job', 'dispatch_jobs') and c.kind = 'completedDispatch' and e.external_ref = c.id::text)
        or (e.source in ('officer_field_report', 'officer_field_reports') and c.kind = 'reviewedReports' and e.external_ref = any(c.provenance_ids::text[]))
        or (c.kind = 'completedDispatch' and e.payload ->> 'dispatch_job_id' = c.id::text)
        or (c.kind = 'reviewedReports' and e.payload ->> 'officer_field_report_id' = any(c.provenance_ids::text[]))
        or (c.kind = 'completedStatic' and e.payload ->> 'shift_stop_id' = c.stop_id::text)
        or (c.client_event_id is not null and e.payload ->> 'client_event_id' = c.client_event_id::text)
      )
  ) or exists (
    select 1 from public.observations o
    join agreement a on o.organization_id in (a.provider_organization_id, a.client_organization_id)
    where o.observed_at >= p_from and o.observed_at < p_to
      and exists (select 1 from links l where l.site_id = o.site_id or l.zone_id = o.zone_id)
      and (
        (c.kind = 'reviewedReports' and o.external_refs ->> 'officer_field_report_id' = any(c.provenance_ids::text[]))
        or (c.kind = 'completedDispatch' and o.external_refs ->> 'dispatch_job_id' = c.id::text)
        or (c.client_event_id is not null and o.external_refs ->> 'client_event_id' = c.client_event_id::text)
      )
  ) or exists (
    select 1 from public.incidents i
    join agreement a on i.organization_id in (a.provider_organization_id, a.client_organization_id)
    where i.occurred_at >= p_from and i.occurred_at < p_to and not i.is_staff_sensitive
      and exists (select 1 from links l where l.site_id = i.client_site_id or l.zone_id = i.zone_id)
      and c.kind = 'completedDispatch' and i.dispatch_job_id = c.id
  ) as in_activity
  from candidates c
), counts as (
  select kinds.kind, count(r.id) as recorded,
    count(r.id) filter (where r.in_activity) as represented
  from (values ('reviewedReports'), ('completedDispatch'), ('completedStatic')) kinds(kind)
  left join represented r on r.kind = kinds.kind group by kinds.kind
)
select jsonb_build_object(
  'client', jsonb_build_object(
    'version', 1,
    'counts', (select jsonb_object_agg(kind, jsonb_build_object(
      'recorded', recorded, 'alreadyInActivity', represented, 'additional', recorded - represented
    )) from counts)
  ),
  'internal', jsonb_build_object(
    'awaitingReview', (select count(*) from field_scope where status = 'submitted'),
    'handoversReceived', (
      select count(*) from public.shift_debriefs d join agreement a on d.organization_id = a.provider_organization_id
      where d.shift_id in (select id from contracted_shifts) and d.submitted_at >= p_from and d.submitted_at < p_to
    )
  )
);
$function$;
revoke all on function public.report_service_delivery_summary(uuid,timestamptz,timestamptz) from public, anon, authenticated, service_role;

create or replace function public.get_agreement_service_delivery_summary(
  p_agreement_ids uuid[], p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog
as $function$
declare v_id uuid; v_result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '3660 days' then
    raise exception 'A valid reporting window is required';
  end if;
  if coalesce(cardinality(p_agreement_ids), 0) > 100 then raise exception 'Too many agreements'; end if;
  for v_id in select distinct unnest(p_agreement_ids) loop
    if not exists (
      select 1 from public.service_agreements a where a.id = v_id
        and public.is_report_provider_custodian_for_org(a.provider_organization_id)
    ) then raise exception 'Provider report access required'; end if;
    v_result := v_result || jsonb_build_array(public.report_service_delivery_summary(v_id, p_from, p_to));
  end loop;
  return v_result;
end;
$function$;
revoke all on function public.get_agreement_service_delivery_summary(uuid[],timestamptz,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.get_agreement_service_delivery_summary(uuid[],timestamptz,timestamptz) to authenticated;

-- Keep the existing hunter-return wrapper and activity accounting intact.
create or replace function public.build_agreement_activity_report(
  p_service_agreement_id uuid, p_from timestamptz, p_to timestamptz, p_max_lines integer default 2000
) returns jsonb
language sql stable security definer set search_path = pg_catalog
as $function$
with core as (
  select public.build_agreement_activity_report_core(p_service_agreement_id,p_from,p_to,p_max_lines) as j
), agreement as (
  select provider_organization_id,client_organization_id from public.service_agreements where id=p_service_agreement_id
), client_returns as (
  select h.hunting_area,h.return_type,h.animals,h.total_animals,h.hunt_date
  from public.hunter_kill_returns h join agreement a
    on h.organization_id=a.provider_organization_id and h.client_organization_id=a.client_organization_id
  where h.withdrawn_at is null
), in_window as (
  select c.* from client_returns c
  where (c.hunt_date::timestamp at time zone 'Pacific/Auckland')>=p_from
    and (c.hunt_date::timestamp at time zone 'Pacific/Auckland')<p_to
), species as (
  select a->>'species' as species,sum((a->>'count')::integer)::integer as animals,count(*)::integer as returns
  from in_window w cross join lateral jsonb_array_elements(w.animals) a group by 1
), areas as (
  select w.hunting_area as area,count(*)::integer as returns,
    count(*) filter(where w.return_type='kill')::integer as kill,
    count(*) filter(where w.return_type='nil')::integer as nil,sum(w.total_animals)::integer as animals
  from in_window w group by 1
), summary as (
  select jsonb_build_object(
    'source','Hunter-submitted returns (RAMS)','returns',(select count(*) from in_window),
    'killReturns',(select count(*) from in_window where return_type='kill'),
    'nilReturns',(select count(*) from in_window where return_type='nil'),
    'animals',(select coalesce(sum(total_animals),0) from in_window),
    'bySpecies',coalesce((select jsonb_agg(jsonb_build_object('species',s.species,'animals',s.animals,'returns',s.returns)
      order by s.animals desc,s.species) from species s),'[]'::jsonb),
    'byArea',coalesce((select jsonb_agg(jsonb_build_object('area',ar.area,'returns',ar.returns,'kill',ar.kill,'nil',ar.nil,'animals',ar.animals)
      order by ar.animals desc,ar.returns desc,ar.area) from areas ar),'[]'::jsonb)
  ) as s
), base as (
  select case when core.j->'report' is null or not exists(select 1 from client_returns) then core.j
    else jsonb_set(core.j,'{report,hunterReturns}',(select s from summary)) end as j from core
)
select case when base.j->'report' is null then base.j else jsonb_set(base.j,'{report,serviceDelivery}',
  public.report_service_delivery_summary(p_service_agreement_id,p_from,p_to)->'client') end
from base;
$function$;
revoke all on function public.build_agreement_activity_report(uuid,timestamptz,timestamptz,integer) from public, anon, authenticated, service_role;
comment on function public.report_service_delivery_summary(uuid,timestamptz,timestamptz) is
'Internal count-only service evidence: reviewed incident reports, completed dispatch and static attendance, with provenance overlaps; private handover counts only in the provider projection. No free text or financial estimates.';