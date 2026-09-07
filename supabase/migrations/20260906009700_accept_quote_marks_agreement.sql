CREATE OR REPLACE FUNCTION public.accept_quote(p_quote_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare
  v_quote            public.quotes%rowtype;
  v_role             text;
  v_caller_org       uuid;
  v_employer_org     uuid;
  v_agreement_id     uuid;
  v_base_rate        numeric;
  v_callout_rate     numeric;
  v_travel_rate      numeric;
  v_site             record;
  v_site_rate        numeric;
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if not found then
    raise exception 'accept_quote: quote % not found', p_quote_id;
  end if;

  select role, organization_id, employer_organization_id into v_role, v_caller_org, v_employer_org
  from public.user_profiles where id = auth.uid();

  if not (
    public.is_grand_master()
    or (
      v_role in ('master','admin','admin_officer')
      and v_quote.provider_org_id = any(public.get_descendant_organizations(coalesce(v_employer_org, v_caller_org)))
    )
  ) then
    raise exception 'accept_quote: not authorised to accept quotes for this provider';
  end if;

  if v_quote.status = 'accepted' and v_quote.service_agreement_id is not null then
    return v_quote.service_agreement_id;
  end if;

  if v_quote.status not in ('draft','sent') then
    raise exception 'accept_quote: quote status % cannot be accepted', v_quote.status;
  end if;
  if v_quote.client_org_id is null then
    raise exception 'accept_quote: quote has no client organisation; a service agreement requires a real client (set client_org_id before accepting)';
  end if;

  v_agreement_id := v_quote.service_agreement_id;

  if v_agreement_id is null then
    select id into v_agreement_id
    from public.service_agreements
    where provider_organization_id = v_quote.provider_org_id
      and client_organization_id  = v_quote.client_org_id
      and name = v_quote.title
    limit 1;
  end if;

  if v_agreement_id is null then
    insert into public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status)
    values (v_quote.provider_org_id, v_quote.client_org_id, v_quote.title, current_date, 'operational', 'accepted')
    returning id into v_agreement_id;
  else
    update public.service_agreements
    set agreement_type = 'operational',
        invitation_status = 'accepted',
        updated_at = now()
    where id = v_agreement_id;
  end if;

  select avg(unit_charge) into v_base_rate
  from public.quote_lines where quote_id = p_quote_id and kind in ('labour','module') and unit_charge > 0;

  select avg(unit_charge) into v_travel_rate
  from public.quote_lines where quote_id = p_quote_id and kind = 'travel' and unit_charge > 0;

  select avg(unit_charge) into v_callout_rate
  from public.quote_lines where quote_id = p_quote_id and kind in ('platform_fee','custom')
    and unit_charge > 0 and lower(description) like '%callout%';

  if exists (select 1 from public.crm_commercial_settings where service_agreement_id = v_agreement_id) then
    update public.crm_commercial_settings set
      currency            = v_quote.currency,
      base_rate_per_hour  = coalesce(v_base_rate, base_rate_per_hour),
      callout_rate_per_hour = coalesce(v_callout_rate, callout_rate_per_hour),
      travel_rate_per_km  = coalesce(v_travel_rate, travel_rate_per_km)
    where service_agreement_id = v_agreement_id;
  else
    insert into public.crm_commercial_settings
      (service_agreement_id, currency, base_rate_per_hour, callout_rate_per_hour, travel_rate_per_km)
    values
      (v_agreement_id, v_quote.currency, v_base_rate, v_callout_rate, v_travel_rate);
  end if;

  for v_site in
    select distinct site_id from public.quote_lines
    where quote_id = p_quote_id and site_id is not null
  loop
    select avg(unit_charge) into v_site_rate
    from public.quote_lines
    where quote_id = p_quote_id and site_id = v_site.site_id and kind in ('labour','module') and unit_charge > 0;
    v_site_rate := coalesce(v_site_rate, v_base_rate);

    if exists (
      select 1 from public.site_financial_config
      where site_id = v_site.site_id and service_agreement_id = v_agreement_id
    ) then
      update public.site_financial_config set
        billing_model = 'hourly',
        hourly_rate   = coalesce(v_site_rate, hourly_rate),
        updated_at    = now()
      where site_id = v_site.site_id and service_agreement_id = v_agreement_id;
    else
      insert into public.site_financial_config
        (organization_id, site_id, service_agreement_id, billing_model, hourly_rate)
      values
        (v_quote.provider_org_id, v_site.site_id, v_agreement_id, 'hourly', v_site_rate);
    end if;
  end loop;

  update public.quotes set
    status               = 'accepted',
    accepted_at          = now(),
    accepted_by          = auth.uid(),
    service_agreement_id = v_agreement_id,
    updated_by           = auth.uid()
  where id = p_quote_id;

  return v_agreement_id;
end $$;

REVOKE ALL ON FUNCTION public.accept_quote(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quote(uuid) TO service_role;
