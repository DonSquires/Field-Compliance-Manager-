create or replace function public.sync_service_agreement_location_from_site()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
begin
  if new.service_agreement_id is not null then
    insert into public.service_agreement_locations (
      service_agreement_id,
      site_id,
      status,
      created_by
    )
    values (
      new.service_agreement_id,
      new.id,
      'active',
      null
    )
    on conflict (service_agreement_id, site_id) do update
      set status = excluded.status,
          updated_at = now();
  end if;

  return new;
end;
$function$;

grant execute on function "public"."sync_service_agreement_location_from_site"() to public, "anon", "authenticated", "postgres", "service_role";
