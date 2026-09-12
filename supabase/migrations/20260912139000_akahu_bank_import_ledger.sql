CREATE TABLE IF NOT EXISTS public.finance_external_bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connection_request_id uuid NOT NULL REFERENCES public.finance_external_connection_requests(id) ON DELETE CASCADE,
  bank_account_id uuid REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  external_transaction_id text NOT NULL,
  transaction_date date,
  description text,
  amount numeric(14,2),
  currency_code text,
  direction text CHECK (direction IN ('credit','debit','unknown')),
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_at timestamptz NOT NULL DEFAULT now(),
  matched_payment_receipt_id uuid REFERENCES public.payment_receipts(id) ON DELETE SET NULL,
  reconciliation_status text NOT NULL DEFAULT 'unmatched' CHECK (reconciliation_status IN ('unmatched','matched','review','excluded')),
  UNIQUE (connection_request_id, external_transaction_id)
);

ALTER TABLE public.finance_external_bank_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_external_bank_transactions_select ON public.finance_external_bank_transactions FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_external_bank_transactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_external_bank_transactions TO authenticated;
GRANT ALL ON TABLE public.finance_external_bank_transactions TO service_role;

CREATE OR REPLACE FUNCTION public.record_akahu_import(
  p_request_id uuid,
  p_provider_reference text,
  p_accounts jsonb DEFAULT '[]'::jsonb,
  p_transactions jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_request public.finance_external_connection_requests%rowtype; v_item jsonb; v_transactions integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Provider adapter execution only'; END IF;
  SELECT * INTO v_request FROM public.finance_external_connection_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.provider_name <> 'ANZ' THEN RAISE EXCEPTION 'ANZ connection request not found'; END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_transactions, '[]'::jsonb)) LOOP
    INSERT INTO public.finance_external_bank_transactions(organization_id, connection_request_id, bank_account_id, external_transaction_id, transaction_date, description, amount, currency_code, direction, raw_summary)
    VALUES (v_request.organization_id, p_request_id, v_request.bank_account_id, COALESCE(v_item->>'id', v_item->>'transaction_id'), NULLIF(v_item->>'date', '')::date, NULLIF(v_item->>'description', ''), NULLIF(v_item->>'amount', '')::numeric, COALESCE(v_item->>'currency', 'NZD'), CASE WHEN (v_item->>'amount')::numeric >= 0 THEN 'credit' ELSE 'debit' END, v_item)
    ON CONFLICT (connection_request_id, external_transaction_id) DO UPDATE SET transaction_date = EXCLUDED.transaction_date, description = EXCLUDED.description, amount = EXCLUDED.amount, currency_code = EXCLUDED.currency_code, raw_summary = EXCLUDED.raw_summary;
    v_transactions := v_transactions + 1;
  END LOOP;
  UPDATE public.finance_external_connection_requests SET status = 'connected', provider_connection_reference = p_provider_reference, connected_at = now(), last_sync_at = now(), last_error = NULL, updated_at = now() WHERE id = p_request_id;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) VALUES (v_request.organization_id, NULL, 'anz_transactions_imported', 'finance_external_bank_transactions', p_request_id, jsonb_build_object('transaction_count', v_transactions, 'credentials_stored', false));
  RETURN jsonb_build_object('transaction_count', v_transactions, 'account_count', jsonb_array_length(COALESCE(p_accounts, '[]'::jsonb)));
END;
$$;

REVOKE ALL ON FUNCTION public.record_akahu_import(uuid,text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_akahu_import(uuid,text,jsonb,jsonb) TO service_role;
