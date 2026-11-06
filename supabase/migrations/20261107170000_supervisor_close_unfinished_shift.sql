-- An officer who cannot sign out (app error, flat phone, no signal) leaves the
-- shift in progress forever: complete_officer_shift is officer-only and stamps
-- now(). A branch admin needs a governed way to close it at the time the work
-- actually ended, with a reason and an audit receipt.

ALTER TABLE public.shifts DROP CONSTRAINT IF EXISTS shifts_ended_reason_check;
ALTER TABLE public.shifts ADD CONSTRAINT shifts_ended_reason_check CHECK (
  ended_reason IS NULL OR ended_reason = ANY (ARRAY['officer', 'superseded_by_next_shift', 'not_started', 'supervisor_closed'])
);

COMMENT ON COLUMN public.shifts.ended_reason IS 'How the shift ended: officer (End shift), superseded_by_next_shift (stopped when the officer''s next shift started), not_started (missed), supervisor_closed (a branch admin closed an unfinished shift at the recorded end time via close_unfinished_officer_shift). Null = ended by another path.';

CREATE OR REPLACE FUNCTION public.close_unfinished_officer_shift(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_expected_status text,
  p_expected_updated_at timestamptz,
  p_actual_end timestamptz,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_existing public.audit_log%rowtype;
  v_now timestamptz := clock_timestamp();
  v_skipped_stops integer := 0;
  v_completed_stops integer := 0;
  v_closed_breaks integer := 0;
  v_previous jsonb;
  v_resulting jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'A client request ID is required';
  END IF;

  SELECT * INTO v_shift FROM public.shifts s WHERE s.id = p_shift_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Shift not found or access denied';
  END IF;

  SELECT * INTO v_existing
  FROM public.audit_log al
  WHERE al.organization_id = v_shift.organization_id
    AND al.action = 'shift_supervisor_close'
    AND al.target_table = 'shifts'
    AND al.metadata ->> 'client_request_id' = p_client_request_id::text
  ORDER BY al.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_existing.target_id IS DISTINCT FROM p_shift_id THEN
      RAISE EXCEPTION 'Client request ID was already used for a different shift';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'action', 'close', 'target_id', p_shift_id,
      'previous', v_existing.metadata -> 'previous', 'resulting', v_existing.metadata -> 'resulting');
  END IF;

  IF v_shift.status IS DISTINCT FROM p_expected_status
    OR v_shift.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Shift changed since it was opened';
  END IF;
  IF v_shift.status <> 'in_progress' OR v_shift.actual_start IS NULL THEN
    RAISE EXCEPTION 'Only a started, unfinished shift can be closed this way';
  END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;
  IF length(trim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'The reason is too long';
  END IF;
  IF p_actual_end IS NULL THEN
    RAISE EXCEPTION 'The time the shift ended is required';
  END IF;
  IF p_actual_end <= v_shift.actual_start THEN
    RAISE EXCEPTION 'The end time must be after the shift started';
  END IF;
  IF p_actual_end > v_now THEN
    RAISE EXCEPTION 'The end time cannot be in the future';
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_jobs j WHERE j.shift_id = v_shift.id AND j.status NOT IN ('completed', 'cancelled')) THEN
    RAISE EXCEPTION 'Complete or cancel this shift''s dispatch jobs before closing it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.welfare_alerts w WHERE w.shift_id = v_shift.id AND w.status <> 'resolved') THEN
    RAISE EXCEPTION 'Resolve this shift''s welfare alerts before closing it';
  END IF;

  v_previous := jsonb_build_object('status', v_shift.status, 'actual_start', v_shift.actual_start,
    'actual_end', v_shift.actual_end, 'ended_reason', v_shift.ended_reason, 'updated_at', v_shift.updated_at);

  UPDATE public.shift_breaks
  SET ended_at = greatest(started_at, p_actual_end)
  WHERE shift_id = v_shift.id AND ended_at IS NULL;
  GET DIAGNOSTICS v_closed_breaks = ROW_COUNT;

  -- A stop the officer reached is finished at the recorded end; one never reached is skipped.
  UPDATE public.shift_stops
  SET status = 'completed',
      actual_departed_at = coalesce(actual_departed_at, greatest(actual_arrived_at, p_actual_end)),
      sla_status = 'completed',
      updated_at = v_now
  WHERE shift_id = v_shift.id AND status = 'on_scene';
  GET DIAGNOSTICS v_completed_stops = ROW_COUNT;

  UPDATE public.shift_stops
  SET status = 'skipped', sla_status = 'skipped', updated_at = v_now
  WHERE shift_id = v_shift.id AND status IN ('pending', 'en_route');
  GET DIAGNOSTICS v_skipped_stops = ROW_COUNT;

  UPDATE public.shifts
  SET status = 'completed', actual_end = p_actual_end, ended_reason = 'supervisor_closed', updated_at = v_now
  WHERE id = v_shift.id
  RETURNING * INTO v_shift;

  UPDATE public.roster_slots SET status = 'completed'
  WHERE linked_shift_id = v_shift.id AND status IN ('published', 'accepted');

  v_resulting := jsonb_build_object('status', v_shift.status, 'actual_start', v_shift.actual_start,
    'actual_end', v_shift.actual_end, 'ended_reason', v_shift.ended_reason, 'updated_at', v_shift.updated_at,
    'stops_skipped', v_skipped_stops, 'stops_completed', v_completed_stops, 'breaks_closed', v_closed_breaks);

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_shift.organization_id, v_actor, 'shift_supervisor_close', 'shifts', v_shift.id, jsonb_build_object(
    'client_request_id', p_client_request_id,
    'reason', trim(p_reason),
    'officer_user_id', v_shift.officer_user_id,
    'previous', v_previous,
    'resulting', v_resulting));

  RETURN jsonb_build_object('replayed', false, 'action', 'close', 'target_id', v_shift.id,
    'previous', v_previous, 'resulting', v_resulting);
