CREATE OR REPLACE FUNCTION public.generate_crm_invoice_from_agreement(
  p_client_request_id uuid,
  p_service_agreement_id uuid,
  p_service_period_start date,
  p_service_period_end date
)
RETURNS TABLE(invoice_id uuid, invoice_number text, client_organization_id uuid, subtotal numeric, gst_amount numeric, total_amount numeric, line_item_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid:=auth.uid(); v_agreement public.service_agreements%rowtype; v_invoice public.invoices%rowtype; v_inv_number text; v_count integer:=0; v_qline record; v_comm public.crm_commercial_settings%rowtype;
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id=p_service_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Not authorised to invoice for this agreement'; END IF;
  IF v_agreement.invitation_status <> 'accepted' THEN RAISE EXCEPTION 'Client approval required before invoicing this agreement'; END IF;
  IF p_service_period_end < p_service_period_start THEN RAISE EXCEPTION 'Service period end cannot precede service period start'; END IF;
  SELECT 'INV-'||to_char(now(),'YYYYMMDD')||'-'||upper(substring(gen_random_uuid()::text,1,4)) INTO v_inv_number;
  INSERT INTO public.invoices(organization_id,client_organization_id,service_agreement_id,invoice_number,invoice_date,due_date,status,service_period_start,service_period_end,created_by)
  VALUES(v_agreement.provider_organization_id,v_agreement.client_organization_id,v_agreement.id,v_inv_number,current_date,(current_date+interval '14 days')::date,'draft',p_service_period_start,p_service_period_end,v_actor) RETURNING * INTO v_invoice;
  FOR v_qline IN SELECT line.description,line.quantity,line.unit_charge FROM public.quotes quote JOIN public.quote_lines line ON line.quote_id=quote.id WHERE quote.service_agreement_id=v_agreement.id AND quote.status='accepted' LOOP
    v_count:=v_count+1; INSERT INTO public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id) VALUES(v_invoice.id,v_count,v_qline.description,v_qline.quantity,v_qline.unit_charge,round(v_qline.quantity*v_qline.unit_charge,2),v_invoice.organization_id);
  END LOOP;
  IF v_count=0 THEN
    SELECT * INTO v_comm FROM public.crm_commercial_settings WHERE service_agreement_id=v_agreement.id;
    IF FOUND AND v_comm.base_rate_per_hour IS NOT NULL AND v_comm.base_rate_per_hour>0 THEN
      v_count:=1; INSERT INTO public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id) VALUES(v_invoice.id,1,'Service Agreement Base Retainer',1,v_comm.base_rate_per_hour,v_comm.base_rate_per_hour,v_invoice.organization_id);
    ELSE RAISE EXCEPTION 'Commercial configuration incomplete: an accepted quote line or positive agreement rate is required before invoicing'; END IF;
  END IF;
  UPDATE public.invoices invoice SET subtotal=totals.subtotal,gst_amount=round(totals.subtotal*.15,2),total_amount=round(totals.subtotal*1.15,2),updated_at=now() FROM (SELECT coalesce(sum(line.line_total),0)::numeric(12,2) subtotal FROM public.invoice_line_items line WHERE line.invoice_id=v_invoice.id) totals WHERE invoice.id=v_invoice.id RETURNING invoice.* INTO v_invoice;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_invoice.organization_id,v_actor,'crm_invoice_generated_from_agreement','invoices',v_invoice.id,jsonb_build_object('service_agreement_id',v_agreement.id,'invoice_number',v_invoice.invoice_number,'subtotal',v_invoice.subtotal,'total_amount',v_invoice.total_amount,'line_item_count',v_count,'client_request_id',p_client_request_id));
  RETURN QUERY SELECT v_invoice.id,v_invoice.invoice_number,v_invoice.client_organization_id,v_invoice.subtotal,v_invoice.gst_amount,v_invoice.total_amount,v_count;
EXCEPTION WHEN OTHERS THEN
  IF v_invoice.id IS NOT NULL THEN DELETE FROM public.invoices WHERE id=v_invoice.id; END IF;
  RAISE;
END; $$;
REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_agreement(uuid,uuid,date,date) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_agreement(uuid,uuid,date,date) TO authenticated,service_role;
