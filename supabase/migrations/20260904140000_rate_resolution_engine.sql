-- Rate resolution engine.
-- Replaces the lost rateEngine.ts / resolvePayLines() / computeTravelDistanceKm()
-- referenced by dispatch_job_pay_lines' own table comment but absent from this
-- repository and all reachable history (see docs/ENTERPRISE_SAAS_TODO.md).
--
-- Deliberately additive. Atlas flow reach before this migration:
--   rate_rules            -> 3 direct callers (all reads)
--   dispatch_job_pay_lines -> 0 direct callers
-- Nothing here alters quotes, invoices, shifts, client_sites,
-- service_agreement_locations, or get_roster_commercial_readiness, which carry
-- 15/6/53/57/30 direct flow callers respectively.

-- Haversine over the WGS84 mean radius. Travel rates band on distance, so an
-- unavailable coordinate must return NULL rather than a misleading zero.
CREATE OR REPLACE FUNCTION "public"."compute_travel_distance_km"(
  p_from_lat double precision,
  p_from_lng double precision,
  p_to_lat double precision,
  p_to_lng double precision
)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  select case
    when p_from_lat is null or p_from_lng is null or p_to_lat is null or p_to_lng is null then null
    else round((
      6371.0088 * 2 * asin(sqrt(
        power(sin(radians(p_to_lat - p_from_lat) / 2), 2)
        + cos(radians(p_from_lat)) * cos(radians(p_to_lat))
          * power(sin(radians(p_to_lng - p_from_lng) / 2), 2)
      ))
    )::numeric, 3)
  end;
$$;

REVOKE ALL ON FUNCTION "public"."compute_travel_distance_km"(double precision,double precision,double precision,double precision) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."compute_travel_distance_km"(double precision,double precision,double precision,double precision) TO "authenticated", "service_role";

