create or replace function public.my_entitled_org_ids_for_user (
  p_user_id uuid
)
  returns SETOF uuid
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select public._entitled_org_ids_for(p_user_id);
$function$;

grant execute on function "public"."my_entitled_org_ids_for_user"(uuid) to "postgres", "service_role";

comment on function "public"."my_entitled_org_ids_for_user"(uuid) is 'SERVICE-ROLE ONLY entitlement resolver for an EXPLICIT user id. Same set as my_entitled_org_ids() would return for that user (shared _entitled_org_ids_for). For back-end callers with no user JWT (the Bob conductor admin client, #306). REVOKED from public/authenticated/anon and granted to service_role ONLY - a user JWT cannot call it, so it is NOT an impersonation surface. Mirrors the 0125 bob_execute_read_query grant pattern.';

revoke all on function "public"."my_entitled_org_ids_for_user"(uuid) from public;
