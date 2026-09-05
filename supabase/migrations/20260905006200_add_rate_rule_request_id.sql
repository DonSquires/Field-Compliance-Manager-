ALTER TABLE public.rate_rules ADD COLUMN IF NOT EXISTS client_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_rules_client_request
  ON public.rate_rules(organization_id,client_request_id)
  WHERE client_request_id IS NOT NULL;