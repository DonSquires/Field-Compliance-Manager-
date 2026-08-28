create or replace function public.user_authorised_branch_ids()
  returns uuid[]
  language sql
  stable
  security definer
  AS $function$
  select coalesce(array_agg(branch_org_id), array[]::uuid[])
  from public.staff_branch_authorisations
  where user_id = auth.uid() and status = 'active';
$function$;

grant execute on function "public"."user_authorised_branch_ids"() to public, "anon", "authenticated", "postgres", "service_role";
