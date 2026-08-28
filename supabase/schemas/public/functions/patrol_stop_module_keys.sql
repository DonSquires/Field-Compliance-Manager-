create or replace function public.patrol_stop_module_keys (
  p_stop_id uuid
)
  returns SETOF text
  language sql
  stable
  security definer
  AS $function$
  select module_key
  from public.shift_stop_modules
  where shift_stop_id = p_stop_id
  order by module_key;
$function$;

grant execute on function "public"."patrol_stop_module_keys"(uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."patrol_stop_module_keys"(uuid) is 'Returns the module_key list for a shift stop from shift_stop_modules (canonical many-modules-per-stop, unified stop model !709). The engine/solver should carry all of these, not just the legacy singular shift_stops.module_key.';
