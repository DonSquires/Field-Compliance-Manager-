-- Timesheet, staff pay and roster readiness links.
-- 1. Remove the one-argument branch timesheet queue overload. PostgREST cannot
--    choose between it and the date-range overload when called with one argument.
-- 2. Staff-specific pay rates live on rate_rules (staff_id) and are managed from
--    Staff Profile > Employment & pay through manage_staff_pay_rate.
-- 3. Every pay resolver gives staff-specific rules precedence and never applies
--    one person's rate to anyone else.
-- 4. Roster commercial readiness returns human references (work unit, time,
--    officer, agreement, client, site) instead of only a slot id.

DROP FUNCTION IF EXISTS public.get_branch_timesheet_queue(uuid);

ALTER TABLE public.rate_rules
  ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;

ALTER TABLE public.rate_rules DROP CONSTRAINT IF EXISTS rate_rules_staff_pay_only;
ALTER TABLE public.rate_rules
  ADD CONSTRAINT rate_rules_staff_pay_only CHECK (staff_id IS NULL OR rule_kind = 'pay');

CREATE INDEX IF NOT EXISTS rate_rules_staff_pay_idx
  ON public.rate_rules (staff_id, effective_from)
  WHERE staff_id IS NOT NULL;

COMMENT ON COLUMN public.rate_rules.staff_id IS
  'Optional staff member a pay rule applies to. Staff-specific rules take precedence over role, service and general pay rules. Managed through manage_staff_pay_rate.';

