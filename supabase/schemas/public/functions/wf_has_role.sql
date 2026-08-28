create or replace function public.wf_has_role (
  _role public.wf_app_role
)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select exists (
    select 1
    from public.wf_user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.role = _role
  );
$function$;

grant execute on function "public"."wf_has_role"(public.wf_app_role) to "anon", "authenticated", "postgres", "service_role";

revoke all on function "public"."wf_has_role"(public.wf_app_role) from public;
