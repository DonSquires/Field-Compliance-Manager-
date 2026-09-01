create or replace function public.preserve_scan_geofence_context()
  returns trigger
  language plpgsql
  set search_path = public
  AS $function$
begin
  if old.geofence_context <> '{}'::jsonb
     and new.geofence_context is distinct from old.geofence_context then
    raise exception 'Captured geofence context is immutable';
  end if;
  return new;
end;
$function$;

revoke all on function public.preserve_scan_geofence_context() from public, anon, authenticated;
grant execute on function public.preserve_scan_geofence_context() to service_role;