CREATE OR REPLACE FUNCTION public.timesheet_effective_pay(p_timesheet_id uuid)
 RETURNS TABLE(rate_rule_id uuid, pay_code text, hourly_rate numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN t.payroll_snapshot IS NOT NULL THEN (t.payroll_snapshot->>'rate_rule_id')::uuid ELSE r.id END,
    coalesce(t.payroll_snapshot->>'pay_code',t.pay_code_override,r.pay_code),
    coalesce((t.payroll_snapshot->>'hourly_rate')::numeric,t.hourly_rate_override,r.amount)
  FROM public.timesheets t
  JOIN public.staff_profiles sp ON sp.id=t.staff_id AND sp.organization_id=t.organization_id
  LEFT JOIN public.shifts s ON s.id=t.shift_id
  LEFT JOIN LATERAL (
    SELECT rr.id,rr.pay_code,rr.amount FROM public.rate_rules rr
    WHERE rr.organization_id=t.organization_id AND rr.rule_kind='pay' AND rr.rate_type='hourly' AND rr.active
      AND (rr.staff_id IS NULL OR rr.staff_id=sp.id)
      AND (rr.role_code IS NULL OR rr.role_code=sp.role_code)
      AND (rr.service_type IS NULL OR rr.service_type=s.service_type)
      AND (rr.effective_from IS NULL OR rr.effective_from<=t.period_start)
      AND (rr.effective_to IS NULL OR rr.effective_to>=t.period_start)
    ORDER BY (rr.staff_id IS NOT NULL)::integer DESC,(rr.role_code IS NOT NULL)::integer DESC,
      (rr.service_type IS NOT NULL)::integer DESC,rr.priority DESC,rr.effective_from DESC NULLS LAST,rr.id LIMIT 1
  ) r ON true
  WHERE t.id=p_timesheet_id AND public.is_admin_for_org(t.organization_id)
    AND EXISTS (SELECT 1 FROM public.user_profiles u WHERE u.id=auth.uid()
      AND u.organization_id=t.organization_id AND u.deactivated_at IS NULL)
$function$;
REVOKE ALL ON FUNCTION public.timesheet_effective_pay(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.timesheet_effective_pay(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_staff_pay_rate(
  p_client_request_id uuid,
  p_action text,
  p_staff_id uuid,
  p_rate_rule_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_rate_type text DEFAULT 'hourly',
  p_amount numeric DEFAULT NULL,
  p_pay_code text DEFAULT NULL,
  p_service_type text DEFAULT NULL,
  p_effective_from date DEFAULT NULL,
  p_effective_to date DEFAULT NULL,
  p_reason text DEFAULT NULL
)
 RETURNS public.rate_rules
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_old public.rate_rules%rowtype;
  v_rule public.rate_rules%rowtype;
  v_name text;
  v_pay_code text := upper(nullif(btrim(coalesce(p_pay_code, '')), ''));
  v_service text := nullif(btrim(coalesce(p_service_type, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_from date := coalesce(p_effective_from, current_date);
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_action NOT IN ('create', 'review', 'end') THEN RAISE EXCEPTION 'Unsupported staff pay action'; END IF;
  IF v_reason IS NULL OR length(v_reason) > 2000 THEN RAISE EXCEPTION 'A reason is required for every pay change'; END IF;

  SELECT * INTO v_staff FROM public.staff_profiles WHERE id = p_staff_id;
  IF NOT FOUND OR NOT public.is_timesheet_payroll_admin(v_staff.organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_rule FROM public.rate_rules
   WHERE organization_id = v_staff.organization_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_rule.staff_id IS DISTINCT FROM v_staff.id THEN RAISE EXCEPTION 'Request ID already used for another pay rule'; END IF;
    RETURN v_rule;
  END IF;
  SELECT rr.* INTO v_rule FROM public.audit_log a JOIN public.rate_rules rr ON rr.id = a.target_id
   WHERE a.organization_id = v_staff.organization_id AND a.action = 'staff_pay_rate_ended'
     AND a.metadata->>'client_request_id' = p_client_request_id::text;
  IF FOUND THEN RETURN v_rule; END IF;

  IF p_action IN ('review', 'end') THEN
    SELECT * INTO v_old FROM public.rate_rules
     WHERE id = p_rate_rule_id AND staff_id = v_staff.id AND organization_id = v_staff.organization_id
     FOR UPDATE;
    IF NOT FOUND OR NOT v_old.active THEN RAISE EXCEPTION 'Active staff pay rate not found'; END IF;
    IF p_expected_updated_at IS NOT NULL AND v_old.updated_at <> p_expected_updated_at THEN
      RAISE EXCEPTION 'This pay rate changed since it was opened; reload';
    END IF;
  END IF;

  IF p_action = 'end' THEN
    IF p_effective_to IS NULL THEN RAISE EXCEPTION 'Choose the last day this rate applies'; END IF;
    IF v_old.effective_from IS NOT NULL AND p_effective_to < v_old.effective_from THEN
      RAISE EXCEPTION 'The end date cannot precede the start of the rate';
    END IF;
    UPDATE public.rate_rules SET effective_to = p_effective_to, updated_by = v_actor
     WHERE id = v_old.id RETURNING * INTO v_rule;
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_staff.organization_id, v_actor, 'staff_pay_rate_ended', 'rate_rules', v_rule.id,
      jsonb_build_object('client_request_id', p_client_request_id, 'staff_id', v_staff.id,
        'effective_to', p_effective_to, 'reason', v_reason));
    RETURN v_rule;
  END IF;

  IF p_action = 'review' THEN
    v_service := CASE WHEN p_service_type IS NULL THEN v_old.service_type ELSE v_service END;
    v_pay_code := coalesce(v_pay_code, v_old.pay_code);
  END IF;

  IF p_rate_type NOT IN ('hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage',
      'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout',
      'higher_duties_flat', 'per_visit', 'per_notice')
    OR p_amount IS NULL OR p_amount < 0 OR p_amount > 100000 OR p_amount = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Choose a rate type and a non-negative amount';
  END IF;
  IF p_effective_to IS NOT NULL AND p_effective_to < v_from THEN
    RAISE EXCEPTION 'Effective end cannot precede effective start';
  END IF;
  IF v_pay_code IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.reference_codes code
     WHERE code.organization_id = v_staff.organization_id AND code.code_type = 'pay_item'
       AND code.code = v_pay_code AND code.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active payroll pay code';
  END IF;
  IF v_service IS NOT NULL
    AND v_service IS DISTINCT FROM v_old.service_type
    AND NOT EXISTS (SELECT 1 FROM public.module_catalog m WHERE m.module_key = v_service AND m.active)
    AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.organization_id = v_staff.organization_id AND s.service_type = v_service)
    AND NOT EXISTS (SELECT 1 FROM public.roster_work_units u WHERE u.organization_id = v_staff.organization_id AND u.service_type = v_service)
  THEN
    RAISE EXCEPTION 'Choose a service from the module catalogue or one already rostered';
  END IF;

  IF p_action = 'review' THEN
    IF v_old.effective_from IS NOT NULL AND v_from <= v_old.effective_from THEN
      RAISE EXCEPTION 'A pay review must start after the current rate started';
    END IF;
    UPDATE public.rate_rules SET effective_to = v_from - 1, updated_by = v_actor
     WHERE id = v_old.id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.rate_rules rr
     WHERE rr.staff_id = v_staff.id AND rr.organization_id = v_staff.organization_id AND rr.active
       AND rr.rate_type = p_rate_type
       AND rr.service_type IS NOT DISTINCT FROM v_service
       AND (rr.effective_to IS NULL OR rr.effective_to >= v_from)
       AND (p_effective_to IS NULL OR rr.effective_from IS NULL OR rr.effective_from <= p_effective_to)
  ) THEN
    RAISE EXCEPTION 'This person already has a % rate for that task in this period; use Pay review to change it', replace(p_rate_type, '_', ' ');
  END IF;

  SELECT coalesce(nullif(btrim(u.display_name), ''), v_staff.employee_number, 'Staff member')
    INTO v_name
    FROM public.user_profiles u WHERE u.id = coalesce(v_staff.user_id, v_staff.id);
  v_name := coalesce(v_name, v_staff.employee_number, 'Staff member') || ' · '
    || coalesce(replace(v_service, '_', ' '), 'all work') || ' · ' || replace(p_rate_type, '_', ' ');

  INSERT INTO public.rate_rules (
    organization_id, rule_kind, name, rate_type, amount, pay_code, staff_id, service_type,
    effective_from, effective_to, priority, active, created_by, updated_by, client_request_id
  ) VALUES (
    v_staff.organization_id, 'pay', left(v_name, 200), p_rate_type, p_amount, v_pay_code, v_staff.id, v_service,
    v_from, p_effective_to, 0, true, v_actor, v_actor, p_client_request_id
  ) RETURNING * INTO v_rule;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_staff.organization_id, v_actor,
    CASE WHEN p_action = 'review' THEN 'staff_pay_rate_reviewed' ELSE 'staff_pay_rate_created' END,
    'rate_rules', v_rule.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'staff_id', v_staff.id,
      'previous_rate_rule_id', v_old.id, 'previous_amount', v_old.amount, 'amount', p_amount,
      'rate_type', p_rate_type, 'pay_code', v_pay_code, 'service_type', v_service,
      'effective_from', v_from, 'effective_to', p_effective_to, 'reason', v_reason));
  RETURN v_rule;
END
$function$;
COMMENT ON FUNCTION public.manage_staff_pay_rate(uuid, text, uuid, uuid, timestamptz, text, numeric, text, text, date, date, text) IS
  'Employer payroll administrators create, review (end the current rate and start a new one) or end a staff member''s pay rate. Pay codes come from active pay_item reference codes and services from module_catalog. Audited and idempotent on client_request_id.';
REVOKE ALL ON FUNCTION public.manage_staff_pay_rate(uuid, text, uuid, uuid, timestamptz, text, numeric, text, text, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_staff_pay_rate(uuid, text, uuid, uuid, timestamptz, text, numeric, text, text, date, date, text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_roster_commercial_readiness(uuid, timestamptz, timestamptz);
CREATE FUNCTION public.get_roster_commercial_readiness(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(
   slot_id uuid, pay_status text, billing_status text, quote_status text, geofence_status text, cost_centre_status text,
   work_unit_id uuid, work_unit_name text, work_unit_type text, service_type text,
   scheduled_start timestamptz, scheduled_end timestamptz, linked_shift_id uuid,
   staff_id uuid, staff_name text, service_agreement_id uuid, service_agreement_name text,
   client_organization_id uuid, site_id uuid
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to view roster commercial readiness';end if;
  if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '62 days' then raise exception 'Readiness window must be between 1 and 62 days';end if;
  return query
  select s.id,
    case when exists(select 1 from public.rate_rules r where r.organization_id=s.organization_id and r.rule_kind='pay' and r.active and (r.staff_id is null or r.staff_id=s.staff_id) and (r.service_type is null or r.service_type=u.service_type) and (r.effective_from is null or r.effective_from<=s.scheduled_start::date) and (r.effective_to is null or r.effective_to>=s.scheduled_start::date)) then 'ready' else 'missing_rule' end,
    case
      when public.roster_slot_is_source_truth(s.external_refs) then 'source_verified'
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' and not exists(select 1 from public.service_agreement_locations l join public.service_agreements a on a.id=l.service_agreement_id join public.service_agreement_modules m on m.id=u.service_agreement_module_id and m.service_agreement_id=a.id and m.enabled where l.id=u.service_agreement_location_id and l.status='active' and a.agreement_type='operational' and (a.starts_on is null or a.starts_on<=s.scheduled_start::date) and (a.ends_on is null or a.ends_on>=s.scheduled_start::date)) then 'missing_contract'
      when u.work_unit_type='static' and public.roster_agreement_billing_ready(loc.service_agreement_id,loc.site_id,loc.zone_id) then 'ready'
      when u.work_unit_type='static' then 'missing_rate'
      when s.linked_shift_id is null then 'pending_materialization'
      when not exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required where st.shift_id=s.linked_shift_id) or exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required where st.shift_id=s.linked_shift_id and (sm.service_agreement_location_id is null or sm.service_agreement_module_id is null)) then 'missing_attribution'
      when exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required join public.service_agreement_locations l on l.id=sm.service_agreement_location_id where st.shift_id=s.linked_shift_id and not public.roster_agreement_billing_ready(l.service_agreement_id,l.site_id,l.zone_id)) then 'missing_rate'
      else 'ready' end,
    case
      when public.roster_slot_is_source_truth(s.external_refs) then 'source_verified'
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' and exists(select 1 from public.quotes q where q.service_agreement_id=loc.service_agreement_id and q.status='accepted') then 'accepted'
      when u.work_unit_type='static' then 'missing'
      when s.linked_shift_id is null then 'pending_materialization'
      when exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required left join public.service_agreement_locations l on l.id=sm.service_agreement_location_id left join public.quotes q on q.service_agreement_id=l.service_agreement_id and q.status='accepted' where st.shift_id=s.linked_shift_id and q.id is null) then 'missing'
      else 'accepted' end,
    case
      when public.roster_slot_is_source_truth(s.external_refs) then 'source_verified'
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' then public.roster_place_geofence_state(loc.site_id,loc.zone_id)
      when s.linked_shift_id is null then 'pending_materialization'
      when not exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id) then 'pending_materialization'
      when exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id and public.roster_place_geofence_state(st.site_id,st.zone_id)='missing') then 'missing'
      when not exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id and public.roster_place_geofence_state(st.site_id,st.zone_id)<>'verified') then 'verified'
      else 'mapped_unverified' end,
    case when u.work_unit_type in ('patrol', 'static') then 'not_applicable' when u.cost_centre_id is not null then 'ready' else 'missing' end,
    u.id, u.name, u.work_unit_type, u.service_type,
    s.scheduled_start, s.scheduled_end, s.linked_shift_id,
    s.staff_id,
    coalesce(nullif(btrim(up.display_name), ''), sp.employee_number),
    coalesce(loc.service_agreement_id, mod_link.service_agreement_id),
    agreement.name,
    agreement.client_organization_id,
    loc.site_id
  from public.roster_slots s
  join public.roster_work_units u on u.id=s.work_unit_id
  left join public.service_agreement_locations loc on loc.id=u.service_agreement_location_id
  left join public.service_agreement_modules mod_link on mod_link.id=u.service_agreement_module_id
  left join public.service_agreements agreement on agreement.id=coalesce(loc.service_agreement_id, mod_link.service_agreement_id)
  left join public.staff_profiles sp on sp.id=s.staff_id
  left join public.user_profiles up on up.id=coalesce(sp.user_id, sp.id)
  where s.organization_id=p_organization_id and s.scheduled_start<p_to and s.scheduled_end>p_from and s.status<>'cancelled'
  order by s.scheduled_start, u.name;
