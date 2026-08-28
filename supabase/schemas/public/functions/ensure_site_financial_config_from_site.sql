create or replace function public.ensure_site_financial_config_from_site()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
begin
  if new.service_agreement_id is null then
    return new;
  end if;

  insert into public.site_financial_config (
    organization_id,
    site_id,
    service_agreement_id,
    billing_model,
    billing_cycle,
    gst_registered,
    gst_rate,
    payment_terms_days,
    minimum_hours,
    active
  )
  values (
    new.client_organization_id,
    new.id,
    new.service_agreement_id,
    'hourly',
    'monthly',
    true,
    0.15,
    14,
    2,
    true
  )
  on conflict (site_id, service_agreement_id) do nothing;

  return new;
end;
$function$;

grant execute on function "public"."ensure_site_financial_config_from_site"() to public, "anon", "authenticated", "postgres", "service_role";
