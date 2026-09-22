-- Bridges the automatic per-km vehicle cost (resolve_dispatch_job_financials_internal,
-- already computing real GPS distance x rate on every completed dispatch job) into the
-- P&L cost-capture / contract-profitability pipeline (finance_service_costs ->
-- calculate_service_profitability_snapshot). Before this, vehicle travel cost only ever
-- reached dispatch_job_pay_lines/charge_lines - a dead end the profitability engine never
-- read from (confirmed via Atlas: zero writers into finance_service_costs from dispatch).
--
-- Capture is best-effort: if no open (non-closed/archived) finance_pl_period exists for the
-- job's organisation and completion date, the job still resolves normally - a missing
-- accounting period must never block dispatch pay/charge resolution.
ALTER TABLE public.finance_service_costs
  DROP CONSTRAINT finance_service_costs_source_document_type_check,
  ADD CONSTRAINT finance_service_costs_source_document_type_check
    CHECK (source_document_type = ANY (ARRAY['timesheet'::text, 'asset_check'::text, 'inventory_transaction'::text, 'asset_maintenance'::text, 'depreciation_schedule'::text, 'estimate'::text, 'manual'::text, 'dispatch_job'::text]));

CREATE OR REPLACE FUNCTION "public"."resolve_dispatch_job_financials_internal"(p_actor uuid, p_client_request_id uuid, p_dispatch_job_id uuid, p_day_category text DEFAULT NULL::text)
 RETURNS TABLE(lines_written integer, total_pay numeric, unresolved_count integer, charge_lines_written integer, total_charge numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := p_actor; v_job public.dispatch_jobs%rowtype; v_site public.client_sites%rowtype;
  v_client_org uuid; v_charge record; v_charge_written integer := 0; v_charge_total numeric := 0; v_charge_line numeric; v_shift_service text;
  v_officer uuid; v_role_code text; v_worked_hours numeric; v_distance numeric; v_distance_reason text;
  v_rule record; v_written integer := 0; v_unresolved integer := 0; v_total numeric := 0; v_line_total numeric;
  v_pl_period_id uuid;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select j.* into v_job from public.dispatch_jobs j where j.id = p_dispatch_job_id for update;
  if not found then raise exception 'Dispatch job not found'; end if;
  if v_job.status <> 'completed' or v_job.completed_at is null then raise exception 'Only completed dispatch jobs produce pay lines'; end if;
  -- Replay only when something actually resolved. Unresolved-only rows are cleared and the
  -- job is priced again, so adding the missing rule and pressing "Re-check" completes it.
  if exists (select 1 from public.dispatch_job_pay_lines line where line.source_dispatch_id = v_job.id and line.rate_rule_id is not null)
     or exists (select 1 from public.dispatch_job_charge_lines line where line.source_dispatch_id = v_job.id and line.rate_rule_id is not null) then
    select count(*)::integer, coalesce(sum(line.line_total), 0) into v_written, v_total from public.dispatch_job_pay_lines line where line.source_dispatch_id = v_job.id;
    select count(*)::integer, coalesce(sum(line.line_total), 0) into v_charge_written, v_charge_total from public.dispatch_job_charge_lines line where line.source_dispatch_id = v_job.id;
    return query select v_written, v_total, (select count(*)::integer from public.dispatch_job_pay_lines line where line.source_dispatch_id = v_job.id and line.rate_rule_id is null), v_charge_written, v_charge_total; return;
  end if;
  delete from public.dispatch_job_pay_lines where source_dispatch_id = v_job.id and rate_rule_id is null;
  delete from public.dispatch_job_charge_lines where source_dispatch_id = v_job.id and rate_rule_id is null;

  select shift.officer_user_id, shift.service_type into v_officer, v_shift_service from public.shifts shift where shift.id = v_job.shift_id;
  select staff.role_code into v_role_code from public.staff_profiles staff
  where staff.organization_id = v_job.organization_id and (staff.user_id = v_officer or staff.id = v_officer) limit 1;
  v_worked_hours := case when v_job.on_scene_at is not null then extract(epoch from (v_job.completed_at - v_job.on_scene_at)) / 3600.0 when v_job.en_route_at is not null then extract(epoch from (v_job.completed_at - v_job.en_route_at)) / 3600.0 else null end;
  if v_job.client_site_id is not null then select site.* into v_site from public.client_sites site where site.id = v_job.client_site_id; end if;
  v_distance := public.compute_travel_distance_km(v_job.insert_gps_lat, v_job.insert_gps_lng, v_site.gps_lat, v_site.gps_lng);
  v_distance_reason := case when v_distance is not null then 'haversine_dispatch_origin_to_site' when v_job.insert_gps_lat is null then 'no_dispatch_origin_coordinate' when v_site.gps_lat is null then 'site_has_no_coordinate' else 'unavailable' end;

  select * into v_rule from public.resolve_rate_rule(v_job.organization_id, 'pay', v_job.completed_at, null, v_job.job_type, null, null, v_job.client_site_id, null, v_role_code, v_distance, p_day_category, 'hourly');
  if v_rule.rate_rule_id is null and v_shift_service is not null then
  select * into v_rule from public.resolve_rate_rule(v_job.organization_id, 'pay', v_job.completed_at, v_shift_service, null, null, null, v_job.client_site_id, null, v_role_code, v_distance, p_day_category, 'hourly');
  end if;
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
  if v_rule.rate_rule_id is null and v_shift_service is not null then
  select * into v_rule from public.resolve_rate_rule(v_job.organization_id, 'pay', v_job.completed_at, v_shift_service, null, null, null, v_job.client_site_id, null, v_role_code, v_distance, p_day_category, 'per_km');
  end if;
    if v_rule.rate_rule_id is not null then
      v_line_total := round(v_distance * v_rule.amount, 2);
      insert into public.dispatch_job_pay_lines(organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code, rate_type, description, quantity, unit_rate, multiplier, line_total, distance_km, distance_reason, role_code, region_code, service_type, day_category)
      values (v_job.organization_id, v_job.id, v_officer, v_rule.rate_rule_id, coalesce(v_rule.pay_code, 'TRAVEL'), 'per_km', 'Travel to site', v_distance, v_rule.amount, 1, v_line_total, v_distance, v_distance_reason, v_rule.role_code, v_rule.region_code, v_job.job_type, v_rule.day_category);
      v_written := v_written + 1; v_total := v_total + v_line_total;

      -- Feed the same travel cost into the P&L cost ledger so contract-profitability
      -- review sees real vehicle cost, not just the dispatch pay line. Best-effort: a
      -- missing/closed period silently skips capture rather than failing the job.
      begin
        select id into v_pl_period_id from public.finance_pl_periods
        where organization_id = v_job.organization_id
          and v_job.completed_at::date between period_start and period_end
          and status not in ('closed', 'archived')
        order by period_end desc limit 1;
        if v_pl_period_id is not null and v_job.service_agreement_id is not null then
          insert into public.finance_service_costs(
            organization_id, pl_period_id, service_agreement_id, client_organization_id, cost_type,
            dispatch_job_id, shift_id, source_document_type, source_reference, quantity, unit_cost, total_cost, created_by
          )
          select v_job.organization_id, v_pl_period_id, v_job.service_agreement_id, sa.client_organization_id, 'vehicle',
            v_job.id, v_job.shift_id, 'dispatch_job', 'Travel to site (auto, dispatch completion)', v_distance, v_rule.amount, v_line_total, v_officer
          from public.service_agreements sa where sa.id = v_job.service_agreement_id
          on conflict do nothing;
        end if;
      exception when others then null;
      end;
    end if;
  end if;

  -- Customer side: what this job may be charged, from the organisation's billing rules.
  select coalesce(sa.client_organization_id, v_site.client_organization_id) into v_client_org
  from (select 1) x left join public.service_agreements sa on sa.id = v_job.service_agreement_id;
  select * into v_charge from public.resolve_rate_rule(v_job.organization_id, 'billing', v_job.completed_at, null, v_job.job_type, v_job.module_key, v_client_org, v_job.client_site_id, null, null, v_distance, p_day_category, 'hourly');
  if v_charge.rate_rule_id is null and v_shift_service is not null then
    select * into v_charge from public.resolve_rate_rule(v_job.organization_id, 'billing', v_job.completed_at, v_shift_service, null, v_job.module_key, v_client_org, v_job.client_site_id, null, null, v_distance, p_day_category, 'hourly');
  end if;
  if v_charge.rate_rule_id is not null and v_worked_hours is not null then
    v_charge_line := round(v_worked_hours * v_charge.amount, 2);
    insert into public.dispatch_job_charge_lines(organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_rule_id, rate_type, description, quantity, unit_rate, line_total, distance_km, service_type, day_category)
    values (v_job.organization_id, v_job.id, v_client_org, v_job.service_agreement_id, v_charge.rate_rule_id, 'hourly', 'Attendance', round(v_worked_hours, 4), v_charge.amount, v_charge_line, v_distance, v_job.job_type, v_charge.day_category);
    v_charge_written := v_charge_written + 1; v_charge_total := v_charge_total + v_charge_line;
  else
    insert into public.dispatch_job_charge_lines(organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_rule_id, rate_type, description, quantity, unit_rate, line_total, distance_km, service_type, day_category)
    values (v_job.organization_id, v_job.id, v_client_org, v_job.service_agreement_id, null, 'hourly', case when v_worked_hours is null then 'Unresolved: no on-scene or en-route timestamp' else 'Unresolved: no active hourly charge rule matched' end, coalesce(round(v_worked_hours, 4), 0), 0, 0, v_distance, v_job.job_type, p_day_category);
    v_charge_written := v_charge_written + 1;
  end if;
  if v_distance is not null then
    select * into v_charge from public.resolve_rate_rule(v_job.organization_id, 'billing', v_job.completed_at, null, v_job.job_type, v_job.module_key, v_client_org, v_job.client_site_id, null, null, v_distance, p_day_category, 'per_km');
    if v_charge.rate_rule_id is null and v_shift_service is not null then
      select * into v_charge from public.resolve_rate_rule(v_job.organization_id, 'billing', v_job.completed_at, v_shift_service, null, v_job.module_key, v_client_org, v_job.client_site_id, null, null, v_distance, p_day_category, 'per_km');
    end if;
    if v_charge.rate_rule_id is not null then
      v_charge_line := round(v_distance * v_charge.amount, 2);
      insert into public.dispatch_job_charge_lines(organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_rule_id, rate_type, description, quantity, unit_rate, line_total, distance_km, service_type, day_category)
      values (v_job.organization_id, v_job.id, v_client_org, v_job.service_agreement_id, v_charge.rate_rule_id, 'per_km', 'Travel to site', v_distance, v_charge.amount, v_charge_line, v_distance, v_job.job_type, v_charge.day_category);
      v_charge_written := v_charge_written + 1; v_charge_total := v_charge_total + v_charge_line;
    end if;
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_job.organization_id, v_actor, 'dispatch_financials_resolved', 'dispatch_job_pay_lines', v_job.id, jsonb_build_object('dispatch_job_id', v_job.id, 'lines_written', v_written, 'unresolved_count', v_unresolved, 'total_pay', v_total, 'charge_lines_written', v_charge_written, 'total_charge', v_charge_total, 'distance_km', v_distance, 'distance_reason', v_distance_reason, 'role_code', v_role_code, 'client_request_id', p_client_request_id));
  return query select v_written, v_total, v_unresolved, v_charge_written, v_charge_total;
end;
$function$;
