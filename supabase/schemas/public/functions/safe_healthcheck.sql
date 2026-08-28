create or replace function public.safe_healthcheck()
  returns jsonb
  language sql
  stable
  set search_path to 'public'
  AS $function$
  select jsonb_build_object(
    'ok', true,
    'uid', (select auth.uid()),
    'ts', now()
  );
$function$;

grant execute on function "public"."safe_healthcheck"() to "authenticated", "postgres", "service_role";

revoke all on function "public"."safe_healthcheck"() from public;
