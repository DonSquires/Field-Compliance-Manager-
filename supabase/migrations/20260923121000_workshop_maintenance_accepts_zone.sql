-- Workshop maintenance work orders currently require a client_sites row
-- (an actual LINZ address). Per the owner's site/zone distinction (2026-09-23:
-- site = a LINZ address, zone = an area with no address, or part of a parcel/
-- multiple parcels of land, a section of road/beach/river etc), a forest
-- estate is unambiguously a zone, never a site - so a maintenance visit to a
-- forest (e.g. R&M's digger job at OFO's "Golden Downs Forest") had nowhere
-- valid to attach. Extends the existing site XOR zone pattern (already used
-- by location_events) to workshop_work_orders instead of inventing a new one.
ALTER TABLE public.workshop_work_orders ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES public.location_zones(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.workshop_work_orders.zone_id IS 'The zone this maintenance visit is at, when the place has no address (see client_site_id for the addressed case). A maintenance work order needs client_site_id, zone_id, or asset_id.';

CREATE OR REPLACE FUNCTION "public"."create_workshop_work_order"(p_client_request_id uuid, p_organization_id uuid, p_kind text, p_title text, p_description text DEFAULT NULL::text, p_client_organization_id uuid DEFAULT NULL::uuid, p_service_agreement_id uuid DEFAULT NULL::uuid, p_client_site_id uuid DEFAULT NULL::uuid, p_asset_id uuid DEFAULT NULL::uuid, p_inventory_location_id uuid DEFAULT NULL::uuid, p_assigned_user_id uuid DEFAULT NULL::uuid, p_scheduled_for timestamp with time zone DEFAULT NULL::timestamp with time zone, p_bom_template_id uuid DEFAULT NULL::uuid, p_zone_id uuid DEFAULT NULL::uuid)
 RETURNS workshop_work_orders
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
  if p_kind = 'maintenance' and p_client_site_id is null and p_asset_id is null and p_zone_id is null then raise exception 'A maintenance visit needs the place (site or zone) or the asset being maintained'; end if;
  if p_client_site_id is not null and not exists (select 1 from public.client_sites s where s.id = p_client_site_id) then raise exception 'Site not found'; end if;
  if p_zone_id is not null and not exists (select 1 from public.location_zones z where z.id = p_zone_id) then raise exception 'Zone not found'; end if;
  if p_asset_id is not null and not exists (select 1 from public.assets a where a.id = p_asset_id and a.organization_id in (p_organization_id, p_client_organization_id)) then raise exception 'Asset not found'; end if;
  if p_inventory_location_id is not null and not exists (select 1 from public.finance_inventory_locations l where l.id = p_inventory_location_id and l.organization_id = p_organization_id and l.active) then raise exception 'Stock location not found'; end if;
  if p_service_agreement_id is not null and not exists (select 1 from public.service_agreements a where a.id = p_service_agreement_id and a.provider_organization_id = p_organization_id) then raise exception 'Agreement not found for this organisation'; end if;
  if p_bom_template_id is not null and not exists (select 1 from public.workshop_bom_templates t where t.id = p_bom_template_id and t.organization_id = p_organization_id and t.active) then raise exception 'Template not found'; end if;

  select count(*) + 1 into v_seq from public.workshop_work_orders w where w.organization_id = p_organization_id;
  insert into public.workshop_work_orders (organization_id, client_request_id, order_number, kind, title, description, client_organization_id, service_agreement_id,
                                           client_site_id, zone_id, asset_id, inventory_location_id, bom_template_id, assigned_user_id, scheduled_for, created_by, updated_by)
  values (p_organization_id, p_client_request_id, 'WO-' || to_char(now(), 'YYYYMM') || '-' || lpad(v_seq::text, 4, '0'), p_kind, trim(p_title),
          nullif(trim(coalesce(p_description, '')), ''), p_client_organization_id, p_service_agreement_id, p_client_site_id, p_zone_id, p_asset_id, p_inventory_location_id,
          p_bom_template_id, p_assigned_user_id, p_scheduled_for, v_actor, v_actor)
  returning * into v_wo;

  for v_tpl_line in select * from public.workshop_bom_template_lines l where l.template_id = p_bom_template_id order by l.position loop
    v_cost := null; v_price := null; v_uom := null;
    if v_tpl_line.item_id is not null then
      select cp.unit_cost, cp.unit_price, cp.unit_of_measure into v_cost, v_price, v_uom from public.workshop_current_prices(v_tpl_line.item_id) cp;
    end if;
    insert into public.workshop_work_order_lines (work_order_id, organization_id, line_kind, item_id, description, quantity, unit_of_measure, unit_cost, unit_price, position)
    values (v_wo.id, p_organization_id, v_tpl_line.line_kind, v_tpl_line.item_id, v_tpl_line.description, v_tpl_line.quantity,
            coalesce(v_tpl_line.unit_of_measure, v_uom), coalesce(v_cost, 0), coalesce(v_price, 0), v_tpl_line.position);
  end loop;

  return v_wo;
end;
$function$;

REVOKE ALL ON FUNCTION "public"."create_workshop_work_order"(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,uuid,uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."create_workshop_work_order"(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,uuid,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."create_workshop_work_order"(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,uuid,uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."create_workshop_work_order"(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,uuid,uuid) TO "service_role";

CREATE OR REPLACE VIEW "public"."workshop_work_order_summary" WITH (security_invoker=true) AS
 SELECT wo.id,
    wo.organization_id,
    wo.order_number,
    wo.kind,
    wo.status,
    wo.title,
    wo.description,
    wo.client_organization_id,
    co.name AS client_name,
    wo.service_agreement_id,
    wo.client_site_id,
    cs.name AS site_name,
    wo.asset_id,
    a.name AS asset_name,
    wo.inventory_location_id,
    il.name AS stock_location_name,
    wo.bom_template_id,
    t.name AS template_name,
    wo.assigned_user_id,
    up.display_name AS assigned_name,
    wo.scheduled_for,
    wo.started_at,
    wo.completed_at,
    wo.cancelled_at,
    wo.completion_note,
    wo.created_at,
    wo.updated_at,
    COALESCE(l.line_count, 0::bigint) AS line_count,
    COALESCE(l.charge_total, 0::numeric) AS charge_total,
    COALESCE(l.cost_total, 0::numeric) AS cost_total,
    COALESCE(l.uninvoiced_total, 0::numeric) AS uninvoiced_total,
    wo.zone_id,
    z.name AS zone_name
   FROM workshop_work_orders wo
     LEFT JOIN organizations co ON co.id = wo.client_organization_id
     LEFT JOIN client_sites cs ON cs.id = wo.client_site_id
     LEFT JOIN location_zones z ON z.id = wo.zone_id
     LEFT JOIN assets a ON a.id = wo.asset_id
     LEFT JOIN finance_inventory_locations il ON il.id = wo.inventory_location_id
     LEFT JOIN workshop_bom_templates t ON t.id = wo.bom_template_id
     LEFT JOIN user_profiles up ON up.id = wo.assigned_user_id
     LEFT JOIN LATERAL ( SELECT count(*) AS line_count,
            sum(x.line_total) AS charge_total,
            sum(round(x.quantity * x.unit_cost, 2)) AS cost_total,
            sum(x.line_total) FILTER (WHERE x.invoice_line_item_id IS NULL) AS uninvoiced_total
           FROM workshop_work_order_lines x
          WHERE x.work_order_id = wo.id) l ON true;
COMMENT ON VIEW "public"."workshop_work_order_summary" IS 'One row per work order with names resolved and line totals (charge, cost, still-to-invoice). Inherits RLS via security_invoker.';