end;$function$;
COMMENT ON FUNCTION public.get_roster_commercial_readiness(uuid, timestamptz, timestamptz) IS 'Admin-only pay, billing, quote, geofence and cost-centre readiness per roster slot, with human references (work unit, time, officer, agreement, client, site). Slots seeded from an owner-verified source of record report source_verified: no geofence requirement, billed by their source.';
REVOKE ALL ON FUNCTION public.get_roster_commercial_readiness(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_roster_commercial_readiness(uuid, timestamptz, timestamptz) TO authenticated, service_role;


-- Cost of service: staff-specific pay rules apply only to that person.
CREATE OR REPLACE FUNCTION "public"."get_cost_of_service_summary"(p_organization_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_organization_id is null or public.is_admin_for_org(p_organization_id) is not true then
    raise exception 'Cost of service access required' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a reporting window of up to 400 days';
  end if;

  with agreements as materialized (
    select a.id, a.name, coalesce(o.name, 'Client') as client_name
    from public.service_agreements a
    left join public.organizations o on o.id = a.client_organization_id
    where a.provider_organization_id = p_organization_id
  ),
  shifts_in_window as materialized (
    select s.id, coalesce(am.service_agreement_id, sal.service_agreement_id) as agreement_id,
      s.officer_user_id, s.service_type,
      (s.actual_start at time zone 'Pacific/Auckland')::date as work_date,
      case when s.actual_end > s.actual_start then
        greatest(extract(epoch from s.actual_end - s.actual_start) / 3600.0 - coalesce(ub.hours, 0), 0)
      end as hours
    from public.shifts s
    left join public.service_agreement_modules am on am.id = s.service_agreement_module_id
    left join public.service_agreement_locations sal on sal.id = s.service_agreement_location_id
    left join lateral (
      select sum(extract(epoch from b.ended_at - b.started_at)) / 3600.0 as hours
      from public.shift_breaks b
      where b.shift_id = s.id and b.organization_id = s.organization_id
        and not b.is_paid and b.ended_at is not null
    ) ub on true
    where s.organization_id = p_organization_id
      and s.actual_start is not null
      and s.superseded_by_shift_id is null
      and (s.actual_start at time zone 'Pacific/Auckland')::date between p_from and p_to
  ),
  worked as materialized (
    select w.*,
      exists (
        select 1 from public.finance_service_costs f
        where f.organization_id = p_organization_id and f.shift_id = w.id and f.cost_type = 'labour'
      ) as posted,
      t.id as timesheet_id, t.status as timesheet_status,
      coalesce((t.payroll_snapshot ->> 'hourly_rate')::numeric, t.hourly_rate_override, r.amount) as hourly_rate
    from shifts_in_window w
    left join lateral (
      select sp.id, sp.role_code from public.staff_profiles sp
      where sp.organization_id = p_organization_id
        and (sp.id = w.officer_user_id or sp.user_id = w.officer_user_id)
      order by (sp.id = w.officer_user_id) desc, sp.id
      limit 1
    ) sp on true
    left join lateral (
      select t.id, t.status, t.payroll_snapshot, t.hourly_rate_override
      from public.timesheets t
      where t.organization_id = p_organization_id
        and (t.shift_id = w.id or (
          t.shift_id is null and t.staff_id = sp.id
          and w.work_date between t.period_start and t.period_end
        ))
      order by (t.shift_id = w.id) desc nulls last, (t.status in ('approved', 'paid')) desc, t.created_at desc
      limit 1
    ) t on true
    left join lateral (
      select rr.amount from public.rate_rules rr
      where rr.organization_id = p_organization_id and rr.rule_kind = 'pay'
        and rr.rate_type = 'hourly' and rr.active and rr.amount is not null
        and (rr.staff_id is null or rr.staff_id = sp.id)
        and (rr.role_code is null or rr.role_code = sp.role_code)
        and (rr.service_type is null or rr.service_type = w.service_type)
        and (rr.effective_from is null or rr.effective_from <= w.work_date)
        and (rr.effective_to is null or rr.effective_to >= w.work_date)
      order by (rr.staff_id is not null)::integer desc, (rr.role_code is not null)::integer desc, (rr.service_type is not null)::integer desc,
        rr.priority desc, rr.effective_from desc nulls last, rr.id
      limit 1
    ) r on true
  ),
  jobs as materialized (
    select j.id, coalesce(
      (select a.id from agreements a where a.id = j.service_agreement_id),
      (select min(l.service_agreement_id::text)::uuid
         from public.service_agreement_locations l
         join agreements a on a.id = l.service_agreement_id
        where j.service_agreement_id is null and l.status = 'active'
          and (l.site_id = j.client_site_id or l.zone_id = j.zone_id)
       having count(distinct l.service_agreement_id) = 1)
    ) as agreement_id,
    exists (
      select 1 from public.finance_service_costs f
      where f.organization_id = p_organization_id and f.dispatch_job_id = j.id and f.cost_type = 'labour'
    ) as posted
    from public.dispatch_jobs j
    where j.organization_id = p_organization_id and j.status = 'completed'
      and (j.completed_at at time zone 'Pacific/Auckland')::date between p_from and p_to
  ),
  job_pay as (
    select j.agreement_id, count(distinct j.id) as jobs,
      count(distinct j.id) filter (where j.posted) as posted_jobs,
      coalesce(sum(pl.line_total) filter (where pl.rate_rule_id is not null and coalesce(pl.pay_code, '') <> 'UNRESOLVED'), 0) as pay_total,
      coalesce(sum(pl.line_total) filter (where not j.posted and pl.rate_rule_id is not null and coalesce(pl.pay_code, '') <> 'UNRESOLVED'), 0) as unposted_total,
      count(pl.id) filter (where pl.rate_rule_id is null or coalesce(pl.pay_code, '') = 'UNRESOLVED') as unresolved_lines,
      count(distinct j.id) filter (where pl.id is null) as jobs_without_pay
    from jobs j
    left join public.dispatch_job_pay_lines pl
      on pl.source_dispatch_id = j.id and pl.organization_id = p_organization_id
    group by j.agreement_id
  ),
  posted as (
    select f.service_agreement_id as agreement_id, f.cost_type,
      sum(f.total_cost) as total, count(*) as entries
    from public.finance_service_costs f
    left join public.shifts s on s.id = f.shift_id
    left join public.dispatch_jobs j on j.id = f.dispatch_job_id
    left join public.finance_pl_periods p on p.id = f.pl_period_id
    where f.organization_id = p_organization_id
      and case
        when s.id is not null then
          (coalesce(s.actual_start, s.scheduled_start) at time zone 'Pacific/Auckland')::date between p_from and p_to
        when j.id is not null then
          (coalesce(j.completed_at, j.created_at) at time zone 'Pacific/Auckland')::date between p_from and p_to
        else p.period_start <= p_to and p.period_end >= p_from
      end
    group by f.service_agreement_id, f.cost_type
  ),
  labour as (
    select w.agreement_id,
      count(*) filter (where w.hours is not null) as worked_shifts,
      count(*) filter (where w.hours is null) as in_progress_shifts,
      coalesce(sum(w.hours), 0) as hours,
      count(*) filter (where w.posted) as posted_shifts,
      count(*) filter (where not w.posted and w.hours is not null and w.timesheet_id is null) as no_timesheet,
      count(*) filter (where not w.posted and w.hours is not null and w.timesheet_id is not null
        and w.timesheet_status not in ('approved', 'paid')) as timesheet_not_approved,
      count(*) filter (where not w.posted and w.hours is not null
        and w.timesheet_status in ('approved', 'paid')) as approved_not_posted,
      coalesce(sum(w.hours * w.hourly_rate) filter (where not w.posted and w.hourly_rate is not null), 0) as estimate,
      count(*) filter (where not w.posted and w.hours is not null and w.hourly_rate is not null) as estimated_shifts,
      count(*) filter (where not w.posted and w.hours is not null and w.hourly_rate is null) as rate_unresolved
    from worked w
    group by w.agreement_id
  ),
  agreement_rows as (
    select a.id, a.name, a.client_name,
      coalesce((select sum(p.total) from posted p where p.agreement_id = a.id), 0) as posted_total,
      coalesce((select jsonb_agg(jsonb_build_object('costType', p.cost_type, 'total', round(p.total, 2), 'entries', p.entries)
        order by p.total desc, p.cost_type) from posted p where p.agreement_id = a.id), '[]'::jsonb) as posted_by_type,
      l.*, jp.jobs, jp.posted_jobs, jp.pay_total, jp.unposted_total, jp.unresolved_lines, jp.jobs_without_pay
    from agreements a
    left join labour l on l.agreement_id = a.id
    left join job_pay jp on jp.agreement_id = a.id
    where l.agreement_id is not null or jp.agreement_id is not null
      or exists (select 1 from posted p where p.agreement_id = a.id)
  )
  select jsonb_build_object(
    'version', 1,
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'agreements', coalesce((select jsonb_agg(jsonb_build_object(
      'agreementId', r.id,
      'agreementName', r.name,
      'clientName', r.client_name,
      'posted', jsonb_build_object('total', round(r.posted_total, 2), 'byType', r.posted_by_type),
      'labour', jsonb_build_object(
        'workedShifts', coalesce(r.worked_shifts, 0),
        'inProgressShifts', coalesce(r.in_progress_shifts, 0),
        'hours', round(coalesce(r.hours, 0), 2),
        'postedShifts', coalesce(r.posted_shifts, 0),
        'estimateNotPosted', round(coalesce(r.estimate, 0), 2),
        'estimatedShifts', coalesce(r.estimated_shifts, 0),
        'rateUnresolvedShifts', coalesce(r.rate_unresolved, 0),
        'missingSteps', jsonb_build_object(
          'noTimesheet', coalesce(r.no_timesheet, 0),
          'timesheetNotApproved', coalesce(r.timesheet_not_approved, 0),
          'approvedNotPosted', coalesce(r.approved_not_posted, 0)
        )
      ),
      'callouts', jsonb_build_object(
        'completedJobs', coalesce(r.jobs, 0),
        'postedJobs', coalesce(r.posted_jobs, 0),
        'payLineTotal', round(coalesce(r.pay_total, 0), 2),
        'notPostedPayTotal', round(coalesce(r.unposted_total, 0), 2),
        'unresolvedPayLines', coalesce(r.unresolved_lines, 0),
        'jobsWithoutPayLines', coalesce(r.jobs_without_pay, 0)
      )
    ) order by r.client_name, r.name, r.id) from agreement_rows r), '[]'::jsonb),
    'unattributed', jsonb_build_object(
      'workedShifts', (select count(*) from worked w where w.agreement_id is null),
      'hours', (select round(coalesce(sum(w.hours), 0), 2) from worked w where w.agreement_id is null),
      'completedJobs', (select count(*) from jobs j where j.agreement_id is null)
    )
  ) into v_result;
  return v_result;
end;
$function$;
COMMENT ON FUNCTION "public"."get_cost_of_service_summary"(p_organization_id uuid, p_from date, p_to date) IS 'Admin-only cost of service per agreement: posted finance costs, callout pay lines, worked hours less unpaid breaks, missing costing steps and a separate unposted labour estimate. Agreement totals only; no officer identities or per-officer pay.';
REVOKE ALL ON FUNCTION public.get_cost_of_service_summary(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cost_of_service_summary(uuid, date, date) TO authenticated, service_role;

-- Payroll readiness: a staff-specific rule is not a general fallback for a payroll role.
CREATE OR REPLACE FUNCTION "public"."get_payroll_setup_readiness"(p_operating_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_payroll_organization_id uuid;
  v_result jsonb;
BEGIN
  SELECT profile.organization_id
  INTO v_payroll_organization_id
  FROM public.user_profiles profile
  WHERE profile.id = v_actor
    AND profile.deactivated_at IS NULL
    AND profile.role IN ('grand_master', 'master', 'admin', 'admin_officer');

  IF v_payroll_organization_id IS NULL
    OR NOT public.user_can_operate_organization(p_operating_organization_id)
    OR NOT public.is_admin_for_org(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized payroll administrator required';
  END IF;

  SELECT jsonb_build_object(
    'payroll_organization_id', v_payroll_organization_id,
    'operating_organization_id', p_operating_organization_id,
    'active_pay_code_count', (
      SELECT count(*)
      FROM public.reference_codes code
      WHERE code.organization_id = v_payroll_organization_id
        AND code.code_type = 'pay_item'
        AND code.is_active
    ),
    'unassigned_staff_count', (
      SELECT count(*)
      FROM public.staff_profiles staff
      WHERE staff.organization_id = v_payroll_organization_id
        AND staff.end_date IS NULL
        AND staff.role_code IS NULL
    ),
    'rules_without_active_pay_code', (
      SELECT count(*)
      FROM public.rate_rules rule
      WHERE rule.organization_id = p_operating_organization_id
        AND rule.rule_kind = 'pay'
        AND rule.active
        AND NOT EXISTS (
          SELECT 1
          FROM public.reference_codes code
          WHERE code.organization_id = v_payroll_organization_id
            AND code.code_type = 'pay_item'
            AND code.code = rule.pay_code
            AND code.is_active
        )
    ),
    'roles', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'code', role.code,
          'name', role.name,
          'staff_count', (
            SELECT count(*)
            FROM public.staff_profiles staff
            WHERE staff.organization_id = v_payroll_organization_id
              AND staff.end_date IS NULL
              AND staff.role_code = role.code
          ),
          'specific_rule_count', (
            SELECT count(*)
            FROM public.rate_rules rule
            WHERE rule.organization_id = p_operating_organization_id
              AND rule.rule_kind = 'pay'
              AND rule.active
              AND rule.role_code = role.code
          ),
          'fallback_rule_count', (
            SELECT count(*)
            FROM public.rate_rules rule
            WHERE rule.organization_id = p_operating_organization_id
              AND rule.rule_kind = 'pay'
              AND rule.active
              AND rule.role_code IS NULL
                AND rule.staff_id IS NULL
          ),
          'status', CASE
            WHEN EXISTS (
              SELECT 1 FROM public.rate_rules rule
              WHERE rule.organization_id = p_operating_organization_id
                AND rule.rule_kind = 'pay'
                AND rule.active
                AND rule.role_code = role.code
            ) THEN 'ready'
            WHEN EXISTS (
              SELECT 1 FROM public.rate_rules rule
              WHERE rule.organization_id = p_operating_organization_id
                AND rule.rule_kind = 'pay'
                AND rule.active
                AND rule.role_code IS NULL
                AND rule.staff_id IS NULL
            ) THEN 'fallback'
            ELSE 'missing_rule'
          END
        )
        ORDER BY role.sort_order, role.code
      )
      FROM public.reference_codes role
      WHERE role.organization_id = v_payroll_organization_id
        AND role.code_type = 'role_code'
        AND role.is_active
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_payroll_setup_readiness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payroll_setup_readiness(uuid) TO authenticated, service_role;