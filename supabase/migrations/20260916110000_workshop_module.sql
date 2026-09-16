-- 20260916110000_workshop_module.sql
-- Manufacturing & maintenance ("workshop") module on the existing work spine.
-- Owner ruling 2026-09-16: a new sellable 'workshop' module (not folded into
-- dispatch). First slice: fabrication work orders with a bill of materials from
-- the price book; maintenance visits to a client place/asset with materials +
-- labour + travel; strict inventory draw-down and stock-on-hand per
-- workshop/van location; reusable BOM templates; and one sweep that turns
-- completed work (workshop lines + dispatch charge lines) into a draft invoice
-- so the human does not re-key anything.
--
-- Spine reuse: finance_item_catalog / finance_price_book (items + current
-- approved cost & sell price), finance_inventory_locations/_balances/
-- _transactions via record_finance_inventory_transaction (idempotent, audited),
-- assets, client_sites, service_agreements, invoices/invoice_line_items,
-- dispatch_job_charge_lines (invoice_line_item_id was never populated before).

-- ---------------------------------------------------------------------------
-- 1. Module catalog row + R&M subscription
-- ---------------------------------------------------------------------------
INSERT INTO public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active)
VALUES ('workshop', 0, 0, 0, 'monthly', 'NZD', true)
ON CONFLICT (module_key) DO UPDATE SET active = true, updated_at = now();

