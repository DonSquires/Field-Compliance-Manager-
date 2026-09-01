create function public.resolve_operational_context(
  p_lat double precision,
  p_lng double precision,
  p_org_id uuid,
  p_module_key text default null,
  p_at timestamptz default now()
) returns table(
  in_operating_bounds boolean,
  out_of_bounds_district text,
  governing_jurisdiction_id uuid,
  governing_jurisdiction_name text,
  on_site boolean,
  site_id uuid,
  client_org_id uuid,
  matched_zone_id uuid,
  matched_module_key text,
  effective_rules jsonb,
  resolution_status text,
  governor_overlap_flag boolean
) language plpgsql stable security definer set search_path=public as $$
declare
  v_direct record;
  v_contracted record;
begin
  select * into v_direct from public.resolve_context(p_lat,p_lng,p_org_id,p_module_key,p_at);
  if v_direct.matched_zone_id is not null or v_direct.site_id is not null then
    return query select v_direct.in_operating_bounds,v_direct.out_of_bounds_district,v_direct.governing_jurisdiction_id,v_direct.governing_jurisdiction_name,v_direct.on_site,v_direct.site_id,v_direct.client_org_id,v_direct.matched_zone_id,v_direct.matched_module_key,v_direct.effective_rules,v_direct.resolution_status,v_direct.governor_overlap_flag;
    return;
  end if;

  select rc.* into v_contracted
  from public.service_agreements sa
  join public.service_agreement_modules sam on sam.service_agreement_id=sa.id and sam.enabled and (p_module_key is null or sam.module_key=p_module_key)
  join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
  cross join lateral public.resolve_context(p_lat,p_lng,sa.client_organization_id,p_module_key,p_at) rc
  where sa.provider_organization_id=p_org_id
    and sa.invitation_status='accepted'
    and sa.starts_on<=p_at::date
    and (sa.ends_on is null or sa.ends_on>=p_at::date)
    and rc.resolution_status='resolved'
    and ((sal.zone_id is not null and sal.zone_id=rc.matched_zone_id) or (sal.site_id is not null and sal.site_id=rc.site_id))
  order by case when sal.zone_id=rc.matched_zone_id then 0 else 1 end
  limit 1;

  if found then
    return query select true,null::text,v_contracted.governing_jurisdiction_id,v_contracted.governing_jurisdiction_name,v_contracted.on_site,v_contracted.site_id,v_contracted.client_org_id,v_contracted.matched_zone_id,v_contracted.matched_module_key,v_contracted.effective_rules,v_contracted.resolution_status,v_contracted.governor_overlap_flag;
    return;
  end if;

  return query select v_direct.in_operating_bounds,v_direct.out_of_bounds_district,v_direct.governing_jurisdiction_id,v_direct.governing_jurisdiction_name,v_direct.on_site,v_direct.site_id,v_direct.client_org_id,v_direct.matched_zone_id,v_direct.matched_module_key,v_direct.effective_rules,v_direct.resolution_status,v_direct.governor_overlap_flag;
end;$$;

revoke all on function public.resolve_operational_context(double precision,double precision,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.resolve_operational_context(double precision,double precision,uuid,text,timestamptz) to service_role;

comment on function public.resolve_operational_context(double precision,double precision,uuid,text,timestamptz) is 'Service-only field-operation resolver. Preserves direct organization resolution, then permits only accepted active agreement places with enabled modules and active service-agreement location links.';