-- CCTV inference claim gate for the release lane (review of PR #298, 2026-11-01).
--
-- The release lane replaces the VPS vision watcher and inference service. Reading the queue for an idle
-- moment cannot stop a watcher (VPS or laptop) claiming a job a moment later, so Compose could interrupt
-- newly started work and leave its lease waiting for stale recovery. The lane now pauses claims here,
-- drains processing jobs, replaces and health-checks the services (rolling back if needed), then resumes.
--
-- Every watcher version calls claim_cctv_inference_job, so the gate needs no watcher change: a paused
-- claim returns no row and the watcher polls again. Claims hold a shared advisory lock and a pause takes
-- it exclusively, so a claim already in flight commits before the pause does and is visible to the lane's
-- drain read, and every later claim sees the pause. paused_until bounds a pause whose holder died.
-- The replaced claim guard now fails closed when the request role is missing (auth.role() IS NULL used to
-- make the old `auth.role() <> 'service_role'` test NULL, which IF treats as false).

CREATE TABLE IF NOT EXISTS public.cctv_inference_claim_pauses (
  holder text PRIMARY KEY CHECK (holder ~ '^[a-z0-9][a-z0-9:._-]{0,79}$'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  paused_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.cctv_inference_claim_pauses IS
  'Release-time pauses of CCTV inference job claims. Written only by pause_/resume_cctv_inference_claims (service role); a row blocks claim_cctv_inference_job until paused_until.';

ALTER TABLE public.cctv_inference_claim_pauses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cctv_inference_claim_pauses FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pause_cctv_inference_claims(p_holder text, p_reason text, p_seconds integer)
 RETURNS timestamptz
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_until timestamptz;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_holder IS NULL OR p_holder !~ '^[a-z0-9][a-z0-9:._-]{0,79}$' THEN
    RAISE EXCEPTION 'A valid pause holder is required';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'A pause reason of at most 300 characters is required';
  END IF;
  IF p_seconds IS NULL OR p_seconds NOT BETWEEN 60 AND 7200 THEN
    RAISE EXCEPTION 'Pause duration must be between 60 and 7200 seconds';
  END IF;

  -- Waits for claims already in flight to commit; claims that start afterwards see this pause.
  PERFORM pg_advisory_xact_lock(hashtextextended('public.cctv_inference_claim_gate', 0));

  INSERT INTO public.cctv_inference_claim_pauses AS p (holder, reason, paused_until)
  VALUES (p_holder, btrim(p_reason), clock_timestamp() + make_interval(secs => p_seconds))
  ON CONFLICT (holder) DO UPDATE
     SET reason = EXCLUDED.reason, paused_until = EXCLUDED.paused_until, created_at = clock_timestamp()
  RETURNING p.paused_until INTO v_until;
  RETURN v_until;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resume_cctv_inference_claims(p_holder text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  DELETE FROM public.cctv_inference_claim_pauses WHERE holder = p_holder;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_cctv_inference_job(p_job_id uuid, p_lease_token uuid, p_lease_seconds integer DEFAULT 900)
 RETURNS TABLE(id uuid, organization_id uuid, evidence_item_id uuid, domain text, status text, lease_token uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_seconds NOT BETWEEN 60 AND 7200 THEN
    RAISE EXCEPTION 'Valid job, lease, and lease duration are required';
  END IF;

  -- Released at commit, so a pause waits for this claim; the pause check below then reads a fresh snapshot.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('public.cctv_inference_claim_gate', 0));
  IF EXISTS (SELECT 1 FROM public.cctv_inference_claim_pauses p WHERE p.paused_until > clock_timestamp()) THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.inference_jobs j
     SET status = 'processing', stage = 'claimed', attempt_count = j.attempt_count + 1,
         lease_token = p_lease_token, lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         heartbeat_at = clock_timestamp(), error_message = NULL
   WHERE j.id = p_job_id AND j.domain = 'video_motion' AND j.status = 'queued'
   RETURNING j.id, j.organization_id, j.evidence_item_id, j.domain, j.status, j.lease_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.pause_cctv_inference_claims(text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resume_cctv_inference_claims(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_cctv_inference_job(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pause_cctv_inference_claims(text, text, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.resume_cctv_inference_claims(text) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.claim_cctv_inference_job(uuid, uuid, integer) TO postgres, service_role;
