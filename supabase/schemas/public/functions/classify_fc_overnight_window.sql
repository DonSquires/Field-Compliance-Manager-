create or replace function public.classify_fc_overnight_window (
  p_observed_at timestamp with time zone,
  p_timezone    text                     default 'Pacific/Auckland'::text
)
  returns table (
    overnight_date date,
    scan_window    text
  )
  language sql
  stable
  AS $function$
  select
    case
      when ((p_observed_at at time zone p_timezone)::time >= time '00:00'
        and (p_observed_at at time zone p_timezone)::time < time '12:00')
      then ((p_observed_at at time zone p_timezone)::date - 1)
      else (p_observed_at at time zone p_timezone)::date
    end as overnight_date,
    case
      when ((p_observed_at at time zone p_timezone)::time >= time '00:00'
        and (p_observed_at at time zone p_timezone)::time < time '12:00')
      then 'morning'
      else 'evening'
    end as scan_window;
$function$;

grant execute on function "public"."classify_fc_overnight_window"(timestamp with time zone, text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."classify_fc_overnight_window"(timestamp with time zone, text) is 'Returns overnight_date and scan window for the two-photo FC verification model using local midnight boundary.';
