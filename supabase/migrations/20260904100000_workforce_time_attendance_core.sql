-- Tier 1: universal time & attendance core
-- 1. shift_breaks + NZ Employment Relations Act 1990 (Part 6D) entitlements
-- 2. organization_fatigue_rules + roster-time enforcement
-- 3. start_officer_shift: universal clock-in (actual_start was previously only
--    ever written by manage_officer_static_post, so patrol/internal shifts
--    could be completed but never started)
-- 4. create_payroll_export_batch: activates the dormant payroll_export_batches

CREATE TABLE IF NOT EXISTS "public"."shift_breaks" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
  "shift_id" uuid NOT NULL REFERENCES "public"."shifts"("id") ON DELETE CASCADE,
  "officer_user_id" uuid NOT NULL REFERENCES "public"."user_profiles"("id") ON DELETE RESTRICT,
  "break_type" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "ended_at" timestamptz,
  "is_paid" boolean NOT NULL,
  "client_request_id" uuid NOT NULL,
  "notes" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "shift_breaks_type_check" CHECK ("break_type" IN ('rest', 'meal')),
  CONSTRAINT "shift_breaks_time_check" CHECK ("ended_at" IS NULL OR "ended_at" > "started_at"),
  UNIQUE ("organization_id", "client_request_id")
);

