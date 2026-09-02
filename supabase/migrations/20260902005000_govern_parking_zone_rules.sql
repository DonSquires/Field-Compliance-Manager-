create or replace function public.manage_parking_zone_rule(
  p_zone_id uuid,
  p_expected_version integer,
  p_time_limit_minutes integer,
  p_disabled_multiplier numeric,
  p_limit_source text,
  p_signage_photo_path text default null
) returns public.location_zones
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_zone public.location_zones%rowtype;
begin
  select organization_id into v_provider
  from public.user_profiles
  where id = v_actor and deactivated_at is null;

  select * into v_zone
  from public.location_zones
  where id = p_zone_id
  for update;

  if not found
    or v_provider is null
    or not public.is_admin_for_org(v_provider)
    or not public.crm_actor_can_manage_location(v_zone.location_id)
  then
    raise exception 'Active administrator required for this Parking zone';
  end if;
  if v_zone.zone_type <> 'parking' or v_zone.module_key <> 'parking_enforcement' then
    raise exception 'Parking rules require a Parking enforcement zone';
  end if;
  if v_zone.configuration_version <> p_expected_version then
    raise exception 'Zone configuration changed since it was opened';
  end if;
  if p_time_limit_minutes is null or p_time_limit_minutes < 1 or p_time_limit_minutes > 1440 then
    raise exception 'Parking time limit must be between 1 and 1440 minutes';
  end if;
  if p_disabled_multiplier is null or p_disabled_multiplier < 1 or p_disabled_multiplier > 4 then
    raise exception 'Disabled-bay multiplier must be between 1 and 4';
  end if;
  if p_limit_source not in ('manual', 'bob_signage', 'rfp_seed') then
    raise exception 'Supported Parking rule provenance is required';
  end if;
  if p_signage_photo_path is not null then
    if p_signage_photo_path not like 'org/' || v_zone.organization_id::text || '/parking-signage/' || v_zone.id::text || '/%' then
      raise exception 'Parking signage path is outside the governed zone';
    end if;
    if not exists (
      select 1 from storage.objects
      where bucket_id = 'scans' and name = p_signage_photo_path
    ) then
      raise exception 'Parking signage evidence was not found';
    end if;
  end if;

  update public.location_zones
  set parking_time_limit_minutes = p_time_limit_minutes,
      parking_disabled_multiplier = p_disabled_multiplier,
      parking_limit_source = p_limit_source,
      parking_signage_photo_url = coalesce(p_signage_photo_path, parking_signage_photo_url),
      parking_limit_set_by = v_actor,
      parking_limit_set_at = clock_timestamp(),
      configuration_version = configuration_version + 1
  where id = v_zone.id
  returning * into v_zone;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_provider,
    v_actor,
    'parking_zone_rule_updated',
    'location_zones',
    v_zone.id,
    jsonb_build_object(
      'zone_organization_id', v_zone.organization_id,
      'configuration_version', v_zone.configuration_version,
      'time_limit_minutes', v_zone.parking_time_limit_minutes,
      'disabled_multiplier', v_zone.parking_disabled_multiplier,
      'limit_source', v_zone.parking_limit_source,
      'signage_photo_path', v_zone.parking_signage_photo_url
    )
  );
  return v_zone;
end;
$$;

revoke all on function public.manage_parking_zone_rule(uuid,integer,integer,numeric,text,text) from public, anon, authenticated;
grant execute on function public.manage_parking_zone_rule(uuid,integer,integer,numeric,text,text) to authenticated, service_role;

revoke insert, update, delete on table public.parking_chalk_records from public, anon, authenticated;
revoke update on table public.location_zones from public, anon, authenticated;