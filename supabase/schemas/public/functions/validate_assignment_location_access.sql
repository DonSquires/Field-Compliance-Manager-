create or replace function public.validate_assignment_location_access()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_assignment_org_id uuid;
  v_site_id           uuid := null;
  v_zone_id           uuid := null;
  v_has_access        boolean;
begin
  -- Resolve the assignment org from patrol_routes.
  select organization_id into v_assignment_org_id
    from public.patrol_routes
   where id = new.patrol_route_id;

  if v_assignment_org_id is null then
    raise exception 'Assignment (patrol_route_id=%) not found or has no organization_id.', new.patrol_route_id;
  end if;

  -- Determine which location is being added.
  if tg_table_name = 'patrol_route_sites' then
    v_site_id := new.site_id;
  else
    v_zone_id := new.zone_id;
  end if;

  -- Check ownership: does the assignment org own the location?
  if v_site_id is not null then
    select exists (
      select 1 from public.client_sites
      where id = v_site_id
        and client_organization_id = v_assignment_org_id
    ) into v_has_access;
  else
    select exists (
      select 1 from public.location_zones
      where id = v_zone_id
        and organization_id = v_assignment_org_id
    ) into v_has_access;
  end if;

  -- If not owner, check for an active service_agreement_locations row
  -- where the assignment org is the provider.
  if not v_has_access then
    select exists (
      select 1
      from public.service_agreement_locations sal
      join public.service_agreements sa on sa.id = sal.service_agreement_id
      where sal.status = 'active'
        and (sal.site_id = v_site_id or sal.zone_id = v_zone_id)
        and sa.provider_organization_id = v_assignment_org_id
    ) into v_has_access;
  end if;

  if not v_has_access then
    raise exception
      'Cannot add location to assignment: org % does not own this location and has no active service agreement for it. Create a service_agreement_locations row first.',
      v_assignment_org_id
      using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

grant execute on function "public"."validate_assignment_location_access"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."validate_assignment_location_access"() is 'Trigger: validates that the assignment org owns the location OR has an active service_agreement_locations row before allowing a location to be added to an assignment (patrol_route_sites / patrol_route_zones). QA gap G4, epic #179.';
