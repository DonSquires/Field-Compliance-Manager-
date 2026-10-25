-- Owner decisions 2026-10-25 (follow-up to 20261029090000):
--  1. Private community-camera customers get their own client record each (Barber Motueka, Coppins,
--     Kaiteriteri), so each is invoiced on its own. Rate $85/hr and $1.26/km excl. GST, from the
--     "Invoice Spreadsheets/Community Cameras - Private" workbooks. The existing "R&M Other Private
--     Clients" umbrella carries the same rates on file (seed wave 2) and gets them as client rules too.
--     No sites are created: the workbooks name the customer but give no address.
--  2. The Rotorua job at $160/hr is a one-off and is not loaded.
--  4. Fixed fee with drawdown does not apply to pay-as-you-use work. The seven agreements set to
--     fixed_price_with_extras without a monthly fee (STAND, TDC, Birdhurst, Stringer, Wrattens,
--     Thomas Bros, Taylors) are switched to pay_as_you_go. OneFortyOne stays fixed price with Extra.
-- Idempotent and audited throughout.
do $$
declare
  v_rm uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_seed text := 'rm_private_camera_clients_2026-10-25';
  v_owner uuid;
  v_master uuid;
  r record;
  v_org_id uuid;
  v_agreement_id uuid;
  v_settings_id uuid;
  v_request uuid;
  v_rule_id uuid;
  v_rules integer := 0;
  v_source text := 'R&M Invoice Spreadsheets/Community Cameras - Private workbooks; owner instruction 2026-10-25';