END;
$$;

COMMENT ON FUNCTION public.close_unfinished_officer_shift(uuid, uuid, text, timestamptz, timestamptz, text) IS 'Branch admin closes an in-progress shift the officer could not end, at the recorded end time (after start, not in the future). Reached stops complete, unreached stops are skipped, open breaks end; dispatch jobs and welfare alerts must already be closed. Replay-safe on client_request_id with a before/after audit receipt.';

REVOKE ALL ON FUNCTION public.close_unfinished_officer_shift(uuid, uuid, text, timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_unfinished_officer_shift(uuid, uuid, text, timestamptz, timestamptz, text) TO authenticated, service_role;

-- Owner-approved correction (2026-11-07): R&M's pending Nelson noise-control jobs
-- and their client sites were linked to First Security's expired draft proposal
-- (c7e29b21â€¦) instead of R&M's accepted Nelson City Council agreement
-- (58eed793â€¦, noise_control enabled). Re-link them so they can be assigned to R&M
-- officers and resolve finance against the right provider. Guarded so it is a
-- no-op anywhere these rows do not exist; completed history is left untouched.
DO $$
DECLARE
  v_draft constant uuid := 'c7e29b21-baff-484e-97f8-eb4438332b4e';
  v_rm_ncc constant uuid := '58eed793-3b77-4d9c-bfab-ee95e7d2fe3a';
  v_rm_org constant uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_sites uuid[];
  v_jobs uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.service_agreements WHERE id = v_rm_ncc AND provider_organization_id = v_rm_org) THEN
    RETURN;
  END IF;

  SELECT array_agg(j.id ORDER BY j.id), array_agg(DISTINCT j.client_site_id)
  INTO v_jobs, v_sites
  FROM public.dispatch_jobs j
  WHERE j.service_agreement_id = v_draft AND j.organization_id = v_rm_org AND j.status = 'pending';

  IF v_jobs IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.client_sites SET service_agreement_id = v_rm_ncc
  WHERE id = ANY (v_sites) AND service_agreement_id = v_draft;

  UPDATE public.dispatch_jobs SET service_agreement_id = v_rm_ncc
  WHERE id = ANY (v_jobs);

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  SELECT v_rm_org, NULL, 'dispatch_job_agreement_corrected', 'dispatch_jobs', job_id, jsonb_build_object(
    'from_service_agreement_id', v_draft, 'to_service_agreement_id', v_rm_ncc,
    'reason', 'Owner-approved correction: R&M noise-control job was linked to First Security''s expired draft proposal.',
    'migration', '20261107170000_supervisor_close_unfinished_shift')
  FROM unnest(v_jobs) AS job_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  SELECT v_rm_org, NULL, 'client_site_agreement_corrected', 'client_sites', site_id, jsonb_build_object(
    'from_service_agreement_id', v_draft, 'to_service_agreement_id', v_rm_ncc,
    'migration', '20261107170000_supervisor_close_unfinished_shift')
  FROM unnest(v_sites) AS site_id;
END;
$$;