-- Most-specific rule wins: every dimension a rule pins down scores, so a
-- site-specific weekend rule beats an org-wide default. NULL on a rule means
-- wildcard, not mismatch.
CREATE OR REPLACE FUNCTION "public"."resolve_rate_rule"(
  p_organization_id uuid,
  p_rule_kind text,
  p_when timestamptz,
  p_service_type text DEFAULT NULL,
  p_job_type text DEFAULT NULL,
  p_module_key text DEFAULT NULL,
  p_client_org_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_role_code text DEFAULT NULL,
  p_distance_km numeric DEFAULT NULL,
  p_day_category text DEFAULT NULL,
  p_rate_type text DEFAULT NULL
)
RETURNS TABLE(
  rate_rule_id uuid,
  rate_type text,
  amount numeric,
  pay_code text,
  role_code text,
  region_code text,
  specificity integer,
  day_category text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_when date := (p_when at time zone 'Pacific/Auckland')::date;
  v_hour integer := extract(hour from (p_when at time zone 'Pacific/Auckland'));
  v_dow integer := extract(isodow from (p_when at time zone 'Pacific/Auckland'));
  v_day text;
begin
  if p_rule_kind not in ('pay', 'billing') then
    raise exception 'rule_kind must be pay or billing';
  end if;

  -- Callers holding the regional holiday calendar pass p_day_category explicitly.
  v_day := coalesce(
    p_day_category,
    case
      when v_hour >= 22 or v_hour < 6 then 'night'
      when v_dow >= 6 then 'weekend'
      else 'weekday'
    end
  );

  return query
  select
    r.id,
    r.rate_type,
    r.amount,
    r.pay_code,
    r.role_code,
    r.region_code,
    (
      (case when r.service_type is not null then 8 else 0 end) +
      (case when r.site_id is not null then 16 else 0 end) +
      (case when r.zone_id is not null then 12 else 0 end) +
      (case when r.client_org_id is not null then 10 else 0 end) +
      (case when r.job_type is not null then 6 else 0 end) +
      (case when r.module_key is not null then 6 else 0 end) +
      (case when r.role_code is not null then 4 else 0 end) +
      (case when r.day_category is not null then 4 else 0 end) +
      (case when r.distance_min_km is not null or r.distance_max_km is not null then 3 else 0 end)
    )::integer as specificity,
    v_day
  from public.rate_rules r
  where r.organization_id = p_organization_id
    and r.rule_kind = p_rule_kind
    and r.active = true
    and (r.effective_from is null or r.effective_from <= v_when)
    and (r.effective_to is null or r.effective_to >= v_when)
    and (p_rate_type is null or r.rate_type = p_rate_type)
    and (r.service_type is null or r.service_type = p_service_type)
    and (r.job_type is null or r.job_type = p_job_type)
    and (r.module_key is null or r.module_key = p_module_key)
    and (r.client_org_id is null or r.client_org_id = p_client_org_id)
    and (r.site_id is null or r.site_id = p_site_id)
    and (r.zone_id is null or r.zone_id = p_zone_id)
    and (r.role_code is null or r.role_code = p_role_code)
    and (r.day_category is null or r.day_category = v_day)
    and (r.distance_min_km is null or (p_distance_km is not null and p_distance_km >= r.distance_min_km))
    and (r.distance_max_km is null or (p_distance_km is not null and p_distance_km <= r.distance_max_km))
  order by specificity desc, r.priority desc, r.effective_from desc nulls last, r.updated_at desc
  limit 1;
end;
$$;

REVOKE ALL ON FUNCTION "public"."resolve_rate_rule"(uuid,text,timestamptz,text,text,text,uuid,uuid,uuid,text,numeric,text,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."resolve_rate_rule"(uuid,text,timestamptz,text,text,text,uuid,uuid,uuid,text,numeric,text,text) TO "authenticated", "service_role";

-- Writes pay lines for one completed dispatch job. Idempotent through the
-- existing partial unique indexes on (organization_id, source_dispatch_id, pay_code).
-- Never emits a silent zero: an unresolved rule or unavailable distance is
-- recorded as an explicit exception line for finance review.
CREATE OR REPLACE FUNCTION "public"."resolve_dispatch_job_pay_lines"(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_day_category text DEFAULT NULL
)
RETURNS TABLE(
  lines_written integer,
  total_pay numeric,
  unresolved_count integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_job public.dispatch_jobs%rowtype;
  v_site public.client_sites%rowtype;
  v_officer uuid;
  v_worked_hours numeric;
  v_distance numeric;
  v_distance_reason text;
  v_rule record;
  v_written integer := 0;
  v_unresolved integer := 0;
  v_total numeric := 0;
  v_line_total numeric;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select j.* into v_job from public.dispatch_jobs j where j.id = p_dispatch_job_id for update;
  if not found then
    raise exception 'Dispatch job not found';
  end if;

  if not public.is_admin_for_org(v_job.organization_id) then
    raise exception 'Not authorised to resolve pay for this organization';
  end if;

  if v_job.status <> 'completed' or v_job.completed_at is null then
    raise exception 'Only completed dispatch jobs produce pay lines';
  end if;

  if exists (select 1 from public.dispatch_job_pay_lines l where l.source_dispatch_id = v_job.id) then
    select count(*)::integer, coalesce(sum(l.line_total), 0)
    into v_written, v_total
    from public.dispatch_job_pay_lines l where l.source_dispatch_id = v_job.id;
    return query select v_written, v_total, 0;
    return;
  end if;

  select up.officer_user_id into v_officer
  from (select s.officer_user_id from public.shifts s where s.id = v_job.shift_id) up;

  v_worked_hours := case
    when v_job.on_scene_at is not null then
      extract(epoch from (v_job.completed_at - v_job.on_scene_at)) / 3600.0
    when v_job.en_route_at is not null then
      extract(epoch from (v_job.completed_at - v_job.en_route_at)) / 3600.0
    else null
  end;

  if v_job.client_site_id is not null then
    select cs.* into v_site from public.client_sites cs where cs.id = v_job.client_site_id;
  end if;

  v_distance := public.compute_travel_distance_km(
    v_job.insert_gps_lat, v_job.insert_gps_lng, v_site.gps_lat, v_site.gps_lng);

  v_distance_reason := case
    when v_distance is not null then 'haversine_dispatch_origin_to_site'
    when v_job.insert_gps_lat is null then 'no_dispatch_origin_coordinate'
    when v_site.gps_lat is null then 'site_has_no_coordinate'
    else 'unavailable'
  end;

  -- Labour
  select * into v_rule from public.resolve_rate_rule(
    v_job.organization_id, 'pay', v_job.completed_at, null, v_job.job_type, null,
    null, v_job.client_site_id, null, null, v_distance, p_day_category, 'hourly');

  if v_rule.rate_rule_id is not null and v_worked_hours is not null then
    v_line_total := round(v_worked_hours * v_rule.amount, 2);
    insert into public.dispatch_job_pay_lines(
      organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code,
      rate_type, description, quantity, unit_rate, multiplier, line_total,
      distance_km, distance_reason, role_code, region_code, service_type, day_category)
    values (
      v_job.organization_id, v_job.id, v_officer, v_rule.rate_rule_id, v_rule.pay_code,
      'hourly', 'Attendance labour', round(v_worked_hours, 4), v_rule.amount, 1, v_line_total,
      v_distance, v_distance_reason, v_rule.role_code, v_rule.region_code, v_job.job_type, v_rule.day_category);
    v_written := v_written + 1;
    v_total := v_total + v_line_total;
  else
    v_unresolved := v_unresolved + 1;
    insert into public.dispatch_job_pay_lines(
      organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code,
      rate_type, description, quantity, unit_rate, multiplier, line_total,
      distance_km, distance_reason, service_type, day_category)
    values (
      v_job.organization_id, v_job.id, v_officer, null, 'UNRESOLVED',
      'hourly',
      case
        when v_worked_hours is null then 'Unresolved: no on-scene or en-route timestamp'
        else 'Unresolved: no active hourly pay rule matched'
      end,
      coalesce(round(v_worked_hours, 4), 0), 0, 1, 0,
      v_distance, v_distance_reason, v_job.job_type, p_day_category);
    v_written := v_written + 1;
  end if;

  -- Travel, only when a real distance exists
  if v_distance is not null then
    select * into v_rule from public.resolve_rate_rule(
      v_job.organization_id, 'pay', v_job.completed_at, null, v_job.job_type, null,
      null, v_job.client_site_id, null, null, v_distance, p_day_category, 'per_km');

    if v_rule.rate_rule_id is not null then
      v_line_total := round(v_distance * v_rule.amount, 2);
      insert into public.dispatch_job_pay_lines(
        organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code,
        rate_type, description, quantity, unit_rate, multiplier, line_total,
        distance_km, distance_reason, role_code, region_code, service_type, day_category)
      values (
        v_job.organization_id, v_job.id, v_officer, v_rule.rate_rule_id, coalesce(v_rule.pay_code, 'TRAVEL'),
        'per_km', 'Travel to site', v_distance, v_rule.amount, 1, v_line_total,
        v_distance, v_distance_reason, v_rule.role_code, v_rule.region_code, v_job.job_type, v_rule.day_category);
      v_written := v_written + 1;
      v_total := v_total + v_line_total;
    end if;
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_job.organization_id, v_actor, 'dispatch_pay_lines_resolved', 'dispatch_job_pay_lines', v_job.id,
    jsonb_build_object(
      'dispatch_job_id', v_job.id,
      'lines_written', v_written,
      'unresolved_count', v_unresolved,
      'total_pay', v_total,
      'distance_km', v_distance,
      'distance_reason', v_distance_reason,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_written, v_total, v_unresolved;
end;
$$;

REVOKE ALL ON FUNCTION "public"."resolve_dispatch_job_pay_lines"(uuid,uuid,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."resolve_dispatch_job_pay_lines"(uuid,uuid,text) TO "authenticated", "service_role";

-- Roster labour cost forecast: the remaining Deputy-parity gap. Read-only, so
-- it cannot disturb the roster board's existing flow edges.
CREATE OR REPLACE FUNCTION "public"."get_roster_labour_cost"(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(
  slot_id uuid,
  work_unit_name text,
  staff_id uuid,
  scheduled_hours numeric,
  pay_rate numeric,
  charge_rate numeric,
  pay_cost numeric,
  billable numeric,
  margin numeric,
  rate_status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
begin
  if not public.is_admin_for_org(p_organization_id) then
    raise exception 'Not authorised to view labour cost for this organization';
  end if;

  return query
  select
    s.id,
    wu.name,
    s.staff_id,
    round(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2) as hrs,
    pay.amount,
    bill.amount,
    round(coalesce(pay.amount, 0) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    round(coalesce(bill.amount, 0) * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    round((coalesce(bill.amount, 0) - coalesce(pay.amount, 0))
      * extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600.0, 2),
    case
      when pay.amount is null and bill.amount is null then 'no_rules'
      when pay.amount is null then 'no_pay_rule'
      when bill.amount is null then 'no_billing_rule'
      else 'resolved'
    end
  from public.roster_slots s
  join public.roster_work_units wu on wu.id = s.work_unit_id
  left join lateral public.resolve_rate_rule(
    p_organization_id, 'pay', s.scheduled_start, wu.service_type,
    null, null, null, null, null, null, null, null, 'hourly') pay on true
  left join lateral public.resolve_rate_rule(
    p_organization_id, 'billing', s.scheduled_start, wu.service_type,
    null, null, null, null, null, null, null, null, 'hourly') bill on true
  where s.organization_id = p_organization_id
    and s.status not in ('cancelled', 'declined')
    and s.scheduled_start >= p_from
    and s.scheduled_start < p_to
  order by s.scheduled_start;
end;
$$;

REVOKE ALL ON FUNCTION "public"."get_roster_labour_cost"(uuid,timestamptz,timestamptz) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."get_roster_labour_cost"(uuid,timestamptz,timestamptz) TO "authenticated", "service_role";
