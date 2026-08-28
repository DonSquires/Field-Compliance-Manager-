create or replace function public.is_grand_master()
  returns boolean
  language sql
  stable
  security definer
  AS $function$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid() and role = 'grand_master'
  );
$function$;

grant execute on function "public"."is_grand_master"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."is_grand_master"() is 'Returns true if the current user has the grand_master role.';
