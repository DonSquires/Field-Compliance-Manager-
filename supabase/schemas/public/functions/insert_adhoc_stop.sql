create or replace function public.insert_adhoc_stop (
  p_shift_id        uuid,
  p_dispatch_job_id uuid,
  p_site_id         uuid,
  p_module_key      text,
  p_sla_respond_by  timestamp with time zone,
  p_officer_gps_lat double precision,
  p_officer_gps_lng double precision
)
  returns uuid
  language plpgsql
  security definer
  AS $function$
declare
  v_shift     record;
  v_stop_id   uuid;
  v_max_order integer;
begin
  select * into v_shift from shifts where id = p_shift_id;
  if not found then
    raise exception 'Shift % not found', p_shift_id;
  end if;

  -- Place adhoc stop at end of current sequence.
  select coalesce(max(stop_order), 0) into v_max_order
  from shift_stops
  where shift_id = p_shift_id
    and status = 'pending';

  insert into shift_stops (
    organization_id,
    shift_id,
    dispatch_job_id,
    site_id,
    module_key,
    stop_order,
    visit_number,
    is_adhoc,
    sla_arrive_by,
    required_dwell_minutes,
    status,
    sla_status
  ) values (
    v_shift.organization_id,
    p_shift_id,
    p_dispatch_job_id,
    p_site_id,
    p_module_key,
    v_max_order + 10,
    1,
    true,
    p_sla_respond_by,
    15,  -- default dwell for adhoc; API can update after insertion
    'pending',
    'on_track'
  )
  returning id into v_stop_id;

  -- Mark dispatch job as inserted into shift.
  update dispatch_jobs
  set shift_id          = p_shift_id,
      shift_stop_id     = v_stop_id,
      adhoc_inserted_at = now(),
      insert_gps_lat    = p_officer_gps_lat,
      insert_gps_lng    = p_officer_gps_lng,
      status            = 'dispatched'
  where id = p_dispatch_job_id;

  -- Invalidate solve cache so API re-solves with new stop.
  update patrol_solve_cache
  set invalidated_at      = now(),
      invalidation_reason = 'adhoc_inserted'
  where shift_id = p_shift_id;

  return v_stop_id;
end;
$function$;

grant execute
  on function "public"."insert_adhoc_stop"(uuid, uuid, uuid, text, timestamp with time zone, double precision, double precision)
  to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."insert_adhoc_stop"(uuid, uuid, uuid, text, timestamp with time zone, double precision, double precision) is 'Inserts an adhoc dispatch job as a shift stop and invalidates the solve cache. Called by apps/api dispatch engine.';
