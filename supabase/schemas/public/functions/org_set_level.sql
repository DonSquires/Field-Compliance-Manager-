create or replace function public.org_set_level()
  returns trigger
  language plpgsql
  AS $function$
declare
  parent_level smallint;
begin
  if new.parent_organization_id is null then
    new.organization_level := public.org_default_level(new.organization_type);
  else
    select organization_level into parent_level
      from public.organizations where id = new.parent_organization_id;
    if parent_level is null then
      new.organization_level := public.org_default_level(new.organization_type);
    else
      new.organization_level := (parent_level + 1)::smallint;
    end if;
  end if;
  return new;
end;
$function$;

grant execute on function "public"."org_set_level"() to public, "anon", "authenticated", "postgres", "service_role";
