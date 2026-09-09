CREATE TABLE IF NOT EXISTS public.cctv_report_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id) ON DELETE RESTRICT,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE RESTRICT,
  batch_id text,
  generated_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  payload jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE public.cctv_report_receipts IS
  'Immutable, tenant-scoped CCTV report payloads issued after human review context is available.';

CREATE INDEX IF NOT EXISTS idx_cctv_report_receipts_scope
  ON public.cctv_report_receipts (organization_id, generated_at DESC);

ALTER TABLE public.cctv_report_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_report_receipts_select ON public.cctv_report_receipts;
CREATE POLICY cctv_report_receipts_select ON public.cctv_report_receipts
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.cctv_report_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cctv_report_receipts TO authenticated;
GRANT ALL ON TABLE public.cctv_report_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.issue_cctv_report_receipt(
  p_job_id uuid,
  p_evidence_id uuid,
  p_organization_id uuid,
  p_batch_id text,
  p_payload jsonb
)
RETURNS TABLE (
  report_id uuid,
  generated_at timestamptz,
  observation_count integer,
  sha256 text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  actor_id uuid := auth.uid();
  generated timestamp with time zone := clock_timestamp();
  receipt_id uuid := gen_random_uuid();
  payload_text text;
  payload_hash text;
  count_observations integer;
BEGIN
  IF actor_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'CCTV report access denied';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'CCTV report payload must be an object';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
    WHERE id = p_job_id
      AND evidence_item_id = p_evidence_id
      AND organization_id = p_organization_id
      AND domain IN ('video_motion', 'vehicle', 'face')
  ) THEN
    RAISE EXCEPTION 'CCTV job or evidence is missing or outside the organization';
  END IF;

  count_observations := jsonb_array_length(CASE
    WHEN jsonb_typeof(p_payload->'observations') = 'array' THEN p_payload->'observations'
    ELSE '[]'::jsonb
  END);
  payload_text := p_payload::text;
  payload_hash := encode(digest(convert_to(payload_text, 'UTF8'), 'sha256'), 'hex');

  INSERT INTO public.cctv_report_receipts (
    id, organization_id, inference_job_id, evidence_item_id, batch_id,
    generated_by, generated_at, observation_count, payload, sha256
  ) VALUES (
    receipt_id, p_organization_id, p_job_id, p_evidence_id, NULLIF(trim(p_batch_id), ''),
    actor_id, generated, count_observations, p_payload, payload_hash
  );

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    p_organization_id, actor_id, 'cctv_report_receipt_issued', 'cctv_report_receipts', receipt_id,
    jsonb_build_object('inference_job_id', p_job_id, 'evidence_item_id', p_evidence_id, 'batch_id', p_batch_id, 'observation_count', count_observations, 'sha256', payload_hash)
  );

  RETURN QUERY SELECT receipt_id, generated, count_observations, payload_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_cctv_report_receipt(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_cctv_report_receipt(uuid, uuid, uuid, text, jsonb) TO authenticated, service_role;
