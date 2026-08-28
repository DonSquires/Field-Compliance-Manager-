create or replace function public.complete_shift_stop (
  p_stop_id       uuid,
  p_officer_notes text             default null::text,
  p_gps_lat       double precision default null::double precision,
  p_gps_lng       double precision default null::double precision
)
  returns void
  language plpgsql
  security definer
  AS $function$
declare
  v_stop record;
begin
  select * into v_stop from shift_stops where id = p_stop_id;
  if not found then
    raise exception 'Shift stop % not found', p_stop_id;
  end if;

  update shift_stops
  set status              = 'completed',
      sla_status          = case
                              when actual_arrived_at is null then 'completed'
                              when actual_arrived_at > sla_arrive_by then 'breached'
                              else 'completed'
                            end,
      actual_departed_at  = now(),
      officer_notes       = coalesce(p_officer_notes, officer_notes),
      updated_at          = now()
  where id = p_stop_id;

  -- Increment completed_stops on the shift.
  update shifts
  set completed_stops = completed_stops + 1
  where id = v_stop.shift_id;
end;
$function$;

grant execute on function "public"."complete_shift_stop"(uuid, text, double precision, double precision) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."complete_shift_stop"(uuid, text, double precision, double precision) is 'Marks a shift stop as completed and updates shift progress counters.';
