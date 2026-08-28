create or replace function public.record_sla_arrival (
  p_clock_id   uuid,
  p_arrived_at timestamp with time zone default now()
)
  returns text
  language plpgsql
  security definer
  AS $function$
declare
  v_clock   sla_clocks%rowtype;
  v_elapsed integer;
  v_status  text;
begin
  select * into v_clock from sla_clocks where id = p_clock_id;
  if not found then
    raise exception 'SLA clock not found';
  end if;
  if not org_access_allowed(v_clock.organization_id) then
    raise exception 'Access denied';
  end if;

  v_elapsed := ceil(extract(epoch from (p_arrived_at - v_clock.started_at)) / 60.0);

  if v_clock.target_minutes is null then
    v_status := 'met'; -- no target = informational only
  elsif v_elapsed <= v_clock.target_minutes then
    v_status := 'met';
  else
    v_status := 'breached';
  end if;

  update sla_clocks
  set arrived_at      = p_arrived_at,
      elapsed_minutes = v_elapsed,
      status          = v_status,
      updated_at      = now()
  where id = p_clock_id;

  return v_status;
end;
$function$;

grant execute on function "public"."record_sla_arrival"(uuid, timestamp with time zone) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."record_sla_arrival"(uuid, timestamp with time zone) is 'Stops an SLA clock at arrival, computes elapsed minutes, records met/breached vs target_minutes, and returns the resulting status.';
