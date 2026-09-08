-- Domain promotion proposals keep extracted document data separate from
-- authoritative CRM/HR/finance/evidence records until a later approval command.

CREATE TABLE IF NOT EXISTS public.document_promotion_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE RESTRICT,
  target_type text NOT NULL,
  proposed_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed',
  requested_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_promotion_proposals_target_check CHECK (target_type IN ('crm_agreement','site_brief','credential','finance_reconciliation','hr_case','evidence_link','investigation_link')),
  CONSTRAINT document_promotion_proposals_status_check CHECK (status IN ('proposed','approved','rejected','applied','failed'))
);

CREATE INDEX IF NOT EXISTS document_promotion_proposals_org_status
  ON public.document_promotion_proposals (organization_id, status, created_at DESC);

ALTER TABLE public.document_promotion_proposals
  ADD COLUMN IF NOT EXISTS applied_target_id uuid,
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

ALTER TABLE public.document_promotion_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_promotion_proposals_select ON public.document_promotion_proposals
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE INSERT, UPDATE, DELETE ON public.document_promotion_proposals FROM anon, authenticated;
GRANT SELECT ON public.document_promotion_proposals TO authenticated;

CREATE OR REPLACE FUNCTION public.propose_document_promotion(
  p_document_version_id uuid,
  p_target_type text,
  p_proposed_payload jsonb DEFAULT '{}'::jsonb,
  p_source_map jsonb DEFAULT '{}'::jsonb
) RETURNS public.document_promotion_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_proposal public.document_promotion_proposals%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_target_type NOT IN ('crm_agreement','site_brief','credential','finance_reconciliation','hr_case','evidence_link','investigation_link') THEN
    RAISE EXCEPTION 'Unsupported document promotion target';
  END IF;
  SELECT d.organization_id INTO v_org_id
  FROM public.document_versions dv JOIN public.documents d ON d.id = dv.document_id
  WHERE dv.id = p_document_version_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Document version not found'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Document promotion proposal denied'; END IF;
  INSERT INTO public.document_promotion_proposals (organization_id, document_version_id, target_type, proposed_payload, source_map, requested_by)
  VALUES (v_org_id, p_document_version_id, p_target_type, coalesce(p_proposed_payload, '{}'::jsonb), coalesce(p_source_map, '{}'::jsonb), v_actor)
  RETURNING * INTO v_proposal;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_actor, 'document_promotion_proposed', 'document_promotion_proposals', v_proposal.id,
    jsonb_build_object('document_version_id', p_document_version_id, 'target_type', p_target_type));
  RETURN v_proposal;
END;
$$;

REVOKE ALL ON FUNCTION public.propose_document_promotion(uuid, text, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.propose_document_promotion(uuid, text, jsonb, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_document_promotion_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_reason text
) RETURNS public.document_promotion_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_proposal public.document_promotion_proposals%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Review reason is required'; END IF;
  SELECT * INTO v_proposal FROM public.document_promotion_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Promotion proposal not found'; END IF;
  IF NOT public.is_admin_for_org(v_proposal.organization_id) AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Promotion proposal review denied';
  END IF;
  IF v_proposal.status <> 'proposed' THEN RAISE EXCEPTION 'Only proposed promotions can be reviewed'; END IF;
  UPDATE public.document_promotion_proposals
  SET status = p_decision, reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_reason = trim(p_reason), updated_at = clock_timestamp()
  WHERE id = v_proposal.id
  RETURNING * INTO v_proposal;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_proposal.organization_id, v_actor, 'document_promotion_proposal_reviewed', 'document_promotion_proposals', v_proposal.id,
    jsonb_build_object('decision', p_decision, 'target_type', v_proposal.target_type, 'reason', trim(p_reason)));
  RETURN v_proposal;
END;
$$;

