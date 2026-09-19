-- CCTV inference cost controls: meter every job's GPU use, give each organisation a daily frame budget,
-- and let the worker defer (never fail) work once the budget is spent.
--
-- Before this migration the only limits were per-worker environment caps (frames per job, batch size,
-- RunPod back-off). Nothing recorded how much inference an organisation consumed, nothing bounded it per
-- tenant, and a runaway import could spend the shared GPU budget with no trace in the platform.
--
-- What this adds:
--   * cctv_inference_budgets — one row per organisation: daily_frame_budget (frames sent to the GPU per UTC
--     day). Absent row = platform default (20,000 frames/day). Written only through set_cctv_inference_budget
--     (organisation administrator, audited). Readable by the organisation.
--   * record_cctv_inference_usage (service) — one audit_log row per completed analysis with counts only
--     (frames sampled / recognised / sent, GPU calls, GPU milliseconds), attributed to the job's organisation.
--   * cctv_inference_budget_check (service) — budget, frames used today, remaining, exhausted.
--   * defer_cctv_inference_job (service) — puts a claimed job back to queued with a not-before time and a
--     plain-words progress label, so a spent budget pauses work instead of failing it. The worker's poll
--     skips queued jobs whose not-before (lease_expires_at while queued) is still in the future.
--   * cctv_inference_usage (authenticated, org-scoped) — per-day usage for the last N days, the budget, and
--     how many jobs are currently deferred.

