CREATE TABLE IF NOT EXISTS public.finance_akahu_apply_transaction_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES public.finance_akahu_apply_reports(id) ON DELETE CASCADE,
  external_transaction_id text NOT NULL,
  transaction_date date,
  description text,
  amount numeric(14,2),
  currency_code text NOT NULL DEFAULT 'NZD',
  direction text CHECK (direction IN ('credit', 'debit', 'unknown')),
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  review_reason text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, external_transaction_id)
);

ALTER TABLE public.finance_akahu_apply_transaction_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_akahu_apply_transaction_reviews_select ON public.finance_akahu_apply_transaction_reviews
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_akahu_apply_transaction_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_akahu_apply_transaction_reviews TO authenticated;
GRANT ALL ON TABLE public.finance_akahu_apply_transaction_reviews TO service_role;
