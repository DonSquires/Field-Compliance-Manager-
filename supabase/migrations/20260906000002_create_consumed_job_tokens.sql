CREATE TABLE IF NOT EXISTS public.consumed_job_tokens (
  jti uuid PRIMARY KEY,
  inference_job_id uuid NOT NULL
    REFERENCES public.inference_jobs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.consumed_job_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.consumed_job_tokens FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.consumed_job_tokens TO service_role;

CREATE OR REPLACE FUNCTION public.consume_workload_token(
  p_jti uuid,
  p_job_id uuid,
  p_org_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  IF p_jti IS NULL OR p_job_id IS NULL OR p_org_id IS NULL THEN
    RAISE EXCEPTION 'Token, job, and organization identifiers are required';
  END IF;

  INSERT INTO public.consumed_job_tokens (
    jti,
    inference_job_id,
    organization_id
  )
  VALUES (
    p_jti,
    p_job_id,
    p_org_id
  )
  ON CONFLICT (jti) DO NOTHING;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_workload_token(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_workload_token(uuid, uuid, uuid) TO service_role;