CREATE TABLE IF NOT EXISTS public.cctv_inference_budgets (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  daily_frame_budget integer NOT NULL CHECK (daily_frame_budget BETWEEN 100 AND 10000000),
  reason text,
  set_by uuid,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.cctv_inference_budgets IS 'Per-organisation daily cap on frames sent to GPU inference by the CCTV worker. No row = platform default. Written via set_cctv_inference_budget only.';
ALTER TABLE public.cctv_inference_budgets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_inference_budgets_select ON public.cctv_inference_budgets;
CREATE POLICY cctv_inference_budgets_select ON public.cctv_inference_budgets FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.cctv_inference_budgets FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.cctv_inference_budgets TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cctv_inference_budgets TO service_role;

CREATE OR REPLACE FUNCTION public.cctv_inference_default_daily_frames() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 20000 $$;

CREATE OR REPLACE FUNCTION public.set_cctv_inference_budget(p_organization_id uuid, p_daily_frame_budget integer, p_reason text DEFAULT NULL)
RETURNS public.cctv_inference_budgets LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.cctv_inference_budgets%rowtype; v_previous integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Only an administrator of the organisation can set its inference budget'; END IF;
  IF p_daily_frame_budget IS NULL OR p_daily_frame_budget < 100 THEN RAISE EXCEPTION 'A daily frame budget must be at least 100 frames'; END IF;
  SELECT daily_frame_budget INTO v_previous FROM public.cctv_inference_budgets WHERE organization_id = p_organization_id;
  INSERT INTO public.cctv_inference_budgets (organization_id, daily_frame_budget, reason, set_by, set_at)
  VALUES (p_organization_id, p_daily_frame_budget, nullif(trim(coalesce(p_reason, '')), ''), v_actor, clock_timestamp())
  ON CONFLICT (organization_id) DO UPDATE SET daily_frame_budget = EXCLUDED.daily_frame_budget, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
  RETURNING * INTO v_row;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'cctv_inference_budget_set', 'cctv_inference_budgets', p_organization_id,
          jsonb_strip_nulls(jsonb_build_object('daily_frame_budget', p_daily_frame_budget, 'previous', v_previous, 'reason', v_row.reason)));
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION public.set_cctv_inference_budget(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_cctv_inference_budget(uuid, integer, text) TO authenticated, service_role;

-- Frames the organisation has sent to the GPU since 00:00 UTC today.
CREATE OR REPLACE FUNCTION public.cctv_inference_frames_used_today(p_organization_id uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(sum((a.metadata->>'frames_sent')::bigint), 0)
    FROM public.audit_log a
   WHERE a.organization_id = p_organization_id AND a.action = 'cctv_inference_usage_recorded'
     AND a.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
$$;
REVOKE ALL ON FUNCTION public.cctv_inference_frames_used_today(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_cctv_inference_usage(p_job_id uuid, p_usage jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.inference_jobs%rowtype; v_counts jsonb; v_used bigint;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF p_usage IS NULL OR jsonb_typeof(p_usage) <> 'object' THEN RAISE EXCEPTION 'Usage must be a JSON object'; END IF;
  SELECT * INTO v_job FROM public.inference_jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Job not found'; END IF;
  -- Counts only. Nothing about who or what was seen belongs in a metering row.
  v_counts := jsonb_build_object(
    'frames_sampled', greatest(0, coalesce((p_usage->>'frames_sampled')::int, 0)),
    'frames_recognised', greatest(0, coalesce((p_usage->>'frames_recognised')::int, 0)),
    'frames_sent', greatest(0, coalesce((p_usage->>'frames_sent')::int, 0)),
    'gpu_calls', greatest(0, coalesce((p_usage->>'gpu_calls')::int, 0)),
    'gpu_ms', greatest(0, coalesce((p_usage->>'gpu_ms')::bigint, 0)),
    'evidence_item_id', v_job.evidence_item_id);
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_job.organization_id, NULL, 'cctv_inference_usage_recorded', 'inference_jobs', v_job.id, v_counts);
  v_used := public.cctv_inference_frames_used_today(v_job.organization_id);
  RETURN jsonb_build_object('organization_id', v_job.organization_id, 'frames_used_today', v_used);
END $$;
REVOKE ALL ON FUNCTION public.record_cctv_inference_usage(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_inference_usage(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.cctv_inference_budget_check(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_budget integer; v_used bigint;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT daily_frame_budget INTO v_budget FROM public.cctv_inference_budgets WHERE organization_id = p_organization_id;
  v_budget := coalesce(v_budget, public.cctv_inference_default_daily_frames());
  v_used := public.cctv_inference_frames_used_today(p_organization_id);
  RETURN jsonb_build_object('organization_id', p_organization_id, 'daily_frame_budget', v_budget, 'frames_used_today', v_used,
                            'remaining', greatest(0, v_budget - v_used), 'exhausted', v_used >= v_budget,
                            'resets_at', (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC');
END $$;
REVOKE ALL ON FUNCTION public.cctv_inference_budget_check(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cctv_inference_budget_check(uuid) TO service_role;

-- Back to the queue with a not-before time. While a job is queued, lease_expires_at doubles as "not before";
-- claim_cctv_inference_job overwrites it on the next claim and recover_stale only touches processing jobs.
CREATE OR REPLACE FUNCTION public.defer_cctv_inference_job(p_job_id uuid, p_lease_token uuid, p_reason text, p_not_before_seconds integer DEFAULT 900)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF p_not_before_seconds NOT BETWEEN 60 AND 86400 THEN RAISE EXCEPTION 'Deferral must be between one minute and one day'; END IF;
  UPDATE public.inference_jobs j
     SET status = 'queued', stage = 'deferred', lease_token = NULL, heartbeat_at = NULL,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_not_before_seconds),
         attempt_count = greatest(0, j.attempt_count - 1),
         progress_label = left(coalesce(nullif(trim(p_reason), ''), 'Deferred'), 200)
   WHERE j.id = p_job_id AND j.status = 'processing' AND j.lease_token = p_lease_token
   RETURNING j.organization_id INTO v_org;
  IF v_org IS NULL THEN RETURN false; END IF;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, NULL, 'cctv_inference_job_deferred', 'inference_jobs', p_job_id, jsonb_build_object('reason', p_reason, 'not_before_seconds', p_not_before_seconds));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.defer_cctv_inference_job(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.defer_cctv_inference_job(uuid, uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.cctv_inference_usage(p_organization_id uuid, p_days integer DEFAULT 14)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_budget public.cctv_inference_budgets%rowtype; v_days jsonb; v_deferred integer; v_used bigint;
BEGIN
  IF auth.uid() IS NULL AND auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.org_access_allowed(p_organization_id) THEN RAISE EXCEPTION 'CCTV usage access denied'; END IF;
  SELECT * INTO v_budget FROM public.cctv_inference_budgets WHERE organization_id = p_organization_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('day', day, 'jobs', jobs, 'frames_sent', frames_sent, 'gpu_calls', gpu_calls, 'gpu_ms', gpu_ms) ORDER BY day), '[]'::jsonb) INTO v_days
  FROM (
    SELECT (a.created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS jobs,
           sum((a.metadata->>'frames_sent')::bigint) AS frames_sent, sum((a.metadata->>'gpu_calls')::bigint) AS gpu_calls, sum((a.metadata->>'gpu_ms')::bigint) AS gpu_ms
      FROM public.audit_log a
     WHERE a.organization_id = p_organization_id AND a.action = 'cctv_inference_usage_recorded'
       AND a.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => greatest(0, coalesce(p_days, 14) - 1))) AT TIME ZONE 'UTC'
     GROUP BY 1
  ) d;
  SELECT count(*) INTO v_deferred FROM public.inference_jobs j
   WHERE j.organization_id = p_organization_id AND j.domain = 'video_motion' AND j.status = 'queued' AND j.stage = 'deferred' AND j.lease_expires_at > clock_timestamp();
  v_used := public.cctv_inference_frames_used_today(p_organization_id);
  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'daily_frame_budget', coalesce(v_budget.daily_frame_budget, public.cctv_inference_default_daily_frames()),
    'budget_is_default', v_budget.organization_id IS NULL,
    'budget_reason', v_budget.reason,
    'frames_used_today', v_used,
    'exhausted', v_used >= coalesce(v_budget.daily_frame_budget, public.cctv_inference_default_daily_frames()),
    'deferred_jobs', v_deferred,
    'days', v_days);
END $$;
REVOKE ALL ON FUNCTION public.cctv_inference_usage(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cctv_inference_usage(uuid, integer) TO authenticated, service_role;
COMMENT ON FUNCTION public.cctv_inference_usage(uuid, integer) IS 'Org-scoped inference metering: per-day frames sent / GPU calls / GPU ms, the daily frame budget (default or set), today''s use, and jobs currently deferred for budget.';
