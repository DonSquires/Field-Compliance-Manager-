CREATE TABLE IF NOT EXISTS public.finance_akahu_apply_sharing_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES public.finance_akahu_apply_applications(id) ON DELETE CASCADE,
  akahu_sharing_request_id text NOT NULL CHECK (akahu_sharing_request_id ~ '^sharing_request_[a-z0-9]{24,27}$'),
  link text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_submitted_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (akahu_sharing_request_id)
);

ALTER TABLE public.finance_akahu_apply_sharing_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_akahu_apply_sharing_requests_select ON public.finance_akahu_apply_sharing_requests
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_akahu_apply_sharing_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_akahu_apply_sharing_requests TO authenticated;
GRANT ALL ON TABLE public.finance_akahu_apply_sharing_requests TO service_role;
