-- Client-specific billing rates from R&M's monthly invoice workbooks (owner instruction 2026-10-25:
-- "rates for each client are in the spreadsheet pages; if no rate is set the standing rate card applies").
--
-- resolve_rate_rule already prefers the most specific active rule: client (10) + service type (8) = 18
-- outranks the standing card's service-type rule (8). Client rates are therefore scoped to the hourly
-- labour services the standing card charges at $54.10 (patrol, security enquiries, investigations,
-- cordon guard, camera review). Specialist standing rates (engineering, excavator, two-person work,
-- emergency callout job types, equipment hire) are NOT overridden; they keep applying to these clients.
--
-- Travel: billing per-km is resolved with no service type on the first pass, so a client per-km rate has
-- to be client-wide (specificity 10) to take effect. OneFortyOne's travel rate equals the standing
-- $1.04/km, so it gets no travel rule.
--
-- Rates are before GST. Each rule is idempotent on client_request_id and audited individually, with the
-- workbook it was taken from. Clients with no rule here (TDC, Birdhurst, Taylors, Thomas Bros, Wrattens,
-- Stringer, private clients, ...) stay on the standing rate card. Not loaded and left for the owner:
-- private community-camera work at $85/hr + $1.26/km (no matching client record per customer), a one-off
-- Rotorua job at $160/hr, and OneFortyOne lines at $137.80, $166.60 and $135/hr that are not on the
-- standing card and have no stated service.
do $$
declare
  v_rm uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_master uuid := '08369a00-e2df-45d6-9e6b-6b3a6bede645';
  v_actor uuid;
  v_source text := 'R&M Invoice Spreadsheets workbooks (RemSec - Documents/Invoice Spreadsheets); owner instruction 2026-10-25';
  r record;
  v_rule_id uuid;
  v_request uuid;
  v_count integer := 0;
