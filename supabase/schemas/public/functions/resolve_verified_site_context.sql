create or replace function public.resolve_verified_site_context(
  p_lat double precision,
  p_lng double precision,
  p_client_org_ids uuid[],
  p_module_key text default null,
  p_provider_org_id uuid default null
)
  returns table(site_id uuid, site_name text, location_id uuid, client_organization_id uuid, match_kind text)
  language sql
  stable
  security definer
  set search_path = public
  AS $function$
  with point as (
    select st_setsrid(st_point(p_lng, p_lat), 4326) geometry
  )
  select s.id, s.name, s.location_id, s.client_organization_id,
    case when st_covers(s.boundary, p.geometry) then 'verified_boundary' else 'verified_onsite_radius' end
  from public.client_sites s
  cross join point p
  where s.client_organization_id = any(coalesce(p_client_org_ids, '{}'::uuid[]))
    and s.active
    and s.boundary is not null
    and s.boundary_verification = 'verified'
    and st_isvalid(s.boundary)
    and not st_isempty(s.boundary)
    and (
      st_covers(s.boundary, p.geometry)
      or st_dwithin(
        coalesce(s.center_point, s.boundary)::geography,
        p.geometry::geography,
        coalesce(s.onsite_radius_meters, 10)
      )
    )
    and (
      p_module_key is null
      or exists (
        select 1
        from public.service_agreements sa
        join public.service_agreement_modules sam on sam.service_agreement_id = sa.id
          and sam.enabled and sam.module_key = p_module_key
        join public.service_agreement_locations sal on sal.service_agreement_id = sa.id
          and sal.site_id = s.id and sal.status = 'active'
        where sa.client_organization_id = s.client_organization_id
          and (p_provider_org_id is null or sa.provider_organization_id = p_provider_org_id)
          and sa.invitation_status = 'accepted'
          and sa.starts_on <= current_date
          and (sa.ends_on is null or sa.ends_on >= current_date)
      )
    )
  order by case when st_covers(s.boundary, p.geometry) then 0 else 1 end,
    st_area(s.boundary), s.name
  limit 1;
$function$;

revoke all on function public.resolve_verified_site_context(double precision, double precision, uuid[], text, uuid) from public, anon, authenticated;
grant execute on function public.resolve_verified_site_context(double precision, double precision, uuid[], text, uuid) to service_role;

comment on function public.resolve_verified_site_context(double precision, double precision, uuid[], text, uuid) is 'Service-only verified Site resolver. When module_key is supplied, only returns Sites linked to an accepted active service agreement with that module enabled; legacy callers may omit module_key.';