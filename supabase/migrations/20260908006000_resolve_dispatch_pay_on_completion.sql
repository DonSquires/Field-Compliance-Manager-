-- Completing a dispatch job must snapshot pay and travel resolution in the same transaction.

create or replace function public.resolve_dispatch_job_pay_lines(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_day_category text default null
)
returns table(lines_written integer, total_pay numeric, unresolved_count integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid(); v_job public.dispatch_jobs%rowtype; v_site public.client_sites%rowtype;
  v_officer uuid; v_role_code text; v_worked_hours numeric; v_distance numeric; v_distance_reason text;
  v_rule record; v_written integer := 0; v_unresolved integer := 0; v_total numeric := 0; v_line_total numeric;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select job.* into v_job from public.dispatch_jobs job where job.id = p_dispatch_job_id for update;
  if not found then raise exception 'Dispatch job not found'; end if;
  if not public.is_admin_for_org(v_job.organization_id)
     and not exists (select 1 from public.dispatch_resources resource where resource.id = v_job.dispatch_resource_id and resource.assigned_officer_id = auth.uid())
     and v_job.assigned_officer_id is distinct from auth.uid() then
    raise exception 'Not authorised to resolve pay for this dispatch job';
  end if;
  if v_job.status <> 'completed' or v_job.completed_at is null then raise exception 'Only completed dispatch jobs produce pay lines'; end if;
  if exists (select 1 from public.dispatch_job_pay_lines line where line.source_dispatch_id = v_job.id) then
    select count(*)::integer, coalesce(sum(line.line_total), 0) into v_written, v_total from public.dispatch_job_pay_lines line where line.source_dispatch_id = v_job.id;
    return query select v_written, v_total, 0; return;
  end if;

  v_officer := coalesce(v_job.assigned_officer_id, (select shift.officer_user_id from public.shifts shift where shift.id = v_job.shift_id));
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

create or replace function public.advance_dispatch_job_status(
  p_job_id uuid,
  p_expected_status text,
  p_next_status text,
  p_outcome_notes text default null
) returns table(id uuid, status text, shift_id uuid, completed_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare
  v_job public.dispatch_jobs%rowtype;
  v_allowed boolean := false;
begin
  select * into v_job from public.dispatch_jobs where public.dispatch_jobs.id = p_job_id for update;
  if not found then raise exception 'Dispatch job not found'; end if;
  if not public.is_admin_for_org(v_job.organization_id) and not exists (
    select 1 from public.dispatch_resources resource where resource.id = v_job.dispatch_resource_id and resource.assigned_officer_id = auth.uid()
  ) and v_job.assigned_officer_id is distinct from auth.uid() then
    raise exception 'Not authorised to update this dispatch job';
  end if;
  if v_job.status <> p_expected_status then raise exception 'Dispatch job changed from expected status'; end if;
  v_allowed := case v_job.status
    when 'pending' then p_next_status in ('dispatched', 'cancelled')
    when 'dispatched' then p_next_status in ('acknowledged', 'en_route', 'cancelled')
    when 'acknowledged' then p_next_status in ('en_route', 'cancelled')
    when 'en_route' then p_next_status in ('on_scene', 'cancelled')
    when 'on_scene' then p_next_status in ('completed', 'cancelled')
    else false end;
  if not v_allowed then raise exception 'Invalid dispatch transition'; end if;
  if p_next_status in ('completed', 'cancelled') and nullif(trim(p_outcome_notes), '') is null then
    raise exception 'Outcome notes are required for terminal dispatch transitions';
  end if;
  update public.dispatch_jobs
    set status=p_next_status,
        acknowledged_at=case when p_next_status='acknowledged' then clock_timestamp() else public.dispatch_jobs.acknowledged_at end,
        en_route_at=case when p_next_status='en_route' then clock_timestamp() else public.dispatch_jobs.en_route_at end,
        on_scene_at=case when p_next_status='on_scene' then clock_timestamp() else public.dispatch_jobs.on_scene_at end,
        completed_at=case when p_next_status='completed' then clock_timestamp() else public.dispatch_jobs.completed_at end,
        outcome_notes=case when p_next_status in ('completed','cancelled') then nullif(trim(p_outcome_notes),'') else public.dispatch_jobs.outcome_notes end
    where public.dispatch_jobs.id=p_job_id;
  if p_next_status = 'completed' then
    perform public.resolve_dispatch_job_pay_lines(gen_random_uuid(), p_job_id, null);
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    values(v_job.organization_id,auth.uid(),'dispatch_job_status_advanced','dispatch_jobs',p_job_id,jsonb_build_object('previous_status',p_expected_status,'next_status',p_next_status,'assigned_officer_id',v_job.assigned_officer_id,'investigation_id',v_job.investigation_id));
  if p_next_status = 'completed' and v_job.investigation_id is not null then
    insert into public.investigation_events (investigation_id, organization_id, event_type, description, source_table, source_id, created_by)
      values(v_job.investigation_id, v_job.organization_id, 'follow_up_dispatch_completed', coalesce(nullif(trim(p_outcome_notes), ''), 'Investigation follow-up dispatch completed'), 'dispatch_jobs', p_job_id, auth.uid());
  end if;
  return query select updated.id, updated.status, updated.shift_id, updated.completed_at from public.dispatch_jobs updated where updated.id=p_job_id;
end;
$$;
