CREATE OR REPLACE FUNCTION public.manage_crm_quote(p_quote_id uuid,p_expected_status text,p_action text,p_reason text DEFAULT NULL)
RETURNS TABLE(quote_id uuid,quote_status text,service_agreement_id uuid) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_quote public.quotes%rowtype;v_reason text:=nullif(trim(coalesce(p_reason,'')), '');v_margin numeric;v_agreement uuid;
BEGIN
  SELECT q.* INTO v_quote FROM public.quotes q WHERE q.id=p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found';END IF;
  IF NOT public.is_admin_for_org(v_quote.provider_org_id) THEN RAISE EXCEPTION 'Not authorised to manage this quote';END IF;
  IF v_quote.status<>p_expected_status THEN RAISE EXCEPTION 'Quote changed from expected status % to %',p_expected_status,v_quote.status;END IF;
  IF p_action='send' THEN
    IF v_quote.status<>'draft' THEN RAISE EXCEPTION 'Only draft quotes can be sent';END IF;
    IF v_quote.valid_until IS NOT NULL AND v_quote.valid_until<current_date THEN RAISE EXCEPTION 'Expired quotes cannot be sent';END IF;
    IF NOT EXISTS(SELECT 1 FROM public.quote_lines line WHERE line.quote_id=v_quote.id AND line.quantity>0 AND line.unit_charge>0 AND (line.kind='labour' OR (line.kind='module' AND line.module_key IS NOT NULL AND EXISTS(SELECT 1 FROM public.quote_proposal_modules module WHERE module.quote_id=v_quote.id AND module.module_key=line.module_key)))) THEN RAISE EXCEPTION 'At least one positively priced labour or quoted module line is required';END IF;
    IF v_quote.subtotal_charge<=0 OR v_quote.total_charge<=0 THEN RAISE EXCEPTION 'Quote totals must be positive before sending';END IF;
    v_margin:=CASE WHEN v_quote.subtotal_charge=0 THEN 0 ELSE (v_quote.subtotal_charge-v_quote.total_cost)*100/v_quote.subtotal_charge END;
    IF v_margin<v_quote.target_margin_pct THEN RAISE EXCEPTION 'Achieved margin % is below target %',round(v_margin,2),v_quote.target_margin_pct;END IF;
    UPDATE public.quotes q SET status='sent',updated_by=v_actor WHERE q.id=v_quote.id RETURNING q.* INTO v_quote;
  ELSIF p_action='accept' THEN
    IF v_quote.status<>'sent' THEN RAISE EXCEPTION 'Only sent quotes can be accepted';END IF;
    IF v_quote.valid_until IS NOT NULL AND v_quote.valid_until<current_date THEN RAISE EXCEPTION 'Expired quotes cannot be accepted';END IF;
    SELECT public.accept_quote(v_quote.id) INTO v_agreement;SELECT q.* INTO v_quote FROM public.quotes q WHERE q.id=v_quote.id;
  ELSIF p_action='decline' THEN
    IF v_quote.status<>'sent' THEN RAISE EXCEPTION 'Only sent quotes can be declined';END IF;
    IF v_reason IS NULL THEN RAISE EXCEPTION 'Decline reason is required';END IF;
    UPDATE public.quotes q SET status='declined',notes=concat_ws(E'\n',nullif(q.notes,''),'Declined: '||v_reason),updated_by=v_actor WHERE q.id=v_quote.id RETURNING q.* INTO v_quote;
  ELSE RAISE EXCEPTION 'Unsupported quote action';END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_quote.provider_org_id,v_actor,CASE p_action WHEN 'send' THEN 'crm_quote_sent' WHEN 'accept' THEN 'crm_quote_accepted' ELSE 'crm_quote_declined' END,'quotes',v_quote.id,jsonb_build_object('client_org_id',v_quote.client_org_id,'previous_status',p_expected_status,'status',v_quote.status,'service_agreement_id',v_quote.service_agreement_id,'reason',CASE WHEN p_action='decline' THEN v_reason ELSE NULL END));
  RETURN QUERY SELECT v_quote.id,v_quote.status,v_quote.service_agreement_id;
END;$$;

REVOKE ALL ON FUNCTION public.manage_crm_quote(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_crm_quote(uuid,text,text,text) TO authenticated,service_role;