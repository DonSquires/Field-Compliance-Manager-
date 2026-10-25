-- Phase B: seed historical patrol-log labour into the main roster (owner rulings 2026-10-25).
--   * Staff who completed patrol-log jobs are rostered like any other employee, as completed slots.
--   * Forestry patrol pay is $32/hour (pay code FORESTRY-PATROL, service type 'patrol').
--   * Unnamed work goes to a non-login "Relief Officer (No Name)" staff placeholder.
--   * Days with blank/invalid hours or more than 24 hours stay evidence only (decided in the planner).
-- Historical slots are labour evidence only: the work was billed through the patrol-log jobs and
-- invoices, so roster labour cost must not price them again.

-- 1. Pay code and pay rule ---------------------------------------------------------------------
INSERT INTO public.reference_codes(organization_id, code_type, code, name, description, item_category, unit, default_rate, service_type)
VALUES ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid, 'pay_item', 'FORESTRY-PATROL', 'Forestry Patrol',
  'Hourly pay for forestry/patrol-log patrol work (owner ruling 2026-10-25).', 'earning', 'hour', 32, 'patrol')
ON CONFLICT (organization_id, code_type, code) DO NOTHING;

INSERT INTO public.rate_rules(organization_id, rule_kind, name, rate_type, amount, pay_code, service_type, priority)
SELECT 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid, 'pay', 'Forestry patrol (pay, per hour)', 'hourly', 32, 'FORESTRY-PATROL', 'patrol', 10
WHERE NOT EXISTS (
  SELECT 1 FROM public.rate_rules
  WHERE organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid AND rule_kind = 'pay' AND pay_code = 'FORESTRY-PATROL'
);

