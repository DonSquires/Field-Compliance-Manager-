-- Price book, dispatch charge lines, and live financials on job completion
-- (owner direction 2026-09-15: a select menu of rates and materials for quotes and
-- jobs, travel by distance, and "the automation for job completion is sending live
-- financials"; materials in scope ahead of a manufacturing & maintenance module).
--
-- 1. Price book: finance_item_price_versions (sell price, versioned/approved like the
--    existing finance_item_cost_versions), view finance_price_book (one row per item
--    with current approved cost + price), RPC manage_finance_item (create/reprice/
--    deactivate/reactivate; the administrator entering a price list is its approver).
-- 2. dispatch_job_charge_lines: the customer side of a completed job, resolved from
--    billing rules the same way dispatch_job_pay_lines are resolved from pay rules.
-- 3. resolve_dispatch_job_financials_internal(p_actor, ...) is the resolver body
--    (verbatim from resolve_dispatch_job_pay_lines, plus charge resolution and a fallback
--    from the job's job_type to the shift's service_type, because dispatch rules are keyed
--    by job_type while roster and quote rules are keyed by service_type); the public
--    resolve_dispatch_job_pay_lines keeps its gate and return contract and delegates.
--    advance_dispatch_job_status calls the internal resolver when a job completes;
--    a failure is written to audit_log, never raised into the officer's completion.
-- 4. Quote lines accept kind 'materials' and 'equipment'.
-- 3b. advance_dispatch_job_status also gets its pre-existing ambiguity fixed (unqualified
--    completed_at/status collided with its RETURNS TABLE columns; completing a job through
--    the RPC failed live with 'column reference "completed_at" is ambiguous').
-- 5. Seed for the first subscriber (R & M): 19 customer charge rules and 89 price-book
--    items transcribed from the pricing sheets the owner photographed and supplied on
--    2026-09-15. Provenance is recorded on every row and in audit_log. No staff PAY
--    rules are seeded (the sheets carry customer charges only), so pay lines resolve
--    as UNRESOLVED for review until R & M enters its pay rates.

-- ---------------------------------------------------------------------------
-- 1. Price book
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_item_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  unit_price numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  currency text NOT NULL DEFAULT 'NZD',
  effective_from date NOT NULL,
  effective_to date,
  source_reference text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (item_id, version)
);
COMMENT ON TABLE public.finance_item_price_versions IS 'Sell price per price-book item, versioned and approved like finance_item_cost_versions. Written only by manage_finance_item.';
ALTER TABLE public.finance_item_price_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.finance_item_price_versions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.finance_item_price_versions TO authenticated;
GRANT ALL ON TABLE public.finance_item_price_versions TO service_role;
DROP POLICY IF EXISTS finance_item_price_versions_select ON public.finance_item_price_versions;
CREATE POLICY finance_item_price_versions_select ON public.finance_item_price_versions FOR SELECT TO authenticated USING (org_access_allowed(organization_id));
DROP POLICY IF EXISTS bob_full_read ON public.finance_item_price_versions;
CREATE POLICY bob_full_read ON public.finance_item_price_versions FOR SELECT TO authenticated USING ((SELECT auth.uid()) = '00000000-0000-0000-0000-00000000b0b0'::uuid);
CREATE INDEX IF NOT EXISTS idx_finance_item_price_versions_item ON public.finance_item_price_versions (item_id, status, effective_from DESC);

CREATE OR REPLACE VIEW public.finance_price_book WITH (security_invoker = true) AS
SELECT
  item.id AS item_id,
  item.organization_id,
  item.sku,
  item.name,
  item.item_type,
  item.unit_of_measure,
  item.active,
  cost.unit_cost,
  cost.supplier_name,
  price.unit_price,
  CASE WHEN price.unit_price > 0 THEN round((price.unit_price - coalesce(cost.unit_cost, 0)) / price.unit_price * 100, 2) END AS margin_pct,
  greatest(item.updated_at, coalesce(cost.created_at, item.updated_at), coalesce(price.created_at, item.updated_at)) AS updated_at
