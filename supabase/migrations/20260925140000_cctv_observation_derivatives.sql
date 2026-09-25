-- Recognition derivatives are separate, private artifacts linked to an authoritative source observation.
-- They may assist review, never replace source evidence or auto-confirm identity/plate/species.

CREATE TABLE IF NOT EXISTS public.cctv_observation_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES public.cctv_entity_observations(id) ON DELETE CASCADE,
  inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id) ON DELETE CASCADE,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  source_event_id text NOT NULL,
  entity_kind text NOT NULL CHECK (entity_kind IN ('person','vehicle','animal')),
  original_bucket text NOT NULL,
  original_path text NOT NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  enhanced_bucket text NOT NULL,
  enhanced_path text NOT NULL,
  enhanced_sha256 text NOT NULL CHECK (enhanced_sha256 ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('laptop_gpu','runpod_fallback','worker_deterministic')),
  enhancement_profile text NOT NULL,
  generative boolean NOT NULL DEFAULT false,
  source_frame_hash text,
  source_frames jsonb NOT NULL DEFAULT '[]'::jsonb,
  fusion_receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  enhancement_receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  recognition_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  recognition_comparison jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (observation_id, enhancement_profile)
);

COMMENT ON TABLE public.cctv_observation_derivatives IS 'Private original/enhanced still pairs and receipts for human CCTV review. Source evidence remains authoritative; generative output is always interpretive.';
CREATE INDEX IF NOT EXISTS cctv_observation_derivatives_org_idx ON public.cctv_observation_derivatives (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cctv_observation_derivatives_evidence_idx ON public.cctv_observation_derivatives (evidence_item_id, source_event_id);

ALTER TABLE public.cctv_observation_derivatives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_observation_derivatives_select ON public.cctv_observation_derivatives;
CREATE POLICY cctv_observation_derivatives_select ON public.cctv_observation_derivatives
FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.cctv_observation_derivatives FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cctv_observation_derivatives TO authenticated;
GRANT ALL ON TABLE public.cctv_observation_derivatives TO service_role;

CREATE OR REPLACE FUNCTION public.record_cctv_observation_derivatives(p_job_id uuid, p_derivatives jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_job public.inference_jobs%rowtype;
  v_observation public.cctv_entity_observations%rowtype;
  v_item jsonb;
  v_id uuid;
  v_profile text;
  v_prefix text;
  v_count integer := 0;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF jsonb_typeof(p_derivatives) <> 'array' THEN RAISE EXCEPTION 'CCTV derivatives must be an array'; END IF;
  SELECT * INTO v_job FROM public.inference_jobs WHERE id = p_job_id AND domain = 'video_motion';
  IF NOT FOUND THEN RAISE EXCEPTION 'CCTV inference job is missing'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_derivatives)
  LOOP
    SELECT * INTO v_observation
    FROM public.cctv_entity_observations
    WHERE inference_job_id = p_job_id AND source_event_id = v_item->>'source_event_id'
      AND entity_kind = v_item->>'entity_kind' AND review_state <> 'superseded'
    ORDER BY created_at LIMIT 1;
    IF NOT FOUND THEN CONTINUE; END IF;
    v_profile := nullif(v_item#>>'{enhancement,profile}', '');
    v_prefix := 'org/' || v_job.organization_id::text || '/cctv-derivatives/' || v_job.evidence_item_id::text || '/';
    IF v_profile IS NULL OR NOT (coalesce(v_item->>'original_path','') LIKE v_prefix || '%') OR NOT (coalesce(v_item->>'enhanced_path','') LIKE v_prefix || '%') THEN
      RAISE EXCEPTION 'Derivative storage path or enhancement profile is invalid';
    END IF;
    IF coalesce(v_item->>'original_sha256','') !~ '^[0-9a-f]{64}$' OR coalesce(v_item->>'enhanced_sha256','') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Derivative hashes must be lowercase SHA-256';
    END IF;
    IF v_item->>'provider' NOT IN ('laptop_gpu','runpod_fallback','worker_deterministic') THEN
      RAISE EXCEPTION 'Unknown derivative provider';
    END IF;

    INSERT INTO public.cctv_observation_derivatives (
      organization_id, observation_id, inference_job_id, evidence_item_id, source_event_id, entity_kind,
      original_bucket, original_path, original_sha256, enhanced_bucket, enhanced_path, enhanced_sha256,
      provider, enhancement_profile, generative, source_frame_hash, source_frames,
      fusion_receipt, enhancement_receipt, recognition_results, recognition_comparison, review_required
    ) VALUES (
      v_job.organization_id, v_observation.id, p_job_id, v_job.evidence_item_id, v_item->>'source_event_id', v_item->>'entity_kind',
      v_item->>'original_bucket', v_item->>'original_path', v_item->>'original_sha256', v_item->>'enhanced_bucket', v_item->>'enhanced_path', v_item->>'enhanced_sha256',
      v_item->>'provider', v_profile, coalesce((v_item#>>'{enhancement,generative}')::boolean, false), nullif(v_item->>'source_frame_hash',''),
      CASE WHEN jsonb_typeof(v_item->'source_frames')='array' THEN v_item->'source_frames' ELSE '[]'::jsonb END,
      coalesce(v_item->'fusion','{}'::jsonb), coalesce(v_item->'enhancement','{}'::jsonb), coalesce(v_item->'recognition','{}'::jsonb), coalesce(v_item->'recognition_comparison','{}'::jsonb), true
    )
    ON CONFLICT (observation_id, enhancement_profile) DO UPDATE SET
      original_bucket=excluded.original_bucket, original_path=excluded.original_path, original_sha256=excluded.original_sha256,
      enhanced_bucket=excluded.enhanced_bucket, enhanced_path=excluded.enhanced_path, enhanced_sha256=excluded.enhanced_sha256,
      provider=excluded.provider, generative=excluded.generative, source_frame_hash=excluded.source_frame_hash, source_frames=excluded.source_frames,
      fusion_receipt=excluded.fusion_receipt, enhancement_receipt=excluded.enhancement_receipt,
      recognition_results=excluded.recognition_results, recognition_comparison=excluded.recognition_comparison, updated_at=clock_timestamp()
    RETURNING id INTO v_id;

    UPDATE public.cctv_entity_observations
    SET attributes = attributes || jsonb_build_object('capture_recognition', jsonb_build_object(
      'derivative_id', v_id, 'provider', v_item->>'provider',
      'original_storage_bucket', v_item->>'original_bucket', 'original_storage_path', v_item->>'original_path', 'original_sha256', v_item->>'original_sha256',
      'enhanced_storage_bucket', v_item->>'enhanced_bucket', 'enhanced_storage_path', v_item->>'enhanced_path', 'enhanced_sha256', v_item->>'enhanced_sha256',
      'enhancement', coalesce(v_item->'enhancement','{}'::jsonb), 'fusion', coalesce(v_item->'fusion','{}'::jsonb),
      'recognition_comparison', coalesce(v_item->'recognition_comparison','{}'::jsonb), 'authority', 'provisional', 'review_required', true
    ))
    WHERE id = v_observation.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.record_cctv_observation_derivatives(uuid,jsonb) IS 'Service-only writer for private source/enhanced CCTV still pairs. Validates evidence-scoped paths, hashes, provider and provisional authority.';
REVOKE ALL ON FUNCTION public.record_cctv_observation_derivatives(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_observation_derivatives(uuid,jsonb) TO service_role;
