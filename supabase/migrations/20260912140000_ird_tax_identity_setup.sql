CREATE TABLE IF NOT EXISTS public.finance_tax_identity (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  ird_number text NOT NULL,
  gst_registered boolean NOT NULL DEFAULT false,
  gst_basis text CHECK (gst_basis IN ('payments','invoice','hybrid','not_registered')),
  gst_filing_frequency text CHECK (gst_filing_frequency IN ('monthly','two_monthly','six_monthly','not_registered')),
  tax_agent_name text,
  tax_agent_contact text,
  setup_status text NOT NULL DEFAULT 'owner_review' CHECK (setup_status IN ('owner_review','accountant_review','ready_for_provider','active')),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_tax_identity ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_tax_identity_select ON public.finance_tax_identity FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id));
REVOKE ALL ON TABLE public.finance_tax_identity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_tax_identity TO authenticated;
GRANT ALL ON TABLE public.finance_tax_identity TO service_role;

CREATE OR REPLACE FUNCTION public.save_finance_tax_identity(
  p_ird_number text,
  p_gst_registered boolean,
  p_gst_basis text,
  p_gst_filing_frequency text,
  p_tax_agent_name text DEFAULT NULL,
  p_tax_agent_contact text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_org uuid; v_ird text; v_status text;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  v_ird := regexp_replace(COALESCE(p_ird_number, ''), '[^0-9]', '', 'g');
  IF length(v_ird) NOT BETWEEN 8 AND 9 THEN RAISE EXCEPTION 'Enter the organisation IRD number as 8 or 9 digits'; END IF;
  IF p_gst_registered AND p_gst_basis NOT IN ('payments','invoice','hybrid') THEN RAISE EXCEPTION 'Choose the GST accounting basis'; END IF;
  IF p_gst_registered AND p_gst_filing_frequency NOT IN ('monthly','two_monthly','six_monthly') THEN RAISE EXCEPTION 'Choose the GST filing frequency'; END IF;
  v_status := CASE WHEN nullif(trim(COALESCE(p_tax_agent_name, '')), '') IS NULL THEN 'owner_review' ELSE 'accountant_review' END;
  INSERT INTO public.finance_tax_identity(organization_id, ird_number, gst_registered, gst_basis, gst_filing_frequency, tax_agent_name, tax_agent_contact, setup_status, created_by, updated_by)
  VALUES (v_org, v_ird, p_gst_registered, CASE WHEN p_gst_registered THEN p_gst_basis ELSE 'not_registered' END, CASE WHEN p_gst_registered THEN p_gst_filing_frequency ELSE 'not_registered' END, nullif(trim(p_tax_agent_name), ''), nullif(trim(p_tax_agent_contact), ''), v_status, v_actor, v_actor)
  ON CONFLICT (organization_id) DO UPDATE SET ird_number = EXCLUDED.ird_number, gst_registered = EXCLUDED.gst_registered, gst_basis = EXCLUDED.gst_basis, gst_filing_frequency = EXCLUDED.gst_filing_frequency, tax_agent_name = EXCLUDED.tax_agent_name, tax_agent_contact = EXCLUDED.tax_agent_contact, setup_status = EXCLUDED.setup_status, updated_by = v_actor, updated_at = now();
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) VALUES (v_org, v_actor, 'finance_tax_identity_saved', 'finance_tax_identity', v_org, jsonb_build_object('ird_last_four', right(v_ird, 4), 'gst_registered', p_gst_registered, 'setup_status', v_status));
  RETURN jsonb_build_object('ird_last_four', right(v_ird, 4), 'gst_registered', p_gst_registered, 'gst_basis', CASE WHEN p_gst_registered THEN p_gst_basis ELSE 'not_registered' END, 'gst_filing_frequency', CASE WHEN p_gst_registered THEN p_gst_filing_frequency ELSE 'not_registered' END, 'setup_status', v_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_finance_tax_identity_summary()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object('configured', true, 'ird_last_four', right(t.ird_number, 4), 'gst_registered', t.gst_registered, 'gst_basis', t.gst_basis, 'gst_filing_frequency', t.gst_filing_frequency, 'tax_agent_name', t.tax_agent_name, 'setup_status', t.setup_status)
  FROM public.finance_tax_identity t
  WHERE public.is_admin_for_org(t.organization_id)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.save_finance_tax_identity(text,boolean,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_finance_tax_identity(text,boolean,text,text,text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_finance_tax_identity_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_finance_tax_identity_summary() TO authenticated, service_role;
