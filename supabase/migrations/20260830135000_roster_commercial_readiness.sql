create function public.roster_place_geofence_state(p_site_id uuid,p_zone_id uuid)
returns text language plpgsql stable security definer set search_path=public as $$
declare v_has_boundary boolean;v_verified boolean;
begin
  select case when p_site_id is not null then exists(select 1 from public.client_sites s where s.id=p_site_id and s.boundary is not null) else exists(select 1 from public.location_zones z where z.id=p_zone_id and z.boundary is not null) end into v_has_boundary;
  if not v_has_boundary then return 'missing';end if;
  select coalesce((select h.verification_state='verified' from public.geofence_boundary_history h where h.entity_type=case when p_site_id is not null then 'client_site' else 'location_zone' end and h.entity_id=coalesce(p_site_id,p_zone_id) order by h.created_at desc limit 1),false) into v_verified;
  return case when v_verified then 'verified' else 'mapped_unverified' end;
end;$$;

create function public.roster_agreement_billing_ready(p_agreement_id uuid,p_site_id uuid,p_zone_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.crm_commercial_settings c where c.service_agreement_id=p_agreement_id and coalesce(c.base_rate_per_hour,c.callout_rate_per_hour,c.travel_rate_per_km)>0)
    or exists(select 1 from public.site_financial_config f where f.service_agreement_id=p_agreement_id and f.active and (f.site_id=p_site_id or (p_zone_id is not null and f.zone_id=p_zone_id)) and coalesce(f.hourly_rate,f.per_visit_rate,f.flat_rate_monthly,f.per_notice_rate,f.callout_rate)>0);
$$;

create function public.get_roster_commercial_readiness(p_organization_id uuid,p_from timestamptz,p_to timestamptz)
returns table(slot_id uuid,pay_status text,billing_status text,quote_status text,geofence_status text,cost_centre_status text) language plpgsql stable security definer set search_path=public as $$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to view roster commercial readiness';end if;
  if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '62 days' then raise exception 'Readiness window must be between 1 and 62 days';end if;
  return query
  select s.id,
    case when exists(select 1 from public.rate_rules r where r.organization_id=s.organization_id and r.rule_kind='pay' and r.active and (r.service_type is null or r.service_type=u.service_type) and (r.effective_from is null or r.effective_from<=s.scheduled_start::date) and (r.effective_to is null or r.effective_to>=s.scheduled_start::date)) then 'ready' else 'missing_rule' end,
    case
      when u.work_unit_type='internal' then 'not_applicable'
      when u.work_unit_type='static' and not exists(select 1 from public.service_agreement_locations l join public.service_agreements a on a.id=l.service_agreement_id join public.service_agreement_modules m on m.id=u.service_agreement_module_id and m.service_agreement_id=a.id and m.enabled where l.id=u.service_agreement_location_id and l.status='active' and a.agreement_type='operational' and (a.starts_on is null or a.starts_on<=s.scheduled_start::date) and (a.ends_on is null or a.ends_on>=s.scheduled_start::date)) then 'missing_contract'
      when u.work_unit_type='static' and public.roster_agreement_billing_ready((select l.service_agreement_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.site_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.zone_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id)) then 'ready'
      when u.work_unit_type='static' then 'missing_rate'
      when s.linked_shift_id is null then 'pending_materialization'
      when not exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required where st.shift_id=s.linked_shift_id) or exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required where st.shift_id=s.linked_shift_id and (sm.service_agreement_location_id is null or sm.service_agreement_module_id is null)) then 'missing_attribution'
      when exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required join public.service_agreement_locations l on l.id=sm.service_agreement_location_id where st.shift_id=s.linked_shift_id and not public.roster_agreement_billing_ready(l.service_agreement_id,l.site_id,l.zone_id)) then 'missing_rate'
      else 'ready' end,
    case
      when u.work_unit_type='internal' then 'not_applicable'
      when u.work_unit_type='static' and exists(select 1 from public.service_agreement_locations l join public.quotes q on q.service_agreement_id=l.service_agreement_id and q.status='accepted' where l.id=u.service_agreement_location_id) then 'accepted'
      when u.work_unit_type='static' then 'missing'
      when s.linked_shift_id is null then 'pending_materialization'
      when exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required left join public.service_agreement_locations l on l.id=sm.service_agreement_location_id left join public.quotes q on q.service_agreement_id=l.service_agreement_id and q.status='accepted' where st.shift_id=s.linked_shift_id and q.id is null) then 'missing'
      else 'accepted' end,
    case
      when u.work_unit_type='internal' then 'not_applicable'
      when u.work_unit_type='static' then public.roster_place_geofence_state((select l.site_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.zone_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id))
      when s.linked_shift_id is null then 'pending_materialization'
      when not exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id) then 'pending_materialization'
      when exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id and public.roster_place_geofence_state(st.site_id,st.zone_id)='missing') then 'missing'
      when not exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id and public.roster_place_geofence_state(st.site_id,st.zone_id)<>'verified') then 'verified'
      else 'mapped_unverified' end,
    case when u.work_unit_type<>'internal' then 'not_applicable' when u.cost_centre_id is not null then 'ready' else 'missing' end
  from public.roster_slots s join public.roster_work_units u on u.id=s.work_unit_id
  where s.organization_id=p_organization_id and s.scheduled_start<p_to and s.scheduled_end>p_from and s.status<>'cancelled';
end;$$;

revoke all on function public.roster_place_geofence_state(uuid,uuid),public.roster_agreement_billing_ready(uuid,uuid,uuid),public.get_roster_commercial_readiness(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.roster_place_geofence_state(uuid,uuid),public.roster_agreement_billing_ready(uuid,uuid,uuid) to service_role;
grant execute on function public.get_roster_commercial_readiness(uuid,timestamptz,timestamptz) to authenticated,service_role;