DO $$
DECLARE v_rm uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'; v_don uuid := '1b02ab97-8611-40ab-a3a0-b5c74589db58';
BEGIN
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = v_rm) THEN
    INSERT INTO public.org_module_subscriptions (organization_id, module_key, status, started_at, created_by, updated_by)
    VALUES (v_rm, 'workshop', 'active', current_date, v_don, v_don)
    ON CONFLICT (organization_id, module_key) DO UPDATE SET status = 'active', ended_at = NULL, updated_at = now();
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (v_rm, 'workshop', true)
    ON CONFLICT (organization_id, module_key) DO UPDATE SET enabled = true;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workshop_bom_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'fabrication' CHECK (kind IN ('fabrication', 'maintenance')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
COMMENT ON TABLE public.workshop_bom_templates IS 'Reusable bill-of-materials templates (e.g. "Standard lockbox") an organisation copies onto a work order or quote.';

CREATE TABLE IF NOT EXISTS public.workshop_bom_template_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.workshop_bom_templates(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  line_kind text NOT NULL CHECK (line_kind IN ('material', 'labour', 'travel', 'equipment')),
  item_id uuid REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  description text NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_of_measure text,
  position integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.workshop_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  order_number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fabrication', 'maintenance')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'in_progress', 'completed', 'cancelled')),
  title text NOT NULL,
  description text,
  client_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE SET NULL,
  client_site_id uuid REFERENCES public.client_sites(id) ON DELETE SET NULL,
  asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  inventory_location_id uuid REFERENCES public.finance_inventory_locations(id) ON DELETE SET NULL,
  bom_template_id uuid REFERENCES public.workshop_bom_templates(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  completion_note text,
  created_by uuid REFERENCES public.user_profiles(id),
  updated_by uuid REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, client_request_id),
  UNIQUE (organization_id, order_number),
  CONSTRAINT workshop_work_orders_maintenance_needs_place CHECK (kind <> 'maintenance' OR client_site_id IS NOT NULL OR asset_id IS NOT NULL)
);
COMMENT ON TABLE public.workshop_work_orders IS 'Fabrication (workshop build) and maintenance (visit to a client place/asset) work orders. Lines are the bill of materials + labour + travel; completion draws down stock and leaves billable lines for the invoice sweep.';

CREATE TABLE IF NOT EXISTS public.workshop_work_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.workshop_work_orders(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_request_id uuid,
  line_kind text NOT NULL CHECK (line_kind IN ('material', 'labour', 'travel', 'equipment')),
  item_id uuid REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  description text NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_of_measure text,
  unit_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  unit_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total numeric(14,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  inventory_transaction_id uuid REFERENCES public.finance_inventory_transactions(id) ON DELETE SET NULL,
  invoice_line_item_id uuid REFERENCES public.invoice_line_items(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workshop_work_order_lines_request_key ON public.workshop_work_order_lines (organization_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workshop_work_orders_org_status ON public.workshop_work_orders (organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workshop_work_order_lines_uninvoiced ON public.workshop_work_order_lines (organization_id, work_order_id) WHERE invoice_line_item_id IS NULL;

-- Grants + RLS: members read their organisation's rows; every write goes through the RPCs below.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workshop_bom_templates', 'workshop_bom_template_lines', 'workshop_work_orders', 'workshop_work_order_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (org_access_allowed(organization_id))', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS bob_full_read ON public.%I', t);
    EXECUTE format('CREATE POLICY bob_full_read ON public.%I FOR SELECT TO authenticated USING ((SELECT auth.uid()) = %L::uuid)', t, '00000000-0000-0000-0000-00000000b0b0');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workshop_actor_org(p_organization_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_home uuid;
begin
  if p_organization_id is null then raise exception 'organization_id is required'; end if;
  select up.organization_id into v_home from public.user_profiles up where up.id = v_actor and up.deactivated_at is null;
  if v_home is null then raise exception 'Active user required'; end if;
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Workshop administrator access required'; end if;
  if not exists (select 1 from public.organization_modules m where m.organization_id = p_organization_id and m.module_key = 'workshop' and m.enabled) then
    raise exception 'The workshop module is not enabled for this organisation';
  end if;
  return v_actor;
end;
$function$;
REVOKE ALL ON FUNCTION public.workshop_actor_org(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Current approved cost & sell price for an item (0 when nothing is approved yet).
CREATE OR REPLACE FUNCTION public.workshop_current_prices(p_item_id uuid, OUT unit_cost numeric, OUT unit_price numeric, OUT unit_of_measure text, OUT item_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(pb.unit_cost, 0), coalesce(pb.unit_price, 0), pb.unit_of_measure, pb.name
  from public.finance_price_book pb where pb.item_id = p_item_id;
$function$;
REVOKE ALL ON FUNCTION public.workshop_current_prices(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. BOM templates
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.manage_workshop_bom_template(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_action text,
  p_template_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_kind text DEFAULT 'fabrication',
  p_lines jsonb DEFAULT '[]'::jsonb
) RETURNS workshop_bom_templates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := public.workshop_actor_org(p_organization_id);
  v_tpl public.workshop_bom_templates%rowtype;
  v_line jsonb;
  v_pos integer := 0;
  v_item public.finance_item_catalog%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if p_action = 'create' then
    if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Template name is required'; end if;
    if p_kind not in ('fabrication', 'maintenance') then raise exception 'Template kind must be fabrication or maintenance'; end if;
    insert into public.workshop_bom_templates (organization_id, name, description, kind, created_by)
    values (p_organization_id, trim(p_name), nullif(trim(coalesce(p_description, '')), ''), p_kind, v_actor)
    on conflict (organization_id, name) do update set description = excluded.description, kind = excluded.kind, active = true, updated_at = now()
    returning * into v_tpl;
  elsif p_action in ('update', 'archive') then
    select * into v_tpl from public.workshop_bom_templates t where t.id = p_template_id and t.organization_id = p_organization_id for update;
    if not found then raise exception 'Template not found'; end if;
    if p_action = 'archive' then
      update public.workshop_bom_templates set active = false, updated_at = now() where id = v_tpl.id returning * into v_tpl;
      insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (p_organization_id, v_actor, 'workshop_bom_template_archived', 'workshop_bom_templates', v_tpl.id, jsonb_build_object('name', v_tpl.name));
      return v_tpl;
    end if;
    update public.workshop_bom_templates
       set name = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
           description = coalesce(nullif(trim(coalesce(p_description, '')), ''), description),
           kind = coalesce(p_kind, kind), active = true, updated_at = now()
     where id = v_tpl.id returning * into v_tpl;
  else
    raise exception 'Action must be create, update or archive';
  end if;

  -- Lines are replaced wholesale: [{line_kind, item_id?, description?, quantity, unit_of_measure?}]
  delete from public.workshop_bom_template_lines where template_id = v_tpl.id;
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    if coalesce(v_line->>'line_kind', '') not in ('material', 'labour', 'travel', 'equipment') then raise exception 'Line % has an unknown kind', v_pos; end if;
    if coalesce((v_line->>'quantity')::numeric, 0) <= 0 then raise exception 'Line % needs a quantity above zero', v_pos; end if;
    v_item := null;
    if nullif(v_line->>'item_id', '') is not null then
      select * into v_item from public.finance_item_catalog i where i.id = (v_line->>'item_id')::uuid and i.organization_id = p_organization_id and i.active;
      if not found then raise exception 'Line % refers to an item that is not in this organisation''s price book', v_pos; end if;
    end if;
    insert into public.workshop_bom_template_lines (template_id, organization_id, line_kind, item_id, description, quantity, unit_of_measure, position)
    values (v_tpl.id, p_organization_id, v_line->>'line_kind', v_item.id,
            coalesce(nullif(trim(coalesce(v_line->>'description', '')), ''), v_item.name, 'Line ' || v_pos),
            (v_line->>'quantity')::numeric, coalesce(nullif(v_line->>'unit_of_measure', ''), v_item.unit_of_measure), v_pos);
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'workshop_bom_template_' || p_action || 'd', 'workshop_bom_templates', v_tpl.id,
          jsonb_build_object('name', v_tpl.name, 'kind', v_tpl.kind, 'lines', v_pos, 'client_request_id', p_client_request_id));
  return v_tpl;
end;
$function$;
REVOKE ALL ON FUNCTION public.manage_workshop_bom_template(uuid, uuid, text, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_workshop_bom_template(uuid, uuid, text, uuid, text, text, text, jsonb) TO authenticated;
COMMENT ON FUNCTION public.manage_workshop_bom_template(uuid, uuid, text, uuid, text, text, text, jsonb) IS 'Create, update (lines replaced wholesale) or archive a reusable bill-of-materials template. Workshop admin of the organisation; audited.';

-- ---------------------------------------------------------------------------
-- 5. Work orders
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_workshop_work_order(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_kind text,
  p_title text,
  p_description text DEFAULT NULL,
  p_client_organization_id uuid DEFAULT NULL,
  p_service_agreement_id uuid DEFAULT NULL,
  p_client_site_id uuid DEFAULT NULL,
  p_asset_id uuid DEFAULT NULL,
  p_inventory_location_id uuid DEFAULT NULL,
  p_assigned_user_id uuid DEFAULT NULL,
  p_scheduled_for timestamptz DEFAULT NULL,
  p_bom_template_id uuid DEFAULT NULL
) RETURNS workshop_work_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := public.workshop_actor_org(p_organization_id);
  v_wo public.workshop_work_orders%rowtype;
  v_tpl_line record;
  v_cost numeric; v_price numeric; v_uom text;
  v_seq integer;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_wo from public.workshop_work_orders w where w.organization_id = p_organization_id and w.client_request_id = p_client_request_id;
  if found then return v_wo; end if;
  if p_kind not in ('fabrication', 'maintenance') then raise exception 'Kind must be fabrication or maintenance'; end if;
  if nullif(trim(coalesce(p_title, '')), '') is null then raise exception 'Give the work order a title'; end if;
  if p_kind = 'maintenance' and p_client_site_id is null and p_asset_id is null then raise exception 'A maintenance visit needs the place or the asset being maintained'; end if;
  if p_client_site_id is not null and not exists (select 1 from public.client_sites s where s.id = p_client_site_id) then raise exception 'Site not found'; end if;
  if p_asset_id is not null and not exists (select 1 from public.assets a where a.id = p_asset_id and a.organization_id in (p_organization_id, p_client_organization_id)) then raise exception 'Asset not found'; end if;
  if p_inventory_location_id is not null and not exists (select 1 from public.finance_inventory_locations l where l.id = p_inventory_location_id and l.organization_id = p_organization_id and l.active) then raise exception 'Stock location not found'; end if;
  if p_service_agreement_id is not null and not exists (select 1 from public.service_agreements a where a.id = p_service_agreement_id and a.provider_organization_id = p_organization_id) then raise exception 'Agreement not found for this organisation'; end if;
  if p_bom_template_id is not null and not exists (select 1 from public.workshop_bom_templates t where t.id = p_bom_template_id and t.organization_id = p_organization_id and t.active) then raise exception 'Template not found'; end if;

  select count(*) + 1 into v_seq from public.workshop_work_orders w where w.organization_id = p_organization_id;
  insert into public.workshop_work_orders (organization_id, client_request_id, order_number, kind, title, description, client_organization_id, service_agreement_id,
                                           client_site_id, asset_id, inventory_location_id, bom_template_id, assigned_user_id, scheduled_for, created_by, updated_by)
  values (p_organization_id, p_client_request_id, 'WO-' || to_char(now(), 'YYYYMM') || '-' || lpad(v_seq::text, 4, '0'), p_kind, trim(p_title),
          nullif(trim(coalesce(p_description, '')), ''), p_client_organization_id, p_service_agreement_id, p_client_site_id, p_asset_id, p_inventory_location_id,
          p_bom_template_id, p_assigned_user_id, p_scheduled_for, v_actor, v_actor)
  returning * into v_wo;

  -- Copy the template's lines at today's approved cost and sell price.
  for v_tpl_line in select * from public.workshop_bom_template_lines l where l.template_id = p_bom_template_id order by l.position loop
    v_cost := null; v_price := null; v_uom := null;
    if v_tpl_line.item_id is not null then
      select cp.unit_cost, cp.unit_price, cp.unit_of_measure into v_cost, v_price, v_uom from public.workshop_current_prices(v_tpl_line.item_id) cp;
    end if;
    insert into public.workshop_work_order_lines (work_order_id, organization_id, line_kind, item_id, description, quantity, unit_of_measure, unit_cost, unit_price, position)
    values (v_wo.id, p_organization_id, v_tpl_line.line_kind, v_tpl_line.item_id, v_tpl_line.description, v_tpl_line.quantity,
            coalesce(v_tpl_line.unit_of_measure, v_uom), coalesce(v_cost, 0), coalesce(v_price, 0), v_tpl_line.position);
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'workshop_work_order_created', 'workshop_work_orders', v_wo.id,
          jsonb_build_object('order_number', v_wo.order_number, 'kind', v_wo.kind, 'client_organization_id', v_wo.client_organization_id, 'bom_template_id', p_bom_template_id));
  return v_wo;
end;
$function$;
REVOKE ALL ON FUNCTION public.create_workshop_work_order(uuid, uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_workshop_work_order(uuid, uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.add_workshop_work_order_line(
  p_client_request_id uuid,
  p_work_order_id uuid,
  p_line_kind text,
  p_item_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_quantity numeric DEFAULT 1,
  p_unit_price numeric DEFAULT NULL,
  p_unit_cost numeric DEFAULT NULL
) RETURNS workshop_work_order_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wo public.workshop_work_orders%rowtype;
  v_actor uuid;
  v_line public.workshop_work_order_lines%rowtype;
  v_cost numeric; v_price numeric;
  v_item public.finance_item_catalog%rowtype;
  v_pos integer;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_wo from public.workshop_work_orders w where w.id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  v_actor := public.workshop_actor_org(v_wo.organization_id);
  select * into v_line from public.workshop_work_order_lines l where l.organization_id = v_wo.organization_id and l.client_request_id = p_client_request_id;
  if found then return v_line; end if;
  if v_wo.status in ('completed', 'cancelled') then raise exception 'Lines cannot be added once the work order is %', v_wo.status; end if;
  if p_line_kind not in ('material', 'labour', 'travel', 'equipment') then raise exception 'Line kind must be material, labour, travel or equipment'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantity must be above zero'; end if;
  if p_item_id is not null then
    select * into v_item from public.finance_item_catalog i where i.id = p_item_id and i.organization_id = v_wo.organization_id and i.active;
    if not found then raise exception 'Item is not in this organisation''s price book'; end if;
    select cp.unit_cost, cp.unit_price into v_cost, v_price from public.workshop_current_prices(p_item_id) cp;
  end if;
  if nullif(trim(coalesce(p_description, '')), '') is null and v_item.id is null then raise exception 'Describe the line or pick a price-book item'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.workshop_work_order_lines where work_order_id = v_wo.id;

  insert into public.workshop_work_order_lines (work_order_id, organization_id, client_request_id, line_kind, item_id, description, quantity, unit_of_measure, unit_cost, unit_price, position)
  values (v_wo.id, v_wo.organization_id, p_client_request_id, p_line_kind, v_item.id,
          coalesce(nullif(trim(coalesce(p_description, '')), ''), v_item.name), p_quantity, v_item.unit_of_measure,
          coalesce(p_unit_cost, v_cost, 0), coalesce(p_unit_price, v_price, 0), v_pos)
  returning * into v_line;
  update public.workshop_work_orders set updated_at = now(), updated_by = v_actor where id = v_wo.id;
  return v_line;
end;
$function$;
REVOKE ALL ON FUNCTION public.add_workshop_work_order_line(uuid, uuid, text, uuid, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_workshop_work_order_line(uuid, uuid, text, uuid, text, numeric, numeric, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_workshop_work_order_line(p_work_order_id uuid, p_line_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wo public.workshop_work_orders%rowtype;
  v_actor uuid;
begin
  select * into v_wo from public.workshop_work_orders w where w.id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  v_actor := public.workshop_actor_org(v_wo.organization_id);
  if v_wo.status in ('completed', 'cancelled') then raise exception 'Lines cannot be removed once the work order is %', v_wo.status; end if;
  delete from public.workshop_work_order_lines where id = p_line_id and work_order_id = v_wo.id;
  update public.workshop_work_orders set updated_at = now(), updated_by = v_actor where id = v_wo.id;
end;
$function$;
REVOKE ALL ON FUNCTION public.remove_workshop_work_order_line(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_workshop_work_order_line(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.advance_workshop_work_order_status(p_work_order_id uuid, p_status text, p_note text DEFAULT NULL)
 RETURNS workshop_work_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wo public.workshop_work_orders%rowtype;
  v_actor uuid := auth.uid();
  v_line record;
  v_tx public.finance_inventory_transactions%rowtype;
  v_on_hand numeric;
  v_is_admin boolean;
begin
  select * into v_wo from public.workshop_work_orders w where w.id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  v_is_admin := public.is_admin_for_org(v_wo.organization_id);
  -- The assigned worker may start and complete; approving, cancelling and re-opening stay with an administrator.
  if not (v_is_admin or (v_wo.assigned_user_id = v_actor and p_status in ('in_progress', 'completed'))) then
    raise exception 'Only a workshop administrator or the assigned worker can move this work order';
  end if;
  if v_wo.status = p_status then return v_wo; end if;
  if not (
       (v_wo.status = 'draft' and p_status in ('approved', 'cancelled'))
    or (v_wo.status = 'approved' and p_status in ('in_progress', 'cancelled', 'draft'))
    or (v_wo.status = 'in_progress' and p_status in ('completed', 'cancelled'))
  ) then
    raise exception 'A % work order cannot move to %', v_wo.status, p_status;
  end if;

  if p_status = 'completed' then
    if not exists (select 1 from public.workshop_work_order_lines l where l.work_order_id = v_wo.id) then
      raise exception 'Add at least one line (materials, labour or travel) before completing';
    end if;
    -- Strict stock draw-down when the order names a stock location: every material/equipment line with a
    -- price-book item is consumed there. A shortfall stops completion with a plain message.
    if v_wo.inventory_location_id is not null then
      if not v_is_admin then
        raise exception 'This order draws stock from a location, so a workshop administrator must complete it (or clear the stock location first)';
      end if;
      for v_line in select l.* from public.workshop_work_order_lines l
                     where l.work_order_id = v_wo.id and l.line_kind in ('material', 'equipment') and l.item_id is not null and l.inventory_transaction_id is null
                     order by l.position loop
        select coalesce(b.on_hand - b.reserved, 0) into v_on_hand from public.finance_inventory_balances b where b.item_id = v_line.item_id and b.location_id = v_wo.inventory_location_id;
        if coalesce(v_on_hand, 0) < v_line.quantity then
          raise exception 'Not enough "%" in stock at this location (on hand %, needed %). Record the stock receipt first, or clear the stock location on the work order.',
            v_line.description, coalesce(v_on_hand, 0), v_line.quantity;
        end if;
        v_tx := public.record_finance_inventory_transaction(
          v_line.item_id, v_wo.inventory_location_id, 'consumption', v_line.quantity, v_line.unit_cost,
          'workshop_line:' || v_line.id::text, 'workshop_work_order:' || v_wo.order_number, null, v_wo.asset_id, null, null);
        update public.workshop_work_order_lines set inventory_transaction_id = v_tx.id where id = v_line.id;
      end loop;
    end if;
    update public.workshop_work_orders
       set status = 'completed', completed_at = now(), completion_note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now(), updated_by = v_actor
     where id = v_wo.id returning * into v_wo;
  elsif p_status = 'in_progress' then
    update public.workshop_work_orders set status = 'in_progress', started_at = coalesce(started_at, now()), updated_at = now(), updated_by = v_actor where id = v_wo.id returning * into v_wo;
  elsif p_status = 'cancelled' then
    update public.workshop_work_orders set status = 'cancelled', cancelled_at = now(), completion_note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now(), updated_by = v_actor where id = v_wo.id returning * into v_wo;
  else
    update public.workshop_work_orders set status = p_status, updated_at = now(), updated_by = v_actor where id = v_wo.id returning * into v_wo;
  end if;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_wo.organization_id, v_actor, 'workshop_work_order_' || p_status, 'workshop_work_orders', v_wo.id,
          jsonb_build_object('order_number', v_wo.order_number, 'kind', v_wo.kind, 'note', nullif(trim(coalesce(p_note, '')), ''),
                             'charge_total', (select coalesce(sum(line_total), 0) from public.workshop_work_order_lines where work_order_id = v_wo.id)));
  return v_wo;
end;
$function$;
REVOKE ALL ON FUNCTION public.advance_workshop_work_order_status(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.advance_workshop_work_order_status(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.advance_workshop_work_order_status(uuid, text, text) IS 'draft→approved→in_progress→completed (cancel from any open state). Completion draws material/equipment lines down from the named stock location through record_finance_inventory_transaction and leaves the lines billable for generate_crm_invoice_from_completed_work.';

-- ---------------------------------------------------------------------------
-- 6. Stock helpers for the Stock tab (receipts use record_finance_inventory_transaction directly)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.manage_finance_inventory_location(
  p_organization_id uuid,
  p_action text,
  p_location_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_location_type text DEFAULT 'warehouse',
  p_asset_id uuid DEFAULT NULL
) RETURNS finance_inventory_locations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := public.workshop_actor_org(p_organization_id);
  v_loc public.finance_inventory_locations%rowtype;
begin
  if p_action = 'create' then
    if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Give the stock location a name (e.g. Workshop, Van 1)'; end if;
    if p_location_type not in ('warehouse', 'depot', 'vehicle', 'site', 'technician', 'quarantine') then raise exception 'Unknown stock location type'; end if;
    insert into public.finance_inventory_locations (organization_id, name, location_type, asset_id, created_by)
    values (p_organization_id, trim(p_name), p_location_type, p_asset_id, v_actor) returning * into v_loc;
  elsif p_action = 'archive' then
    update public.finance_inventory_locations set active = false where id = p_location_id and organization_id = p_organization_id returning * into v_loc;
    if not found then raise exception 'Stock location not found'; end if;
  else
    raise exception 'Action must be create or archive';
  end if;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'finance_inventory_location_' || p_action || 'd', 'finance_inventory_locations', v_loc.id, jsonb_build_object('name', v_loc.name, 'location_type', v_loc.location_type));
  return v_loc;
end;
$function$;
REVOKE ALL ON FUNCTION public.manage_finance_inventory_location(uuid, text, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_finance_inventory_location(uuid, text, uuid, text, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Invoice sweep: completed work → one draft invoice, nothing re-keyed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_crm_invoice_from_completed_work(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_client_organization_id uuid,
  p_service_agreement_id uuid DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end date DEFAULT NULL
) RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_invoice public.invoices%rowtype;
  v_count integer := 0;
  v_row record;
  v_line_id uuid;
  v_start date := coalesce(p_period_start, date '1970-01-01');
  v_end date := coalesce(p_period_end, current_date);
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if p_organization_id is null or p_client_organization_id is null then raise exception 'Organisation and client are required'; end if;
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Finance administrator access required'; end if;
  if v_end < v_start then raise exception 'Period end cannot precede period start'; end if;
  -- Idempotent on the request id via the audit receipt.
  select i.* into v_invoice from public.audit_log a join public.invoices i on i.id = a.target_id
   where a.organization_id = p_organization_id and a.action = 'crm_invoice_generated_from_completed_work' and a.metadata->>'client_request_id' = p_client_request_id::text limit 1;
  if found then return v_invoice; end if;

  insert into public.invoices (organization_id, client_organization_id, service_agreement_id, invoice_number, invoice_date, due_date, status, service_period_start, service_period_end, created_by)
  values (p_organization_id, p_client_organization_id, p_service_agreement_id,
          'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substring(gen_random_uuid()::text, 1, 4)),
          current_date, (current_date + interval '14 days')::date, 'draft', p_period_start, p_period_end, v_actor)
  returning * into v_invoice;

  -- Completed workshop work for this client that has not been invoiced yet.
  for v_row in
    select l.id as line_id, wo.order_number, wo.title, l.description, l.quantity, l.unit_price, l.unit_cost, l.line_kind, l.item_id, l.unit_of_measure
      from public.workshop_work_order_lines l join public.workshop_work_orders wo on wo.id = l.work_order_id
     where wo.organization_id = p_organization_id and wo.client_organization_id = p_client_organization_id and wo.status = 'completed'
       and l.invoice_line_item_id is null and wo.completed_at::date between v_start and v_end
       and (p_service_agreement_id is null or wo.service_agreement_id is null or wo.service_agreement_id = p_service_agreement_id)
     order by wo.completed_at, l.position
  loop
    v_count := v_count + 1;
    insert into public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, finance_item_catalog_id, item_type, unit_of_measure, internal_cost_amount, created_by)
    values (v_invoice.id, v_count, v_row.order_number || ' · ' || v_row.title || ' — ' || v_row.description, v_row.quantity, v_row.unit_price, round(v_row.quantity * v_row.unit_price, 2),
            p_organization_id, v_row.item_id, v_row.line_kind, v_row.unit_of_measure, round(v_row.quantity * v_row.unit_cost, 2), v_actor)
    returning id into v_line_id;
    update public.workshop_work_order_lines set invoice_line_item_id = v_line_id where id = v_row.line_id;
  end loop;

  -- Completed dispatch jobs' charge lines for this client that were never invoiced (invoice_line_item_id had no writer before this migration).
  for v_row in
    select c.id as charge_id, c.source_dispatch_id, c.description, c.quantity, c.unit_rate, c.line_total, c.rate_type, c.created_at
      from public.dispatch_job_charge_lines c
     where c.organization_id = p_organization_id and c.client_organization_id = p_client_organization_id and c.invoice_line_item_id is null
       and c.created_at::date between v_start and v_end
       and (p_service_agreement_id is null or c.service_agreement_id is null or c.service_agreement_id = p_service_agreement_id)
     order by c.created_at
  loop
    v_count := v_count + 1;
    insert into public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, item_type, source_dispatch_id, created_by)
    values (v_invoice.id, v_count, coalesce(v_row.description, 'Dispatch ' || v_row.rate_type), coalesce(v_row.quantity, 1), coalesce(v_row.unit_rate, v_row.line_total), v_row.line_total,
            p_organization_id, 'other', v_row.source_dispatch_id, v_actor)
    returning id into v_line_id;
    update public.dispatch_job_charge_lines set invoice_line_item_id = v_line_id where id = v_row.charge_id;
  end loop;

  if v_count = 0 then
    delete from public.invoices where id = v_invoice.id;
    raise exception 'No completed, uninvoiced work for this client in the period';
  end if;

  update public.invoices i set subtotal = t.subtotal, gst_amount = round(t.subtotal * 0.15, 2), total_amount = round(t.subtotal * 1.15, 2), updated_at = now()
    from (select coalesce(sum(line_total), 0) as subtotal from public.invoice_line_items where invoice_id = v_invoice.id) t
   where i.id = v_invoice.id returning i.* into v_invoice;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'crm_invoice_generated_from_completed_work', 'invoices', v_invoice.id,
          jsonb_build_object('client_request_id', p_client_request_id, 'client_organization_id', p_client_organization_id, 'lines', v_count, 'total_amount', v_invoice.total_amount,
                             'period_start', p_period_start, 'period_end', p_period_end));
  return v_invoice;
end;
$function$;
REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) TO authenticated;
COMMENT ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) IS 'Sweep every completed, uninvoiced workshop line and dispatch charge line for one client into a single draft invoice (GST 15%). Stamps invoice_line_item_id on the source lines so nothing is billed twice. Idempotent on client_request_id; audited.';

-- ---------------------------------------------------------------------------
-- 8. Read model for the Workshop page
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.workshop_work_order_summary WITH (security_invoker = true) AS
SELECT wo.id, wo.organization_id, wo.order_number, wo.kind, wo.status, wo.title, wo.description, wo.client_organization_id, co.name AS client_name,
       wo.service_agreement_id, wo.client_site_id, cs.name AS site_name, wo.asset_id, a.name AS asset_name, wo.inventory_location_id, il.name AS stock_location_name,
       wo.bom_template_id, t.name AS template_name, wo.assigned_user_id, up.display_name AS assigned_name, wo.scheduled_for, wo.started_at, wo.completed_at, wo.cancelled_at,
       wo.completion_note, wo.created_at, wo.updated_at,
       coalesce(l.line_count, 0) AS line_count, coalesce(l.charge_total, 0) AS charge_total, coalesce(l.cost_total, 0) AS cost_total,
       coalesce(l.uninvoiced_total, 0) AS uninvoiced_total
FROM public.workshop_work_orders wo
LEFT JOIN public.organizations co ON co.id = wo.client_organization_id
LEFT JOIN public.client_sites cs ON cs.id = wo.client_site_id
LEFT JOIN public.assets a ON a.id = wo.asset_id
LEFT JOIN public.finance_inventory_locations il ON il.id = wo.inventory_location_id
LEFT JOIN public.workshop_bom_templates t ON t.id = wo.bom_template_id
LEFT JOIN public.user_profiles up ON up.id = wo.assigned_user_id
LEFT JOIN LATERAL (
  SELECT count(*) AS line_count, sum(x.line_total) AS charge_total, sum(round(x.quantity * x.unit_cost, 2)) AS cost_total,
         sum(x.line_total) FILTER (WHERE x.invoice_line_item_id IS NULL) AS uninvoiced_total
  FROM public.workshop_work_order_lines x WHERE x.work_order_id = wo.id
) l ON true;
REVOKE ALL ON public.workshop_work_order_summary FROM PUBLIC, anon;
GRANT SELECT ON public.workshop_work_order_summary TO authenticated, service_role;
COMMENT ON VIEW public.workshop_work_order_summary IS 'One row per work order with names resolved and line totals (charge, cost, still-to-invoice). Inherits RLS via security_invoker.';
