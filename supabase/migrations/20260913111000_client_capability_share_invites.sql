-- Per-capability client sharing invites. Replaces the "client org must accept
-- the whole agreement" gate for reporting/finance visibility specifically,
-- without touching the ~60 other call sites where invitation_status='accepted'
-- legitimately gates real operational authorization (dispatch, geography,
-- CRM contacts) — those stay as-is; only reporting/finance sharing changes.

ALTER TABLE public.onboarding_invites
  ADD COLUMN IF NOT EXISTS invite_kind text NOT NULL DEFAULT 'agreement_onboarding';

ALTER TABLE public.onboarding_invites DROP CONSTRAINT IF EXISTS onboarding_invites_invite_kind_check;
ALTER TABLE public.onboarding_invites
  ADD CONSTRAINT onboarding_invites_invite_kind_check
  CHECK (invite_kind IN ('agreement_onboarding', 'reporting_share', 'finance_share'));

CREATE INDEX IF NOT EXISTS idx_onboarding_invites_agreement_kind
  ON public.onboarding_invites (service_agreement_id, invite_kind, status);

-- Provider admin invites a client contact to a single shared capability
-- (reporting or finance) without requiring the client to accept the whole
-- operational agreement first.
CREATE OR REPLACE FUNCTION public.invite_client_capability_share(
  p_service_agreement_id uuid,
  p_capability text,
  p_email text
)
RETURNS public.onboarding_invites
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_invite_kind text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_invite public.onboarding_invites%rowtype;
BEGIN
  IF p_capability NOT IN ('reporting', 'finance') THEN
    RAISE EXCEPTION 'capability must be reporting or finance';
  END IF;
  v_invite_kind := p_capability || '_share';
  IF v_email = '' OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'A valid email is required';
  END IF;

  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;

  INSERT INTO public.onboarding_invites (target_organization_id, service_agreement_id, invited_by, email, token_hash, invite_kind, status, expires_at)
  VALUES (v_agreement.client_organization_id, v_agreement.id, v_actor, v_email, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_invite_kind, 'pending', now() + interval '14 days')
  RETURNING * INTO v_invite;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_agreement.provider_organization_id, v_actor, 'client_capability_share_invited', 'onboarding_invites', v_invite.id, jsonb_build_object('service_agreement_id', v_agreement.id, 'capability', p_capability, 'email', v_email));

  -- Plaintext token returned once, to the inviter, for delivery out-of-band.
  v_invite.token_hash := v_token;
  RETURN v_invite;
END;
$$;

REVOKE ALL ON FUNCTION public.invite_client_capability_share(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invite_client_capability_share(uuid, text, text) TO authenticated, service_role;

-- Client-side acceptance: enables the specific shared capability directly on
-- the agreement, independent of invitation_status.
CREATE OR REPLACE FUNCTION public.accept_client_capability_share(p_token text)
RETURNS public.service_agreements
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite public.onboarding_invites%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_hash text := encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
BEGIN
  SELECT * INTO v_invite FROM public.onboarding_invites
  WHERE token_hash = v_hash AND invite_kind IN ('reporting_share', 'finance_share')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invite not found'; END IF;
  IF v_invite.status <> 'pending' THEN RAISE EXCEPTION 'Invite is no longer pending'; END IF;
  IF v_invite.expires_at < now() THEN
    UPDATE public.onboarding_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'Invite has expired';
  END IF;

  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = v_invite.service_agreement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;

  IF v_invite.invite_kind = 'reporting_share' THEN
    UPDATE public.service_agreements SET client_portal_reports_enabled = true WHERE id = v_agreement.id RETURNING * INTO v_agreement;
  ELSE
    UPDATE public.service_agreements SET client_portal_finance_enabled = true WHERE id = v_agreement.id RETURNING * INTO v_agreement;
  END IF;

  UPDATE public.onboarding_invites SET status = 'accepted', accepted_at = now() WHERE id = v_invite.id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_agreement.provider_organization_id, auth.uid(), 'client_capability_share_accepted', 'service_agreements', v_agreement.id, jsonb_build_object('invite_kind', v_invite.invite_kind));

  RETURN v_agreement;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_client_capability_share(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_client_capability_share(text) TO authenticated, service_role;

-- Widen (never narrow) the two gates named explicitly: invoicing may proceed
-- on either a fully accepted agreement OR an active finance-share grant.
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
  IF v_agreement.invitation_status <> 'accepted' AND NOT v_agreement.client_portal_finance_enabled THEN
    RAISE EXCEPTION 'Client approval or an active finance-share invite is required before invoicing this agreement';
  END IF;
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

-- Reporting configuration may proceed on either a fully accepted agreement OR
-- an active reporting-share grant.
CREATE OR REPLACE FUNCTION public.manage_crm_agreement_reporting(
  p_agreement_id uuid,
  p_expected_invitation_status text,
  p_client_portal_reports_enabled boolean,
  p_monthly_report_template_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_template text := nullif(trim(coalesce(p_monthly_report_template_code, '')), '');
BEGIN
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id=p_agreement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Provider administrator required'; END IF;
  IF v_agreement.agreement_type <> 'operational' THEN RAISE EXCEPTION 'Only operational agreements can be configured'; END IF;
  IF v_agreement.invitation_status <> 'accepted' AND NOT v_agreement.client_portal_reports_enabled THEN
    RAISE EXCEPTION 'Client approval or an active reporting-share invite is required to configure reporting';
  END IF;
  IF v_agreement.invitation_status IS DISTINCT FROM p_expected_invitation_status THEN RAISE EXCEPTION 'Service agreement changed since it was opened'; END IF;
  IF p_client_portal_reports_enabled AND v_template IS NULL THEN RAISE EXCEPTION 'A monthly report template is required when client report delivery is enabled'; END IF;
  IF v_template IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.report_templates rt WHERE rt.organization_id=v_agreement.provider_organization_id AND rt.template_code=v_template) THEN RAISE EXCEPTION 'Monthly report template is not configured for this provider'; END IF;

  UPDATE public.service_agreements
  SET client_portal_reports_enabled = coalesce(p_client_portal_reports_enabled, false),
      monthly_report_template_code = CASE WHEN coalesce(p_client_portal_reports_enabled, false) THEN v_template ELSE NULL END
  WHERE id = v_agreement.id
  RETURNING * INTO v_agreement;

  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_agreement.provider_organization_id,v_actor,'crm_agreement_reporting_updated','service_agreements',v_agreement.id,jsonb_build_object('client_portal_reports_enabled',v_agreement.client_portal_reports_enabled,'monthly_report_template_code',v_agreement.monthly_report_template_code));

  RETURN jsonb_build_object('agreement_id',v_agreement.id,'client_portal_reports_enabled',v_agreement.client_portal_reports_enabled,'monthly_report_template_code',v_agreement.monthly_report_template_code);
END;
$$;
REVOKE ALL ON FUNCTION public.manage_crm_agreement_reporting(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_crm_agreement_reporting(uuid, text, boolean, text) TO authenticated, service_role;
