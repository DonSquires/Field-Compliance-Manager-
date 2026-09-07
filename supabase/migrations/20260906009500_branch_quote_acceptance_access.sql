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

  -- ── Authz: grand_master, or admin/master/admin_officer of the provider tree ──
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

  -- ── Idempotency: already accepted -> return the linked agreement ────────────
  if v_quote.status = 'accepted' and v_quote.service_agreement_id is not null then
    return v_quote.service_agreement_id;
  end if;

  -- ── Guards ─────────────────────────────────────────────────────────────────
  if v_quote.status not in ('draft','sent') then
    raise exception 'accept_quote: quote status % cannot be accepted', v_quote.status;
  end if;
  if v_quote.client_org_id is null then
    raise exception 'accept_quote: quote has no client organisation; a service agreement requires a real client (set client_org_id before accepting)';
  end if;

  -- ── Service agreement: reuse linked, else check-then-create ─────────────────
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
    select base_rate_per_hour, callout_rate, travel_rate
      into v_base_rate, v_callout_rate, v_travel_rate
    from public.organization_settings
    where organization_id = v_quote.provider_org_id;

    insert into public.service_agreements(
      client_organization_id,
      provider_organization_id,
      name,
      agreement_type,
      invitation_status,
      base_rate_per_hour,
      callout_rate,
      travel_rate,
      accepted_at,
      accepted_by
    ) values (
      v_quote.client_org_id,
      v_quote.provider_org_id,
      v_quote.title,
      'operational',
      'accepted',
      v_base_rate,
      v_callout_rate,
      v_travel_rate,
      now(),
      auth.uid()
    ) returning id into v_agreement_id;
  else
    update public.service_agreements
    set invitation_status = 'accepted',
        accepted_at = coalesce(accepted_at, now()),
        accepted_by = coalesce(accepted_by, auth.uid()),
        updated_at = now()
    where id = v_agreement_id;
  end if;

  -- ── Link quote to agreement and mark accepted ───────────────────────────────
  update public.quotes
  set service_agreement_id = v_agreement_id,
      status = 'accepted',
      updated_by = auth.uid(),
      updated_at = now()
  where id = v_quote.id;

  -- ── Copy any site-specific rates attached to this quote ─────────────────────
  for v_site in
    select id as site_id, hourly_rate
    from public.client_sites
    where quote_id = v_quote.id
      and hourly_rate is not null
  loop
    v_site_rate := v_site.hourly_rate;

    update public.client_sites
    set service_agreement_id = v_agreement_id,
        updated_at = now()
    where id = v_site.site_id;

    update public.client_site_patrol_config
    set hourly_rate = v_site_rate,
        updated_at = now()
    where client_site_id = v_site.site_id;
  end loop;

  return v_agreement_id;
end;
$$;

REVOKE ALL ON FUNCTION public.accept_quote(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quote(uuid) TO service_role;
