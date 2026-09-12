CREATE TABLE IF NOT EXISTS public.finance_akahu_personal_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  app_reference text NOT NULL,
  account_count integer NOT NULL DEFAULT 0,
  connected_account_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('verified','failed')),
  error_category text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_akahu_personal_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_akahu_personal_checks_select ON public.finance_akahu_personal_checks FOR SELECT TO authenticated USING (public.is_grand_master() AND public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_akahu_personal_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_akahu_personal_checks TO authenticated;
GRANT ALL ON TABLE public.finance_akahu_personal_checks TO service_role;

CREATE OR REPLACE FUNCTION public.record_akahu_personal_check(p_actor_user_id uuid, p_app_reference text, p_account_count integer, p_account_summary jsonb, p_status text, p_error_category text DEFAULT NULL)
RETURNS public.finance_akahu_personal_checks
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_actor uuid := p_actor_user_id; v_org uuid; v_check public.finance_akahu_personal_checks%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Personal Akahu adapter execution only'; END IF;
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND role = 'grand_master' AND deactivated_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Grandmaster test access required'; END IF;
  INSERT INTO public.finance_akahu_personal_checks(organization_id, requested_by, app_reference, account_count, connected_account_summary, status, error_category)
  VALUES (v_org, v_actor, p_app_reference, COALESCE(p_account_count, 0), COALESCE(p_account_summary, '[]'::jsonb), p_status, p_error_category)
  RETURNING * INTO v_check;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'akahu_personal_test_checked', 'finance_akahu_personal_checks', v_check.id, jsonb_build_object('account_count', v_check.account_count, 'status', v_check.status, 'personal_test_only', true, 'transactions_imported', false));
  RETURN v_check;
END;
$$;

REVOKE ALL ON FUNCTION public.record_akahu_personal_check(uuid,text,integer,jsonb,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_akahu_personal_check(uuid,text,integer,jsonb,text,text) TO service_role;