CREATE INDEX IF NOT EXISTS "idx_shift_breaks_shift" ON "public"."shift_breaks"("shift_id", "started_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_shift_breaks_open" ON "public"."shift_breaks"("shift_id") WHERE "ended_at" IS NULL;

ALTER TABLE "public"."shift_breaks" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shift_breaks_select" ON "public"."shift_breaks";
CREATE POLICY "shift_breaks_select" ON "public"."shift_breaks" FOR SELECT TO "authenticated"
  USING (public.is_admin_for_org(organization_id) OR officer_user_id = auth.uid());

REVOKE ALL ON TABLE "public"."shift_breaks" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT ON TABLE "public"."shift_breaks" TO "authenticated";
GRANT ALL ON TABLE "public"."shift_breaks" TO "service_role";

COMMENT ON TABLE "public"."shift_breaks" IS 'Rest and meal breaks taken during a shift. Rest breaks are paid, meal breaks unpaid, per Employment Relations Act 1990 Part 6D.';

CREATE TABLE IF NOT EXISTS "public"."organization_fatigue_rules" (
  "organization_id" uuid PRIMARY KEY REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
  "min_rest_hours_between_shifts" numeric(4,1) DEFAULT 10 NOT NULL,
  "max_hours_per_week" numeric(5,1) DEFAULT 60 NOT NULL,
  "max_consecutive_days" integer DEFAULT 7 NOT NULL,
  "enforced" boolean DEFAULT true NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fatigue_rest_check" CHECK ("min_rest_hours_between_shifts" >= 0 AND "min_rest_hours_between_shifts" <= 48),
  CONSTRAINT "fatigue_week_check" CHECK ("max_hours_per_week" > 0 AND "max_hours_per_week" <= 168),
  CONSTRAINT "fatigue_days_check" CHECK ("max_consecutive_days" > 0 AND "max_consecutive_days" <= 31)
);

ALTER TABLE "public"."organization_fatigue_rules" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organization_fatigue_rules_select" ON "public"."organization_fatigue_rules";
CREATE POLICY "organization_fatigue_rules_select" ON "public"."organization_fatigue_rules" FOR SELECT TO "authenticated"
  USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE "public"."organization_fatigue_rules" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT ON TABLE "public"."organization_fatigue_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_fatigue_rules" TO "service_role";

DROP TRIGGER IF EXISTS "trg_fatigue_rules_touch" ON "public"."organization_fatigue_rules";
CREATE TRIGGER "trg_fatigue_rules_touch" BEFORE UPDATE ON "public"."organization_fatigue_rules"
  FOR EACH ROW EXECUTE FUNCTION "public"."tg_touch_updated_at"();

-- Universal clock-in. Idempotent: a second call on an already-started shift
-- returns the original actual_start rather than moving it.
CREATE OR REPLACE FUNCTION "public"."start_officer_shift"(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_expected_status text,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL
)
RETURNS TABLE(shift_id uuid, shift_status text, started_at timestamptz, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_at timestamptz := now();
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then
    raise exception 'Shift not found';
  end if;

  if v_shift.officer_user_id <> v_actor and not public.is_admin_for_org(v_shift.organization_id) then
    raise exception 'Only the assigned officer or an administrator can start this shift';
  end if;

  if v_shift.status = 'in_progress' and v_shift.actual_start is not null then
    return query select v_shift.id, v_shift.status, v_shift.actual_start, false;
    return;
  end if;

  if v_shift.status <> p_expected_status then
    raise exception 'Shift changed from expected status % to %', p_expected_status, v_shift.status;
  end if;

  if v_shift.status not in ('scheduled', 'published', 'accepted') then
    raise exception 'Shift cannot be started from status %', v_shift.status;
  end if;

  update public.shifts
  set status = 'in_progress', actual_start = coalesce(actual_start, v_at), updated_at = v_at
  where id = v_shift.id
  returning * into v_shift;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_shift.organization_id, v_actor, 'officer_shift_started', 'shifts', v_shift.id,
    jsonb_build_object(
      'previous_status', p_expected_status,
      'actual_start', v_shift.actual_start,
      'gps_lat', p_gps_lat,
      'gps_lng', p_gps_lng,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_shift.id, v_shift.status, v_shift.actual_start, true;
end;
$$;

REVOKE ALL ON FUNCTION "public"."start_officer_shift"(uuid,uuid,text,double precision,double precision) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."start_officer_shift"(uuid,uuid,text,double precision,double precision) TO "authenticated", "service_role";

-- Entitlement per Employment Relations Act 1990 s69ZD: one paid 10-minute rest
-- break per ~2h of a 4h block, one unpaid 30-minute meal break per 4h beyond
-- the first two hours worked.
CREATE OR REPLACE FUNCTION "public"."get_shift_break_entitlement"(p_shift_id uuid)
RETURNS TABLE(
  worked_hours numeric,
  rest_breaks_required integer,
  meal_breaks_required integer,
  rest_breaks_taken integer,
  meal_breaks_taken integer,
  compliant boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_shift public.shifts%rowtype;
  v_hours numeric;
  v_rest_req integer;
  v_meal_req integer;
  v_rest_taken integer;
  v_meal_taken integer;
begin
  select s.* into v_shift from public.shifts s where s.id = p_shift_id;
  if not found then
    raise exception 'Shift not found';
  end if;

  v_hours := extract(epoch from (coalesce(v_shift.actual_end, v_shift.scheduled_end)
    - coalesce(v_shift.actual_start, v_shift.scheduled_start))) / 3600.0;

  v_rest_req := case
    when v_hours < 2 then 0
    when v_hours < 4 then 1
    when v_hours < 6 then 1
    when v_hours < 8 then 2
    else 2 + floor((v_hours - 8) / 4)::integer
  end;

  v_meal_req := case
    when v_hours < 4 then 0
    when v_hours < 8 then 1
    else 1 + floor((v_hours - 8) / 4)::integer
  end;

  select
    count(*) filter (where b.break_type = 'rest' and b.ended_at is not null),
    count(*) filter (where b.break_type = 'meal' and b.ended_at is not null)
  into v_rest_taken, v_meal_taken
  from public.shift_breaks b
  where b.shift_id = v_shift.id;

  return query select
    round(v_hours, 2),
    v_rest_req,
    v_meal_req,
    coalesce(v_rest_taken, 0),
    coalesce(v_meal_taken, 0),
    coalesce(v_rest_taken, 0) >= v_rest_req and coalesce(v_meal_taken, 0) >= v_meal_req;
end;
$$;

REVOKE ALL ON FUNCTION "public"."get_shift_break_entitlement"(uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_shift_break_entitlement"(uuid) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."start_shift_break"(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_break_type text
)
RETURNS public.shift_breaks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_break public.shift_breaks%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  if p_break_type not in ('rest', 'meal') then
    raise exception 'Break type must be rest or meal';
  end if;

  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then
    raise exception 'Shift not found';
  end if;

  if v_shift.officer_user_id <> v_actor then
    raise exception 'Only the assigned officer can record a break';
  end if;

  select b.* into v_break from public.shift_breaks b
  where b.organization_id = v_shift.organization_id and b.client_request_id = p_client_request_id;
  if found then
    return v_break;
  end if;

  if v_shift.status <> 'in_progress' then
    raise exception 'Breaks can only be recorded while the shift is in progress';
  end if;

  if exists (select 1 from public.shift_breaks b where b.shift_id = v_shift.id and b.ended_at is null) then
    raise exception 'An open break is already in progress for this shift';
  end if;

  insert into public.shift_breaks(
    organization_id, shift_id, officer_user_id, break_type, started_at, is_paid, client_request_id
  )
  values (
    v_shift.organization_id, v_shift.id, v_actor, p_break_type, now(), p_break_type = 'rest', p_client_request_id
  )
  returning * into v_break;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_shift.organization_id, v_actor, 'shift_break_started', 'shift_breaks', v_break.id,
    jsonb_build_object('shift_id', v_shift.id, 'break_type', p_break_type, 'is_paid', v_break.is_paid)
  );

  return v_break;
end;
$$;

REVOKE ALL ON FUNCTION "public"."start_shift_break"(uuid,uuid,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."start_shift_break"(uuid,uuid,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."end_shift_break"(
  p_break_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS public.shift_breaks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_break public.shift_breaks%rowtype;
begin
  select b.* into v_break from public.shift_breaks b where b.id = p_break_id for update;
  if not found then
    raise exception 'Break not found';
  end if;

  if v_break.officer_user_id <> v_actor then
    raise exception 'Only the officer who started this break can end it';
  end if;

  if v_break.ended_at is not null then
    return v_break;
  end if;

  update public.shift_breaks
  set ended_at = now(), notes = nullif(trim(coalesce(p_notes, '')), '')
  where id = v_break.id
  returning * into v_break;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_break.organization_id, v_actor, 'shift_break_ended', 'shift_breaks', v_break.id,
    jsonb_build_object(
      'shift_id', v_break.shift_id,
      'break_type', v_break.break_type,
      'duration_minutes', round(extract(epoch from (v_break.ended_at - v_break.started_at)) / 60.0)
    )
  );

  return v_break;
end;
$$;

REVOKE ALL ON FUNCTION "public"."end_shift_break"(uuid,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."end_shift_break"(uuid,text) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."staff_fatigue_conflict"(
  p_staff_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_exclude_slot_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_org uuid;
  v_rules public.organization_fatigue_rules%rowtype;
  v_gap_hours numeric;
  v_week_hours numeric;
  v_consecutive integer;
begin
  select sp.organization_id into v_org from public.staff_profiles sp where sp.id = p_staff_id;
  if v_org is null then
    return null;
  end if;

  select r.* into v_rules from public.organization_fatigue_rules r where r.organization_id = v_org;
  if not found or not v_rules.enforced then
    return null;
  end if;

  select min(
    case
      when s.scheduled_start >= p_scheduled_end
        then extract(epoch from (s.scheduled_start - p_scheduled_end)) / 3600.0
      else extract(epoch from (p_scheduled_start - s.scheduled_end)) / 3600.0
    end
  ) into v_gap_hours
  from public.roster_slots s
  where s.staff_id = p_staff_id
    and s.status not in ('declined', 'cancelled')
    and (p_exclude_slot_id is null or s.id <> p_exclude_slot_id)
    and not tstzrange(s.scheduled_start, s.scheduled_end, '[)') && tstzrange(p_scheduled_start, p_scheduled_end, '[)');

  if v_gap_hours is not null and v_gap_hours < v_rules.min_rest_hours_between_shifts then
    return format('Minimum rest of %s hours not met (%s hours between shifts)',
      v_rules.min_rest_hours_between_shifts, round(v_gap_hours, 1));
  end if;

  select coalesce(sum(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0), 0)
  into v_week_hours
  from public.roster_slots s
  where s.staff_id = p_staff_id
    and s.status not in ('declined', 'cancelled')
    and (p_exclude_slot_id is null or s.id <> p_exclude_slot_id)
    and s.scheduled_start >= p_scheduled_start - interval '7 days'
    and s.scheduled_start < p_scheduled_start + interval '7 days';

  v_week_hours := v_week_hours + extract(epoch from (p_scheduled_end - p_scheduled_start)) / 3600.0;

  if v_week_hours > v_rules.max_hours_per_week then
    return format('Weekly hours limit exceeded (%s of %s hours)',
      round(v_week_hours, 1), v_rules.max_hours_per_week);
  end if;

  select count(distinct (s.scheduled_start at time zone 'Pacific/Auckland')::date)
  into v_consecutive
  from public.roster_slots s
  where s.staff_id = p_staff_id
    and s.status not in ('declined', 'cancelled')
    and (p_exclude_slot_id is null or s.id <> p_exclude_slot_id)
    and s.scheduled_start >= p_scheduled_start - (v_rules.max_consecutive_days || ' days')::interval
    and s.scheduled_start <= p_scheduled_start;

  if v_consecutive >= v_rules.max_consecutive_days then
    return format('Maximum of %s consecutive working days reached', v_rules.max_consecutive_days);
  end if;

  return null;
end;
$$;

REVOKE ALL ON FUNCTION "public"."staff_fatigue_conflict"(uuid,timestamptz,timestamptz,uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."staff_fatigue_conflict"(uuid,timestamptz,timestamptz,uuid) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."enforce_roster_slot_availability"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_fatigue text;
begin
  if new.status not in ('declined', 'cancelled') then
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
$$;

CREATE OR REPLACE FUNCTION "public"."create_payroll_export_batch"(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_period_from date,
  p_period_to date,
  p_format text DEFAULT 'csv',
  p_notes text DEFAULT NULL
)
RETURNS TABLE(batch_id uuid, timesheet_count integer, total_hours numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_batch public.payroll_export_batches%rowtype;
  v_count integer;
  v_hours numeric;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select actor.organization_id into v_provider from public.user_profiles actor
  where actor.id = v_actor and actor.deactivated_at is null;

  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active payroll administrator required';
  end if;

  if p_organization_id <> v_provider then
    raise exception 'Organization is outside your managed hierarchy';
  end if;

  if p_period_to < p_period_from then
    raise exception 'Export period end must not precede its start';
  end if;

  if p_format not in ('csv', 'json', 'ird_csv') then
    raise exception 'Unsupported payroll export format';
  end if;

  select count(*), coalesce(sum(coalesce(t.actual_hours, t.work_derived_hours, 0)), 0)
  into v_count, v_hours
  from public.timesheets t
  where t.organization_id = v_provider
    and t.status = 'approved'
    and t.payroll_export_batch_id is null
    and t.period_start >= p_period_from
    and t.period_end <= p_period_to;

  if v_count = 0 then
    raise exception 'No approved unexported timesheets in this period';
  end if;

  insert into public.payroll_export_batches(
    organization_id, exported_by, period_from, period_to, format, timesheet_count, total_hours, notes
  )
  values (
    v_provider, v_actor, p_period_from, p_period_to, p_format, v_count, v_hours,
    nullif(trim(coalesce(p_notes, '')), '')
  )
  returning * into v_batch;

  update public.timesheets t
  set payroll_export_batch_id = v_batch.id, status = 'paid'
  where t.organization_id = v_provider
    and t.status = 'approved'
    and t.payroll_export_batch_id is null
    and t.period_start >= p_period_from
    and t.period_end <= p_period_to;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_provider, v_actor, 'payroll_export_batch_created', 'payroll_export_batches', v_batch.id,
    jsonb_build_object(
      'period_from', p_period_from,
      'period_to', p_period_to,
      'timesheet_count', v_count,
      'total_hours', v_hours,
      'format', p_format,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_batch.id, v_batch.timesheet_count, v_batch.total_hours;
end;
$$;

REVOKE ALL ON FUNCTION "public"."create_payroll_export_batch"(uuid,uuid,date,date,text,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."create_payroll_export_batch"(uuid,uuid,date,date,text,text) TO "authenticated", "service_role";
