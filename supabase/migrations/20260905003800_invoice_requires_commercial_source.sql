-- Invoices must never invent a default commercial amount. Existing accepted
-- quote lines and legacy accepted agreement commercial settings remain valid.
CREATE OR REPLACE FUNCTION public.generate_crm_invoice_from_agreement(
  p_client_request_id uuid,
  p_service_agreement_id uuid,
  p_service_period_start date,
  p_service_period_end date
)
RETURNS TABLE(
  invoice_id uuid,
  invoice_number text,
  client_organization_id uuid,
  subtotal numeric,
  gst_amount numeric,
  total_amount numeric,
  line_item_count integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_invoice public.invoices%rowtype;
  v_inv_number text;
  v_count integer := 0;
  v_qline record;
  v_comm public.crm_commercial_settings%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_agreement from public.service_agreements where id = p_service_agreement_id;
  if not found then raise exception 'Service agreement not found'; end if;
  if not public.is_admin_for_org(v_agreement.provider_organization_id) then raise exception 'Not authorised to invoice for this agreement'; end if;
  if p_service_period_end < p_service_period_start then raise exception 'Service period end cannot precede service period start'; end if;

  select 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substring(gen_random_uuid()::text, 1, 4)) into v_inv_number;
  insert into public.invoices(organization_id,client_organization_id,service_agreement_id,invoice_number,invoice_date,due_date,status,service_period_start,service_period_end,created_by)
  values(v_agreement.provider_organization_id,v_agreement.client_organization_id,v_agreement.id,v_inv_number,current_date,(current_date + interval '14 days')::date,'draft',p_service_period_start,p_service_period_end,v_actor)
  returning * into v_invoice;

  -- Accepted quote lines are immutable commercial detail. A snapshot, when
  -- present, provides auditable tender/discount/rate provenance for new quotes.
  for v_qline in
    select line.description,line.quantity,line.unit_charge
    from public.quotes quote
    join public.quote_lines line on line.quote_id = quote.id
    where quote.service_agreement_id = v_agreement.id and quote.status = 'accepted'
  loop
    v_count := v_count + 1;
    insert into public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id)
    values(v_invoice.id,v_count,v_qline.description,v_qline.quantity,v_qline.unit_charge,round(v_qline.quantity * v_qline.unit_charge, 2),v_invoice.organization_id);
  end loop;

  if v_count = 0 then
    select * into v_comm from public.crm_commercial_settings where service_agreement_id = v_agreement.id;
    if found and v_comm.base_rate_per_hour is not null and v_comm.base_rate_per_hour > 0 then
      v_count := 1;
      insert into public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id)
      values(v_invoice.id,1,'Service Agreement Base Retainer',1,v_comm.base_rate_per_hour,v_comm.base_rate_per_hour,v_invoice.organization_id);
    else
      raise exception 'Commercial configuration incomplete: an accepted quote line or positive agreement rate is required before invoicing';
    end if;
  end if;

  update public.invoices invoice set
    subtotal = totals.subtotal,
    gst_amount = round(totals.subtotal * 0.15, 2),
    total_amount = round(totals.subtotal * 1.15, 2),
    updated_at = now()
  from (select coalesce(sum(line.line_total), 0)::numeric(12,2) subtotal from public.invoice_line_items line where line.invoice_id = v_invoice.id) totals
  where invoice.id = v_invoice.id
  returning invoice.* into v_invoice;

  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_invoice.organization_id,v_actor,'crm_invoice_generated_from_agreement','invoices',v_invoice.id,jsonb_build_object('service_agreement_id',v_agreement.id,'invoice_number',v_invoice.invoice_number,'subtotal',v_invoice.subtotal,'total_amount',v_invoice.total_amount,'line_item_count',v_count,'client_request_id',p_client_request_id));
  return query select v_invoice.id,v_invoice.invoice_number,v_invoice.client_organization_id,v_invoice.subtotal,v_invoice.gst_amount,v_invoice.total_amount,v_count;
exception when others then
  if v_invoice.id is not null then delete from public.invoices where id = v_invoice.id; end if;
  raise;
end;
$$;

REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_agreement(uuid,uuid,date,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_agreement(uuid,uuid,date,date) TO authenticated, service_role;