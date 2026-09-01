alter table public.observations add column if not exists geofence_context jsonb not null default '{}'::jsonb;
alter table public.parking_chalk_records add column if not exists geofence_context jsonb not null default '{}'::jsonb;

comment on column public.observations.geofence_context is 'Immutable-at-capture snapshot of resolve_context and is_zone_closed evidence used by the officer scan. Geometry answers where; rules and closure overlays answer what.';
comment on column public.parking_chalk_records.geofence_context is 'Immutable-at-capture snapshot of resolve_context and is_zone_closed evidence used by the parking scan. Geometry answers where; rules and closure overlays answer what.';

create function public.preserve_scan_geofence_context() returns trigger language plpgsql set search_path=public as $$
begin
	if old.geofence_context<>'{}'::jsonb and new.geofence_context is distinct from old.geofence_context then raise exception 'Captured geofence context is immutable';end if;
	return new;
end;$$;

create trigger trg_observations_preserve_geofence_context before update of geofence_context on public.observations for each row execute function public.preserve_scan_geofence_context();
create trigger trg_parking_chalk_preserve_geofence_context before update of geofence_context on public.parking_chalk_records for each row execute function public.preserve_scan_geofence_context();

revoke all on function public.preserve_scan_geofence_context() from public,anon,authenticated;
grant execute on function public.preserve_scan_geofence_context() to service_role;