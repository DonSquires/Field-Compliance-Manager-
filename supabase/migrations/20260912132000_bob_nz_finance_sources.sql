CREATE TABLE IF NOT EXISTS public.bob_nz_finance_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  title text NOT NULL,
  authority text NOT NULL,
  source_url text NOT NULL,
  topic text NOT NULL CHECK (topic IN ('gst','employers','provisional_tax','record_keeping','accounting_standards','payroll')),
  jurisdiction text NOT NULL DEFAULT 'New Zealand',
  status text NOT NULL DEFAULT 'verify_before_relying' CHECK (status IN ('active','verify_before_relying','retired')),
  last_verified_on date,
  review_due_on date,
  guidance_scope text NOT NULL,
  limitations text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bob_nz_finance_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY bob_nz_finance_sources_select ON public.bob_nz_finance_sources FOR SELECT TO authenticated USING (true);
REVOKE ALL ON TABLE public.bob_nz_finance_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.bob_nz_finance_sources TO authenticated;
GRANT ALL ON TABLE public.bob_nz_finance_sources TO service_role;

INSERT INTO public.bob_nz_finance_sources(source_key, title, authority, source_url, topic, status, last_verified_on, review_due_on, guidance_scope, limitations)
VALUES
  ('ird-gst-overview', 'Goods and services tax (GST)', 'Inland Revenue New Zealand', 'https://www.ird.govt.nz/gst', 'gst', 'verify_before_relying', NULL, NULL, 'GST registration, charging, returns, payments, and general obligations.', 'Not a substitute for checking the current IRD position for the organisation or transaction.'),
  ('ird-gst-records', 'GST record keeping', 'Inland Revenue New Zealand', 'https://www.ird.govt.nz/gst/record-keeping', 'record_keeping', 'verify_before_relying', NULL, NULL, 'Records and evidence needed to support GST positions.', 'Do not infer deductibility or tax treatment from a management cost record alone.'),
  ('ird-employers', 'Employing staff', 'Inland Revenue New Zealand', 'https://www.ird.govt.nz/employing-staff', 'employers', 'verify_before_relying', NULL, NULL, 'Employer registration, PAYE, payday filing, and employer responsibilities.', 'Employment agreements, collective obligations, and payroll calculations may require specialist review.'),
  ('ird-provisional-tax', 'Provisional tax', 'Inland Revenue New Zealand', 'https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/provisional-tax', 'provisional_tax', 'verify_before_relying', NULL, NULL, 'General provisional-tax concepts and payment planning.', 'Bob must not calculate a binding liability or payment instruction without current source verification.'),
  ('xrb-nz-accounting-standards', 'New Zealand Accounting Standards framework', 'External Reporting Board New Zealand', 'https://www.xrb.govt.nz/standards/accounting-standards/', 'accounting_standards', 'verify_before_relying', NULL, NULL, 'Authoritative standards framework and reporting-standard navigation.', 'Standards application depends on entity type, reporting obligations, and professional judgement.'),
  ('ird-payroll', 'PAYE and payroll information', 'Inland Revenue New Zealand', 'https://www.ird.govt.nz/employing-staff/payday-filing', 'payroll', 'verify_before_relying', NULL, NULL, 'Payday filing and payroll reporting concepts.', 'The finance system must not replace payroll-provider calculations or employment advice.')
ON CONFLICT (source_key) DO UPDATE SET title = EXCLUDED.title, authority = EXCLUDED.authority, source_url = EXCLUDED.source_url, topic = EXCLUDED.topic, status = EXCLUDED.status, last_verified_on = EXCLUDED.last_verified_on, review_due_on = EXCLUDED.review_due_on, guidance_scope = EXCLUDED.guidance_scope, limitations = EXCLUDED.limitations, updated_at = now();

CREATE OR REPLACE FUNCTION public.get_bob_nz_finance_sources(p_topic text DEFAULT NULL)
RETURNS TABLE(source_key text, title text, authority text, source_url text, topic text, status text, last_verified_on date, review_due_on date, guidance_scope text, limitations text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT source_key, title, authority, source_url, topic, status, last_verified_on, review_due_on, guidance_scope, limitations
  FROM public.bob_nz_finance_sources
  WHERE p_topic IS NULL OR topic = p_topic
  ORDER BY topic, title;
$$;

REVOKE ALL ON FUNCTION public.get_bob_nz_finance_sources(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bob_nz_finance_sources(text) TO authenticated, service_role;
