-- Re-apply the governed noise submission RPC so it resolves the current,
-- effective-dated noise matrix row added in 20260913131000.
CREATE OR REPLACE FUNCTION public.submit_officer_noise_assessment(
  p_client_request_id uuid,
  p_assessed_at timestamptz,
  p_noise_source text,
  p_noise_source_address text,
  p_action_taken text DEFAULT 'no_action',
  p_volume_score smallint DEFAULT 0,
  p_time_score smallint DEFAULT 1,
  p_tone_score smallint DEFAULT 0,
  p_complaint_address text DEFAULT NULL,
  p_complainant_site_id uuid DEFAULT NULL,
  p_notice_number text DEFAULT NULL,
  p_end_number text DEFAULT NULL,
  p_occupant_name text DEFAULT NULL,
  p_occupant_dob date DEFAULT NULL,
  p_is_large_event_or_commercial boolean DEFAULT false,
  p_police_requested boolean DEFAULT false,
  p_police_present boolean DEFAULT false,
  p_scene_description text DEFAULT NULL,
  p_incident_report_text text DEFAULT NULL,
  p_follow_up_required boolean DEFAULT false,
  p_shift_id uuid DEFAULT NULL,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL
) RETURNS TABLE (id uuid, created boolean, received_at timestamptz, review_status text, matrix_total smallint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_existing public.noise_assessments%rowtype;
  v_assessment public.noise_assessments%rowtype;
  v_matrix_total smallint;
  v_threshold smallint := 5;
  v_excessive boolean;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT p.organization_id INTO v_org_id FROM public.user_profiles p
  WHERE p.id = v_user_id AND p.deactivated_at IS NULL
    AND p.role IN ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Active officer profile required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_assessed_at IS NULL OR p_assessed_at > now() + interval '5 minutes' OR p_assessed_at < now() - interval '24 hours' THEN RAISE EXCEPTION 'assessed_at is outside the accepted capture window'; END IF;
  IF nullif(trim(coalesce(p_noise_source_address, '')), '') IS NULL THEN RAISE EXCEPTION 'Noise source address is required'; END IF;
  IF nullif(trim(coalesce(p_noise_source, '')), '') IS NULL THEN RAISE EXCEPTION 'Noise source type is required'; END IF;
  IF p_volume_score NOT BETWEEN 0 AND 4 THEN RAISE EXCEPTION 'Volume score must be between 0 and 4'; END IF;
  IF p_time_score NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'Time score must be between 1 and 4'; END IF;
  IF p_tone_score NOT BETWEEN 0 AND 2 THEN RAISE EXCEPTION 'Tone score must be between 0 and 2'; END IF;

  v_matrix_total := coalesce(p_volume_score, 0) + coalesce(p_time_score, 1) + coalesce(p_tone_score, 0);
  SELECT n.excessive_threshold INTO v_threshold
  FROM public.noise_module_config n
  WHERE n.organization_id = v_org_id AND n.is_current
    AND n.effective_from <= current_date
    AND (n.effective_to IS NULL OR n.effective_to >= current_date)
  ORDER BY n.effective_from DESC, n.version DESC
  LIMIT 1;
  IF v_threshold IS NULL THEN v_threshold := 5; END IF;
  v_excessive := (v_matrix_total >= v_threshold);

  IF p_action_taken IN ('abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized')
    AND nullif(trim(coalesce(p_notice_number, coalesce(p_end_number, ''))), '') IS NULL THEN
    RAISE EXCEPTION 'Notice or END number is required for statutory noise enforcement actions';
  END IF;
  IF p_shift_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = p_shift_id AND s.organization_id = v_org_id) THEN RAISE EXCEPTION 'Shift does not belong to the officer organisation'; END IF;
  IF p_dispatch_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.dispatch_jobs d WHERE d.id = p_dispatch_job_id AND d.organization_id = v_org_id) THEN RAISE EXCEPTION 'Dispatch job does not belong to the officer organisation'; END IF;

  SELECT n.* INTO v_existing FROM public.noise_assessments n
  WHERE n.organization_id = v_org_id AND n.officer_user_id = v_user_id AND n.client_request_id = p_client_request_id;
  IF FOUND THEN RETURN QUERY SELECT v_existing.id, false, v_existing.created_at, v_existing.review_status, v_existing.matrix_total; RETURN; END IF;

  INSERT INTO public.noise_assessments (
    organization_id, officer_user_id, officer_id, client_request_id, assessed_at,
    noise_source, noise_source_address, assessment_location, action_taken, action,
    volume_score, time_score, tone_score, matrix_total, complaint_address,
    complainant_site_id, notice_number, end_number, occupant_name, occupant_dob,
    is_large_event_or_commercial, police_requested, police_present, scene_description,
    incident_report_text, follow_up_required, shift_id, dispatch_job_id, status,
    review_status, assessment_gps_lat, assessment_gps_lng
  ) VALUES (
    v_org_id, v_user_id, v_user_id, p_client_request_id, p_assessed_at,
    trim(p_noise_source), trim(p_noise_source_address), trim(p_noise_source_address),
    p_action_taken, p_action_taken, p_volume_score, p_time_score, p_tone_score,
    v_matrix_total, nullif(trim(coalesce(p_complaint_address, '')), ''),
    p_complainant_site_id, nullif(trim(coalesce(p_notice_number, '')), ''),
    nullif(trim(coalesce(p_end_number, '')), ''), nullif(trim(coalesce(p_occupant_name, '')), ''),
    p_occupant_dob, coalesce(p_is_large_event_or_commercial, false),
    coalesce(p_police_requested, false), coalesce(p_police_present, false),
    nullif(trim(coalesce(p_scene_description, '')), ''),
    nullif(trim(coalesce(p_incident_report_text, '')), ''),
    coalesce(p_follow_up_required, false), p_shift_id, p_dispatch_job_id, 'open', 'open',
    p_gps_lat, p_gps_lng
  ) RETURNING * INTO v_assessment;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_user_id, 'noise_assessment_submitted', 'noise_assessments', v_assessment.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'noise_source', v_assessment.noise_source,
      'matrix_total', v_matrix_total, 'excessive', v_excessive, 'action_taken', v_assessment.action_taken,
      'notice_number', v_assessment.notice_number));

  RETURN QUERY SELECT v_assessment.id, true, v_assessment.created_at, v_assessment.review_status, v_assessment.matrix_total;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_officer_noise_assessment FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_officer_noise_assessment TO authenticated, service_role;
