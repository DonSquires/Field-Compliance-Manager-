create or replace function public.sync_client_sites_org_ids()
  returns trigger
  language plpgsql
  AS $function$
begin
  if new.organization_id is null and new.client_organization_id is not null then
    new.organization_id := new.client_organization_id;
  end if;

  if new.client_organization_id is null and new.organization_id is not null then
    new.client_organization_id := new.organization_id;
  end if;

  return new;
end;
$function$;

grant execute on function "public"."sync_client_sites_org_ids"() to public, "anon", "authenticated", "postgres", "service_role";
