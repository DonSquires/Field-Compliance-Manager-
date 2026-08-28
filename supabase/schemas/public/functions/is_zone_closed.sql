create or replace function public.is_zone_closed (
  p_zone_id uuid,
  p_at      timestamp with time zone default now()
)
  returns jsonb
  language sql
  stable
  security definer
  AS $function$
  select jsonb_build_object(
    'closed',       true,
    'closure_id',   c.id,
    'closure_type', c.closure_type,
    'reason',       c.reason,
    'effective_from', c.effective_from,
    'effective_to',   c.effective_to
  )
  from zone_closures c
  where c.zone_id = p_zone_id
    and c.status <> 'lifted'
    and c.effective_from <= (p_at at time zone 'Pacific/Auckland')::date
    and (c.effective_to is null
         or c.effective_to >= (p_at at time zone 'Pacific/Auckland')::date)
  order by
    case c.closure_type
      when 'prohibited' then 0
      when 'restricted' then 1
      else 2
    end asc,
    c.effective_from desc
  limit 1;
$function$;

grant execute on function "public"."is_zone_closed"(uuid, timestamp with time zone) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."is_zone_closed"(uuid, timestamp with time zone) is 'Returns the in-force closure for a zone at p_at as JSON (closed, closure_id, closure_type, reason, dates), or NULL when the zone is open. prohibited > restricted > temporary_closure. Dates compared in Pacific/Auckland.';
