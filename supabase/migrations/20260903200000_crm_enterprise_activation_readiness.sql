-- ============================================================
-- Migration 20260903200000 - CRM Enterprise Activation Readiness
-- ============================================================
-- Makes the CRM activation gate evaluate the complete account chain:
-- organization/branch, location house, site/zone, finance, and roster.

create or replace function public.get_crm_enterprise_readiness(p_agreement_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_base jsonb;
  v_provider_ready boolean;
  v_client_ready boolean;
  v_house_ready boolean;
  v_place_ready boolean;
  v_zone_ready boolean;
  v_finance_ready boolean;
  v_roster_ready boolean;
  v_active_links integer;
  v_active_sites integer;
  v_active_zones integer;
  v_active_work_units integer;
  v_dimensions jsonb;
  v_ready boolean;
begin
  select * into v_agreement from public.service_agreements where id=p_agreement_id;
  if not found then raise exception 'Service agreement not found'; end if;
  if v_actor is null or not public.is_admin_for_org(v_agreement.provider_organization_id) then
    raise exception 'Provider administrator required';
  end if;
  if v_agreement.agreement_type<>'operational' then raise exception 'Operational agreement required'; end if;

  v_base := public.get_crm_operational_readiness(p_agreement_id);

  select exists(select 1 from public.organizations o where o.id=v_agreement.provider_organization_id and o.active and o.status='active'),
         exists(select 1 from public.organizations o where o.id=v_agreement.client_organization_id and o.active and o.status in ('active','prospect'))
    into v_provider_ready,v_client_ready;

  select count(*) into v_active_links from public.service_agreement_locations sal where sal.service_agreement_id=p_agreement_id and sal.status='active';
  select count(*) into v_active_sites from public.service_agreement_locations sal join public.client_sites s on s.id=sal.site_id join public.locations l on l.id=s.location_id where sal.service_agreement_id=p_agreement_id and sal.status='active' and sal.site_id is not null and s.active and l.organization_id=v_agreement.client_organization_id;
  select count(*) into v_active_zones from public.service_agreement_locations sal join public.location_zones z on z.id=sal.zone_id where sal.service_agreement_id=p_agreement_id and sal.status='active' and sal.zone_id is not null and z.is_active and z.organization_id=v_agreement.client_organization_id;

  v_house_ready := v_active_links>0 and v_active_sites>0;
  v_place_ready := v_active_links>0 and not exists(
    select 1 from public.service_agreement_locations sal
    left join public.client_sites s on s.id=sal.site_id
    left join public.location_zones z on z.id=sal.zone_id
    where sal.service_agreement_id=p_agreement_id and sal.status='active'
      and ((sal.site_id is not null and (s.id is null or not s.active)) or (sal.zone_id is not null and (z.id is null or not z.is_active)))
  );
  v_zone_ready := not exists(
    select 1 from public.service_agreement_locations sal
    left join public.location_zones z on z.id=sal.zone_id
    where sal.service_agreement_id=p_agreement_id and sal.status='active' and sal.zone_id is not null
      and (z.id is null or z.boundary is null or z.boundary_status<>'authoritative' or not exists(select 1 from public.geofence_boundary_history h where h.entity_type='location_zone' and h.entity_id=z.id and h.verification_state='verified'))
  );
  v_finance_ready := v_active_links>0 and not exists(
    select 1 from public.service_agreement_locations sal
    where sal.service_agreement_id=p_agreement_id and sal.status='active'
      and not exists(select 1 from public.site_financial_config f where f.service_agreement_id=p_agreement_id and f.active and ((sal.site_id is not null and f.site_id=sal.site_id) or (sal.zone_id is not null and f.zone_id=sal.zone_id)) and coalesce(f.hourly_rate,f.per_visit_rate,f.flat_rate_monthly,f.per_notice_rate,f.callout_rate)>0)
  );
  select count(*) into v_active_work_units from public.roster_work_units wu join public.service_agreement_locations sal on sal.id=wu.service_agreement_location_id and sal.service_agreement_id=p_agreement_id and sal.status='active' join public.service_agreement_modules sam on sam.id=wu.service_agreement_module_id and sam.service_agreement_id=p_agreement_id and sam.enabled where wu.active;
  v_roster_ready := v_active_work_units>0;

  v_ready := coalesce((v_base->>'ready')::boolean,false) and v_provider_ready and v_client_ready and v_house_ready and v_place_ready and v_zone_ready and v_finance_ready and v_roster_ready;
  v_dimensions := jsonb_build_array(
    jsonb_build_object('key','organization_branch','label','Organization and branch','status',case when v_provider_ready and v_client_ready then 'ready' else 'blocked' end,'detail',case when v_provider_ready and v_client_ready then 'Active provider branch and client organization are linked' else 'Provider branch and client organization must both be active' end,'owner','Account administration','destination','crm'),
    jsonb_build_object('key','location_house','label','Location house and sites','status',case when v_house_ready then 'ready' else 'blocked' end,'detail',case when v_house_ready then v_active_sites||' active covered site(s) are anchored to canonical locations' else 'Every covered site must belong to an active canonical location house' end,'owner','Account administration','destination','sites'),
    jsonb_build_object('key','site_zone','label','Site and zone configuration','status',case when v_place_ready and v_zone_ready then 'ready' else 'blocked' end,'detail',case when v_place_ready and v_zone_ready then 'Covered sites and zones have active, verified place configuration' else 'Every covered site/zone must be active with verified geometry where a zone is used' end,'owner','Operations administration','destination','sites'),
    jsonb_build_object('key','finance_by_place','label','Finance by covered place','status',case when v_finance_ready then 'ready' else 'blocked' end,'detail',case when v_finance_ready then 'Every active covered site or zone has a positive billable rate' else 'Each active covered site or zone needs its own positive financial configuration' end,'owner','Commercial administration','destination','crm'),
    jsonb_build_object('key','roster_attribution','label','Roster attribution','status',case when v_roster_ready then 'ready' else 'blocked' end,'detail',case when v_roster_ready then v_active_work_units||' active work unit(s) are attributed to the agreement' else 'Create an active roster work unit linked to an enabled agreement module and covered place' end,'owner','Roster administration','destination','roster-targets')
  );
  return jsonb_build_object('agreement_id',p_agreement_id,'invitation_status',v_agreement.invitation_status,'ready',v_ready,'dimensions',coalesce(v_base->'dimensions','[]'::jsonb)||v_dimensions);
end;$$;

revoke all on function public.get_crm_enterprise_readiness(uuid) from public,anon;
grant execute on function public.get_crm_enterprise_readiness(uuid) to authenticated,service_role;
