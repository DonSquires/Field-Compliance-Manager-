create or replace function public.current_user_role()
  returns text
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select role from user_profiles where id = auth.uid() limit 1;
$function$;

grant execute on function "public"."current_user_role"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."current_user_role"() is 'Returns the role of the currently authenticated user.';
