-- Tier 2: activate on-call and callout management.
-- on_call_periods and callout_shifts were deployed with full pay semantics
-- (flat rate, 3h minimum guarantee, complete callout timeline) but had zero
-- RPC or UI callers. This gives them a governed server owner.

ALTER TABLE "public"."on_call_periods"
  ADD COLUMN IF NOT EXISTS "client_request_id" uuid,
  ADD COLUMN IF NOT EXISTS "decline_reason" text,
  ADD COLUMN IF NOT EXISTS "notes" text,
  ADD COLUMN IF NOT EXISTS "responded_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_on_call_periods_client_request"
  ON "public"."on_call_periods"("organization_id", "client_request_id")
  WHERE "client_request_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_on_call_periods_officer_window"
  ON "public"."on_call_periods"("officer_user_id", "starts_at", "ends_at");

ALTER TABLE "public"."callout_shifts"
  ADD COLUMN IF NOT EXISTS "client_request_id" uuid,
  ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'raised' NOT NULL,
  ADD COLUMN IF NOT EXISTS "notes" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'callout_shifts_status_check') THEN
    ALTER TABLE "public"."callout_shifts"
      ADD CONSTRAINT "callout_shifts_status_check"
      CHECK ("status" IN ('raised', 'responding', 'on_site', 'working', 'returning', 'completed', 'cancelled'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_callout_shifts_client_request"
  ON "public"."callout_shifts"("organization_id", "client_request_id")
  WHERE "client_request_id" IS NOT NULL;

REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."on_call_periods" FROM PUBLIC, "anon", "authenticated";
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."callout_shifts" FROM PUBLIC, "anon", "authenticated";

DROP POLICY IF EXISTS "on_call_periods_insert" ON "public"."on_call_periods";
DROP POLICY IF EXISTS "on_call_periods_update" ON "public"."on_call_periods";
DROP POLICY IF EXISTS "on_call_periods_delete" ON "public"."on_call_periods";

CREATE OR REPLACE FUNCTION "public"."create_on_call_period"(
  p_client_request_id uuid,
  p_officer_user_id uuid,
  p_period_type text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_flat_rate numeric DEFAULT NULL,
  p_linked_shift_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.on_call_periods
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_period public.on_call_periods%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor
  where actor.id = v_actor and actor.deactivated_at is null;

  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active roster administrator required';
  end if;

  select p.* into v_period from public.on_call_periods p
  where p.organization_id = v_provider and p.client_request_id = p_client_request_id;
  if found then
    return v_period;
  end if;

  if p_period_type not in ('standard', 'before_shift', 'after_shift', 'overnight') then
    raise exception 'Unsupported on-call period type';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'On-call period must end after it starts';
  end if;

  if not exists (
    select 1 from public.user_profiles u
    where u.id = p_officer_user_id and u.organization_id = v_provider and u.deactivated_at is null
  ) then
    raise exception 'On-call officer must be an active member of your organization';
  end if;

  if exists (
    select 1 from public.on_call_periods p
    where p.officer_user_id = p_officer_user_id
      and p.status in ('pending', 'accepted')
      and tstzrange(p.starts_at, p.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    raise exception 'Officer already holds an overlapping on-call period';
  end if;

  insert into public.on_call_periods(
    organization_id, officer_user_id, period_type, starts_at, ends_at,
    flat_rate, linked_shift_id, status, client_request_id, notes
  )
  values (
    v_provider, p_officer_user_id, p_period_type, p_starts_at, p_ends_at,
    p_flat_rate, p_linked_shift_id, 'pending', p_client_request_id,
    nullif(trim(coalesce(p_notes, '')), '')
  )
  returning * into v_period;

  perform public.enqueue_notification(
    v_provider, 'roster', 'On-call period assigned',
    format('You are on call from %s to %s.',
      to_char(p_starts_at at time zone 'Pacific/Auckland', 'DD Mon HH24:MI'),
      to_char(p_ends_at at time zone 'Pacific/Auckland', 'DD Mon HH24:MI')),
    'info', p_officer_user_id, null, 'roster', jsonb_build_object('on_call_period_id', v_period.id),
    'on_call_assigned:' || v_period.id::text
  );

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_provider, v_actor, 'on_call_period_created', 'on_call_periods', v_period.id,
    jsonb_build_object(
      'officer_user_id', p_officer_user_id,
      'period_type', p_period_type,
      'flat_rate', p_flat_rate,
      'client_request_id', p_client_request_id
    )
  );

  return v_period;
end;
$$;

REVOKE ALL ON FUNCTION "public"."create_on_call_period"(uuid,uuid,text,timestamptz,timestamptz,numeric,uuid,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."create_on_call_period"(uuid,uuid,text,timestamptz,timestamptz,numeric,uuid,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."respond_to_on_call_period"(
  p_period_id uuid,
  p_expected_status text,
  p_response text,
  p_decline_reason text DEFAULT NULL
)
RETURNS public.on_call_periods
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_period public.on_call_periods%rowtype;
  v_reason text := nullif(trim(coalesce(p_decline_reason, '')), '');
begin
  select p.* into v_period from public.on_call_periods p where p.id = p_period_id for update;
  if not found then
    raise exception 'On-call period not found';
  end if;

  if v_period.officer_user_id <> v_actor then
    raise exception 'Only the assigned officer can respond to this on-call period';
  end if;

  if v_period.status <> p_expected_status then
    raise exception 'On-call period changed from expected status % to %', p_expected_status, v_period.status;
  end if;

  if v_period.status <> 'pending' then
    raise exception 'Only pending on-call periods can be answered';
  end if;

  if p_response not in ('accepted', 'declined') then
    raise exception 'Response must be accepted or declined';
  end if;

  if p_response = 'declined' and v_reason is null then
    raise exception 'A decline reason is required';
  end if;

  update public.on_call_periods
  set status = p_response, decline_reason = v_reason, responded_at = now()
  where id = v_period.id
  returning * into v_period;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_period.organization_id, v_actor, 'on_call_period_answered', 'on_call_periods', v_period.id,
    jsonb_build_object('response', p_response, 'decline_reason', v_reason)
  );

  return v_period;
end;
$$;

REVOKE ALL ON FUNCTION "public"."respond_to_on_call_period"(uuid,text,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."respond_to_on_call_period"(uuid,text,text,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."open_callout"(
  p_client_request_id uuid,
  p_on_call_period_id uuid,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_minimum_pay_hours numeric DEFAULT 3,
  p_after_minimum_rate numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.callout_shifts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_period public.on_call_periods%rowtype;
  v_callout public.callout_shifts%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select p.* into v_period from public.on_call_periods p where p.id = p_on_call_period_id for update;
  if not found then
    raise exception 'On-call period not found';
  end if;

  if not public.is_admin_for_org(v_period.organization_id) then
    raise exception 'Not authorised to raise callouts for this organization';
  end if;

  select c.* into v_callout from public.callout_shifts c
  where c.organization_id = v_period.organization_id and c.client_request_id = p_client_request_id;
  if found then
    return v_callout;
  end if;

  if v_period.status <> 'accepted' then
    raise exception 'Callouts can only be raised against an accepted on-call period';
  end if;

  if p_minimum_pay_hours is null or p_minimum_pay_hours <= 0 or p_minimum_pay_hours > 24 then
    raise exception 'Minimum pay hours must be between 0 and 24';
  end if;

  insert into public.callout_shifts(
    organization_id, on_call_period_id, officer_user_id, dispatch_job_id,
    minimum_pay_hours, after_minimum_rate, callout_received_at, status,
    client_request_id, notes
  )
  values (
    v_period.organization_id, v_period.id, v_period.officer_user_id, p_dispatch_job_id,
    p_minimum_pay_hours, p_after_minimum_rate, now(), 'raised',
    p_client_request_id, nullif(trim(coalesce(p_notes, '')), '')
  )
  returning * into v_callout;

  perform public.enqueue_notification(
    v_period.organization_id, 'roster', 'Callout raised',
    format('You have been called out. Minimum %s hours guaranteed.', p_minimum_pay_hours),
    'critical', v_period.officer_user_id, null, 'roster',
    jsonb_build_object('callout_id', v_callout.id), 'callout_raised:' || v_callout.id::text
  );

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_period.organization_id, v_actor, 'callout_raised', 'callout_shifts', v_callout.id,
    jsonb_build_object(
      'on_call_period_id', v_period.id,
      'officer_user_id', v_period.officer_user_id,
      'minimum_pay_hours', p_minimum_pay_hours,
      'client_request_id', p_client_request_id
    )
  );

  return v_callout;
end;
$$;

REVOKE ALL ON FUNCTION "public"."open_callout"(uuid,uuid,uuid,numeric,numeric,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."open_callout"(uuid,uuid,uuid,numeric,numeric,text) TO "authenticated", "service_role";

-- Milestones advance strictly forward through the callout timeline.
CREATE OR REPLACE FUNCTION "public"."record_callout_milestone"(
  p_callout_id uuid,
  p_milestone text,
  p_expected_status text
)
RETURNS public.callout_shifts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_callout public.callout_shifts%rowtype;
  v_at timestamptz := now();
  v_next_status text;
begin
  select c.* into v_callout from public.callout_shifts c where c.id = p_callout_id for update;
  if not found then
    raise exception 'Callout not found';
  end if;

  if v_callout.officer_user_id <> v_actor and not public.is_admin_for_org(v_callout.organization_id) then
    raise exception 'Only the called-out officer or an administrator can record milestones';
  end if;

  if v_callout.status <> p_expected_status then
    raise exception 'Callout changed from expected status % to %', p_expected_status, v_callout.status;
  end if;

  v_next_status := case p_milestone
    when 'departed' then 'responding'
    when 'arrived' then 'on_site'
    when 'work_started' then 'working'
    when 'work_ended' then 'returning'
    when 'returned' then 'completed'
    else null
  end;

  if v_next_status is null then
    raise exception 'Unsupported callout milestone %', p_milestone;
  end if;

  if array_position(array['raised','responding','on_site','working','returning','completed'], v_next_status)
     <> array_position(array['raised','responding','on_site','working','returning','completed'], v_callout.status) + 1 then
    raise exception 'Callout milestone % cannot follow status %', p_milestone, v_callout.status;
  end if;

  update public.callout_shifts
  set
    status = v_next_status,
    departed_at = case when p_milestone = 'departed' then v_at else departed_at end,
    arrived_at = case when p_milestone = 'arrived' then v_at else arrived_at end,
    work_started_at = case when p_milestone = 'work_started' then v_at else work_started_at end,
    work_ended_at = case when p_milestone = 'work_ended' then v_at else work_ended_at end,
    returned_at = case when p_milestone = 'returned' then v_at else returned_at end
  where id = v_callout.id
  returning * into v_callout;

  if v_next_status = 'completed' then
    update public.on_call_periods set status = 'completed'
    where id = v_callout.on_call_period_id and status = 'accepted';
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_callout.organization_id, v_actor, 'callout_milestone_recorded', 'callout_shifts', v_callout.id,
    jsonb_build_object('milestone', p_milestone, 'status', v_next_status, 'recorded_at', v_at)
  );

  return v_callout;
end;
$$;

REVOKE ALL ON FUNCTION "public"."record_callout_milestone"(uuid,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."record_callout_milestone"(uuid,text,text) TO "authenticated", "service_role";

-- Payable hours honour the minimum guarantee even when worked time is shorter.
CREATE OR REPLACE FUNCTION "public"."get_callout_pay_summary"(p_callout_id uuid)
RETURNS TABLE(
  callout_id uuid,
  worked_hours numeric,
  minimum_pay_hours numeric,
  payable_hours numeric,
  minimum_applied boolean,
  response_minutes numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_callout public.callout_shifts%rowtype;
  v_worked numeric;
begin
  select c.* into v_callout from public.callout_shifts c where c.id = p_callout_id;
  if not found then
    raise exception 'Callout not found';
  end if;

  if not public.is_admin_for_org(v_callout.organization_id) and v_callout.officer_user_id <> auth.uid() then
    raise exception 'Not authorised to view this callout';
  end if;

  v_worked := case
    when v_callout.work_started_at is null or v_callout.work_ended_at is null then 0
    else extract(epoch from (v_callout.work_ended_at - v_callout.work_started_at)) / 3600.0
  end;

  return query select
    v_callout.id,
    round(v_worked, 2),
    v_callout.minimum_pay_hours,
    round(greatest(v_worked, v_callout.minimum_pay_hours), 2),
    v_worked < v_callout.minimum_pay_hours,
    case
      when v_callout.callout_received_at is null or v_callout.arrived_at is null then null
      else round(extract(epoch from (v_callout.arrived_at - v_callout.callout_received_at)) / 60.0, 1)
    end;
end;
$$;

REVOKE ALL ON FUNCTION "public"."get_callout_pay_summary"(uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_callout_pay_summary"(uuid) TO "authenticated", "service_role";
