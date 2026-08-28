create or replace function public.get_org_geofence_config (
  p_org_id     uuid,
  p_config_key text,
  p_zone_type  text    default null::text,
  p_default    integer default null::integer
)
  returns integer
  language sql
  stable
  security definer
  AS $function$
  SELECT COALESCE(
    -- Try zone-type-specific override first
    (SELECT config_value FROM public.org_geofence_config
     WHERE organization_id = p_org_id
       AND config_key = p_config_key
       AND zone_type = p_zone_type
     LIMIT 1),
    -- Then org-wide (zone_type IS NULL)
    (SELECT config_value FROM public.org_geofence_config
     WHERE organization_id = p_org_id
       AND config_key = p_config_key
       AND zone_type IS NULL
     LIMIT 1),
    -- Platform default
    p_default
  );
$function$;

grant execute on function "public"."get_org_geofence_config"(uuid, text, text, integer) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."get_org_geofence_config"(uuid, text, text, integer) is 'Reads an org geofence config value with zone-type-specific override -> org-wide -> platform default fallback. Platform defaults: site_provisional_radius_m=50, zone_provisional_radius_m=100, checkpoint_radius_m=5.';
