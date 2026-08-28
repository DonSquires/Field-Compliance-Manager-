create or replace function public.sync_authorised_org_ids()
  returns trigger
  language plpgsql
  AS $function$
declare
  affected uuid;
begin
  affected := coalesce(new.user_id, old.user_id);
  update public.user_profiles up
    set authorized_organization_ids = (
      select coalesce(array_agg(branch_org_id), array[]::uuid[])
      from public.staff_branch_authorisations
      where user_id = affected and status = 'active'
    )
  where up.id = affected;
  return null;
end;
$function$;

grant execute on function "public"."sync_authorised_org_ids"() to public, "anon", "authenticated", "postgres", "service_role";