FROM public.finance_item_catalog item
LEFT JOIN LATERAL (
  SELECT c.unit_cost, c.supplier_name, c.created_at FROM public.finance_item_cost_versions c
  WHERE c.item_id = item.id AND c.status = 'approved' AND c.effective_from <= current_date AND (c.effective_to IS NULL OR c.effective_to >= current_date)
  ORDER BY c.effective_from DESC, c.version DESC LIMIT 1
) cost ON true
LEFT JOIN LATERAL (
  SELECT p.unit_price, p.created_at FROM public.finance_item_price_versions p
  WHERE p.item_id = item.id AND p.status = 'approved' AND p.effective_from <= current_date AND (p.effective_to IS NULL OR p.effective_to >= current_date)
  ORDER BY p.effective_from DESC, p.version DESC LIMIT 1
) price ON true;
COMMENT ON VIEW public.finance_price_book IS 'One row per price-book item with the current approved cost and sell price. Inherits RLS via security_invoker.';
GRANT SELECT ON public.finance_price_book TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_finance_item_internal(
  p_actor uuid,
  p_organization_id uuid,
  p_action text,
  p_item_id uuid,
  p_sku text,
  p_name text,
  p_item_type text,
  p_unit_of_measure text,
  p_unit_cost numeric,
  p_unit_price numeric,
  p_supplier_name text DEFAULT NULL,
  p_source_reference text DEFAULT NULL,
  p_effective_from date DEFAULT current_date
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item public.finance_item_catalog%rowtype;
  v_sku text := nullif(upper(trim(coalesce(p_sku, ''))), '');
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_uom text := nullif(lower(trim(coalesce(p_unit_of_measure, ''))), '');
  v_from date := coalesce(p_effective_from, current_date);
  v_next integer;
  v_created boolean := false;
begin
  if p_action not in ('create', 'reprice', 'deactivate', 'reactivate') then raise exception 'Unsupported price book action'; end if;

  if p_action in ('deactivate', 'reactivate') then
    select * into v_item from public.finance_item_catalog where id = p_item_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Price book item not found'; end if;
    update public.finance_item_catalog set active = (p_action = 'reactivate'), updated_at = now() where id = v_item.id returning * into v_item;
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (p_organization_id, p_actor, 'finance_item_' || p_action || 'd', 'finance_item_catalog', v_item.id, jsonb_build_object('sku', v_item.sku));
    return to_jsonb((select b from public.finance_price_book b where b.item_id = v_item.id));
  end if;

  if p_unit_cost is null or p_unit_cost < 0 or p_unit_price is null or p_unit_price < 0 then raise exception 'Cost and price must be zero or more'; end if;

  if p_action = 'create' then
    if v_sku is null or v_name is null or v_uom is null then raise exception 'SKU, name and unit are required'; end if;
    if p_item_type not in ('part', 'material', 'consumable', 'fuel', 'ppe', 'equipment_component', 'service') then raise exception 'Unsupported item type'; end if;
    select * into v_item from public.finance_item_catalog where organization_id = p_organization_id and sku = v_sku for update;
    if found then
      update public.finance_item_catalog set name = v_name, item_type = p_item_type, unit_of_measure = v_uom, active = true, updated_at = now() where id = v_item.id returning * into v_item;
    else
      insert into public.finance_item_catalog (organization_id, sku, name, item_type, unit_of_measure, created_by)
      values (p_organization_id, v_sku, v_name, p_item_type, v_uom, p_actor) returning * into v_item;
      v_created := true;
    end if;
  else
    select * into v_item from public.finance_item_catalog where id = p_item_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Price book item not found'; end if;
  end if;

  -- Idempotent: an identical current cost and price is not a new version.
  if not v_created and exists (
    select 1 from public.finance_price_book b where b.item_id = v_item.id and b.unit_cost = p_unit_cost and b.unit_price = p_unit_price
  ) then
    return to_jsonb((select b from public.finance_price_book b where b.item_id = v_item.id));
  end if;

  update public.finance_item_cost_versions set status = 'retired', effective_to = least(coalesce(effective_to, v_from), v_from)
   where item_id = v_item.id and status = 'approved' and (effective_to is null or effective_to >= v_from);
  select coalesce(max(version), 0) + 1 into v_next from public.finance_item_cost_versions where item_id = v_item.id;
  insert into public.finance_item_cost_versions (item_id, organization_id, unit_cost, supplier_name, effective_from, source_reference, status, version, approved_by, approved_at, created_by)
  values (v_item.id, p_organization_id, p_unit_cost, nullif(trim(coalesce(p_supplier_name, '')), ''), v_from, p_source_reference, 'approved', v_next, p_actor, now(), p_actor);

  update public.finance_item_price_versions set status = 'retired', effective_to = least(coalesce(effective_to, v_from), v_from)
   where item_id = v_item.id and status = 'approved' and (effective_to is null or effective_to >= v_from);
  select coalesce(max(version), 0) + 1 into v_next from public.finance_item_price_versions where item_id = v_item.id;
  insert into public.finance_item_price_versions (item_id, organization_id, unit_price, effective_from, source_reference, status, version, approved_by, approved_at, created_by)
  values (v_item.id, p_organization_id, p_unit_price, v_from, p_source_reference, 'approved', v_next, p_actor, now(), p_actor);

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, p_actor, case when v_created then 'finance_item_created' else 'finance_item_repriced' end, 'finance_item_catalog', v_item.id,
          jsonb_build_object('sku', v_item.sku, 'unit_cost', p_unit_cost, 'unit_price', p_unit_price, 'effective_from', v_from, 'source_reference', p_source_reference));
  return to_jsonb((select b from public.finance_price_book b where b.item_id = v_item.id));
