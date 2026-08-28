create or replace function public.is_master_or_above()
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid() and role in ('grand_master', 'master')
  );
$function$;

grant execute on function "public"."is_master_or_above"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."is_master_or_above"() is 'True if the current user is master or grand_master. Gate for runtime role/preset editing (issue #3, C1).';
