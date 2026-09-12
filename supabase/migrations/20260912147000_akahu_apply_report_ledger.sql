CREATE TABLE IF NOT EXISTS public.finance_akahu_apply_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES public.finance_akahu_apply_applications(id) ON DELETE CASCADE,
  akahu_report_id text NOT NULL CHECK (akahu_report_id ~ '^report_[a-z0-9]{24,27}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  source_document_ids text[] NOT NULL DEFAULT '{}',
  failure_reason jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (application_id, akahu_report_id)
);

ALTER TABLE public.finance_akahu_apply_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_akahu_apply_reports_select ON public.finance_akahu_apply_reports
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_akahu_apply_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_akahu_apply_reports TO authenticated;
GRANT ALL ON TABLE public.finance_akahu_apply_reports TO service_role;