end;
$function$;
REVOKE ALL ON FUNCTION public.manage_finance_item_internal(uuid, uuid, text, uuid, text, text, text, text, numeric, numeric, text, text, date) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_finance_item(
  p_organization_id uuid,
  p_action text,
  p_item_id uuid,
  p_sku text,
  p_name text,
  p_item_type text,
  p_unit_of_measure text,
  p_unit_cost numeric,
  p_unit_price numeric,
  p_supplier_name text DEFAULT NULL,
  p_source_reference text DEFAULT NULL,
  p_effective_from date DEFAULT current_date
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null or not public.user_can_operate_organization(p_organization_id) or not public.is_admin_for_org(p_organization_id) then
    raise exception 'Active organisation administrator required';
  end if;
  return public.manage_finance_item_internal(auth.uid(), p_organization_id, p_action, p_item_id, p_sku, p_name, p_item_type, p_unit_of_measure, p_unit_cost, p_unit_price, p_supplier_name, p_source_reference, p_effective_from);
end;
$function$;
REVOKE ALL ON FUNCTION public.manage_finance_item(uuid, text, uuid, text, text, text, text, numeric, numeric, text, text, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_finance_item(uuid, text, uuid, text, text, text, text, numeric, numeric, text, text, date) TO authenticated;
COMMENT ON FUNCTION public.manage_finance_item(uuid, text, uuid, text, text, text, text, numeric, numeric, text, text, date) IS 'Price book: create (upsert by SKU) or reprice an item with a new approved cost + price version, or deactivate/reactivate it. Organisation administrator only; every change is audited.';

-- ---------------------------------------------------------------------------
-- 2. Customer charge lines per completed dispatch job
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dispatch_job_charge_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_dispatch_id uuid NOT NULL REFERENCES public.dispatch_jobs(id) ON DELETE CASCADE,
  client_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE SET NULL,
  rate_rule_id uuid REFERENCES public.rate_rules(id) ON DELETE SET NULL,
  rate_type text NOT NULL,
  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  unit_rate numeric NOT NULL DEFAULT 0,
  line_total numeric NOT NULL DEFAULT 0,
  distance_km numeric,
  service_type text,
  day_category text,
  invoice_line_item_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.dispatch_job_charge_lines IS 'Customer charge lines resolved from billing rate_rules when a dispatch job completes (pay lines are the staff side). rate_rule_id NULL = unresolved, kept for finance review, never a $0 charge.';
ALTER TABLE public.dispatch_job_charge_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_job_charge_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.dispatch_job_charge_lines TO authenticated;
GRANT ALL ON TABLE public.dispatch_job_charge_lines TO service_role;
DROP POLICY IF EXISTS dispatch_job_charge_lines_select ON public.dispatch_job_charge_lines;
CREATE POLICY dispatch_job_charge_lines_select ON public.dispatch_job_charge_lines FOR SELECT TO authenticated USING (org_access_allowed(organization_id));
DROP POLICY IF EXISTS bob_full_read ON public.dispatch_job_charge_lines;
CREATE POLICY bob_full_read ON public.dispatch_job_charge_lines FOR SELECT TO authenticated USING ((SELECT auth.uid()) = '00000000-0000-0000-0000-00000000b0b0'::uuid);
CREATE INDEX IF NOT EXISTS idx_dispatch_job_charge_lines_job ON public.dispatch_job_charge_lines (source_dispatch_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_job_charge_lines_org ON public.dispatch_job_charge_lines (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Resolver: internal body with explicit actor; public wrapper unchanged in contract
-- ---------------------------------------------------------------------------
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
REVOKE ALL ON FUNCTION public.resolve_dispatch_job_financials_internal(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.resolve_dispatch_job_financials_internal(uuid, uuid, uuid, text) IS 'Body of dispatch financial resolution: pay lines from pay rules, charge lines from billing rules, unresolved rows kept for review. Called by resolve_dispatch_job_pay_lines (gated) and by advance_dispatch_job_status on completion. Not granted to any API role.';

CREATE OR REPLACE FUNCTION "public"."resolve_dispatch_job_pay_lines"(p_client_request_id uuid, p_dispatch_job_id uuid, p_day_category text DEFAULT NULL::text)
 RETURNS TABLE(lines_written integer, total_pay numeric, unresolved_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  select j.organization_id into v_org from public.dispatch_jobs j where j.id = p_dispatch_job_id;
  if v_org is null then raise exception 'Dispatch job not found'; end if;
  if not public.is_admin_for_org(v_org) then raise exception 'Not authorised to resolve pay for this organization'; end if;
  return query select r.lines_written, r.total_pay, r.unresolved_count
  from public.resolve_dispatch_job_financials_internal(auth.uid(), p_client_request_id, p_dispatch_job_id, p_day_category) r;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."advance_dispatch_job_status"(p_job_id uuid, p_expected_status text, p_next_status text, p_outcome_notes text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, shift_id uuid, completed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_job public.dispatch_jobs%rowtype;
  v_allowed boolean := false;
begin
  select * into v_job
  from public.dispatch_jobs
  where dispatch_jobs.id = p_job_id
  for update;

  if not found then raise exception 'Dispatch job not found'; end if;

  if not public.is_admin_for_org(v_job.organization_id) and not exists (
    select 1 from public.dispatch_resources dr
    where dr.id = v_job.dispatch_resource_id
      and dr.assigned_officer_id = auth.uid()
  ) then
    raise exception 'Not authorised to update this dispatch job';
  end if;

  if v_job.status <> p_expected_status then
    raise exception 'Dispatch job changed from expected status % to %', p_expected_status, v_job.status;
  end if;

  v_allowed := case v_job.status
    when 'pending' then p_next_status in ('dispatched', 'cancelled')
    when 'dispatched' then p_next_status in ('acknowledged', 'en_route', 'cancelled')
    when 'acknowledged' then p_next_status in ('en_route', 'cancelled')
    when 'en_route' then p_next_status in ('on_scene', 'cancelled')
    when 'on_scene' then p_next_status in ('completed', 'cancelled')
    else false
  end;

  if not v_allowed then
    raise exception 'Invalid dispatch transition from % to %', v_job.status, p_next_status;
  end if;

  if p_next_status in ('completed', 'cancelled') and nullif(trim(p_outcome_notes), '') is null then
    raise exception 'Outcome notes are required for terminal dispatch transitions';
  end if;

  update public.dispatch_jobs
  set status = p_next_status,
      acknowledged_at = case when p_next_status = 'acknowledged' then now() else dispatch_jobs.acknowledged_at end,
      en_route_at = case when p_next_status = 'en_route' then now() else dispatch_jobs.en_route_at end,
      on_scene_at = case when p_next_status = 'on_scene' then now() else dispatch_jobs.on_scene_at end,
      completed_at = case when p_next_status = 'completed' then now() else dispatch_jobs.completed_at end,
      outcome_notes = case when p_next_status in ('completed', 'cancelled') then nullif(trim(p_outcome_notes), '') else dispatch_jobs.outcome_notes end
  where dispatch_jobs.id = p_job_id;

  if p_next_status in ('completed', 'cancelled') and v_job.dispatch_resource_id is not null and not exists (
    select 1 from public.dispatch_jobs other
    where other.dispatch_resource_id = v_job.dispatch_resource_id
      and other.id <> p_job_id
      and other.status in ('dispatched', 'acknowledged', 'en_route', 'on_scene')
  ) then
    update public.dispatch_resources
    set status = 'available'
    where dispatch_resources.id = v_job.dispatch_resource_id;
  end if;

  -- Live financials on completion. Pay and charge lines are written now (unmatched rules
  -- become 'UNRESOLVED' rows for finance review); a failure here is recorded, not raised,
  -- so the officer's completion is never lost.
  if p_next_status = 'completed' then
    begin
      perform public.resolve_dispatch_job_financials_internal(auth.uid(), gen_random_uuid(), p_job_id, null);
    exception when others then
      insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (v_job.organization_id, auth.uid(), 'dispatch_financials_auto_resolution_failed', 'dispatch_jobs', p_job_id, jsonb_build_object('error', sqlerrm));
    end;
  end if;

  return query select p_job_id, p_next_status, v_job.shift_id,
    case when p_next_status = 'completed' then now() else v_job.completed_at end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Quote lines: materials and equipment
-- ---------------------------------------------------------------------------
ALTER TABLE public.quote_lines DROP CONSTRAINT IF EXISTS quote_lines_kind_check;
ALTER TABLE public.quote_lines ADD CONSTRAINT quote_lines_kind_check CHECK (kind = ANY (ARRAY['labour'::text, 'travel'::text, 'overhead'::text, 'platform_fee'::text, 'module'::text, 'custom'::text, 'materials'::text, 'equipment'::text]));
CREATE OR REPLACE FUNCTION "public"."add_crm_quote_line"(p_client_request_id uuid, p_quote_id uuid, p_expected_status text, p_kind text, p_description text, p_quantity numeric, p_unit_cost numeric, p_unit_charge numeric, p_module_key text DEFAULT NULL::text, p_site_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(line_id uuid, quote_id uuid, total_cost numeric, subtotal_charge numeric, discount_amount numeric, gst_amount numeric, total_charge numeric, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_quote public.quotes%rowtype;v_line public.quote_lines%rowtype;v_created boolean:=true;v_description text:=nullif(trim(coalesce(p_description,'')),'');
begin
  select q.* into v_quote from public.quotes q where q.id=p_quote_id for update;if not found then raise exception 'Quote not found';end if;
  if not public.is_admin_for_org(v_quote.provider_org_id) then raise exception 'Not authorised to price this quote';end if;
  if v_quote.status<>p_expected_status then raise exception 'Quote changed from expected status % to %',p_expected_status,v_quote.status;end if;if v_quote.status<>'draft' then raise exception 'Only draft quotes can be priced';end if;
  if p_client_request_id is null then raise exception 'client_request_id is required';end if;if p_kind not in('labour','travel','overhead','module','custom','materials','equipment') then raise exception 'Unsupported quote line kind';end if;if v_description is null then raise exception 'Line description is required';end if;
  if p_quantity is null or p_quantity<=0 or p_quantity>100000 or p_unit_cost is null or p_unit_cost<0 or p_unit_cost>1000000 or p_unit_charge is null or p_unit_charge<0 or p_unit_charge>1000000 then raise exception 'Quote line amounts are outside the accepted range';end if;
  if p_kind='module' and nullif(trim(coalesce(p_module_key,'')),'') is null then raise exception 'Module key is required for module lines';end if;
  if p_site_id is not null and not exists(select 1 from public.client_sites s where s.id=p_site_id and s.organization_id=v_quote.client_org_id) then raise exception 'Quote site must belong to the client organization';end if;
  select l.* into v_line from public.quote_lines l where l.quote_id=v_quote.id and l.client_request_id=p_client_request_id;if found then v_created:=false;else insert into public.quote_lines(quote_id,kind,description,quantity,unit_cost,unit_charge,module_key,site_id,line_order,client_request_id) values(v_quote.id,p_kind,v_description,p_quantity,p_unit_cost,p_unit_charge,nullif(trim(coalesce(p_module_key,'')),''),p_site_id,coalesce((select max(l.line_order)+1 from public.quote_lines l where l.quote_id=v_quote.id),0),p_client_request_id) returning * into v_line;end if;
  update public.quotes q set total_cost=totals.total_cost,subtotal_charge=totals.subtotal_charge,discount_amount=round(totals.subtotal_charge*q.discount_pct/100,2),gst_amount=round((totals.subtotal_charge-round(totals.subtotal_charge*q.discount_pct/100,2))*q.gst_rate,2),total_charge=round((totals.subtotal_charge-round(totals.subtotal_charge*q.discount_pct/100,2))*(1+q.gst_rate),2),updated_by=v_actor from (select coalesce(sum(l.quantity*l.unit_cost),0)::numeric(12,2) total_cost,coalesce(sum(l.quantity*l.unit_charge),0)::numeric(12,2) subtotal_charge from public.quote_lines l where l.quote_id=v_quote.id) totals where q.id=v_quote.id returning q.* into v_quote;
  if v_created then insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_quote.provider_org_id,v_actor,'crm_quote_line_added','quote_lines',v_line.id,jsonb_build_object('quote_id',v_quote.id,'kind',v_line.kind,'site_id',v_line.site_id,'module_key',v_line.module_key,'total_cost',v_quote.total_cost,'total_charge',v_quote.total_charge));end if;
  return query select v_line.id,v_quote.id,v_quote.total_cost,v_quote.subtotal_charge,v_quote.discount_amount,v_quote.gst_amount,v_quote.total_charge,v_created;
end;$function$;
REVOKE ALL ON FUNCTION "public"."add_crm_quote_line"(p_client_request_id uuid, p_quote_id uuid, p_expected_status text, p_kind text, p_description text, p_quantity numeric, p_unit_cost numeric, p_unit_charge numeric, p_module_key text, p_site_id uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."add_crm_quote_line"(p_client_request_id uuid, p_quote_id uuid, p_expected_status text, p_kind text, p_description text, p_quantity numeric, p_unit_cost numeric, p_unit_charge numeric, p_module_key text, p_site_id uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."add_crm_quote_line"(p_client_request_id uuid, p_quote_id uuid, p_expected_status text, p_kind text, p_description text, p_quantity numeric, p_unit_cost numeric, p_unit_charge numeric, p_module_key text, p_site_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."add_crm_quote_line"(p_client_request_id uuid, p_quote_id uuid, p_expected_status text, p_kind text, p_description text, p_quantity numeric, p_unit_cost numeric, p_unit_charge numeric, p_module_key text, p_site_id uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."add_finance_budget_line"(p_budget_id uuid, p_pl_period_id uuid, p_cost_type text, p_budget_amount numeric, p_cost_centre_id uuid DEFAULT NULL::uuid, p_service_agreement_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS finance_budget_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_budget public.finance_budgets%rowtype;
  v_period public.finance_pl_periods%rowtype;
  v_line public.finance_budget_lines%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_budget FROM public.finance_budgets WHERE id = p_budget_id AND organization_id = v_org;
  IF NOT FOUND OR v_budget.status <> 'draft' THEN RAISE EXCEPTION 'Only draft budgets can be changed'; END IF;
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND OR v_period.status IN ('closed','archived') THEN RAISE EXCEPTION 'Budget period is unavailable'; END IF;
  IF p_budget_amount IS NULL OR p_budget_amount < 0 THEN RAISE EXCEPTION 'Budget amount cannot be negative'; END IF;
  INSERT INTO public.finance_budget_lines(organization_id, budget_id, pl_period_id, cost_centre_id, service_agreement_id, cost_type, budget_amount, notes, created_by)
  VALUES (v_org, p_budget_id, p_pl_period_id, p_cost_centre_id, p_service_agreement_id, p_cost_type, p_budget_amount, p_notes, v_actor)
  ON CONFLICT (budget_id, pl_period_id, cost_centre_id, service_agreement_id, cost_type)
  DO UPDATE SET budget_amount = EXCLUDED.budget_amount, notes = EXCLUDED.notes
  RETURNING * INTO v_line;
  RETURN v_line;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. First-subscriber seed (no-op where R & M or its master is absent, e.g. the oracle database)
-- ---------------------------------------------------------------------------
DO $$
declare
  v_rm uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';         -- R & M Security and Investigation
  v_master uuid := '08369a00-e2df-45d6-9e6b-6b3a6bede645';     -- R & M master (don@ironeagle.co.nz)
  v_source text := 'Owner-supplied pricing sheets (photographed), chat 2026-09-15';
  r record;
  v_count integer := 0;
begin
  if not exists (select 1 from public.organizations where id = v_rm and organization_type = 'service_provider' and active)
     or not exists (select 1 from public.user_profiles where id = v_master and organization_id = v_rm and deactivated_at is null) then
    return;
  end if;

  -- 5a. Customer charge rules (rate_rules.rule_kind = 'billing'); idempotent on client_request_id.
  for r in
    select * from (values
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151401'::uuid, 'billing', 'Patrolling (per hour)', 'hourly', 54.1, 'patrol', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151402'::uuid, 'billing', 'Security and permit enquiries (per hour)', 'hourly', 54.1, 'security_enquiry', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151403'::uuid, 'billing', 'Emergency callout, alarm response (per hour, Apr 2025)', 'hourly', 58.3, null, 'alarm_response'),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151419'::uuid, 'billing', 'Emergency callout, incident attendance (per hour, Apr 2025)', 'hourly', 58.3, null, 'incident'),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151404'::uuid, 'billing', 'Investigations (per hour)', 'hourly', 54.1, 'investigation', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151405'::uuid, 'billing', 'Cordon guard (per hour)', 'hourly', 54.1, 'cordon_guard', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151406'::uuid, 'billing', 'High-risk two-person patrol (per hour)', 'hourly', 108.2, 'patrol_two_person', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151407'::uuid, 'billing', 'Worker-alone monitoring (per operational day)', 'daily', 10.0, 'worker_alone_monitoring', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151408'::uuid, 'billing', 'Camera downloads and review (per hour)', 'hourly', 54.1, 'camera_review', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151409'::uuid, 'billing', 'Excavator / digger, gate installation and repairs (per hour, Apr 2025)', 'hourly', 116.6, 'excavator', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151410'::uuid, 'billing', 'Engineering, gate installation and repairs (per hour, Apr 2025)', 'hourly', 79.5, 'engineering', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151411'::uuid, 'billing', 'Two-person engineering (per hour)', 'hourly', 133.8, 'engineering_two_person', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151412'::uuid, 'billing', 'Travel, patrol vehicle (per km)', 'per_km', 1.04, null, null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151413'::uuid, 'billing', 'Travel, trailer or digger (per km)', 'per_km', 1.04, 'excavator', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151414'::uuid, 'billing', 'Remote covert camera (per month, minimum 6)', 'per_unit', 420.0, 'camera_hire', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151415'::uuid, 'billing', 'Fixed camera (per month)', 'per_unit', 262.0, 'camera_hire', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151416'::uuid, 'billing', 'Covert detection system (per month)', 'per_unit', 210.0, 'camera_hire', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151417'::uuid, 'billing', 'Radio, vehicle and hand-held pair (per month)', 'per_unit', 21.0, 'radio_hire', null),
      ('c0a80f5e-9e4b-4b6f-8d2e-202609151418'::uuid, 'billing', 'Brush cutter, spray pack and PPE per vehicle setup (per month)', 'per_unit', 53.55, 'vehicle_kit_hire', null)
    ) as t(client_request_id, rule_kind, name, rate_type, amount, service_type, job_type)
  loop
    insert into public.rate_rules (organization_id, rule_kind, name, rate_type, amount, service_type, job_type, effective_from, priority, active, created_by, updated_by, client_request_id)
    values (v_rm, r.rule_kind, r.name, r.rate_type, r.amount, r.service_type::text, r.job_type::text, date '2025-04-01', 0, true, v_master, v_master, r.client_request_id)
    on conflict (organization_id, client_request_id) where client_request_id is not null do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_rm, v_master, 'rate_rules_seeded_from_price_sheets', 'rate_rules', v_rm, jsonb_build_object('rules_inserted', v_count, 'source', v_source, 'note', 'customer charge rules only; no staff pay rules were on the sheets'));

  -- 5b. Price book items (cost + sell price), approved by the master who supplied them.
  for r in
    select * from (values
      ('POSTCRETE-BAG', 'Post crete bag', 'material', 'ea', 12.0, 15.6),
      ('GATE-CYCLONE-14FT', '14ft cyclone gate (4.2m farmgate)', 'material', 'ea', 210.39, 273.51),
      ('GUDGEON-PAIR', 'Gudgeons (pair)', 'material', 'pair', 43.0, 55.9),
      ('POST-2.1M-150', '2.1m posts (150mm strainer post)', 'material', 'ea', 35.27, 45.85),
      ('WARATAH', 'Waratahs', 'material', 'ea', 12.0, 15.6),
      ('WARATAH-CAP', 'Waratah caps', 'material', 'ea', 1.0, 1.3),
      ('CUTOFF-DISC', 'Grinding cut-off discs', 'consumable', 'ea', 6.5, 8.45),
      ('POST-3M-100X100', '3m 100x100 posts', 'material', 'ea', 25.62, 33.31),
      ('CHAIN-10MM', '10mm chain', 'material', 'm', 15.0, 19.5),
      ('GATE-LATCH-STAPLE', 'Gate latch and staple', 'material', 'set', 12.0, 15.6),
      ('CAUTION-TAPE', 'Caution tape', 'consumable', 'm', 0.08, 0.1),
      ('DRUM-HINGEPOST-FULL', 'Full hinge-post drum (incl labour)', 'service', 'ea', 973.25, 1265.23),
      ('DRUM-LOCKBOX-FULL', 'Full lockbox drum (incl labour)', 'service', 'ea', 1139.54, 1481.4),
      ('GATE-4.5M-INSTALLED', '4.5m gate (incl labour)', 'service', 'ea', 1019.75, 1325.68),
      ('BUGLE-SCREW', 'Bugle screws', 'consumable', 'ea', 0.45, 0.59),
      ('I-BEAM-2M', 'I-beams (2m)', 'material', '2m', 120.0, 156.0),
      ('PIPE-STEEL-76MM-2M', '76mm steel pipes (2m)', 'material', '2m', 175.6, 228.28),
      ('HINGE-POST-CAP-25MM', '25mm square hinge post cap', 'material', 'ea', 22.5, 29.25),
      ('THREADED-BAR-25X100', '100mm long x 25mm threaded bar', 'material', 'ea', 10.5, 13.65),
      ('NUTS-WASHERS-20MM', '20mm nuts and flat washers', 'material', 'ea', 5.5, 7.15),
      ('TURNBUCKLE', 'Turn buckles', 'material', 'ea', 31.93, 41.51),
      ('DRUM-STEEL-200L', 'Steel drum 200L', 'material', 'ea', 15.0, 19.5),
      ('CEMENT-BAG', 'Cement bag', 'material', 'ea', 23.0, 29.9),
      ('CONCRETE-AGGREGATE', 'Concrete aggregate', 'material', 'drum', 45.0, 58.5),
      ('WELDING-CONSUMABLES', 'Misc welding consumables', 'consumable', 'ea', 100.0, 130.0),
      ('RHS-75X75X6-2M', '75x75x6 (2m)', 'material', '2m', 77.0, 100.1),
      ('BOX-89X89X6-2M', '89x89x6 box section (2m)', 'material', '2m', 134.0, 174.2),
      ('BOX-200X200-LOCKBOX', '200x200mm box section (lockbox)', 'material', 'm', 149.54, 194.4),
      ('LOCKBOX-TOP-200X200X5', '200x200x5mm lockbox top', 'material', 'ea', 19.5, 25.35),
      ('POST-CAMERA-65MM-GALV', '65mm galvanised camera post, painted, with mounting', 'material', 'ea', 456.0, 592.8),
      ('FENCING-WIRE-5KG', 'Fencing wire 5kg 2.0mm', 'material', 'ea', 69.0, 89.7),
      ('WIRE-TENSIONER', 'Wire tensioners', 'material', 'ea', 5.15, 6.7),
      ('33506', '4 channel NVR with POE', 'equipment_component', 'ea', 280.0, 364.0),
      ('33554', '8 channel NVR no POE', 'equipment_component', 'ea', 205.0, 266.5),
      ('33556H', '8 channel NVR with POE & 4TB HDD', 'equipment_component', 'ea', 650.0, 845.0),
      ('33558', '16 channel NVR no POE', 'equipment_component', 'ea', 288.0, 288.0),
      ('33561H', '16 channel NVR with POE & 4TB HDD', 'equipment_component', 'ea', 864.0, 1123.2),
      ('34300', '4 port POE switch', 'equipment_component', 'ea', 61.0, 79.3),
      ('34305', '8 port POE switch', 'equipment_component', 'ea', 142.0, 184.6),
      ('34303', 'POE powered 4 port switch', 'equipment_component', 'ea', 134.0, 174.2),
      ('48505', 'Solar 5 port POE switch', 'equipment_component', 'ea', 390.0, 507.0),
      ('33261', 'LPR camera, normal speed', 'equipment_component', 'ea', 540.0, 702.0),
      ('33266', 'LPR camera, high speed', 'equipment_component', 'ea', 882.0, 1146.6),
      ('33014', '4MP camera', 'equipment_component', 'ea', 139.0, 180.7),
      ('33019', 'Zoom camera', 'equipment_component', 'ea', 234.0, 304.2),
      ('33340', 'Eye Sight 4MP camera 3.6mm, face detection', 'equipment_component', 'ea', 164.8, 214.24),
      ('33415', 'PIR covert camera', 'equipment_component', 'ea', 158.52, 206.08),
      ('34078', 'Mount for overview camera', 'equipment_component', 'ea', 28.84, 37.49),
      ('34072', 'Mount for LPR camera', 'equipment_component', 'ea', 27.81, 36.15),
      ('05340F', 'Outdoor Cat 6 cable', 'material', 'm', 1.3, 1.69),
      ('RJ45', 'RJ45 connectors', 'consumable', 'ea', 2.0, 2.6),
      ('46073', '2TB hard drive', 'equipment_component', 'ea', 168.0, 218.4),
      ('46075', '4TB hard drive', 'equipment_component', 'ea', 235.0, 305.5),
      ('460752', '8TB hard drive', 'equipment_component', 'ea', 499.0, 499.0),
      ('460753', '10TB hard drive', 'equipment_component', 'ea', 599.0, 778.7),
      ('50008', '24 inch monitor', 'equipment_component', 'ea', 194.0, 252.2),
      ('52150', 'Solar kit', 'equipment_component', 'ea', 2266.0, 2945.8),
      ('LAP-120', '120 degree radio LAP-120', 'equipment_component', 'ea', 158.95, 206.64),
      ('BKT-27', 'Radio roof mount BKT-27', 'equipment_component', 'ea', 43.68, 56.78),
      ('LOCO-5AC-5PK', 'LOCO 5AC radios, 5 pack', 'equipment_component', 'ea', 413.95, 538.14),
      ('RADIO-MOUNT-M10', 'Radio mounts (Mitre 10)', 'material', 'ea', 28.98, 37.67),
      ('INS-3AF-I-G', '48V-24V POE converter INS-3AF-I-G', 'equipment_component', 'ea', 38.25, 49.73),
      ('POE-24-12W-G', '90W camera POE injector POE-24-12W-G', 'equipment_component', 'ea', 25.2, 32.76),
      ('34255', '90W camera POE injector 34255', 'equipment_component', 'ea', 97.0, 126.1),
      ('C6A-1C-IP68', 'Cat6 joiner C6A-1C-IP68', 'material', 'ea', 14.3, 18.59),
      ('34612', 'HDMI ethernet converter 34612', 'equipment_component', 'ea', 265.0, 344.5),
      ('EXT-CORD-5M', '5m extension cord', 'material', 'ea', 15.0, 19.5),
      ('MULTIBOARD-4WAY', '4 way multiboard', 'material', 'ea', 20.0, 26.0),
      ('LOCO-5AC', 'LOCO 5AC radio', 'equipment_component', 'ea', 88.0, 114.4),
      ('TL-WR802N', 'TP-Link TL-WR802N WiFi nano router', 'equipment_component', 'ea', 44.0, 57.2),
      ('LOCO-5AC-POE', 'LOCO 5AC radio incl POE injector', 'equipment_component', 'ea', 118.0, 153.4),
      ('SUNDRIES', 'Sundries / miscellaneous', 'consumable', 'ea', 50.0, 50.0),
      ('WASHER-GALV-FLAT', 'Flat galvanised washer', 'material', 'ea', 2.12, 2.76),
      ('COACH-SCREW-M10X130', 'Coach screw M10x130', 'material', 'ea', 1.4, 1.82),
      ('CR2-BATTERY', 'CR2 battery for e-lock', 'consumable', 'ea', 10.38, 13.49),
      ('SADDLE-ZINC-25MM', 'Zinc 25mm saddles', 'material', 'ea', 1.22, 1.59),
      ('HEX-SCREW-12X65-50PK', 'Timber hex screws 50pk 12x65', 'material', 'ea', 12.98, 16.87),
      ('JBOX-230X175X160', 'Junction box 230x175x160', 'material', 'ea', 83.92, 109.1),
      ('JBOX-315X244X123', 'Junction box 315x244x123', 'material', 'ea', 106.63, 138.62),
      ('CONDUIT-FLEX-25MM', '25mm flexible conduit', 'material', 'm', 12.63, 16.42),
      ('CONDUIT-COUPLING-25MM', '25mm conduit plain coupling', 'material', 'ea', 2.73, 3.55),
      ('CONDUIT-BOX-25MM-2WAY', 'Conduit box 25mm 2 way', 'material', 'ea', 14.23, 18.5),
      ('CONDUIT-BOX-25MM-3WAY', 'Conduit box 25mm 3 way', 'material', 'ea', 14.75, 19.18),
      ('CONDUIT-ELBOW-25MM', 'Conduit solid elbow 25mm', 'material', 'ea', 1.25, 1.63),
      ('HALF-SADDLE-25MM', '25mm half saddle', 'material', 'ea', 1.25, 1.63),
      ('GLAND-NYLON-20MM', '20mm nylon gland', 'material', 'ea', 8.29, 10.78),
      ('GLAND-NYLON-16MM', '16mm nylon gland', 'material', 'ea', 7.0, 9.1),
      ('TAPON-3PIN-SIDE', 'Tapon 3 pin plug, side entry', 'material', 'ea', 32.8, 42.64),
      ('BELT-POCKET-FULLER-100L', '100L belt double pocket fuller', 'ppe', 'ea', 22.08, 28.7)
    ) as t(sku, name, item_type, unit_of_measure, unit_cost, unit_price)
  loop
    perform public.manage_finance_item_internal(v_master, v_rm, 'create', null, r.sku, r.name, r.item_type, r.unit_of_measure, r.unit_cost, r.unit_price, null, v_source, date '2026-09-15');
  end loop;
end $$;
