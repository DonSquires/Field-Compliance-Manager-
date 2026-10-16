-- Bob may PROPOSE organisation compliance-register records (H&S policies,
-- H&S plans, contractor prequalification, licences, insurance, certifications)
-- from evidence he has read. He never writes the register directly: the
-- producer files a pending create_org_compliance_record action, a human
-- approves it, and this service-only executor applies it with the same
-- validation as save_organization_compliance_record. The record is always
-- written as 'unverified'; a master still verifies it in the Compliance
-- section, so approving Bob's filing is never mistaken for verifying evidence.
CREATE OR REPLACE FUNCTION public.apply_bob_compliance_record_proposal(p_action_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action public.bob_agentic_actions%rowtype;
  v_payload jsonb;
  v_actor public.user_profiles%rowtype;
  v_org_id uuid;
  v_record public.organization_compliance_records%rowtype;
  v_replaced public.organization_compliance_records%rowtype;
  v_evidence_id uuid;
  v_attachment_id uuid;
  v_effective date;
  v_expiry date;
  v_source_as_of date;
  v_coverage numeric;
BEGIN
  SELECT * INTO v_action FROM public.bob_agentic_actions WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND OR v_action.action_type <> 'create_org_compliance_record' OR v_action.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved create_org_compliance_record actions can be executed';
  END IF;
  IF v_action.result_record_id IS NOT NULL THEN
    RETURN v_action.result_record_id;
  END IF;

  v_payload := coalesce(v_action.amended_payload, v_action.proposed_payload);
  v_org_id := nullif(v_payload->>'organization_id', '')::uuid;
  IF v_org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_org_id) THEN
    RAISE EXCEPTION 'Target organization does not exist';
  END IF;

  SELECT * INTO v_actor FROM public.user_profiles WHERE id = v_action.approved_by AND deactivated_at IS NULL;
  IF NOT FOUND OR v_actor.role NOT IN ('grand_master', 'master')
    OR NOT public.can_approve_action(v_action.approved_by, v_org_id) THEN
    RAISE EXCEPTION 'Active organization master approval is required';
  END IF;

  -- Idempotent on the action id (unique organization_id + client_request_id).
  SELECT * INTO v_record FROM public.organization_compliance_records
  WHERE organization_id = v_org_id AND client_request_id = v_action.id;
  IF FOUND THEN
    RETURN v_record.id;
  END IF;

  IF coalesce(v_payload->>'record_type', '') NOT IN (
    'company_licence', 'insurance', 'policy', 'prequalification', 'registration', 'certification', 'other'
  ) THEN
    RAISE EXCEPTION 'Unsupported compliance record type';
  END IF;
  IF length(trim(coalesce(v_payload->>'name', ''))) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'Compliance record name is required';
  END IF;
  v_source_as_of := nullif(v_payload->>'source_as_of', '')::date;
  IF length(trim(coalesce(v_payload->>'source_name', ''))) NOT BETWEEN 2 AND 500 OR v_source_as_of IS NULL THEN
    RAISE EXCEPTION 'Source name and source date are required';
  END IF;
  v_effective := nullif(v_payload->>'effective_date', '')::date;
  v_expiry := nullif(v_payload->>'expiry_date', '')::date;
  IF v_effective IS NOT NULL AND v_expiry IS NOT NULL AND v_expiry < v_effective THEN
    RAISE EXCEPTION 'Expiry date cannot precede effective date';
  END IF;
  v_coverage := nullif(v_payload->>'coverage_amount', '')::numeric;
  IF v_coverage IS NOT NULL AND v_coverage < 0 THEN
    RAISE EXCEPTION 'Coverage amount cannot be negative';
  END IF;

  -- Evidence must be a governed document owned by the target organization or
  -- by the operator that filed the proposal. A chat attachment resolves to its
  -- registered document; an unregistered attachment stays as provenance text.
  v_evidence_id := nullif(v_payload->>'evidence_document_id', '')::uuid;
  v_attachment_id := nullif(v_payload->>'source_attachment_id', '')::uuid;
  IF v_evidence_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = v_evidence_id AND d.organization_id IN (v_org_id, v_action.organization_id)
    ) THEN
      RAISE EXCEPTION 'Evidence document is not available to this organization';
    END IF;
  ELSIF v_attachment_id IS NOT NULL THEN
    SELECT d.id INTO v_evidence_id
    FROM public.documents d
    WHERE d.attachment_id = v_attachment_id
      AND d.organization_id IN (v_org_id, v_action.organization_id)
    ORDER BY d.created_at DESC
    LIMIT 1;
  END IF;

  IF nullif(v_payload->>'replaces_record_id', '') IS NOT NULL THEN
    SELECT * INTO v_replaced FROM public.organization_compliance_records
    WHERE id = (v_payload->>'replaces_record_id')::uuid
      AND organization_id = v_org_id
      AND status = 'current'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Current record to replace was not found';
    END IF;
  END IF;

  INSERT INTO public.organization_compliance_records (
    organization_id, record_type, name, reference_number, issuer,
    effective_date, expiry_date, coverage_amount, currency,
    evidence_document_id, source_name, source_as_of, source_notes,
    replaces_record_id, client_request_id, created_by, updated_by
  )
  VALUES (
    v_org_id,
    v_payload->>'record_type',
    trim(v_payload->>'name'),
    nullif(trim(coalesce(v_payload->>'reference_number', '')), ''),
    nullif(trim(coalesce(v_payload->>'issuer', '')), ''),
    v_effective,
    v_expiry,
    v_coverage,
    upper(coalesce(nullif(trim(v_payload->>'currency'), ''), 'NZD')),
    v_evidence_id,
    trim(v_payload->>'source_name'),
    v_source_as_of,
    nullif(trim(coalesce(v_payload->>'source_notes', '')), ''),
    v_replaced.id,
    v_action.id,
    v_action.approved_by,
    v_action.approved_by
  )
  RETURNING * INTO v_record;

  IF v_replaced.id IS NOT NULL THEN
    UPDATE public.organization_compliance_records
    SET status = 'superseded', updated_by = v_action.approved_by, updated_at = clock_timestamp()
    WHERE id = v_replaced.id;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_org_id,
    v_action.approved_by,
    'bob_compliance_record_proposal_applied',
    'organization_compliance_records',
    v_record.id,
    jsonb_build_object(
      'action_id', v_action.id,
      'record_type', v_record.record_type,
      'replaces_record_id', v_replaced.id,
      'evidence_document_id', v_evidence_id,
      'source_attachment_id', v_attachment_id
    )
  );

  RETURN v_record.id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_bob_compliance_record_proposal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_bob_compliance_record_proposal(uuid) TO service_role;
