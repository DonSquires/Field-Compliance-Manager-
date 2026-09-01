create function public.resolve_context_authorized(
  p_lat double precision,
  p_lng double precision,
  p_org_id uuid,
  p_module_key text default null,
  p_at timestamptz default now()
)
returns table(
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
)
language plpgsql stable security definer set search_path=public as $$
begin
  if auth.uid() is null or not public.org_access_allowed(p_org_id) then
    raise exception 'Geofence context access denied';
  end if;
  return query select * from public.resolve_context(p_lat,p_lng,p_org_id,p_module_key,p_at);
end;$$;

revoke all on function public.resolve_context(double precision,double precision,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.resolve_context(double precision,double precision,uuid,text,timestamptz) to service_role;
revoke all on function public.resolve_context_authorized(double precision,double precision,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.resolve_context_authorized(double precision,double precision,uuid,text,timestamptz) to authenticated;

comment on function public.resolve_context_authorized(double precision,double precision,uuid,text,timestamptz) is 'Authenticated tenant-scoped wrapper for resolve_context. The underlying canonical resolver is service-role only; browser callers must pass org_access_allowed for p_org_id.';