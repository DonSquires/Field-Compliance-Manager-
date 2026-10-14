CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_crm_quote_line_update_request
  ON public.audit_log (
    organization_id,
    target_id,
    ((metadata->>'client_request_id'))
  )
  WHERE action = 'crm_quote_line_updated'
    AND target_table = 'quote_lines'
    AND metadata->>'client_request_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION public.update_crm_quote_line(
  p_client_request_id uuid,
  p_quote_id uuid,
  p_line_id uuid,
  p_expected_status text,
  p_description text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_unit_charge numeric
)
RETURNS TABLE(
  line_id uuid,
  quote_id uuid,
  total_cost numeric,
  subtotal_charge numeric,
  discount_amount numeric,
  gst_amount numeric,
  total_charge numeric,
  updated boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_quote public.quotes%rowtype;
  v_line public.quote_lines%rowtype;
  v_description text := nullif(trim(coalesce(p_description, '')), '');
BEGIN
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;

  SELECT q.*
  INTO v_quote
  FROM public.quotes q
  WHERE q.id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;

  IF NOT public.is_admin_for_org(v_quote.provider_org_id) THEN
    RAISE EXCEPTION 'Not authorised to price this quote';
  END IF;

  IF v_quote.status <> p_expected_status THEN
    RAISE EXCEPTION 'Quote changed from expected status % to %', p_expected_status, v_quote.status;
  END IF;

  IF v_quote.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft quotes can be modified';
  END IF;

  IF v_description IS NULL THEN
    RAISE EXCEPTION 'Line description is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 100000
     OR p_unit_cost IS NULL OR p_unit_cost < 0 OR p_unit_cost > 1000000
     OR p_unit_charge IS NULL OR p_unit_charge < 0 OR p_unit_charge > 1000000 THEN
    RAISE EXCEPTION 'Quote line amounts are outside the accepted range';
  END IF;

  SELECT l.*
  INTO v_line
  FROM public.quote_lines l
  WHERE l.id = p_line_id
    AND l.quote_id = v_quote.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote line not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.audit_log a
    WHERE a.organization_id = v_quote.provider_org_id
      AND a.action = 'crm_quote_line_updated'
      AND a.target_table = 'quote_lines'
      AND a.target_id = v_line.id
      AND a.metadata->>'client_request_id' = p_client_request_id::text
  ) THEN
    RETURN QUERY
    SELECT
      v_line.id,
      v_quote.id,
      v_quote.total_cost,
      v_quote.subtotal_charge,
      v_quote.discount_amount,
      v_quote.gst_amount,
      v_quote.total_charge,
      false;
    RETURN;
  END IF;

  UPDATE public.quote_lines
  SET
    description = v_description,
    quantity = p_quantity,
    unit_cost = p_unit_cost,
    unit_charge = p_unit_charge
  WHERE id = v_line.id;

  UPDATE public.quotes q
  SET
    total_cost = totals.total_cost,
    subtotal_charge = totals.subtotal_charge,
    discount_amount = round(totals.subtotal_charge * q.discount_pct / 100, 2),
    gst_amount = round((totals.subtotal_charge - round(totals.subtotal_charge * q.discount_pct / 100, 2)) * q.gst_rate, 2),
    total_charge = round((totals.subtotal_charge - round(totals.subtotal_charge * q.discount_pct / 100, 2)) * (1 + q.gst_rate), 2),
    updated_by = v_actor,
    updated_at = now()
  FROM (
    SELECT
      coalesce(sum(l.quantity * l.unit_cost), 0)::numeric(12,2) AS total_cost,
      coalesce(sum(l.quantity * l.unit_charge), 0)::numeric(12,2) AS subtotal_charge
    FROM public.quote_lines l
    WHERE l.quote_id = v_quote.id
  ) totals
  WHERE q.id = v_quote.id
  RETURNING q.* INTO v_quote;

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
    'crm_quote_line_updated',
    'quote_lines',
    v_line.id,
    jsonb_build_object(
      'quote_id', v_quote.id,
      'previous_description', v_line.description,
      'description', v_description,
      'previous_quantity', v_line.quantity,
      'quantity', p_quantity,
      'previous_unit_cost', v_line.unit_cost,
      'unit_cost', p_unit_cost,
      'previous_unit_charge', v_line.unit_charge,
      'unit_charge', p_unit_charge,
      'total_cost', v_quote.total_cost,
      'total_charge', v_quote.total_charge,
      'client_request_id', p_client_request_id
    )
  );

  RETURN QUERY
  SELECT
    v_line.id,
    v_quote.id,
    v_quote.total_cost,
    v_quote.subtotal_charge,
    v_quote.discount_amount,
    v_quote.gst_amount,
    v_quote.total_charge,
    true;
END;
$$;

REVOKE ALL ON FUNCTION public.update_crm_quote_line(uuid, uuid, uuid, text, text, numeric, numeric, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_crm_quote_line(uuid, uuid, uuid, text, text, numeric, numeric, numeric)
  TO authenticated, service_role;