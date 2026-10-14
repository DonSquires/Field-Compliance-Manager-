ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS client_request_id uuid,
  ADD COLUMN IF NOT EXISTS line_source text NOT NULL DEFAULT 'generated';

ALTER TABLE public.invoice_line_items
  ADD CONSTRAINT invoice_line_items_line_source_check
  CHECK (line_source IN ('generated', 'manual'));

CREATE UNIQUE INDEX IF NOT EXISTS invoice_line_items_manual_request_unique
  ON public.invoice_line_items(invoice_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.add_crm_invoice_line(
  p_client_request_id uuid,
  p_invoice_id uuid,
  p_description text,
  p_quantity numeric,
  p_unit_price numeric
)
RETURNS TABLE(
  line_id uuid,
  invoice_id uuid,
  subtotal numeric,
  gst_amount numeric,
  total_amount numeric,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%rowtype;
  v_line public.invoice_line_items%rowtype;
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_next_seq integer;
  v_line_total numeric(12,2);
  v_prior_line_id uuid;
BEGIN
  IF p_client_request_id IS NULL OR p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id and invoice are required';
  END IF;

  SELECT i.* INTO v_invoice
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;
  IF NOT public.is_admin_for_org(v_invoice.organization_id) THEN
    RAISE EXCEPTION 'Not authorised to manage invoices for this organization';
  END IF;
  IF v_invoice.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft invoices can be updated';
  END IF;

  SELECT l.* INTO v_line
  FROM public.invoice_line_items l
  WHERE l.invoice_id = v_invoice.id
    AND l.client_request_id = p_client_request_id;

  IF FOUND THEN
    RETURN QUERY
    SELECT v_line.id, v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, false;
    RETURN;
  END IF;

  SELECT a.target_id INTO v_prior_line_id
  FROM public.audit_log a
  WHERE a.organization_id = v_invoice.organization_id
    AND a.action = 'crm_invoice_line_added'
    AND a.metadata->>'invoice_id' = v_invoice.id::text
    AND a.metadata->>'client_request_id' = p_client_request_id::text
  ORDER BY a.created_at DESC
  LIMIT 1;

  IF v_prior_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'This line-add request was already applied and the original line is no longer present';
  END IF;
  IF v_description IS NULL OR length(v_description) > 500 THEN
    RAISE EXCEPTION 'Line description must contain 1 to 500 characters';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 100000
    OR p_unit_price IS NULL OR p_unit_price < 0 OR p_unit_price > 1000000
    OR p_quantity * p_unit_price > 9999999999.99
  THEN
    RAISE EXCEPTION 'Invoice line quantity or price is outside the accepted range';
  END IF;

  v_line_total := round(p_quantity * p_unit_price, 2);
  SELECT coalesce(max(l.line_number), 0) + 1 INTO v_next_seq
  FROM public.invoice_line_items l
  WHERE l.invoice_id = v_invoice.id;

  INSERT INTO public.invoice_line_items(
    invoice_id, line_number, description, quantity, unit_price, line_total,
    organization_id, item_type, unit_of_measure, tax_rate_pct, tax_amount,
    total_line_amount, created_by, client_request_id, line_source
  ) VALUES (
    v_invoice.id, v_next_seq, v_description, p_quantity, p_unit_price, v_line_total,
    v_invoice.organization_id, 'other', 'unit', 15,
    round(v_line_total * 0.15, 2), round(v_line_total * 1.15, 2),
    v_actor, p_client_request_id, 'manual'
  )
  RETURNING * INTO v_line;

  UPDATE public.invoices i
  SET subtotal = totals.subtotal,
      gst_amount = round(totals.subtotal * 0.15, 2),
      total_amount = round(totals.subtotal * 1.15, 2),
      updated_at = now()
  FROM (
    SELECT coalesce(sum(l.line_total), 0)::numeric(12,2) AS subtotal
    FROM public.invoice_line_items l
    WHERE l.invoice_id = v_invoice.id
  ) totals
  WHERE i.id = v_invoice.id
  RETURNING i.* INTO v_invoice;

  INSERT INTO public.audit_log(
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_invoice.organization_id, v_actor, 'crm_invoice_line_added',
    'invoice_line_items', v_line.id,
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'description', v_description,
      'quantity', p_quantity,
      'unit_price', p_unit_price,
      'line_total', v_line.line_total,
      'client_request_id', p_client_request_id
    )
  );

  RETURN QUERY
  SELECT v_line.id, v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_crm_invoice_line(
  p_client_request_id uuid,
  p_invoice_id uuid,
  p_line_id uuid
)
RETURNS TABLE(
  invoice_id uuid,
  subtotal numeric,
  gst_amount numeric,
  total_amount numeric,
  removed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%rowtype;
  v_line public.invoice_line_items%rowtype;
  v_prior_removal boolean;
BEGIN
  IF p_client_request_id IS NULL OR p_invoice_id IS NULL OR p_line_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id, invoice, and line are required';
  END IF;

  SELECT i.* INTO v_invoice
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;
  IF NOT public.is_admin_for_org(v_invoice.organization_id) THEN
    RAISE EXCEPTION 'Not authorised to manage invoices for this organization';
  END IF;
  IF v_invoice.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft invoices can be modified';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.audit_log a
    WHERE a.organization_id = v_invoice.organization_id
      AND a.action = 'crm_invoice_line_removed'
      AND a.metadata->>'invoice_id' = v_invoice.id::text
      AND a.metadata->>'line_id' = p_line_id::text
      AND a.metadata->>'client_request_id' = p_client_request_id::text
  ) INTO v_prior_removal;

  IF v_prior_removal THEN
    RETURN QUERY
    SELECT v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, true;
    RETURN;
  END IF;

  SELECT l.* INTO v_line
  FROM public.invoice_line_items l
  WHERE l.id = p_line_id AND l.invoice_id = v_invoice.id;

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, false;
    RETURN;
  END IF;
  IF v_line.line_source <> 'manual' OR v_line.client_request_id IS NULL THEN
    RAISE EXCEPTION 'Evidence-backed invoice lines cannot be removed; correct the source work or void the draft';
  END IF;

  DELETE FROM public.invoice_line_items
  WHERE id = v_line.id;

  UPDATE public.invoices i
  SET subtotal = totals.subtotal,
      gst_amount = round(totals.subtotal * 0.15, 2),
      total_amount = round(totals.subtotal * 1.15, 2),
      updated_at = now()
  FROM (
    SELECT coalesce(sum(l.line_total), 0)::numeric(12,2) AS subtotal
    FROM public.invoice_line_items l
    WHERE l.invoice_id = v_invoice.id
  ) totals
  WHERE i.id = v_invoice.id
  RETURNING i.* INTO v_invoice;

  INSERT INTO public.audit_log(
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_invoice.organization_id, v_actor, 'crm_invoice_line_removed',
    'invoice_line_items', v_line.id,
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'line_id', v_line.id,
      'description', v_line.description,
      'line_total', v_line.line_total,
      'original_client_request_id', v_line.client_request_id,
      'client_request_id', p_client_request_id
    )
  );

  RETURN QUERY
  SELECT v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, true;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_crm_invoice_line(uuid, uuid, text, numeric, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_crm_invoice_line(uuid, uuid, text, numeric, numeric)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.remove_crm_invoice_line(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_crm_invoice_line(uuid, uuid, uuid)
  TO authenticated, service_role;