create function public.get_crm_operational_readiness(p_agreement_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;v_location_count integer;v_boundary_ready boolean;v_module_count integer;v_billing_ready boolean;v_work_unit_count integer;v_reporting_ready boolean;
begin
  select sa.* into v_agreement from public.service_agreements sa where sa.id=p_agreement_id;
  if not found then raise exception 'Service agreement not found';end if;
  if v_actor is null or not public.is_admin_for_org(v_agreement.provider_organization_id) then raise exception 'Provider administrator required';end if;
  if v_agreement.agreement_type<>'operational' then raise exception 'Operational agreement required';end if;

  select count(*) into v_location_count from public.service_agreement_locations sal where sal.service_agreement_id=v_agreement.id and sal.status='active';
  select v_location_count>0 and not exists(
    select 1 from public.service_agreement_locations sal
    left join public.client_sites s on s.id=sal.site_id
    left join public.location_zones z on z.id=sal.zone_id
    where sal.service_agreement_id=v_agreement.id and sal.status='active' and (
      (sal.site_id is not null and (s.boundary is null or s.boundary_status<>'authoritative' or s.boundary_verification<>'verified'))
      or (sal.zone_id is not null and (z.boundary is null or not exists(select 1 from public.geofence_boundary_history h where h.entity_type='location_zone' and h.entity_id=z.id and h.verification_state='verified')))
    )
  ) into v_boundary_ready;
  select count(*) into v_module_count from public.service_agreement_modules sam where sam.service_agreement_id=v_agreement.id and sam.enabled;
  select exists(select 1 from public.crm_commercial_settings c where c.service_agreement_id=v_agreement.id and coalesce(c.base_rate_per_hour,c.callout_rate_per_hour,c.travel_rate_per_km)>0)
    or exists(select 1 from public.site_financial_config f join public.service_agreement_locations sal on sal.service_agreement_id=f.service_agreement_id and (sal.site_id=f.site_id or sal.zone_id=f.zone_id) where f.service_agreement_id=v_agreement.id and f.active and sal.status='active' and coalesce(f.hourly_rate,f.per_visit_rate,f.flat_rate_monthly,f.per_notice_rate,f.callout_rate)>0) into v_billing_ready;
  select count(*) into v_work_unit_count from public.roster_work_units wu join public.service_agreement_locations sal on sal.id=wu.service_agreement_location_id and sal.service_agreement_id=v_agreement.id and sal.status='active' join public.service_agreement_modules sam on sam.id=wu.service_agreement_module_id and sam.service_agreement_id=v_agreement.id and sam.enabled where wu.active;
  select not v_agreement.client_portal_reports_enabled or (v_agreement.monthly_report_template_code is not null and exists(select 1 from public.report_templates rt where rt.organization_id=v_agreement.provider_organization_id and rt.template_code=v_agreement.monthly_report_template_code)) into v_reporting_ready;

  return jsonb_build_object('agreement_id',v_agreement.id,'invitation_status',v_agreement.invitation_status,'ready',v_agreement.invitation_status='accepted' and v_location_count>0 and v_boundary_ready and v_module_count>0 and v_billing_ready and v_work_unit_count>0 and v_reporting_ready,'dimensions',jsonb_build_array(
    jsonb_build_object('key','coverage','label','Covered places','status',case when v_location_count>0 then 'ready' else 'blocked' end,'detail',case when v_location_count>0 then v_location_count||' active location link'||case when v_location_count=1 then '' else 's' end else 'No active covered site or zone is linked' end,'owner','Account administration','destination','relationships'),
    jsonb_build_object('key','boundary','label','Boundary evidence','status',case when v_boundary_ready then 'ready' else 'blocked' end,'detail',case when v_boundary_ready then 'All covered places have authoritative verified boundaries' else 'Every covered place needs authoritative verified geometry' end,'owner','Operations administration','destination','sites'),
    jsonb_build_object('key','modules','label','Service scope','status',case when v_module_count>0 then 'ready' else 'blocked' end,'detail',case when v_module_count>0 then v_module_count||' enabled service module'||case when v_module_count=1 then '' else 's' end else 'No service module is enabled' end,'owner','Account administration','destination','relationships'),
    jsonb_build_object('key','billing','label','Commercial rates','status',case when v_billing_ready then 'ready' else 'blocked' end,'detail',case when v_billing_ready then 'A positive agreement or covered-place rate is recorded' else 'No positive billable rate is recorded' end,'owner','Commercial administration','destination','crm'),
    jsonb_build_object('key','operations','label','Operational work','status',case when v_work_unit_count>0 then 'ready' else 'blocked' end,'detail',case when v_work_unit_count>0 then v_work_unit_count||' active attributed work unit'||case when v_work_unit_count=1 then '' else 's' end else 'No active work unit is attributed to this agreement' end,'owner','Roster administration','destination','roster-targets'),
    jsonb_build_object('key','reporting','label','Reporting delivery','status',case when v_reporting_ready then 'ready' else 'blocked' end,'detail',case when not v_agreement.client_portal_reports_enabled then 'Client report delivery is disabled by contract' when v_reporting_ready then 'The configured monthly template exists for the provider' else 'Client reporting is enabled without a valid monthly template' end,'owner','Reporting administration','destination','reports')
  ));
end;$$;

revoke all on function public.get_crm_operational_readiness(uuid) from public,anon,authenticated;
grant execute on function public.get_crm_operational_readiness(uuid) to authenticated,service_role;