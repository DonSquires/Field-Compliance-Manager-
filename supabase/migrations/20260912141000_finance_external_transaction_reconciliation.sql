CREATE OR REPLACE FUNCTION public.match_finance_external_bank_transaction(
  p_transaction_id uuid,
  p_payment_receipt_id uuid
)
RETURNS public.finance_external_bank_transactions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_org uuid; v_transaction public.finance_external_bank_transactions%rowtype; v_receipt public.payment_receipts%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_transaction FROM public.finance_external_bank_transactions WHERE id = p_transaction_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'External bank transaction not found in organization'; END IF;
  SELECT * INTO v_receipt FROM public.payment_receipts WHERE id = p_payment_receipt_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment receipt not found in organization'; END IF;
  IF abs(COALESCE(v_transaction.amount, 0) - v_receipt.payment_amount) > 0.01 THEN RAISE EXCEPTION 'Transaction amount does not match payment receipt'; END IF;
  UPDATE public.finance_external_bank_transactions SET matched_payment_receipt_id = p_payment_receipt_id, reconciliation_status = 'matched' WHERE id = p_transaction_id RETURNING * INTO v_transaction;
  UPDATE public.payment_receipts SET reconciliation_status = 'matched', bank_statement_reference = v_transaction.external_transaction_id, reconciled_by = v_actor, reconciled_at = now() WHERE id = p_payment_receipt_id;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) VALUES (v_org, v_actor, 'finance_external_transaction_matched', 'finance_external_bank_transactions', v_transaction.id, jsonb_build_object('payment_receipt_id', p_payment_receipt_id, 'amount', v_transaction.amount));
  RETURN v_transaction;
END;
$$;

REVOKE ALL ON FUNCTION public.match_finance_external_bank_transaction(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_finance_external_bank_transaction(uuid,uuid) TO authenticated, service_role;
