DROP FUNCTION IF EXISTS public.manage_crm_quote_commercial_source(uuid, uuid, uuid);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_crm_quote_commercial_source_request
  ON public.audit_log (
    organization_id,
    target_id,
    ((metadata->>'client_request_id'))
  )
  WHERE action = 'crm_quote_commercial_source_set'
    AND target_table = 'quotes'
    AND metadata->>'client_request_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION public.manage_crm_quote_commercial_source(
  p_client_request_id uuid,
  p_quote_id uuid,
  p_expected_status text,
  p_tender_id uuid DEFAULT NULL,
  p_discount_schedule_id uuid DEFAULT NULL
)
RETURNS public.quotes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_quote public.quotes%rowtype;
  v_previous_tender_id uuid;
  v_previous_discount_schedule_id uuid;
BEGIN
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;

  SELECT *
  INTO v_quote
  FROM public.quotes
  WHERE id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND OR NOT public.is_admin_for_org(v_quote.provider_org_id) THEN
    RAISE EXCEPTION 'Quote not found in your organization';
  END IF;

  IF v_quote.status <> p_expected_status THEN
    RAISE EXCEPTION 'Quote changed from expected status % to %', p_expected_status, v_quote.status;
  END IF;

  IF v_quote.status <> 'draft' THEN
    RAISE EXCEPTION 'Commercial sources can only be changed on a draft quote';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.audit_log a
    WHERE a.organization_id = v_quote.provider_org_id
      AND a.action = 'crm_quote_commercial_source_set'
      AND a.target_table = 'quotes'
      AND a.target_id = v_quote.id
      AND a.metadata->>'client_request_id' = p_client_request_id::text
  ) THEN
    RETURN v_quote;
  END IF;

  IF p_tender_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.tenders tender
    WHERE tender.id = p_tender_id
      AND tender.organization_id = v_quote.provider_org_id
      AND tender.client_organization_id = v_quote.client_org_id
      AND tender.status IN ('in_review', 'submitted', 'awarded')
  ) THEN
    RAISE EXCEPTION 'Tender is not an eligible provider commercial source for this quote';
  END IF;

  IF p_discount_schedule_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.commercial_discount_schedules schedule
    WHERE schedule.id = p_discount_schedule_id
      AND schedule.provider_organization_id = v_quote.provider_org_id
      AND schedule.status = 'active'
      AND schedule.effective_from <= current_date
      AND (schedule.effective_to IS NULL OR schedule.effective_to >= current_date)
  ) THEN
    RAISE EXCEPTION 'Active provider discount schedule required';
  END IF;

  IF v_quote.tender_id IS NOT DISTINCT FROM p_tender_id
     AND v_quote.discount_schedule_id IS NOT DISTINCT FROM p_discount_schedule_id THEN
    RETURN v_quote;
  END IF;

  v_previous_tender_id := v_quote.tender_id;
  v_previous_discount_schedule_id := v_quote.discount_schedule_id;

  UPDATE public.quotes
  SET
    tender_id = p_tender_id,
    discount_schedule_id = p_discount_schedule_id,
    updated_by = v_actor,
    updated_at = now()
  WHERE id = v_quote.id
  RETURNING * INTO v_quote;

  INSERT INTO public.audit_log(
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_quote.provider_org_id,
    v_actor,
    'crm_quote_commercial_source_set',
    'quotes',
    v_quote.id,
    jsonb_build_object(
      'previous_tender_id', v_previous_tender_id,
      'tender_id', p_tender_id,
      'previous_discount_schedule_id', v_previous_discount_schedule_id,
      'discount_schedule_id', p_discount_schedule_id,
      'client_request_id', p_client_request_id
    )
  );

  RETURN v_quote;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_crm_quote_commercial_source(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_crm_quote_commercial_source(uuid, uuid, text, uuid, uuid)
  TO authenticated, service_role;