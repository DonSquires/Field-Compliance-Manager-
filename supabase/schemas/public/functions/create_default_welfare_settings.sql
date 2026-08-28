create or replace function public.create_default_welfare_settings()
  returns trigger
  language plpgsql
  security definer
  AS $function$
begin
  if new.role in ('officer', 'admin_officer') and new.organization_id is not null then
    insert into officer_welfare_settings (organization_id, officer_user_id)
    values (new.organization_id, new.id)
    on conflict (officer_user_id, organization_id) do nothing;
  end if;
  return new;
end;
$function$;

grant execute on function "public"."create_default_welfare_settings"() to public, "anon", "authenticated", "postgres", "service_role";
