-- One receipt represents one bank movement. Serialize receipt matching across
-- both import paths and keep same-request retries idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS finance_statement_lines_one_payment_match
  ON public.finance_bank_statement_lines(matched_payment_receipt_id)
  WHERE matched_payment_receipt_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS finance_external_transactions_one_payment_match
  ON public.finance_external_bank_transactions(matched_payment_receipt_id)
  WHERE matched_payment_receipt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.match_finance_bank_statement_line(
  p_statement_line_id uuid,
  p_payment_receipt_id uuid
)
RETURNS public.finance_bank_statement_lines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_line public.finance_bank_statement_lines%rowtype;
  v_payment public.payment_receipts%rowtype;
BEGIN
  SELECT organization_id INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN
    RAISE EXCEPTION 'Active finance administrator required';
  END IF;
  IF p_statement_line_id IS NULL OR p_payment_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Statement line and payment receipt are required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payment-match:' || p_payment_receipt_id::text, 0));

  SELECT * INTO v_line
  FROM public.finance_bank_statement_lines
  WHERE id = p_statement_line_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found in organization';
  END IF;

  SELECT * INTO v_payment
  FROM public.payment_receipts
  WHERE id = p_payment_receipt_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment receipt not found in organization';
  END IF;

  IF v_line.matched_payment_receipt_id = p_payment_receipt_id
    AND v_line.reconciliation_status = 'matched'
    AND v_payment.reconciliation_status = 'matched'
  THEN
    RETURN v_line;
  END IF;

  IF v_line.reconciliation_status NOT IN ('unmatched', 'review')
    OR v_line.matched_payment_receipt_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'Statement line is no longer available for matching';
  END IF;
  IF v_payment.reconciliation_status NOT IN ('pending', 'unmatched') THEN
    RAISE EXCEPTION 'Payment receipt is no longer available for matching';
  END IF;
  IF abs(abs(v_line.amount) - v_payment.payment_amount) > 0.01 THEN
    RAISE EXCEPTION 'Statement amount does not match payment receipt';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.finance_bank_statement_lines
    WHERE matched_payment_receipt_id = p_payment_receipt_id
      AND id <> p_statement_line_id
  ) OR EXISTS (
    SELECT 1 FROM public.finance_external_bank_transactions
    WHERE matched_payment_receipt_id = p_payment_receipt_id
  ) THEN
    RAISE EXCEPTION 'Payment receipt is already matched to another bank movement';
  END IF;

  UPDATE public.finance_bank_statement_lines
  SET matched_payment_receipt_id = p_payment_receipt_id,
      reconciliation_status = 'matched'
  WHERE id = p_statement_line_id
  RETURNING * INTO v_line;

  UPDATE public.payment_receipts
  SET reconciliation_status = 'matched',
      bank_statement_reference = v_line.reference,
      reconciled_by = v_actor,
      reconciled_at = clock_timestamp()
  WHERE id = p_payment_receipt_id;

  INSERT INTO public.audit_log(
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_org, v_actor, 'finance_bank_statement_line_matched',
    'finance_bank_statement_lines', v_line.id,
    jsonb_build_object('payment_receipt_id', p_payment_receipt_id)
  );

  RETURN v_line;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_finance_external_bank_transaction(
  p_transaction_id uuid,
  p_payment_receipt_id uuid
)
RETURNS public.finance_external_bank_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_transaction public.finance_external_bank_transactions%rowtype;
  v_receipt public.payment_receipts%rowtype;
BEGIN
  SELECT organization_id INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN
    RAISE EXCEPTION 'Active finance administrator required';
  END IF;
  IF p_transaction_id IS NULL OR p_payment_receipt_id IS NULL THEN
    RAISE EXCEPTION 'External transaction and payment receipt are required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('finance-payment-match:' || p_payment_receipt_id::text, 0));

  SELECT * INTO v_transaction
  FROM public.finance_external_bank_transactions
  WHERE id = p_transaction_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'External bank transaction not found in organization';
  END IF;

  SELECT * INTO v_receipt
  FROM public.payment_receipts
  WHERE id = p_payment_receipt_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment receipt not found in organization';
  END IF;

  IF v_transaction.matched_payment_receipt_id = p_payment_receipt_id
    AND v_transaction.reconciliation_status = 'matched'
    AND v_receipt.reconciliation_status = 'matched'
  THEN
    RETURN v_transaction;
  END IF;

  IF v_transaction.reconciliation_status NOT IN ('unmatched', 'review')
    OR v_transaction.matched_payment_receipt_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'External bank transaction is no longer available for matching';
  END IF;
  IF v_receipt.reconciliation_status NOT IN ('pending', 'unmatched') THEN
    RAISE EXCEPTION 'Payment receipt is no longer available for matching';
  END IF;
  IF v_transaction.direction <> 'credit'
    OR abs(COALESCE(v_transaction.amount, 0) - v_receipt.payment_amount) > 0.01
  THEN
    RAISE EXCEPTION 'Transaction amount does not match payment receipt';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.finance_external_bank_transactions
    WHERE matched_payment_receipt_id = p_payment_receipt_id
      AND id <> p_transaction_id
  ) OR EXISTS (
    SELECT 1 FROM public.finance_bank_statement_lines
    WHERE matched_payment_receipt_id = p_payment_receipt_id
  ) THEN
    RAISE EXCEPTION 'Payment receipt is already matched to another bank movement';
  END IF;

  UPDATE public.finance_external_bank_transactions
  SET matched_payment_receipt_id = p_payment_receipt_id,
      reconciliation_status = 'matched'
  WHERE id = p_transaction_id
  RETURNING * INTO v_transaction;

  UPDATE public.payment_receipts
  SET reconciliation_status = 'matched',
      bank_statement_reference = v_transaction.external_transaction_id,
      reconciled_by = v_actor,
      reconciled_at = clock_timestamp()
  WHERE id = p_payment_receipt_id;

  INSERT INTO public.audit_log(
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_org, v_actor, 'finance_external_transaction_matched',
    'finance_external_bank_transactions', v_transaction.id,
    jsonb_build_object(
      'payment_receipt_id', p_payment_receipt_id,
      'amount', v_transaction.amount
    )
  );

  RETURN v_transaction;
END;
$function$;

REVOKE ALL ON FUNCTION public.match_finance_bank_statement_line(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_finance_bank_statement_line(uuid, uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.match_finance_external_bank_transaction(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_finance_external_bank_transaction(uuid, uuid)
  TO authenticated, service_role;