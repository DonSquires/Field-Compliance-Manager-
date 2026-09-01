-- On-call callout milestone tracking and travel allowance submission
-- (#travel-allowances-gap). on_call_periods already has full admin
-- INSERT/UPDATE/DELETE RLS, but officers have no way to accept/decline
-- their own assignment, and callout_shifts/travel_allowances are
-- SELECT-only with nothing populating them despite both being fully
-- designed (minimum-pay callout timeline, travel reimbursement).

create or replace function public.respond_to_on_call_period(
  p_period_id uuid,
  p_decision text
) returns table(id uuid, status text)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_user_id uuid := auth.uid();
  v_period on_call_periods%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_decision not in ('accepted', 'declined') then raise exception 'Invalid decision'; end if;

  select * into v_period from on_call_periods where on_call_periods.id = p_period_id for update;
  if not found then raise exception 'On-call period not found'; end if;
  if v_period.officer_user_id <> v_user_id then raise exception 'Not authorised to respond to this on-call period'; end if;
  if v_period.status <> 'pending' then raise exception 'On-call period is no longer pending'; end if;

  update on_call_periods set status = p_decision where on_call_periods.id = p_period_id;

  return query select p_period_id, p_decision;
end;
$$;

alter function public.respond_to_on_call_period(uuid, text) owner to postgres;
comment on function public.respond_to_on_call_period(uuid, text) is 'Officer accept/decline of their own pending on-call period assignment.';
revoke all on function public.respond_to_on_call_period(uuid, text) from public, anon;
grant execute on function public.respond_to_on_call_period(uuid, text) to authenticated, service_role;

create or replace function public.log_callout_milestone(
  p_on_call_period_id uuid,
  p_milestone text,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null
) returns table(id uuid, milestone text, milestone_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_user_id uuid := auth.uid();
  v_period on_call_periods%rowtype;
  v_callout callout_shifts%rowtype;
  v_now timestamptz := now();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_milestone not in ('received', 'departed', 'arrived', 'work_started', 'work_ended', 'returned') then
    raise exception 'Invalid callout milestone';
  end if;

  select * into v_period from on_call_periods where on_call_periods.id = p_on_call_period_id;
  if not found then raise exception 'On-call period not found'; end if;
  if v_period.officer_user_id <> v_user_id then raise exception 'Not authorised to log a callout against this on-call period'; end if;
  if v_period.status <> 'accepted' then raise exception 'On-call period is not in an accepted state'; end if;

  select * into v_callout from callout_shifts
  where callout_shifts.on_call_period_id = p_on_call_period_id and callout_shifts.officer_user_id = v_user_id;

  if not found then
    if p_milestone <> 'received' then raise exception 'The first logged milestone for a callout must be received'; end if;
    insert into callout_shifts (organization_id, on_call_period_id, officer_user_id, callout_received_at)
    values (v_period.organization_id, p_on_call_period_id, v_user_id, v_now)
    returning * into v_callout;
  else
    update callout_shifts set
      departed_at = case when p_milestone = 'departed' then v_now else departed_at end,
      arrived_at = case when p_milestone = 'arrived' then v_now else arrived_at end,
      work_started_at = case when p_milestone = 'work_started' then v_now else work_started_at end,
      work_ended_at = case when p_milestone = 'work_ended' then v_now else work_ended_at end,
      returned_at = case when p_milestone = 'returned' then v_now else returned_at end
    where callout_shifts.id = v_callout.id;
  end if;

  if p_milestone = 'returned' then
    update on_call_periods set status = 'completed' where on_call_periods.id = p_on_call_period_id;
  end if;

  return query select v_callout.id, p_milestone, v_now;
end;
$$;

alter function public.log_callout_milestone(uuid, text, double precision, double precision) owner to postgres;
comment on function public.log_callout_milestone(uuid, text, double precision, double precision) is 'Officer callout timeline logging: creates the callout_shift on first (received) milestone, then records each subsequent stage against it.';
revoke all on function public.log_callout_milestone(uuid, text, double precision, double precision) from public, anon;
grant execute on function public.log_callout_milestone(uuid, text, double precision, double precision) to authenticated, service_role;

create or replace function public.submit_travel_allowance(
  p_callout_shift_id uuid,
  p_journey_type text,
  p_distance_km numeric default null,
  p_duration_minutes integer default null,
  p_outside_jurisdiction boolean default false
) returns table(id uuid)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_user_id uuid := auth.uid();
  v_callout callout_shifts%rowtype;
  v_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_journey_type not in ('outbound', 'return', 'round_trip') then raise exception 'Invalid journey type'; end if;

  select * into v_callout from callout_shifts where callout_shifts.id = p_callout_shift_id;
  if not found then raise exception 'Callout shift not found'; end if;
  if v_callout.officer_user_id <> v_user_id and not is_admin_for_org(v_callout.organization_id) then
    raise exception 'Not authorised to submit travel allowance for this callout';
  end if;

  -- Reimbursement rates (rate_per_km, time_rate) are intentionally left null:
  -- no org-level travel rate configuration exists yet. Payroll assigns rates
  -- from the submitted distance/duration when processing the claim.
  insert into travel_allowances (organization_id, callout_shift_id, officer_user_id, journey_type, distance_km, duration_minutes, outside_jurisdiction)
  values (v_callout.organization_id, p_callout_shift_id, v_callout.officer_user_id, p_journey_type, p_distance_km, p_duration_minutes, coalesce(p_outside_jurisdiction, false))
  returning travel_allowances.id into v_id;

  return query select v_id;
end;
$$;

alter function public.submit_travel_allowance(uuid, text, numeric, integer, boolean) owner to postgres;
comment on function public.submit_travel_allowance(uuid, text, numeric, integer, boolean) is 'Officer/admin travel allowance claim for a callout. rate_per_km/time_rate are left for payroll to assign -- no rate configuration table exists yet.';
revoke all on function public.submit_travel_allowance(uuid, text, numeric, integer, boolean) from public, anon;
grant execute on function public.submit_travel_allowance(uuid, text, numeric, integer, boolean) to authenticated, service_role;
