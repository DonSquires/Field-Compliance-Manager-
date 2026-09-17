-- 20260917050000_bom_template_quote_lines.sql
-- A saved bill of materials ("Standard lockbox") becomes quote lines in one
-- step, at today's approved price-book cost and sell price. Every line goes
-- through add_crm_quote_line (same authorisation, validation, totals and
-- audit); the per-line request id is derived from the caller's request id, so
-- replaying the call adds nothing twice.

CREATE OR REPLACE FUNCTION public.add_crm_quote_lines_from_bom_template(
  p_client_request_id uuid,
  p_quote_id uuid,
  p_expected_status text,
  p_template_id uuid,
  p_site_id uuid DEFAULT NULL
) RETURNS TABLE(lines_added integer, lines_needing_price integer, quote_id uuid, total_cost numeric, subtotal_charge numeric, discount_amount numeric, gst_amount numeric, total_charge numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes%rowtype;
  v_tpl public.workshop_bom_templates%rowtype;
  v_line record;
  v_cost numeric; v_price numeric;
  v_kind text;
  v_receipt record;
  v_added integer := 0;
  v_unpriced integer := 0;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select q.* into v_quote from public.quotes q where q.id = p_quote_id;
  if not found then raise exception 'Quote not found'; end if;
  if not public.is_admin_for_org(v_quote.provider_org_id) then raise exception 'Not authorised to price this quote'; end if;
  select t.* into v_tpl from public.workshop_bom_templates t where t.id = p_template_id and t.organization_id = v_quote.provider_org_id and t.active;
  if not found then raise exception 'Template not found for this quote''s provider'; end if;
  if not exists (select 1 from public.workshop_bom_template_lines l where l.template_id = v_tpl.id) then raise exception 'Template "%" has no lines', v_tpl.name; end if;

  for v_line in select l.* from public.workshop_bom_template_lines l where l.template_id = v_tpl.id order by l.position loop
    v_cost := null; v_price := null;
    if v_line.item_id is not null then
      select cp.unit_cost, cp.unit_price into v_cost, v_price from public.workshop_current_prices(v_line.item_id) cp;
    end if;
    if coalesce(v_price, 0) = 0 then v_unpriced := v_unpriced + 1; end if;
    v_kind := case v_line.line_kind when 'material' then 'materials' when 'equipment' then 'equipment' when 'travel' then 'travel' else 'labour' end;
    -- Deterministic per-line request id: the same call replayed adds nothing twice.
    select * into v_receipt from public.add_crm_quote_line(
      md5(p_client_request_id::text || ':' || v_line.id::text)::uuid, v_quote.id, p_expected_status, v_kind,
      v_tpl.name || ' — ' || v_line.description, v_line.quantity, coalesce(v_cost, 0), coalesce(v_price, 0), null, p_site_id);
    if v_receipt.created then v_added := v_added + 1; end if;
  end loop;

  select q.* into v_quote from public.quotes q where q.id = p_quote_id;
  if v_added > 0 then
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_quote.provider_org_id, auth.uid(), 'crm_quote_lines_added_from_bom_template', 'quotes', v_quote.id,
            jsonb_build_object('template_id', v_tpl.id, 'template_name', v_tpl.name, 'lines_added', v_added, 'lines_needing_price', v_unpriced, 'client_request_id', p_client_request_id));
  end if;
  return query select v_added, v_unpriced, v_quote.id, v_quote.total_cost, v_quote.subtotal_charge, v_quote.discount_amount, v_quote.gst_amount, v_quote.total_charge;
end;
$function$;
REVOKE ALL ON FUNCTION public.add_crm_quote_lines_from_bom_template(uuid, uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_crm_quote_lines_from_bom_template(uuid, uuid, text, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION public.add_crm_quote_lines_from_bom_template(uuid, uuid, text, uuid, uuid) IS 'Copy a workshop BOM template onto a draft quote as priced lines (current approved price-book cost/sell). Idempotent per line on the caller''s request id; audited.';