-- 2. Non-login Relief Officer placeholder (precedent: 20260927280000 import automation profile) --
INSERT INTO public.user_profiles(id, organization_id, employer_organization_id, role, display_name, email)
VALUES ('f1c00000-0000-4000-8000-000000000002'::uuid, 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,
  'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid, 'officer', 'Relief Officer (No Name)', 'rm-relief-officer@field-compliance.invalid')
ON CONFLICT (id) DO UPDATE SET
  organization_id = EXCLUDED.organization_id,
  employer_organization_id = EXCLUDED.employer_organization_id,
  role = EXCLUDED.role,
  display_name = EXCLUDED.display_name,
  email = EXCLUDED.email,
  updated_at = now();

INSERT INTO public.staff_profiles(id, organization_id, user_id, employment_type, work_ready, overtime_eligible, notes, external_refs)
VALUES ('f1c00000-0000-4000-8000-000000000002'::uuid, 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,
  'f1c00000-0000-4000-8000-000000000002'::uuid, 'casual', false, false,
  'Placeholder for historical patrol-log work recorded without an officer name. Cannot log in or be rostered for new work.',
  '{"placeholder":true,"source":"rm_patrol_log_labour"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- 3. Idempotency key for imported slots --------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_slots_patrol_log_labour_source_key
  ON public.roster_slots (organization_id, (external_refs->>'source_key'))
  WHERE external_refs->>'source' = 'rm_patrol_log_labour';

-- 4. Availability/fatigue gate: historical completed patrol-log slots record what already happened.
--    The bypass needs a transaction-local flag that only the import RPC sets.
CREATE OR REPLACE FUNCTION public.enforce_roster_slot_availability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_fatigue text;
begin
  if current_setting('fcm.historical_labour_import', true) = 'on'
     and new.status = 'completed'
     and new.scheduled_end <= now()
     and new.external_refs->>'source' = 'rm_patrol_log_labour' then
    return new;
  end if;
  if new.staff_id is not null and new.status not in ('declined', 'cancelled') then
    if public.staff_has_roster_availability_conflict(new.staff_id, new.scheduled_start, new.scheduled_end) then
      raise exception 'Staff member is unavailable during this roster slot';
    end if;
    v_fatigue := public.staff_fatigue_conflict(new.staff_id, new.scheduled_start, new.scheduled_end, new.id);
    if v_fatigue is not null then
      raise exception 'Fatigue rule breach: %', v_fatigue;
    end if;
  end if;
  return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.enforce_roster_slot_availability() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_roster_slot_availability() TO postgres, service_role;

-- 5. Labour cost: price the pay side of historical slots, never a second billable amount ----------
CREATE OR REPLACE FUNCTION public.get_roster_labour_cost(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(slot_id uuid, work_unit_name text, staff_id uuid, scheduled_hours numeric, pay_rate numeric, charge_rate numeric, pay_cost numeric, billable numeric, margin numeric, rate_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to view labour cost for this organization'; end if;
  return query
  select s.id, work_unit.name, s.staff_id,
    round(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    pay.amount, bill.amount,
    round(coalesce(pay.amount, 0) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    case when historical.yes then null else round(coalesce(bill.amount, 0) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2) end,
    case when historical.yes then null else round((coalesce(bill.amount, 0) - coalesce(pay.amount, 0)) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2) end,
    case
      when historical.yes and pay.amount is null then 'no_pay_rule'
      when historical.yes then 'billed_via_patrol_log'
      when pay.amount is null and bill.amount is null then 'no_rules'
      when pay.amount is null then 'no_pay_rule'
      when bill.amount is null then 'no_billing_rule'
      else 'resolved' end
  from public.roster_slots s
  join public.roster_work_units work_unit on work_unit.id = s.work_unit_id
  left join public.staff_profiles staff on staff.id = s.staff_id
  cross join lateral (select coalesce(s.external_refs->>'source' = 'rm_patrol_log_labour', false) as yes) historical
  left join lateral public.resolve_rate_rule(p_organization_id, 'pay', s.scheduled_start, work_unit.service_type, null, null, null, null, null, staff.role_code, null, null, 'hourly') pay on true
  left join lateral public.resolve_rate_rule(p_organization_id, 'billing', s.scheduled_start, work_unit.service_type, null, null, null, null, null, staff.role_code, null, null, 'hourly') bill on not historical.yes
  where s.organization_id = p_organization_id and s.status not in ('cancelled', 'declined') and s.scheduled_start >= p_from and s.scheduled_start < p_to
  order by s.scheduled_start;
end;
$function$;
REVOKE ALL ON FUNCTION public.get_roster_labour_cost(uuid, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_roster_labour_cost(uuid, timestamp with time zone, timestamp with time zone) TO postgres, authenticated, service_role;

-- 6. Governed import -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_historical_patrol_labour_slots(
  p_organization_id uuid,
  p_client_request_id uuid,
  p_report_fingerprint text,
  p_slots jsonb
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_receipt jsonb;
  v_route uuid;
  v_unit uuid;
  v_slot jsonb;
  v_existing record;
  v_staff uuid;
  v_client uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_hours numeric;
  v_key text;
  v_inserted integer := 0;
  v_unchanged integer := 0;
  v_changed jsonb := '[]'::jsonb;
  v_units jsonb := '{}'::jsonb;
begin
  if v_actor is null or not public.is_admin_for_org(p_organization_id) then
    raise exception 'Not authorised to import historical labour for this organization';
  end if;
  if p_client_request_id is null or coalesce(p_report_fingerprint, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A request ID and the planner report fingerprint are required';
  end if;
  if jsonb_typeof(p_slots) is distinct from 'array' or jsonb_array_length(p_slots) = 0 or jsonb_array_length(p_slots) > 1000 then
    raise exception 'Between 1 and 1000 slots are required per request';
  end if;

  select metadata into v_receipt from public.audit_log
  where organization_id = p_organization_id and action = 'historical_patrol_labour_imported'
    and metadata->>'client_request_id' = p_client_request_id::text
  limit 1;
  if found then return v_receipt || jsonb_build_object('replayed', true); end if;

  select id into v_route from public.patrol_routes
  where organization_id = p_organization_id and route_code = 'RM-PATROL-LOG-HISTORICAL';
  if v_route is null then
    insert into public.patrol_routes(organization_id, name, route_code, description, route_type, checkpoint_mode, assignment_type, is_active)
    values (p_organization_id, 'Patrol log labour (historical)', 'RM-PATROL-LOG-HISTORICAL',
      'Holds historical patrol-log labour imported into the roster. Not used for live patrols.', 'patrol', 'none', 'client_patrol', false)
    returning id into v_route;
  end if;

  perform set_config('fcm.historical_labour_import', 'on', true);

  for v_slot in select value from jsonb_array_elements(p_slots) loop
    v_key := v_slot->>'source_key';
    begin
      v_staff := (v_slot->>'staff_id')::uuid;
      v_client := (v_slot->>'client_organization_id')::uuid;
      v_start := (v_slot->>'scheduled_start')::timestamptz;
      v_end := (v_slot->>'scheduled_end')::timestamptz;
      v_hours := (v_slot->>'recorded_hours')::numeric;
    exception when others then
      raise exception 'Slot % has malformed fields', coalesce(v_key, '(no source key)');
    end;
    if v_key is null or v_key !~ '^rm_patrol_log_labour:' or v_staff is null or v_client is null
       or coalesce(v_slot->>'source_fingerprint', '') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(v_slot->'source_records') is distinct from 'array' or jsonb_array_length(v_slot->'source_records') = 0 then
      raise exception 'Slot % is missing its source identity', coalesce(v_key, '(no source key)');
    end if;
    if v_start >= v_end or v_end > now() or v_end - v_start > interval '24 hours'
       or abs(extract(epoch from (v_end - v_start)) - v_hours * 3600) > 1 then
      raise exception 'Slot % has an invalid or future time window', v_key;
    end if;
    if not exists (select 1 from public.staff_profiles where id = v_staff and organization_id = p_organization_id) then
      raise exception 'Slot % names a staff member outside this organization', v_key;
    end if;

    select id, external_refs into v_existing from public.roster_slots
    where organization_id = p_organization_id and external_refs->>'source' = 'rm_patrol_log_labour'
      and external_refs->>'source_key' = v_key;
    if found then
      if v_existing.external_refs->>'source_fingerprint' = v_slot->>'source_fingerprint' then
        v_unchanged := v_unchanged + 1;
      else
        v_changed := v_changed || jsonb_build_object('slot_id', v_existing.id, 'source_key', v_key);
      end if;
      continue;
    end if;

    if exists (
      select 1 from public.roster_slots other
      where other.organization_id = p_organization_id and other.staff_id = v_staff
        and other.status not in ('declined', 'cancelled')
        and tstzrange(other.scheduled_start, other.scheduled_end, '[)') && tstzrange(v_start, v_end, '[)')
    ) then
      raise exception 'Slot % overlaps an existing roster slot for the same staff member', v_key;
    end if;

    v_unit := (v_units->>v_client::text)::uuid;
    if v_unit is null then
      select id into v_unit from public.roster_work_units
      where organization_id = p_organization_id and external_refs->>'source' = 'rm_patrol_log_labour'
        and external_refs->>'client_organization_id' = v_client::text;
      if v_unit is null then
        insert into public.roster_work_units(organization_id, name, work_unit_type, service_type, patrol_route_id, created_by, external_refs)
        select p_organization_id, 'Patrol log - ' || coalesce(o.name, v_client::text), 'patrol', 'patrol', v_route, v_actor,
          jsonb_build_object('source', 'rm_patrol_log_labour', 'client_organization_id', v_client, 'historical_only', true)
        from (select v_client as id) c left join public.organizations o on o.id = c.id
        returning id into v_unit;
      end if;
      v_units := v_units || jsonb_build_object(v_client::text, v_unit);
    end if;

    insert into public.roster_slots(organization_id, work_unit_id, staff_id, scheduled_start, scheduled_end, status,
      client_request_id, notes, created_by, external_refs)
    values (p_organization_id, v_unit, v_staff, v_start, v_end, 'completed',
      md5('rm_patrol_log_labour|' || v_key)::uuid,
      'Historical patrol-log labour: ' || v_hours || 'h summed from ' || jsonb_array_length(v_slot->'source_records')
        || ' log entries. Start time is approximate.',
      v_actor,
      jsonb_build_object('source', 'rm_patrol_log_labour', 'source_key', v_key,
        'source_fingerprint', v_slot->>'source_fingerprint', 'report_fingerprint', p_report_fingerprint,
        'client_organization_id', v_client, 'work_date', v_slot->>'work_date', 'recorded_hours', v_hours,
        'pay_code', 'FORESTRY-PATROL', 'time_precision', 'summed_hours_anchored_to_first_entry',
        'source_records', v_slot->'source_records', 'imported_request_id', p_client_request_id));
    v_inserted := v_inserted + 1;
  end loop;

  perform set_config('fcm.historical_labour_import', 'off', true);

  v_receipt := jsonb_build_object('client_request_id', p_client_request_id, 'report_fingerprint', p_report_fingerprint,
    'submitted', jsonb_array_length(p_slots), 'inserted', v_inserted, 'unchanged', v_unchanged,
    'changed_source', v_changed, 'work_units', v_units);
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'historical_patrol_labour_imported', 'roster_slots', null, v_receipt);
  return v_receipt;
end;
$function$;
COMMENT ON FUNCTION public.import_historical_patrol_labour_slots(uuid, uuid, text, jsonb) IS
  'Admin-only, idempotent import of planner-approved historical patrol-log labour as completed roster slots. Changed source fingerprints are reported, never overwritten.';
REVOKE ALL ON FUNCTION public.import_historical_patrol_labour_slots(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_historical_patrol_labour_slots(uuid, uuid, text, jsonb) TO authenticated, service_role;
