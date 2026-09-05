-- A staff pay role is separate from the application access role. It selects the
-- organization's active reference_codes.role_code used by payroll rate rules.
ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS role_code text;

CREATE OR REPLACE FUNCTION public.set_staff_pay_role_code(
  p_staff_id uuid,
  p_expected_role_code text,
  p_role_code text DEFAULT NULL
)
RETURNS public.staff_profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_role_code text := nullif(trim(coalesce(p_role_code, '')), '');
begin
  select * into v_staff from public.staff_profiles where id = p_staff_id for update;
  if not found then raise exception 'Staff profile not found'; end if;
  if not public.is_admin_for_org(v_staff.organization_id) then raise exception 'Not authorised to set staff pay role'; end if;
  if v_staff.role_code is distinct from nullif(trim(coalesce(p_expected_role_code, '')), '') then raise exception 'Staff pay role changed; reload before saving'; end if;
  if v_role_code is not null and not exists (
    select 1 from public.reference_codes code
    where code.organization_id = v_staff.organization_id
      and code.code_type = 'role_code'
      and code.code = v_role_code
      and code.is_active
  ) then
    raise exception 'Pay role code must be an active organization role code';
  end if;

  update public.staff_profiles set role_code = v_role_code where id = v_staff.id returning * into v_staff;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_staff.organization_id, v_actor, 'staff_pay_role_set', 'staff_profiles', v_staff.id,
    jsonb_build_object('previous_role_code', nullif(trim(coalesce(p_expected_role_code, '')), ''), 'role_code', v_role_code));
  return v_staff;
end;
$$;

