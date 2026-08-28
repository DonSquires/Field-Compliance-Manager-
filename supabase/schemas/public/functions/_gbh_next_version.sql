create or replace function public._gbh_next_version (
  p_entity_type text,
  p_entity_id   uuid
)
  returns integer
  language sql
  stable
  AS $function$
  SELECT COALESCE(MAX(version), 0) + 1
    FROM public.geofence_boundary_history
   WHERE entity_type = p_entity_type
     AND entity_id   = p_entity_id;
$function$;

grant execute on function "public"."_gbh_next_version"(text, uuid) to public, "anon", "authenticated", "postgres", "service_role";
