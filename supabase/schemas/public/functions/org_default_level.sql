create or replace function public.org_default_level (
  p_type text
)
  returns smallint
  language sql
  immutable
  AS $function$
  select case p_type
    when 'owner'              then 0
    when 'service_provider'   then 1
    when 'government'         then 2
    when 'private_enterprise' then 2
    when 'branch'             then 2
    when 'contractor'         then 3
    when 'client'             then 4
    else 2
  end::smallint;
$function$;

grant execute on function "public"."org_default_level"(text) to public, "anon", "authenticated", "postgres", "service_role";