REVOKE ALL ON FUNCTION public.review_document_promotion_proposal(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_document_promotion_proposal(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_crm_agreement_promotion_proposal(
  p_proposal_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_name text,
  p_starts_on date DEFAULT NULL,
  p_ends_on date DEFAULT NULL,
  p_enabled_modules text[] DEFAULT '{}'::text[]
) RETURNS TABLE (proposal_id uuid, agreement_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_proposal public.document_promotion_proposals%rowtype;
  v_agreement_id uuid;
  v_created boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF nullif(trim(coalesce(p_name, '')), '') IS NULL THEN RAISE EXCEPTION 'Agreement name is required'; END IF;
  SELECT * INTO v_proposal FROM public.document_promotion_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Promotion proposal not found'; END IF;
  IF v_proposal.target_type <> 'crm_agreement' OR v_proposal.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved CRM agreement proposals can be applied';
  END IF;
  IF NOT public.is_admin_for_org(p_provider_organization_id) AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'CRM agreement application denied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_client_organization_id AND active) THEN
    RAISE EXCEPTION 'Active client organisation is required';
  END IF;
  IF v_proposal.applied_target_id IS NOT NULL THEN
    RETURN QUERY SELECT v_proposal.id, v_proposal.applied_target_id, false;
    RETURN;
  END IF;
  SELECT id INTO v_agreement_id
  FROM public.service_agreements
  WHERE provider_organization_id = p_provider_organization_id
    AND client_organization_id = p_client_organization_id
    AND name = trim(p_name)
  LIMIT 1;
  IF v_agreement_id IS NULL THEN
    INSERT INTO public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, ends_on, agreement_type, invitation_status, enabled_modules, external_refs)
    VALUES (p_provider_organization_id, p_client_organization_id, trim(p_name), p_starts_on, p_ends_on, 'operational', 'not_invited', coalesce(p_enabled_modules, '{}'::text[]), jsonb_build_object('document_promotion_proposal_id', v_proposal.id, 'document_version_id', v_proposal.document_version_id))
    RETURNING id INTO v_agreement_id;
    v_created := true;
  END IF;
  UPDATE public.document_promotion_proposals
  SET status = 'applied', applied_target_id = v_agreement_id, applied_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = v_proposal.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_proposal.organization_id, v_actor, 'document_promotion_proposal_applied', 'service_agreements', v_agreement_id,
    jsonb_build_object('proposal_id', v_proposal.id, 'document_version_id', v_proposal.document_version_id, 'created', v_created));
  RETURN QUERY SELECT v_proposal.id, v_agreement_id, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_crm_agreement_promotion_proposal(uuid, uuid, uuid, text, date, date, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_crm_agreement_promotion_proposal(uuid, uuid, uuid, text, date, date, text[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_credential_promotion_proposal(
  p_proposal_id uuid,
  p_staff_id uuid,
  p_credential_type text,
  p_credential_number text DEFAULT NULL,
  p_issuing_authority text DEFAULT NULL,
  p_issued_date date DEFAULT NULL,
  p_expiry_date date DEFAULT NULL,
  p_authorized_activities text[] DEFAULT '{}'
) RETURNS TABLE (proposal_id uuid, credential_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_proposal public.document_promotion_proposals%rowtype;
  v_org_id uuid;
  v_storage_path text;
  v_credential_id uuid;
  v_created boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_credential_type NOT IN ('certificate_of_authority','warrant_of_authority','drivers_licence','first_aid','security_licence','firearms_licence','noise_control_warrant','biosecurity_warrant','other') THEN RAISE EXCEPTION 'Unsupported credential type'; END IF;
  SELECT * INTO v_proposal FROM public.document_promotion_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND OR v_proposal.target_type <> 'credential' OR v_proposal.status <> 'approved' THEN RAISE EXCEPTION 'Only approved credential proposals can be applied'; END IF;
  SELECT sp.organization_id INTO v_org_id FROM public.staff_profiles sp WHERE sp.id = p_staff_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Staff profile not found'; END IF;
  IF v_org_id <> v_proposal.organization_id THEN RAISE EXCEPTION 'Staff profile is outside proposal organisation'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Credential application denied'; END IF;
  SELECT d.storage_object_ref INTO v_storage_path FROM public.document_versions dv JOIN public.documents d ON d.id = dv.document_id WHERE dv.id = v_proposal.document_version_id;
  IF v_proposal.applied_target_id IS NOT NULL THEN RETURN QUERY SELECT v_proposal.id, v_proposal.applied_target_id, false; RETURN; END IF;
  SELECT id INTO v_credential_id FROM public.staff_credentials WHERE staff_id = p_staff_id AND organization_id = v_org_id AND credential_type = p_credential_type AND credential_number IS NOT DISTINCT FROM p_credential_number AND expiry_date IS NOT DISTINCT FROM p_expiry_date LIMIT 1;
  IF v_credential_id IS NULL THEN
    INSERT INTO public.staff_credentials (staff_id, organization_id, credential_type, credential_number, issuing_authority, issued_date, expiry_date, authorized_activities, document_storage_path, verified, notes, client_request_id)
    VALUES (p_staff_id, v_org_id, p_credential_type, nullif(trim(p_credential_number), ''), nullif(trim(p_issuing_authority), ''), p_issued_date, p_expiry_date, coalesce(p_authorized_activities, '{}'::text[]), v_storage_path, false, 'Created from document promotion proposal ' || v_proposal.id::text, v_proposal.id)
    RETURNING id INTO v_credential_id;
    v_created := true;
  END IF;
  UPDATE public.document_promotion_proposals SET status = 'applied', applied_target_id = v_credential_id, applied_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_proposal.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_actor, 'document_promotion_proposal_applied', 'staff_credentials', v_credential_id, jsonb_build_object('proposal_id', v_proposal.id, 'document_version_id', v_proposal.document_version_id, 'created', v_created, 'verified', false));
  RETURN QUERY SELECT v_proposal.id, v_credential_id, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_credential_promotion_proposal(uuid, uuid, text, text, text, date, date, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_credential_promotion_proposal(uuid, uuid, text, text, text, date, date, text[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_finance_reconciliation_proposal(
  p_proposal_id uuid,
  p_client_organization_id uuid,
  p_service_agreement_id uuid DEFAULT NULL,
  p_invoice_number text DEFAULT NULL,
  p_invoice_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_subtotal numeric DEFAULT 0,
  p_gst_amount numeric DEFAULT 0,
  p_total_amount numeric DEFAULT 0,
  p_notes text DEFAULT NULL
) RETURNS TABLE (proposal_id uuid, invoice_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_proposal public.document_promotion_proposals%rowtype;
  v_invoice_id uuid;
  v_due_date date := coalesce(p_due_date, p_invoice_date + 20);
  v_created boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_proposal FROM public.document_promotion_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND OR v_proposal.target_type <> 'finance_reconciliation' OR v_proposal.status <> 'approved' THEN RAISE EXCEPTION 'Only approved finance proposals can be applied'; END IF;
  IF NOT public.is_admin_for_org(v_proposal.organization_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Finance proposal application denied'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_client_organization_id AND organization_type = 'client' AND active) THEN RAISE EXCEPTION 'Active client organisation is required'; END IF;
  IF p_invoice_number IS NULL OR nullif(trim(p_invoice_number), '') IS NULL THEN RAISE EXCEPTION 'Invoice number is required'; END IF;
  IF p_invoice_date IS NULL OR v_due_date < p_invoice_date THEN RAISE EXCEPTION 'Valid invoice and due dates are required'; END IF;
  IF p_subtotal < 0 OR p_gst_amount < 0 OR p_total_amount <= 0 OR p_total_amount <> p_subtotal + p_gst_amount THEN RAISE EXCEPTION 'Invoice totals must be positive and reconcile'; END IF;
  IF p_service_agreement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.service_agreements WHERE id = p_service_agreement_id AND provider_organization_id = v_proposal.organization_id AND client_organization_id = p_client_organization_id) THEN RAISE EXCEPTION 'Service agreement does not match provider and client'; END IF;
  IF v_proposal.applied_target_id IS NOT NULL THEN RETURN QUERY SELECT v_proposal.id, v_proposal.applied_target_id, false; RETURN; END IF;
  SELECT id INTO v_invoice_id FROM public.invoices WHERE organization_id = v_proposal.organization_id AND invoice_number = trim(p_invoice_number) LIMIT 1;
  IF v_invoice_id IS NULL THEN
    INSERT INTO public.invoices (organization_id, client_organization_id, service_agreement_id, invoice_number, invoice_date, due_date, status, subtotal, gst_amount, total_amount, currency, notes, created_by)
    VALUES (v_proposal.organization_id, p_client_organization_id, p_service_agreement_id, trim(p_invoice_number), p_invoice_date, v_due_date, 'draft', p_subtotal, p_gst_amount, p_total_amount, 'NZD', concat_ws(E'\n', nullif(trim(p_notes), ''), 'Created from document promotion proposal ' || v_proposal.id::text || ' / version ' || v_proposal.document_version_id::text), v_actor)
    RETURNING id INTO v_invoice_id;
    v_created := true;
  END IF;
  UPDATE public.document_promotion_proposals SET status = 'applied', applied_target_id = v_invoice_id, applied_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_proposal.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_proposal.organization_id, v_actor, 'document_promotion_proposal_applied', 'invoices', v_invoice_id, jsonb_build_object('proposal_id', v_proposal.id, 'document_version_id', v_proposal.document_version_id, 'created', v_created, 'status', 'draft'));
  RETURN QUERY SELECT v_proposal.id, v_invoice_id, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_finance_reconciliation_proposal(uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_finance_reconciliation_proposal(uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_hr_document_promotion_proposal(
  p_proposal_id uuid,
  p_staff_id uuid,
  p_document_type text,
  p_file_name text,
  p_storage_path text,
  p_expiry_date date DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS TABLE (proposal_id uuid, staff_document_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_proposal public.document_promotion_proposals%rowtype;
  v_org_id uuid;
  v_document_id uuid;
  v_created boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_document_type NOT IN ('credential_evidence','contract','certificate','policy_acknowledgement','other') THEN RAISE EXCEPTION 'Unsupported staff document type'; END IF;
  IF nullif(trim(coalesce(p_file_name, '')), '') IS NULL OR nullif(trim(coalesce(p_storage_path, '')), '') IS NULL THEN RAISE EXCEPTION 'File name and secure storage path are required'; END IF;
  SELECT * INTO v_proposal FROM public.document_promotion_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND OR v_proposal.target_type <> 'hr_case' OR v_proposal.status <> 'approved' THEN RAISE EXCEPTION 'Only approved HR proposals can be applied'; END IF;
  SELECT sp.organization_id INTO v_org_id FROM public.staff_profiles sp WHERE sp.id = p_staff_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Staff profile not found'; END IF;
  IF v_org_id <> v_proposal.organization_id THEN RAISE EXCEPTION 'Staff profile is outside proposal organisation'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'HR document application denied'; END IF;
  IF v_proposal.applied_target_id IS NOT NULL THEN RETURN QUERY SELECT v_proposal.id, v_proposal.applied_target_id, false; RETURN; END IF;
  SELECT id INTO v_document_id FROM public.staff_documents WHERE staff_id = p_staff_id AND organization_id = v_org_id AND storage_path = trim(p_storage_path) LIMIT 1;
  IF v_document_id IS NULL THEN
    INSERT INTO public.staff_documents (staff_id, organization_id, document_type, file_name, storage_path, expiry_date, notes, uploaded_by)
    VALUES (p_staff_id, v_org_id, p_document_type, trim(p_file_name), trim(p_storage_path), p_expiry_date, nullif(trim(p_notes), ''), v_actor)
    RETURNING id INTO v_document_id;
    v_created := true;
  END IF;
  UPDATE public.document_promotion_proposals SET status = 'applied', applied_target_id = v_document_id, applied_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_proposal.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_actor, 'document_promotion_proposal_applied', 'staff_documents', v_document_id, jsonb_build_object('proposal_id', v_proposal.id, 'document_version_id', v_proposal.document_version_id, 'created', v_created, 'document_type', p_document_type));
  RETURN QUERY SELECT v_proposal.id, v_document_id, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_hr_document_promotion_proposal(uuid, uuid, text, text, text, date, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_hr_document_promotion_proposal(uuid, uuid, text, text, text, date, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_site_brief_promotion_proposal(
  p_proposal_id uuid,
  p_name text,
  p_work_unit_type text,
  p_service_type text,
  p_patrol_route_id uuid DEFAULT NULL,
  p_service_agreement_location_id uuid DEFAULT NULL,
  p_service_agreement_module_id uuid DEFAULT NULL,
  p_workplace_id uuid DEFAULT NULL,
  p_team_id uuid DEFAULT NULL,
  p_cost_centre_id uuid DEFAULT NULL
) RETURNS TABLE (proposal_id uuid, work_unit_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_proposal public.document_promotion_proposals%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_created boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_proposal FROM public.document_promotion_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND OR v_proposal.target_type <> 'site_brief' OR v_proposal.status <> 'approved' THEN RAISE EXCEPTION 'Only approved site brief proposals can be applied'; END IF;
  IF NOT public.is_admin_for_org(v_proposal.organization_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Site brief application denied'; END IF;
  IF v_proposal.applied_target_id IS NOT NULL THEN RETURN QUERY SELECT v_proposal.id, v_proposal.applied_target_id, false; RETURN; END IF;
  IF p_work_unit_type NOT IN ('patrol','static','internal') THEN RAISE EXCEPTION 'Unsupported work unit type'; END IF;
  IF nullif(trim(coalesce(p_name, '')), '') IS NULL OR nullif(trim(coalesce(p_service_type, '')), '') IS NULL THEN RAISE EXCEPTION 'Work unit name and service type are required'; END IF;
  SELECT * INTO v_unit FROM public.create_roster_work_unit(trim(p_name), p_work_unit_type, trim(p_service_type), p_patrol_route_id, p_service_agreement_location_id, p_service_agreement_module_id, p_workplace_id, p_team_id, p_cost_centre_id);
  IF v_unit.id IS NULL THEN RAISE EXCEPTION 'Work unit creation was not confirmed'; END IF;
  v_created := true;
  UPDATE public.document_promotion_proposals SET status = 'applied', applied_target_id = v_unit.id, applied_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_proposal.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_proposal.organization_id, v_actor, 'document_promotion_proposal_applied', 'roster_work_units', v_unit.id, jsonb_build_object('proposal_id', v_proposal.id, 'document_version_id', v_proposal.document_version_id, 'created', v_created, 'work_unit_type', p_work_unit_type));
  RETURN QUERY SELECT v_proposal.id, v_unit.id, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_site_brief_promotion_proposal(uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_site_brief_promotion_proposal(uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_investigation_link_promotion_proposal(
  p_proposal_id uuid,
  p_investigation_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_link_role text DEFAULT 'supporting',
  p_link_reason text DEFAULT NULL
) RETURNS TABLE (proposal_id uuid, link_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_proposal public.document_promotion_proposals%rowtype;
  v_investigation public.investigations%rowtype;
  v_link public.investigation_links%rowtype;
  v_created boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_entity_type NOT IN ('observation','field_report','incident','evidence','site','zone','person','vehicle','dispatch_job') THEN RAISE EXCEPTION 'Unsupported investigation entity type'; END IF;
  IF p_link_role NOT IN ('primary','supporting','context','lead','excluded') THEN RAISE EXCEPTION 'Unsupported investigation link role'; END IF;
  IF nullif(trim(coalesce(p_link_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Investigation link reason is required'; END IF;
  SELECT * INTO v_proposal FROM public.document_promotion_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND OR v_proposal.target_type <> 'investigation_link' OR v_proposal.status <> 'approved' THEN RAISE EXCEPTION 'Only approved investigation-link proposals can be applied'; END IF;
  SELECT * INTO v_investigation FROM public.investigations WHERE id = p_investigation_id FOR UPDATE;
  IF NOT FOUND OR v_investigation.organization_id <> v_proposal.organization_id THEN RAISE EXCEPTION 'Investigation is outside proposal organisation'; END IF;
  IF NOT public.is_admin_for_org(v_investigation.organization_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Investigation link application denied'; END IF;
  IF v_proposal.applied_target_id IS NOT NULL THEN RETURN QUERY SELECT v_proposal.id, v_proposal.applied_target_id, false; RETURN; END IF;
  v_link := public.link_investigation_entity(p_investigation_id, p_entity_type, p_entity_id, p_link_role, trim(p_link_reason));
  IF v_link.id IS NULL THEN RAISE EXCEPTION 'Investigation link receipt was not confirmed'; END IF;
  v_created := true;
  UPDATE public.document_promotion_proposals SET status = 'applied', applied_target_id = v_link.id, applied_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_proposal.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_proposal.organization_id, v_actor, 'document_promotion_proposal_applied', 'investigation_links', v_link.id, jsonb_build_object('proposal_id', v_proposal.id, 'document_version_id', v_proposal.document_version_id, 'created', v_created, 'entity_type', p_entity_type, 'entity_id', p_entity_id));
  RETURN QUERY SELECT v_proposal.id, v_link.id, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_investigation_link_promotion_proposal(uuid, uuid, text, uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_investigation_link_promotion_proposal(uuid, uuid, text, uuid, text, text) TO authenticated, service_role;