-- Rest and hours rules the roster actually checks (owner walk finding 2026-09-20).
-- organization_fatigue_rules existed with sensible defaults (10 h rest, 60 h/week, 7 days in a row) and every roster
-- writer called staff_fatigue_conflict — but authenticated users could only SELECT the table, no RPC wrote it and no
-- page showed it, so no organisation had a row and nothing was ever checked (live: 0 rows). The check itself summed a
-- 14-day window (start ± 7 days) against the *weekly* limit, and the rosterer only learned of a breach after the fact,
-- from a one-line error behind the dialog.
--
-- Now: one load calculation (roster_assignment_load) shared by the enforcement (staff_fatigue_conflict) and a
-- roster-time preview (preview_roster_assignment) that tells the rosterer, before the slot exists, how rested the
-- officer is, how many hours they have this week, how many days in a row this makes, whether a credential runs out
-- first — and which rule the roster will refuse on. manage_organization_fatigue_rules is the governed writer.

create or replace function public.roster_assignment_load(p_staff_id uuid, p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_exclude_slot_id uuid default null)
returns table(rest_hours numeric, week_start date, week_hours numeric, consecutive_days integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_week_start date := date_trunc('week', p_scheduled_start at time zone 'Pacific/Auckland')::date;
  v_week_from timestamptz := (v_week_start::timestamp) at time zone 'Pacific/Auckland';
  v_week_to timestamptz := ((v_week_start + 7)::timestamp) at time zone 'Pacific/Auckland';
  v_shift_date date := (p_scheduled_start at time zone 'Pacific/Auckland')::date;
  v_rest numeric;
  v_hours numeric;
  v_days integer := 1;
  v_day date;
begin
  -- Rest: the smallest gap to any other slot of this officer that does not overlap the new one.
  select min(case when s.scheduled_start >= p_scheduled_end then extract(epoch from (s.scheduled_start - p_scheduled_end)) / 3600.0
                  else extract(epoch from (p_scheduled_start - s.scheduled_end)) / 3600.0 end)
  into v_rest
  from public.roster_slots s
  where s.staff_id = p_staff_id
    and s.status not in ('declined', 'cancelled')
    and (p_exclude_slot_id is null or s.id <> p_exclude_slot_id)
    and not tstzrange(s.scheduled_start, s.scheduled_end, '[)') && tstzrange(p_scheduled_start, p_scheduled_end, '[)');

  -- Hours this roster week (Monday to Sunday, NZ time) including the new slot.
  select coalesce(sum(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0), 0)
  into v_hours
  from public.roster_slots s
  where s.staff_id = p_staff_id
    and s.status not in ('declined', 'cancelled')
    and (p_exclude_slot_id is null or s.id <> p_exclude_slot_id)
    and s.scheduled_start >= v_week_from and s.scheduled_start < v_week_to
    and not tstzrange(s.scheduled_start, s.scheduled_end, '[)') && tstzrange(p_scheduled_start, p_scheduled_end, '[)');
  v_hours := v_hours + extract(epoch from (p_scheduled_end - p_scheduled_start)) / 3600.0;

  -- Days in a row ending on the new slot's day: walk back while the previous day has a slot.
  v_day := v_shift_date - 1;
  while v_days < 60 and exists (
    select 1 from public.roster_slots s
    where s.staff_id = p_staff_id
      and s.status not in ('declined', 'cancelled')
      and (p_exclude_slot_id is null or s.id <> p_exclude_slot_id)
      and (s.scheduled_start at time zone 'Pacific/Auckland')::date = v_day
  ) loop
    v_days := v_days + 1;
    v_day := v_day - 1;
  end loop;

  return query select round(v_rest, 1), v_week_start, round(v_hours, 1), v_days;
end;
$$;

revoke all on function public.roster_assignment_load(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated, service_role;
comment on function public.roster_assignment_load(uuid, timestamptz, timestamptz, uuid) is
  'Internal: rest since/until the nearest other slot, hours in the Mon-Sun (NZ) roster week including the proposed slot, and days in a row ending on its day. Used by staff_fatigue_conflict and preview_roster_assignment.';

-- Same signature as before; the roster writers and triggers keep calling it. Messages are what the rosterer reads.
create or replace function public.staff_fatigue_conflict(p_staff_id uuid, p_scheduled_start timestamp with time zone, p_scheduled_end timestamp with time zone, p_exclude_slot_id uuid default null)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_org uuid;
  v_rules public.organization_fatigue_rules%rowtype;
  v_load record;
begin
  select sp.organization_id into v_org from public.staff_profiles sp where sp.id = p_staff_id;
  if v_org is null then return null; end if;
  select r.* into v_rules from public.organization_fatigue_rules r where r.organization_id = v_org;
  if not found or not v_rules.enforced then return null; end if;

  select * into v_load from public.roster_assignment_load(p_staff_id, p_scheduled_start, p_scheduled_end, p_exclude_slot_id);

  if v_load.rest_hours is not null and v_load.rest_hours < v_rules.min_rest_hours_between_shifts then
    return format('Only %s hours'' rest from the nearest other shift; this organisation requires %s', trim_scale(v_load.rest_hours), trim_scale(v_rules.min_rest_hours_between_shifts));
  end if;
  if v_load.week_hours > v_rules.max_hours_per_week then
    return format('%s hours in the week starting %s, over the %s-hour limit', trim_scale(v_load.week_hours), to_char(v_load.week_start, 'DD Mon'), trim_scale(v_rules.max_hours_per_week));
  end if;
  if v_load.consecutive_days > v_rules.max_consecutive_days then
    return format('Day %s in a row, over the limit of %s', v_load.consecutive_days, v_rules.max_consecutive_days);
  end if;
  return null;
end;
$$;

comment on function public.staff_fatigue_conflict(uuid, timestamptz, timestamptz, uuid) is
  'Null when the proposed slot passes the employing organisation''s rest and hours rules (or none are set/enforced); otherwise one plain sentence naming the rule and the numbers. Enforced by the roster_slots trigger and the roster RPCs.';

-- The rosterer sees this before the slot exists.
create or replace function public.preview_roster_assignment(p_staff_id uuid, p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_exclude_slot_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_rules public.organization_fatigue_rules%rowtype;
  v_load record;
  v_credentials jsonb;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_scheduled_start is null or p_scheduled_end is null or p_scheduled_end <= p_scheduled_start then raise exception 'The shift must end after it starts'; end if;
  select * into v_staff from public.staff_profiles sp where sp.id = p_staff_id;
  if not found then raise exception 'Staff member not found'; end if;
  -- Whoever may roster this person may see their load: the employer's administrators, or an administrator of a branch they are authorised at.
  if not (public.is_admin_for_org(v_staff.organization_id) or exists (
      select 1 from public.staff_branch_authorisations a
      where a.user_id = coalesce(v_staff.user_id, v_staff.id) and a.status = 'active' and public.is_admin_for_org(a.branch_org_id))) then
    raise exception 'Not authorised to roster this staff member';
  end if;

  select r.* into v_rules from public.organization_fatigue_rules r where r.organization_id = v_staff.organization_id;
  select * into v_load from public.roster_assignment_load(p_staff_id, p_scheduled_start, p_scheduled_end, p_exclude_slot_id);

  select coalesce(jsonb_agg(jsonb_build_object('credential_type', c.credential_type, 'expiry_date', c.expiry_date, 'verified', c.verified) order by c.expiry_date nulls last), '[]'::jsonb)
  into v_credentials
  from public.staff_credentials c
  where c.staff_id = v_staff.id
    and c.replaces_credential_id is null
    and not exists (select 1 from public.staff_credentials n where n.replaces_credential_id = c.id)
    and (not c.verified or (c.expiry_date is not null and c.expiry_date < (p_scheduled_end at time zone 'Pacific/Auckland')::date));

  return jsonb_build_object(
    'staff_id', v_staff.id,
    'work_ready', v_staff.work_ready,
    'rules', case when v_rules.organization_id is null then null else jsonb_build_object(
      'min_rest_hours_between_shifts', v_rules.min_rest_hours_between_shifts,
      'max_hours_per_week', v_rules.max_hours_per_week,
      'max_consecutive_days', v_rules.max_consecutive_days,
      'enforced', v_rules.enforced) end,
    'rest_hours', v_load.rest_hours,
    'week_start', v_load.week_start,
    'week_hours', v_load.week_hours,
    'consecutive_days', v_load.consecutive_days,
    'availability_conflict', public.staff_has_roster_availability_conflict(v_staff.id, p_scheduled_start, p_scheduled_end),
    'conflict', public.staff_fatigue_conflict(v_staff.id, p_scheduled_start, p_scheduled_end, p_exclude_slot_id),
    'credential_warnings', v_credentials
  );
end;
$$;

revoke all on function public.preview_roster_assignment(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated, service_role;
grant execute on function public.preview_roster_assignment(uuid, timestamptz, timestamptz, uuid) to postgres, authenticated, service_role;
comment on function public.preview_roster_assignment(uuid, timestamptz, timestamptz, uuid) is
  'Before a roster slot is created or edited: the officer''s rest, roster-week hours and days in a row with this slot, the employer''s rules (or null when none are set), the sentence the roster would refuse on, an availability clash, and credentials unverified or expiring before the shift ends. Advisory read for whoever may roster the person.';

-- Governed writer for the rules (there was none; the table was read-only to the app).
create or replace function public.manage_organization_fatigue_rules(p_organization_id uuid, p_min_rest_hours_between_shifts numeric, p_max_hours_per_week numeric, p_max_consecutive_days integer, p_enforced boolean default true)
returns organization_fatigue_rules
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_before public.organization_fatigue_rules%rowtype;
  v_after public.organization_fatigue_rules%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to set rostering rules for this organisation'; end if;
  if not exists (select 1 from public.organizations o where o.id = p_organization_id and o.active) then raise exception 'Organisation not found'; end if;
  if p_min_rest_hours_between_shifts is null or p_min_rest_hours_between_shifts < 0 or p_min_rest_hours_between_shifts > 24 then raise exception 'Minimum rest must be between 0 and 24 hours'; end if;
  if p_max_hours_per_week is null or p_max_hours_per_week < 1 or p_max_hours_per_week > 168 then raise exception 'Weekly hours limit must be between 1 and 168'; end if;
  if p_max_consecutive_days is null or p_max_consecutive_days < 1 or p_max_consecutive_days > 31 then raise exception 'Days in a row must be between 1 and 31'; end if;

  select * into v_before from public.organization_fatigue_rules r where r.organization_id = p_organization_id;
  insert into public.organization_fatigue_rules(organization_id, min_rest_hours_between_shifts, max_hours_per_week, max_consecutive_days, enforced, updated_at)
  values (p_organization_id, p_min_rest_hours_between_shifts, p_max_hours_per_week, p_max_consecutive_days, coalesce(p_enforced, true), now())
  on conflict (organization_id) do update set
    min_rest_hours_between_shifts = excluded.min_rest_hours_between_shifts,
    max_hours_per_week = excluded.max_hours_per_week,
    max_consecutive_days = excluded.max_consecutive_days,
    enforced = excluded.enforced,
    updated_at = now()
  returning * into v_after;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'roster_rules_updated', 'organization_fatigue_rules', p_organization_id, jsonb_build_object(
    'before', case when v_before.organization_id is null then null else to_jsonb(v_before) end,
    'after', to_jsonb(v_after)));
  return v_after;
end;
$$;

revoke all on function public.manage_organization_fatigue_rules(uuid, numeric, numeric, integer, boolean) from public, anon, authenticated, service_role;
grant execute on function public.manage_organization_fatigue_rules(uuid, numeric, numeric, integer, boolean) to postgres, authenticated, service_role;
comment on function public.manage_organization_fatigue_rules(uuid, numeric, numeric, integer, boolean) is
  'Sets the employing organisation''s rest and hours rules (minimum rest between shifts, hours per Mon-Sun roster week, days in a row) and whether the roster enforces them. Administrators of the organisation only; audited with before/after.';

-- Editing a draft slot: same staff rule as creating one (branch-authorised staff count), and the refusal says why.
create or replace function public.update_roster_slot(p_slot_id uuid, p_expected_status text, p_staff_id uuid, p_scheduled_start timestamp with time zone, p_scheduled_end timestamp with time zone, p_notes text default null)
returns roster_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_fatigue text;
begin
  select s.* into v_slot from public.roster_slots s where s.id = p_slot_id for update;
  if not found then raise exception 'Roster slot not found'; end if;
  if not public.is_admin_for_org(v_slot.organization_id) then raise exception 'Not authorised to edit this roster slot'; end if;
  if v_slot.status <> p_expected_status then raise exception 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status; end if;
  if v_slot.status <> 'draft' then raise exception 'Only draft roster slots can be edited'; end if;
  if p_scheduled_end <= p_scheduled_start then raise exception 'Roster slot must end after it starts'; end if;

  select sp.* into v_staff from public.staff_profiles sp where sp.id = p_staff_id and sp.work_ready;
  if not found or not (
    v_staff.organization_id = v_slot.organization_id
    or exists (select 1 from public.staff_branch_authorisations sba where sba.user_id = coalesce(v_staff.user_id, v_staff.id) and sba.branch_org_id = v_slot.organization_id and sba.status = 'active')
  ) then raise exception 'Work-ready staff profile required'; end if;
  if public.staff_has_roster_availability_conflict(v_staff.id, p_scheduled_start, p_scheduled_end) then raise exception 'Staff member is unavailable during this roster slot'; end if;
  v_fatigue := public.staff_fatigue_conflict(v_staff.id, p_scheduled_start, p_scheduled_end, v_slot.id);
  if v_fatigue is not null then raise exception 'Fatigue rule breach: %', v_fatigue; end if;

  update public.roster_slots set staff_id = p_staff_id, scheduled_start = p_scheduled_start, scheduled_end = p_scheduled_end, notes = nullif(trim(coalesce(p_notes, '')), '') where id = v_slot.id returning * into v_slot;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_slot.organization_id, v_actor, 'roster_slot_human_edited', 'roster_slots', v_slot.id, jsonb_build_object('staff_id', p_staff_id, 'scheduled_start', p_scheduled_start, 'scheduled_end', p_scheduled_end));
  return v_slot;
end;
$$;
