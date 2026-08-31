create function public.resolve_verified_site_context(p_lat double precision,p_lng double precision,p_client_org_ids uuid[])
returns table(site_id uuid,site_name text,location_id uuid,client_organization_id uuid,match_kind text)
language sql stable security definer set search_path=public as $$
  with point as(select st_setsrid(st_point(p_lng,p_lat),4326) geometry)
  select s.id,s.name,s.location_id,s.client_organization_id,
    case when st_covers(s.boundary,p.geometry) then 'verified_boundary' else 'verified_onsite_radius' end
  from public.client_sites s cross join point p
  where s.client_organization_id=any(coalesce(p_client_org_ids,'{}'::uuid[]))
    and s.active
    and s.boundary is not null
    and s.boundary_verification='verified'
    and st_isvalid(s.boundary)
    and not st_isempty(s.boundary)
    and (st_covers(s.boundary,p.geometry) or st_dwithin(coalesce(s.center_point,s.boundary)::geography,p.geometry::geography,coalesce(s.onsite_radius_meters,10)))
  order by case when st_covers(s.boundary,p.geometry) then 0 else 1 end,st_area(s.boundary),s.name
  limit 1;
$$;

revoke all on function public.resolve_verified_site_context(double precision,double precision,uuid[]) from public,anon,authenticated;
grant execute on function public.resolve_verified_site_context(double precision,double precision,uuid[]) to service_role;

comment on function public.resolve_verified_site_context(double precision,double precision,uuid[]) is 'Service-only standalone Site resolver. Matches only active, valid, verified Site geometry within an already-authorized client organization scope; prefers polygon coverage over the configured on-site radius.';