REVOKE ALL ON FUNCTION public.set_staff_pay_role_code(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_pay_role_code(uuid,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_dispatch_job_pay_lines(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_day_category text DEFAULT NULL
)
RETURNS TABLE(lines_written integer, total_pay numeric, unresolved_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid(); v_job public.dispatch_jobs%rowtype; v_site public.client_sites%rowtype;
  v_officer uuid; v_role_code text; v_worked_hours numeric; v_distance numeric; v_distance_reason text;
  v_rule record; v_written integer := 0; v_unresolved integer := 0; v_total numeric := 0; v_line_total numeric;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select j.* into v_job from public.dispatch_jobs j where j.id = p_dispatch_job_id for update;
  if not found then raise exception 'Dispatch job not found'; end if;
  if not public.is_admin_for_org(v_job.organization_id) then raise exception 'Not authorised to resolve pay for this organization'; end if;
  if v_job.status <> 'completed' or v_job.completed_at is null then raise exception 'Only completed dispatch jobs produce pay lines'; end if;
  if exists (select 1 from public.dispatch_job_pay_lines line where line.source_dispatch_id = v_job.id) then
    select count(*)::integer, coalesce(sum(line.line_total), 0) into v_written, v_total from public.dispatch_job_pay_lines line where line.source_dispatch_id = v_job.id;
    return query select v_written, v_total, 0; return;
  end if;

  select shift.officer_user_id into v_officer from public.shifts shift where shift.id = v_job.shift_id;
  select staff.role_code into v_role_code from public.staff_profiles staff
  where staff.organization_id = v_job.organization_id and (staff.user_id = v_officer or staff.id = v_officer) limit 1;
  v_worked_hours := case when v_job.on_scene_at is not null then extract(epoch from (v_job.completed_at - v_job.on_scene_at)) / 3600.0 when v_job.en_route_at is not null then extract(epoch from (v_job.completed_at - v_job.en_route_at)) / 3600.0 else null end;
  if v_job.client_site_id is not null then select site.* into v_site from public.client_sites site where site.id = v_job.client_site_id; end if;
  v_distance := public.compute_travel_distance_km(v_job.insert_gps_lat, v_job.insert_gps_lng, v_site.gps_lat, v_site.gps_lng);
  v_distance_reason := case when v_distance is not null then 'haversine_dispatch_origin_to_site' when v_job.insert_gps_lat is null then 'no_dispatch_origin_coordinate' when v_site.gps_lat is null then 'site_has_no_coordinate' else 'unavailable' end;

  select * into v_rule from public.resolve_rate_rule(v_job.organization_id, 'pay', v_job.completed_at, null, v_job.job_type, null, null, v_job.client_site_id, null, v_role_code, v_distance, p_day_category, 'hourly');
  if v_rule.rate_rule_id is not null and v_worked_hours is not null then
    v_line_total := round(v_worked_hours * v_rule.amount, 2);
    insert into public.dispatch_job_pay_lines(organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code, rate_type, description, quantity, unit_rate, multiplier, line_total, distance_km, distance_reason, role_code, region_code, service_type, day_category)
    values (v_job.organization_id, v_job.id, v_officer, v_rule.rate_rule_id, v_rule.pay_code, 'hourly', 'Attendance labour', round(v_worked_hours, 4), v_rule.amount, 1, v_line_total, v_distance, v_distance_reason, v_rule.role_code, v_rule.region_code, v_job.job_type, v_rule.day_category);
    v_written := v_written + 1; v_total := v_total + v_line_total;
  else
    v_unresolved := v_unresolved + 1;
    insert into public.dispatch_job_pay_lines(organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code, rate_type, description, quantity, unit_rate, multiplier, line_total, distance_km, distance_reason, role_code, service_type, day_category)
    values (v_job.organization_id, v_job.id, v_officer, null, 'UNRESOLVED', 'hourly', case when v_worked_hours is null then 'Unresolved: no on-scene or en-route timestamp' else 'Unresolved: no active hourly pay rule matched' end, coalesce(round(v_worked_hours, 4), 0), 0, 1, 0, v_distance, v_distance_reason, v_role_code, v_job.job_type, p_day_category);
    v_written := v_written + 1;
  end if;

  if v_distance is not null then
    select * into v_rule from public.resolve_rate_rule(v_job.organization_id, 'pay', v_job.completed_at, null, v_job.job_type, null, null, v_job.client_site_id, null, v_role_code, v_distance, p_day_category, 'per_km');
    if v_rule.rate_rule_id is not null then
      v_line_total := round(v_distance * v_rule.amount, 2);
      insert into public.dispatch_job_pay_lines(organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code, rate_type, description, quantity, unit_rate, multiplier, line_total, distance_km, distance_reason, role_code, region_code, service_type, day_category)
      values (v_job.organization_id, v_job.id, v_officer, v_rule.rate_rule_id, coalesce(v_rule.pay_code, 'TRAVEL'), 'per_km', 'Travel to site', v_distance, v_rule.amount, 1, v_line_total, v_distance, v_distance_reason, v_rule.role_code, v_rule.region_code, v_job.job_type, v_rule.day_category);
      v_written := v_written + 1; v_total := v_total + v_line_total;
    end if;
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_job.organization_id, v_actor, 'dispatch_pay_lines_resolved', 'dispatch_job_pay_lines', v_job.id, jsonb_build_object('dispatch_job_id', v_job.id, 'lines_written', v_written, 'unresolved_count', v_unresolved, 'total_pay', v_total, 'distance_km', v_distance, 'distance_reason', v_distance_reason, 'role_code', v_role_code, 'client_request_id', p_client_request_id));
  return query select v_written, v_total, v_unresolved;
end;
$$;

REVOKE ALL ON FUNCTION public.resolve_dispatch_job_pay_lines(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_dispatch_job_pay_lines(uuid,uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_roster_labour_cost(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(slot_id uuid, work_unit_name text, staff_id uuid, scheduled_hours numeric, pay_rate numeric, charge_rate numeric, pay_cost numeric, billable numeric, margin numeric, rate_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to view labour cost for this organization'; end if;
  return query
  select s.id, work_unit.name, s.staff_id,
    round(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    pay.amount, bill.amount,
    round(coalesce(pay.amount, 0) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    round(coalesce(bill.amount, 0) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    round((coalesce(bill.amount, 0) - coalesce(pay.amount, 0)) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    case when pay.amount is null and bill.amount is null then 'no_rules' when pay.amount is null then 'no_pay_rule' when bill.amount is null then 'no_billing_rule' else 'resolved' end
  from public.roster_slots s
  join public.roster_work_units work_unit on work_unit.id = s.work_unit_id
  left join public.staff_profiles staff on staff.id = s.staff_id
  left join lateral public.resolve_rate_rule(p_organization_id, 'pay', s.scheduled_start, work_unit.service_type, null, null, null, null, null, staff.role_code, null, null, 'hourly') pay on true
  left join lateral public.resolve_rate_rule(p_organization_id, 'billing', s.scheduled_start, work_unit.service_type, null, null, null, null, null, staff.role_code, null, null, 'hourly') bill on true
  where s.organization_id = p_organization_id and s.status not in ('cancelled', 'declined') and s.scheduled_start >= p_from and s.scheduled_start < p_to
  order by s.scheduled_start;
end;
$$;

REVOKE ALL ON FUNCTION public.get_roster_labour_cost(uuid,timestamptz,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_roster_labour_cost(uuid,timestamptz,timestamptz) TO authenticated, service_role;