begin
  if not exists (select 1 from public.organizations where id = v_rm and organization_type = 'service_provider' and active) then
    return;
  end if;
  select id into v_owner from public.user_profiles where id = '1b02ab97-8611-40ab-a3a0-b5c74589db58' and deactivated_at is null;
  select id into v_master from public.user_profiles where id = '08369a00-e2df-45d6-9e6b-6b3a6bede645' and organization_id = v_rm and deactivated_at is null;

  -- 4. Pay-as-you-use agreements (only those still fixed price with no accepted price).
  for r in
    select cs.id as settings_id, sa.id as agreement_id, o.name
    from public.service_agreements sa
    join public.crm_commercial_settings cs on cs.service_agreement_id = sa.id
    join public.organizations o on o.id = sa.client_organization_id
    where sa.provider_organization_id = v_rm
      and sa.id in (
        'ea29860c-54ad-4ae8-99af-2295bfd3af32', -- STAND (PF Olsen)
        'ea833b30-62bb-4f63-a390-feef857edc99', -- Tasman District Council
        'ff245fea-4ba7-4dd0-bc59-36fd22becb9d', -- Birdhurst
        '1febbf58-9f9a-4738-86c6-32061d6e6bdd', -- Stringer
        'ad2a5116-c480-4ee8-bdff-87b4d0da03e9', -- Wrattens
        'a3a145e2-487b-43b5-b9e6-f930791c4817', -- Thomas Bros
        'a9f026fa-7383-4277-b066-61ce109e9525'  -- Taylors Contracting
      )
      and cs.commercial_model = 'fixed_price_with_extras'
      and not exists (select 1 from public.quotes q where q.service_agreement_id = sa.id and q.status = 'accepted')
      and not exists (select 1 from public.agreement_fee_settlements s where s.service_agreement_id = sa.id)
  loop
    update public.crm_commercial_settings set commercial_model = 'pay_as_you_go', updated_at = now() where id = r.settings_id;
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_rm, v_owner, 'agreement_commercial_terms_set', 'crm_commercial_settings', r.settings_id, jsonb_build_object(
      'service_agreement_id', r.agreement_id, 'client', r.name,
      'reason', 'Owner decision 2026-10-25: no fixed monthly fee; pay as you use, so no drawdown (migration 20261029100000)',
      'before', jsonb_build_object('commercial_model', 'fixed_price_with_extras'),
      'after', jsonb_build_object('commercial_model', 'pay_as_you_go')));
  end loop;

  -- 1. Private community-camera clients, each with its own pay-as-you-go agreement.
  for r in
    select * from (values
      ('barber-motueka', 'Private - Barber (Motueka)', 'Barber Motueka 260129/2601 January 2026 bar.xlsx', 'Camera installation and maintenance, January 2026'),
      ('coppins',        'Private - Coppins',          'Coppins 260129/2601 January 2026 cop.xlsx',        'Camera installation, January 2026'),
      ('kaiteriteri',    'Private - Kaiteriteri',      'Kaiteriteri 260129/2601 January 2026 kai.xlsx',    'Camera repairs and maintenance, December 2025 - January 2026')
    ) as t(key, name, workbook, evidence)
  loop
    v_request := md5(v_seed || ':org:' || r.key)::uuid;
    select id into v_org_id from public.organizations
     where parent_organization_id = v_rm and (client_request_id = v_request or lower(name) = lower(r.name))
     order by (client_request_id = v_request) desc, created_at limit 1;
    if v_org_id is null then
      insert into public.organizations (name, organization_type, parent_organization_id, active, status, account_notes, external_refs, client_request_id)
      values (r.name, 'private_enterprise', v_rm, true, 'active',
        'Private community-camera customer. Rates $85/hr and $1.26/km excl. GST from R&M''s invoice workbook. No site address on file yet.',
        jsonb_build_object('seed_key', v_seed, 'seed_entity_key', r.key, 'workbook', r.workbook, 'retrieved_at', '2026-10-25'),
        v_request)
      returning id into v_org_id;
      insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_rm, v_owner, 'seed_private_camera_clients.organization_created', 'organizations', v_org_id,
        jsonb_build_object('seed_key', v_seed, 'key', r.key, 'workbook', r.workbook));
    end if;
    if not exists (select 1 from public.organization_modules where organization_id = v_org_id and module_key = 'patrol') then
      insert into public.organization_modules (organization_id, module_key, enabled, settings)
      values (v_org_id, 'patrol', true, jsonb_build_object('seed_key', v_seed));
    end if;

    select id into v_agreement_id from public.service_agreements
     where provider_organization_id = v_rm and client_organization_id = v_org_id order by created_at limit 1;
    if v_agreement_id is null then
      insert into public.service_agreements (provider_organization_id, client_organization_id, name, agreement_type, enabled_modules, external_refs)
      values (v_rm, v_org_id, 'Community camera installation and maintenance - ' || r.name, 'operational', array['patrol'],
        jsonb_build_object('seed_key', v_seed, 'evidence', r.evidence, 'workbook', r.workbook, 'rate_standard', '$85/hr', 'rate_mileage', '126c/km', 'retrieved_at', '2026-10-25'))
      returning id into v_agreement_id;
      insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_rm, v_owner, 'seed_private_camera_clients.agreement_created', 'service_agreements', v_agreement_id,
        jsonb_build_object('seed_key', v_seed, 'client_organization_id', v_org_id));
    end if;
    update public.service_agreements
       set invitation_status = 'accepted',
           external_refs = external_refs || jsonb_build_object('accepted_basis', 'R&M has performed and invoiced real camera work for this customer (own workbook); recorded on the owner''s instruction 2026-10-25.', 'accepted_recorded_at', '2026-10-25')
     where id = v_agreement_id and invitation_status = 'not_invited';
    if found then
      insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_rm, v_owner, 'seed_private_camera_clients.agreement_accepted', 'service_agreements', v_agreement_id,
        jsonb_build_object('seed_key', v_seed, 'client_organization_id', v_org_id));
    end if;
    if not exists (select 1 from public.service_agreement_modules where service_agreement_id = v_agreement_id and module_key = 'patrol') then
      insert into public.service_agreement_modules (service_agreement_id, module_key, enabled, settings)
      values (v_agreement_id, 'patrol', true, jsonb_build_object('seed_key', v_seed));
    end if;

    if not exists (select 1 from public.crm_commercial_settings c where c.service_agreement_id = v_agreement_id and c.commercial_model is not null) then
      insert into public.crm_commercial_settings (service_agreement_id, commercial_model, notes, updated_at)
      values (v_agreement_id, 'pay_as_you_go', 'Pay as you use: each job billed at the client rate. Owner decision 2026-10-25.', now())
      on conflict (service_agreement_id) do update set commercial_model = excluded.commercial_model, updated_at = now()
      returning id into v_settings_id;
      insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_rm, v_owner, 'agreement_commercial_terms_set', 'crm_commercial_settings', v_settings_id, jsonb_build_object(
        'service_agreement_id', v_agreement_id, 'reason', 'New private camera client (migration 20261029100000)',
        'after', jsonb_build_object('commercial_model', 'pay_as_you_go')));
    end if;
  end loop;

  -- Client rates for the three new clients and the private-clients umbrella.
  for r in
    select o.id as client_id, o.name as client_label, s.service_type, s.label, s.rate_type, s.amount
    from public.organizations o
    cross join (values
      ('patrol',           'Patrolling',                  'hourly', 85.00),
      ('security_enquiry', 'Security and permit enquiries','hourly', 85.00),
      ('investigation',    'Investigations',              'hourly', 85.00),
      ('cordon_guard',     'Cordon guard',                'hourly', 85.00),
      ('camera_review',    'Camera downloads and review', 'hourly', 85.00),
      (null,               'Travel',                      'per_km', 1.26)
    ) as s(service_type, label, rate_type, amount)
    where o.parent_organization_id = v_rm
      and (o.client_request_id in (md5(v_seed || ':org:barber-motueka')::uuid, md5(v_seed || ':org:coppins')::uuid, md5(v_seed || ':org:kaiteriteri')::uuid)
           or o.id = 'fc047614-ee8d-47d8-8bd3-734cd239dc36') -- R&M Other Private Clients
      and exists (select 1 from public.service_agreements sa where sa.provider_organization_id = v_rm and sa.client_organization_id = o.id)
  loop
    v_request := md5('rm-client-rate:' || r.client_id::text || ':' || coalesce(r.service_type, '*') || ':' || r.rate_type)::uuid;
    insert into public.rate_rules (
      organization_id, rule_kind, name, rate_type, amount, service_type, client_org_id,
      effective_from, priority, active, created_by, updated_by, client_request_id
    ) values (
      v_rm, 'billing',
      format('%s: %s (%s, client rate)', r.client_label, r.label, case r.rate_type when 'per_km' then 'per km' else 'per hour' end),
      r.rate_type, r.amount, r.service_type, r.client_id,
      date '2025-12-01', 0, true, v_master, v_master, v_request
    )
    on conflict (organization_id, client_request_id) where client_request_id is not null do nothing
    returning id into v_rule_id;
    if v_rule_id is not null then
      v_rules := v_rules + 1;
      insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_rm, v_master, 'operating_branch_rate_rule_managed', 'rate_rules', v_rule_id, jsonb_build_object(
        'action', 'create', 'rule_kind', 'billing', 'rate_type', r.rate_type, 'amount', r.amount,
        'service_type', r.service_type, 'client_org_id', r.client_id, 'effective_from', date '2025-12-01',
        'client_request_id', v_request, 'gst', 'excluded', 'source', v_source));
    end if;
    v_rule_id := null;
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_rm, v_master, 'rate_rules_seeded_from_price_sheets', 'rate_rules', v_rm, jsonb_build_object(
    'rules_inserted', v_rules, 'source', v_source,
    'note', 'private community-camera client rates; Rotorua one-off not loaded'));
end $$;
