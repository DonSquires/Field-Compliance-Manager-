drop function if exists public.get_crm_site_boundary_queue();

create function public.get_crm_site_boundary_queue()
returns table(site_id uuid,account_organization_id uuid,account_name text,site_name text,address text,site_type text,active boolean,gps_lat double precision,gps_lng double precision,boundary_status text,boundary_verification text,boundary_verified_at timestamptz,has_boundary boolean,boundary_geojson jsonb)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return query select s.id,o.id,o.name,s.name,s.address,s.site_type,s.active,s.gps_lat,s.gps_lng,s.boundary_status,s.boundary_verification,s.boundary_verified_at,(s.boundary is not null),case when s.boundary is null then null else public.st_asgeojson(s.boundary)::jsonb end
  from public.client_sites s join public.organizations o on o.id=s.client_organization_id
  where public.crm_actor_can_manage_account(o.id)
  order by case when s.boundary_verification='unverified' then 0 else 1 end,case when s.boundary_status='provisional' then 0 else 1 end,o.name,s.name;
end;$$;

revoke all on function public.get_crm_site_boundary_queue() from public,anon,authenticated;
grant execute on function public.get_crm_site_boundary_queue() to authenticated,service_role;

comment on function public.get_crm_site_boundary_queue() is 'Returns manageable CRM sites with current boundary GeoJSON for governed visual review. Geometry remains scoped by crm_actor_can_manage_account.';