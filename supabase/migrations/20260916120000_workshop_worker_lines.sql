-- 20260916120000_workshop_worker_lines.sql
-- The assigned worker records what they actually used, from the field.
-- While a work order is approved or in progress, the worker it is assigned to
-- may add price-book lines (the price always comes from the price book — a
-- worker never types a price) and remove lines they added themselves.
-- Administrators keep the full ability (free-text lines, typed prices, removal
-- of any line). Completion rules are unchanged (20260916110000).

ALTER TABLE public.workshop_work_order_lines ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

-- Who may change the lines of this order right now: 'admin', 'worker', or raise.
CREATE OR REPLACE FUNCTION public.workshop_line_actor_role(p_work_order public.workshop_work_orders)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Active user required'; end if;
  if public.is_admin_for_org(p_work_order.organization_id) then
    perform public.workshop_actor_org(p_work_order.organization_id);
    return 'admin';
  end if;
  if p_work_order.assigned_user_id = v_actor
     and p_work_order.status in ('approved', 'in_progress')
     and exists (select 1 from public.user_profiles up where up.id = v_actor and up.deactivated_at is null)
     and exists (select 1 from public.organization_modules m where m.organization_id = p_work_order.organization_id and m.module_key = 'workshop' and m.enabled) then
    return 'worker';
  end if;
  raise exception 'Only a workshop administrator, or the assigned worker while the job is approved or in progress, can change these lines';
end;
$function$;
REVOKE ALL ON FUNCTION public.workshop_line_actor_role(public.workshop_work_orders) FROM PUBLIC, anon, authenticated, service_role;

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
  v_actor uuid := auth.uid();
  v_role text;
  v_line public.workshop_work_order_lines%rowtype;
  v_cost numeric; v_price numeric;
  v_item public.finance_item_catalog%rowtype;
  v_pos integer;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_wo from public.workshop_work_orders w where w.id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  v_role := public.workshop_line_actor_role(v_wo);
  select * into v_line from public.workshop_work_order_lines l where l.organization_id = v_wo.organization_id and l.client_request_id = p_client_request_id;
  if found then return v_line; end if;
  if v_wo.status in ('completed', 'cancelled') then raise exception 'Lines cannot be added once the work order is %', v_wo.status; end if;
  if p_line_kind not in ('material', 'labour', 'travel', 'equipment') then raise exception 'Line kind must be material, labour, travel or equipment'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantity must be above zero'; end if;
  if v_role = 'worker' and p_item_id is null then
    raise exception 'Pick the item from the price list — free-text lines and prices are set by a workshop administrator';
  end if;
  if p_item_id is not null then
    select * into v_item from public.finance_item_catalog i where i.id = p_item_id and i.organization_id = v_wo.organization_id and i.active;
    if not found then raise exception 'Item is not in this organisation''s price book'; end if;
    select cp.unit_cost, cp.unit_price into v_cost, v_price from public.workshop_current_prices(p_item_id) cp;
  end if;
  if nullif(trim(coalesce(p_description, '')), '') is null and v_item.id is null then raise exception 'Describe the line or pick a price-book item'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.workshop_work_order_lines where work_order_id = v_wo.id;

  insert into public.workshop_work_order_lines (work_order_id, organization_id, client_request_id, line_kind, item_id, description, quantity, unit_of_measure, unit_cost, unit_price, position, created_by)
  values (v_wo.id, v_wo.organization_id, p_client_request_id, p_line_kind, v_item.id,
          coalesce(nullif(trim(coalesce(p_description, '')), ''), v_item.name), p_quantity, v_item.unit_of_measure,
          case when v_role = 'admin' then coalesce(p_unit_cost, v_cost, 0) else coalesce(v_cost, 0) end,
          case when v_role = 'admin' then coalesce(p_unit_price, v_price, 0) else coalesce(v_price, 0) end,
          v_pos, v_actor)
  returning * into v_line;
  update public.workshop_work_orders set updated_at = now(), updated_by = v_actor where id = v_wo.id;
  return v_line;
end;
$function$;

CREATE OR REPLACE FUNCTION public.remove_workshop_work_order_line(p_work_order_id uuid, p_line_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wo public.workshop_work_orders%rowtype;
  v_actor uuid := auth.uid();
  v_role text;
  v_line public.workshop_work_order_lines%rowtype;
begin
  select * into v_wo from public.workshop_work_orders w where w.id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  v_role := public.workshop_line_actor_role(v_wo);
  if v_wo.status in ('completed', 'cancelled') then raise exception 'Lines cannot be removed once the work order is %', v_wo.status; end if;
  select * into v_line from public.workshop_work_order_lines l where l.id = p_line_id and l.work_order_id = v_wo.id;
  if not found then return; end if;
  if v_role = 'worker' and v_line.created_by is distinct from v_actor then
    raise exception 'You can only remove lines you added yourself';
  end if;
  delete from public.workshop_work_order_lines where id = v_line.id;
  update public.workshop_work_orders set updated_at = now(), updated_by = v_actor where id = v_wo.id;
end;
$function$;
