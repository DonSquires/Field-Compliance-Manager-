create or replace function public._geofence_active_at (
  p_schedule jsonb,
  p_at       timestamp with time zone
)
  returns boolean
  language plpgsql
  immutable
  AS $function$
declare
  v_local   timestamp := p_at at time zone 'Pacific/Auckland';
  v_minutes int := extract(hour from v_local)::int * 60 + extract(minute from v_local)::int;
  v_dow     int := extract(dow from v_local)::int;   -- 0=Sunday
  v_start   text;
  v_end     text;
  v_start_m int;
  v_end_m   int;
  v_days    jsonb;
begin
  if p_schedule is null or p_schedule = '{}'::jsonb then
    return true;
  end if;

  -- Day-of-week filter.
  v_days := p_schedule -> 'days';
  if v_days is not null and jsonb_typeof(v_days) = 'array' and jsonb_array_length(v_days) > 0 then
    if not exists (
      select 1 from jsonb_array_elements_text(v_days) d where d::int = v_dow
    ) then
      return false;
    end if;
  end if;

  -- Time-of-day window.
  v_start := p_schedule ->> 'start';
  v_end   := p_schedule ->> 'end';
  if v_start is null or v_end is null then
    return true;  -- day matched (or no day filter) and no time window = active
  end if;

  v_start_m := split_part(v_start, ':', 1)::int * 60 + split_part(v_start, ':', 2)::int;
  v_end_m   := split_part(v_end,   ':', 1)::int * 60 + split_part(v_end,   ':', 2)::int;

  if v_start_m <= v_end_m then
    return v_minutes >= v_start_m and v_minutes < v_end_m;            -- same-day window
  else
    return v_minutes >= v_start_m or v_minutes < v_end_m;             -- overnight wrap
  end if;
end;
$function$;

grant execute on function "public"."_geofence_active_at"(jsonb, timestamp with time zone) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."_geofence_active_at"(jsonb, timestamp with time zone) is 'True if a module geofence active_schedule (jsonb {start,end,days}) is in force at the given time (Pacific/Auckland). Null schedule = always active; start>end wraps midnight.';
