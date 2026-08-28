create or replace function public.autolink_client_site_service_agreement()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
begin
  if new.service_agreement_id is null and new.client_organization_id is not null then
    select sa.id
      into new.service_agreement_id
    from public.service_agreements sa
    where sa.client_organization_id = new.client_organization_id
      and (sa.ends_on is null or sa.ends_on >= current_date)
    order by sa.starts_on desc nulls last, sa.created_at desc, sa.id desc
    limit 1;
  end if;

  return new;
end;
$function$;

grant execute on function "public"."autolink_client_site_service_agreement"() to public, "anon", "authenticated", "postgres", "service_role";