begin
  if not exists (select 1 from public.organizations where id = v_rm and organization_type = 'service_provider' and active) then
    return;
  end if;
  select id into v_actor from public.user_profiles where id = v_master and organization_id = v_rm and deactivated_at is null;

  for r in
    select * from (values
      -- OneFortyOne: workbook formulas =Q*58.3 and =S*1.04 on every 2025-04..2026-09 line; $55/$0.99 before April 2025.
      ('c48c1aaf-236b-417c-bbce-938c151662d6'::uuid, 'OneFortyOne', 'patrol',           'Patrolling',                 'hourly', 58.30, date '2025-04-01', 'OFO/Pest Control/March 26 Pest Control Marl.xlsx (2025, 2026 sheets); OFO monthly breakdowns Apr-Sep 2026'),
      ('c48c1aaf-236b-417c-bbce-938c151662d6'::uuid, 'OneFortyOne', 'security_enquiry', 'Security and permit enquiries','hourly', 58.30, date '2025-04-01', 'OFO/Pest Control/March 26 Pest Control Marl.xlsx (2025, 2026 sheets); OFO monthly breakdowns Apr-Sep 2026'),
      ('c48c1aaf-236b-417c-bbce-938c151662d6'::uuid, 'OneFortyOne', 'investigation',    'Investigations',             'hourly', 58.30, date '2025-04-01', 'OFO/Pest Control/March 26 Pest Control Marl.xlsx (2025, 2026 sheets); OFO monthly breakdowns Apr-Sep 2026'),
      ('c48c1aaf-236b-417c-bbce-938c151662d6'::uuid, 'OneFortyOne', 'cordon_guard',     'Cordon guard',               'hourly', 58.30, date '2025-04-01', 'OFO/Pest Control/March 26 Pest Control Marl.xlsx (2025, 2026 sheets); OFO monthly breakdowns Apr-Sep 2026'),
      ('c48c1aaf-236b-417c-bbce-938c151662d6'::uuid, 'OneFortyOne', 'camera_review',    'Camera downloads and review','hourly', 58.30, date '2025-04-01', 'OFO/Pest Control/March 26 Pest Control Marl.xlsx (2025, 2026 sheets); OFO monthly breakdowns Apr-Sep 2026'),
      -- STAND (PF Olsen managed blocks RABB, HOWA, BORL, SLIP): every line $55/hr and $0.99/km, work from 2025-11-06.
      ('2c433420-9fcc-40ba-8b32-3b542aa15e8f'::uuid, 'STAND (PF Olsen)', 'patrol',           'Patrolling',                 'hourly', 55.00, date '2025-11-01', 'PFO/2601 January 2026.xlsx; PFO/RABB Island March 2026.xlsx'),
      ('2c433420-9fcc-40ba-8b32-3b542aa15e8f'::uuid, 'STAND (PF Olsen)', 'security_enquiry', 'Security and permit enquiries','hourly', 55.00, date '2025-11-01', 'PFO/2601 January 2026.xlsx; PFO/RABB Island March 2026.xlsx'),
      ('2c433420-9fcc-40ba-8b32-3b542aa15e8f'::uuid, 'STAND (PF Olsen)', 'investigation',    'Investigations',             'hourly', 55.00, date '2025-11-01', 'PFO/2601 January 2026.xlsx; PFO/RABB Island March 2026.xlsx'),
      ('2c433420-9fcc-40ba-8b32-3b542aa15e8f'::uuid, 'STAND (PF Olsen)', 'cordon_guard',     'Cordon guard',               'hourly', 55.00, date '2025-11-01', 'PFO/2601 January 2026.xlsx; PFO/RABB Island March 2026.xlsx'),
      ('2c433420-9fcc-40ba-8b32-3b542aa15e8f'::uuid, 'STAND (PF Olsen)', 'camera_review',    'Camera downloads and review','hourly', 55.00, date '2025-11-01', 'PFO/2601 January 2026.xlsx; PFO/RABB Island March 2026.xlsx'),
      ('2c433420-9fcc-40ba-8b32-3b542aa15e8f'::uuid, 'STAND (PF Olsen)', null,               'Travel',                     'per_km', 0.99,  date '2025-11-01', 'PFO/2601 January 2026.xlsx; PFO/RABB Island March 2026.xlsx'),
      -- Operation Lizard (DART), Kea Conservation Trust workbook, site DART: every line $62.50/hr and $0.99/km, work from 2025-10-13.
      ('febfdc61-fc56-4139-bb06-9ab5d616ba86'::uuid, 'Operation Lizard (DART)', 'patrol',           'Patrolling',                 'hourly', 62.50, date '2025-10-01', 'Kea Conservation Trust/2601 January 2026.xlsx'),
      ('febfdc61-fc56-4139-bb06-9ab5d616ba86'::uuid, 'Operation Lizard (DART)', 'security_enquiry', 'Security and permit enquiries','hourly', 62.50, date '2025-10-01', 'Kea Conservation Trust/2601 January 2026.xlsx'),
      ('febfdc61-fc56-4139-bb06-9ab5d616ba86'::uuid, 'Operation Lizard (DART)', 'investigation',    'Investigations',             'hourly', 62.50, date '2025-10-01', 'Kea Conservation Trust/2601 January 2026.xlsx'),
      ('febfdc61-fc56-4139-bb06-9ab5d616ba86'::uuid, 'Operation Lizard (DART)', 'cordon_guard',     'Cordon guard',               'hourly', 62.50, date '2025-10-01', 'Kea Conservation Trust/2601 January 2026.xlsx'),
      ('febfdc61-fc56-4139-bb06-9ab5d616ba86'::uuid, 'Operation Lizard (DART)', 'camera_review',    'Camera downloads and review','hourly', 62.50, date '2025-10-01', 'Kea Conservation Trust/2601 January 2026.xlsx'),
      ('febfdc61-fc56-4139-bb06-9ab5d616ba86'::uuid, 'Operation Lizard (DART)', null,               'Travel',                     'per_km', 0.99,  date '2025-10-01', 'Kea Conservation Trust/2601 January 2026.xlsx'),
      -- Nelson City Council: every line $60/hr and $0.99/km, work from 2026-08-26.
      ('405fc1f7-45e8-4736-a517-885bb3e5ef95'::uuid, 'Nelson City Council', 'patrol',           'Patrolling',                 'hourly', 60.00, date '2026-08-01', 'NCC/Montgomery Toilets.xlsx'),
      ('405fc1f7-45e8-4736-a517-885bb3e5ef95'::uuid, 'Nelson City Council', 'security_enquiry', 'Security and permit enquiries','hourly', 60.00, date '2026-08-01', 'NCC/Montgomery Toilets.xlsx'),
      ('405fc1f7-45e8-4736-a517-885bb3e5ef95'::uuid, 'Nelson City Council', 'investigation',    'Investigations',             'hourly', 60.00, date '2026-08-01', 'NCC/Montgomery Toilets.xlsx'),
      ('405fc1f7-45e8-4736-a517-885bb3e5ef95'::uuid, 'Nelson City Council', 'cordon_guard',     'Cordon guard',               'hourly', 60.00, date '2026-08-01', 'NCC/Montgomery Toilets.xlsx'),
      ('405fc1f7-45e8-4736-a517-885bb3e5ef95'::uuid, 'Nelson City Council', 'camera_review',    'Camera downloads and review','hourly', 60.00, date '2026-08-01', 'NCC/Montgomery Toilets.xlsx'),
      ('405fc1f7-45e8-4736-a517-885bb3e5ef95'::uuid, 'Nelson City Council', null,               'Travel',                     'per_km', 0.99,  date '2026-08-01', 'NCC/Montgomery Toilets.xlsx')
    ) as t(client_id, client_label, service_type, label, rate_type, amount, effective_from, workbook)
  loop
    -- Only for a client that has an R&M agreement in this environment.
    continue when not exists (
      select 1 from public.service_agreements sa
      where sa.provider_organization_id = v_rm and sa.client_organization_id = r.client_id
    );
    v_request := md5('rm-client-rate:' || r.client_id::text || ':' || coalesce(r.service_type, '*') || ':' || r.rate_type)::uuid;
    insert into public.rate_rules (
      organization_id, rule_kind, name, rate_type, amount, service_type, client_org_id,
      effective_from, priority, active, created_by, updated_by, client_request_id
    ) values (
      v_rm, 'billing',
      format('%s: %s (%s, client rate)', r.client_label, r.label, case r.rate_type when 'per_km' then 'per km' else 'per hour' end),
      r.rate_type, r.amount, r.service_type::text, r.client_id,
      r.effective_from, 0, true, v_actor, v_actor, v_request
    )
    on conflict (organization_id, client_request_id) where client_request_id is not null do nothing
    returning id into v_rule_id;
    if v_rule_id is not null then
      v_count := v_count + 1;
      insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_rm, v_actor, 'operating_branch_rate_rule_managed', 'rate_rules', v_rule_id, jsonb_build_object(
        'action', 'create', 'rule_kind', 'billing', 'rate_type', r.rate_type, 'amount', r.amount,
        'service_type', r.service_type, 'client_org_id', r.client_id, 'effective_from', r.effective_from,
        'client_request_id', v_request, 'gst', 'excluded',
        'source', v_source, 'workbook', r.workbook));
    end if;
    v_rule_id := null;
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_rm, v_actor, 'rate_rules_seeded_from_price_sheets', 'rate_rules', v_rm, jsonb_build_object(
    'rules_inserted', v_count, 'source', v_source,
    'note', 'client-specific billing rates; clients without a rule use the standing rate card'));
end $$;
