CREATE TABLE IF NOT EXISTS public.finance_akahu_apply_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  akahu_application_id text NOT NULL CHECK (akahu_application_id ~ '^application_[a-z0-9]{24,27}$'),
  reference text NOT NULL CHECK (length(trim(reference)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, reference),
  UNIQUE (akahu_application_id)
);

ALTER TABLE public.finance_akahu_apply_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_akahu_apply_applications_select ON public.finance_akahu_apply_applications
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_akahu_apply_applications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_akahu_apply_applications TO authenticated;
GRANT ALL ON TABLE public.finance_akahu_apply_applications TO service_role;
