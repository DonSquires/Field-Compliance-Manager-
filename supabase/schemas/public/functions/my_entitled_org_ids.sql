create or replace function public.my_entitled_org_ids()
  returns SETOF uuid
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select public._entitled_org_ids_for(auth.uid());
$function$;

grant execute on function "public"."my_entitled_org_ids"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."my_entitled_org_ids"() is 'Set-returning resolver: org ids the CURRENT user (auth.uid()) is entitled to see. Self-only (no user param) - the impersonation-safe UI primitive. Delegates to _entitled_org_ids_for(auth.uid()); behaviour identical to 0352. Safety contract: o IN my_entitled_org_ids() IFF org_access_allowed(o). Granted to authenticated. #264.';
