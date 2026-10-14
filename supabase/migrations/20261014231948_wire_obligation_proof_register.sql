ALTER TABLE public.obligation_proof_artifacts
  ADD COLUMN client_request_id uuid,
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by uuid,
  ADD COLUMN withdrawal_reason text;

UPDATE public.obligation_proof_artifacts
SET client_request_id = gen_random_uuid()
WHERE client_request_id IS NULL;

ALTER TABLE public.obligation_proof_artifacts
  ALTER COLUMN client_request_id SET NOT NULL,
  ADD CONSTRAINT obligation_proof_artifacts_status_check
    CHECK (status IN ('active', 'withdrawn')),
  ADD CONSTRAINT obligation_proof_artifacts_withdrawn_by_fkey
    FOREIGN KEY (withdrawn_by) REFERENCES public.user_profiles(id);

CREATE UNIQUE INDEX idx_obligation_proof_artifacts_request
  ON public.obligation_proof_artifacts (organization_id, client_request_id);

CREATE UNIQUE INDEX idx_obligation_proof_artifacts_active_source
  ON public.obligation_proof_artifacts (obligation_id, source_table, source_record_id)
  WHERE status = 'active' AND source_table IS NOT NULL AND source_record_id IS NOT NULL;

COMMENT ON COLUMN public.obligation_proof_artifacts.client_request_id IS
  'Caller-generated replay key. Unique within the provider organization.';
COMMENT ON COLUMN public.obligation_proof_artifacts.status IS
  'Append-preserving review state. Withdrawn links remain available for chain-of-custody review.';
COMMENT ON COLUMN public.obligation_proof_artifacts.metadata IS
  'Source-time snapshot used to explain what was reviewed without treating the link as the source record.';

CREATE OR REPLACE FUNCTION public.get_crm_obligation_proof_register(
  p_obligation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_obligation public.agreement_obligations%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_readiness text;
  v_readiness_message text;
BEGIN
  SELECT ao.*
  INTO v_obligation
  FROM public.agreement_obligations ao
  WHERE ao.id = p_obligation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract requirement not found';
  END IF;

  SELECT sa.*
  INTO v_agreement
  FROM public.service_agreements sa
  WHERE sa.id = v_obligation.service_agreement_id;

  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;

  IF NOT v_obligation.requires_proof THEN
    v_readiness := 'not_required';
    v_readiness_message := 'This contract requirement does not require evidence.';
  ELSIF v_obligation.proof_artifact_type IS NULL THEN
    v_readiness := 'configuration_required';
    v_readiness_message := 'Choose a required evidence type before linking field evidence.';
  ELSIF v_obligation.proof_artifact_type = 'timestamp' THEN
    v_readiness := 'ready';
    v_readiness_message := 'Completed, contract-aligned stops can provide timestamp evidence.';
  ELSIF v_obligation.proof_artifact_type = 'gps_track' THEN
    v_readiness := 'ready';
    v_readiness_message := 'Only completed stops with at least two shift-linked GPS points can provide a GPS track.';
  ELSE
    v_readiness := 'source_workflow_unavailable';
    v_readiness_message := format(
      'The %s evidence workflow is not wired to this register yet.',
      replace(v_obligation.proof_artifact_type, '_', ' ')
    );
  END IF;

  RETURN jsonb_build_object(
    'obligation_id', v_obligation.id,
    'required_artifact_type', v_obligation.proof_artifact_type,
    'readiness', v_readiness,
    'readiness_message', v_readiness_message,
    'artifacts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', opa.id,
        'artifact_type', opa.artifact_type,
        'source_table', opa.source_table,
        'source_record_id', opa.source_record_id,
        'captured_at', opa.captured_at,
        'notes', opa.notes,
        'status', opa.status,
        'created_at', opa.created_at,
        'updated_at', opa.updated_at,
        'created_by_name', coalesce(created_profile.display_name, 'Unknown reviewer'),
        'withdrawn_at', opa.withdrawn_at,
        'withdrawn_by_name', withdrawn_profile.display_name,
        'withdrawal_reason', opa.withdrawal_reason,
        'metadata', opa.metadata
      ) ORDER BY opa.created_at DESC), '[]'::jsonb)
      FROM public.obligation_proof_artifacts opa
      LEFT JOIN public.user_profiles created_profile ON created_profile.id = opa.created_by
      LEFT JOIN public.user_profiles withdrawn_profile ON withdrawn_profile.id = opa.withdrawn_by
      WHERE opa.obligation_id = v_obligation.id
    ),
    'eligible_sources', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'source_table', 'shift_stops',
        'source_record_id', candidate.stop_id,
        'site_name', candidate.site_name,
        'officer_name', candidate.officer_name,
        'arrived_at', candidate.arrived_at,
        'departed_at', candidate.departed_at,
        'artifact_type', candidate.artifact_type,
        'gps_point_count', candidate.gps_point_count
      ) ORDER BY candidate.departed_at DESC), '[]'::jsonb)
      FROM (
        SELECT
          ss.id AS stop_id,
          coalesce(cs.name, 'Covered Site') AS site_name,
          coalesce(up.display_name, 'Assigned officer') AS officer_name,
          ss.actual_arrived_at AS arrived_at,
          ss.actual_departed_at AS departed_at,
          CASE
            WHEN v_obligation.proof_artifact_type = 'timestamp' THEN 'arrival_timestamp'
            WHEN v_obligation.proof_artifact_type = 'gps_track' THEN 'gps_track'
          END AS artifact_type,
          (
            SELECT count(*)::integer
            FROM public.officer_gps_log ogl
            WHERE ogl.shift_id = s.id
              AND ogl.officer_id = s.officer_user_id
              AND ogl.recorded_at BETWEEN ss.actual_arrived_at AND ss.actual_departed_at
          ) AS gps_point_count
        FROM public.shift_stops ss
        JOIN public.shifts s ON s.id = ss.shift_id
        JOIN public.service_agreement_locations sal
          ON sal.id = s.service_agreement_location_id
         AND sal.service_agreement_id = v_agreement.id
         AND sal.status = 'active'
        LEFT JOIN public.client_sites cs ON cs.id = ss.site_id
        LEFT JOIN public.user_profiles up ON up.id = s.officer_user_id
        WHERE ss.organization_id = v_agreement.provider_organization_id
          AND ss.status = 'completed'
          AND ss.actual_arrived_at IS NOT NULL
          AND ss.actual_departed_at IS NOT NULL
          AND (v_obligation.site_id IS NULL OR ss.site_id = v_obligation.site_id)
          AND (
            v_obligation.proof_artifact_type = 'timestamp'
            OR (
              v_obligation.proof_artifact_type = 'gps_track'
              AND (
                SELECT count(*)
                FROM public.officer_gps_log ogl
                WHERE ogl.shift_id = s.id
                  AND ogl.officer_id = s.officer_user_id
                  AND ogl.recorded_at BETWEEN ss.actual_arrived_at AND ss.actual_departed_at
              ) >= 2
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.obligation_proof_artifacts existing
            WHERE existing.obligation_id = v_obligation.id
              AND existing.source_table = 'shift_stops'
              AND existing.source_record_id = ss.id
              AND existing.status = 'active'
          )
        ORDER BY ss.actual_departed_at DESC
        LIMIT 20
      ) candidate
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.manage_crm_obligation_proof(
  p_action text,
  p_obligation_id uuid,
  p_client_request_id uuid,
  p_source_record_id uuid DEFAULT NULL,
  p_artifact_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_withdrawal_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_action text := lower(trim(coalesce(p_action, '')));
  v_obligation public.agreement_obligations%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_artifact public.obligation_proof_artifacts%rowtype;
  v_stop record;
  v_gps_point_count integer := 0;
  v_artifact_type text;
  v_receipt jsonb;
  v_replay jsonb;
BEGIN
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Client request identity is required';
  END IF;
  IF v_action NOT IN ('attach_shift_stop', 'withdraw') THEN
    RAISE EXCEPTION 'Unsupported proof action';
  END IF;

  SELECT ao.*
  INTO v_obligation
  FROM public.agreement_obligations ao
  WHERE ao.id = p_obligation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract requirement not found';
  END IF;

  SELECT sa.*
  INTO v_agreement
  FROM public.service_agreements sa
  WHERE sa.id = v_obligation.service_agreement_id;

  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;
  IF v_agreement.agreement_type <> 'operational' OR v_agreement.invitation_status <> 'accepted' THEN
    RAISE EXCEPTION 'An accepted operational agreement is required';
  END IF;

  SELECT al.metadata->'result'
  INTO v_replay
  FROM public.audit_log al
  WHERE al.organization_id = v_agreement.provider_organization_id
    AND al.action IN ('crm_obligation_proof_attached', 'crm_obligation_proof_withdrawn')
    AND al.target_table = 'obligation_proof_artifacts'
    AND al.metadata->>'client_request_id' = p_client_request_id::text
  ORDER BY al.created_at DESC
  LIMIT 1;

  IF v_replay IS NOT NULL THEN
    IF v_replay->>'action' <> v_action
       OR v_replay->>'obligation_id' <> p_obligation_id::text
       OR coalesce(v_replay->>'source_record_id', '') <> coalesce(p_source_record_id::text, '')
       OR coalesce(v_replay->>'artifact_id', '') <> coalesce(p_artifact_id::text, '') THEN
      RAISE EXCEPTION 'Client request identity was already used for a different proof action';
    END IF;
    RETURN v_replay || jsonb_build_object('replayed', true);
  END IF;

  IF v_action = 'attach_shift_stop' THEN
    IF NOT v_obligation.active THEN
      RAISE EXCEPTION 'Inactive contract requirements cannot receive evidence';
    END IF;
    IF NOT v_obligation.requires_proof OR v_obligation.proof_artifact_type IS NULL THEN
      RAISE EXCEPTION 'Configure the required evidence type before linking evidence';
    END IF;
    IF p_source_record_id IS NULL THEN
      RAISE EXCEPTION 'A completed shift stop is required';
    END IF;

    SELECT
      ss.*,
      s.officer_user_id,
      sal.service_agreement_id,
      coalesce(cs.name, 'Covered Site') AS site_name,
      coalesce(up.display_name, 'Assigned officer') AS officer_name
    INTO v_stop
    FROM public.shift_stops ss
    JOIN public.shifts s ON s.id = ss.shift_id
    JOIN public.service_agreement_locations sal
      ON sal.id = s.service_agreement_location_id
     AND sal.service_agreement_id = v_agreement.id
     AND sal.status = 'active'
    LEFT JOIN public.client_sites cs ON cs.id = ss.site_id
    LEFT JOIN public.user_profiles up ON up.id = s.officer_user_id
    WHERE ss.id = p_source_record_id
      AND ss.organization_id = v_agreement.provider_organization_id
    FOR UPDATE OF ss;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shift stop is not covered by this agreement';
    END IF;
    IF v_stop.status <> 'completed'
       OR v_stop.actual_arrived_at IS NULL
       OR v_stop.actual_departed_at IS NULL THEN
      RAISE EXCEPTION 'Only a completed stop with arrival and departure timestamps can be linked';
    END IF;
    IF v_obligation.site_id IS NOT NULL AND v_stop.site_id IS DISTINCT FROM v_obligation.site_id THEN
      RAISE EXCEPTION 'Shift stop is outside the requirement Site scope';
    END IF;

    IF v_obligation.proof_artifact_type = 'timestamp' THEN
      v_artifact_type := 'arrival_timestamp';
    ELSIF v_obligation.proof_artifact_type = 'gps_track' THEN
      SELECT count(*)::integer
      INTO v_gps_point_count
      FROM public.officer_gps_log ogl
      WHERE ogl.shift_id = v_stop.shift_id
        AND ogl.officer_id = v_stop.officer_user_id
        AND ogl.recorded_at BETWEEN v_stop.actual_arrived_at AND v_stop.actual_departed_at;

      IF v_gps_point_count < 2 THEN
        RAISE EXCEPTION 'A GPS track requires at least two shift-linked points inside the completed stop window';
      END IF;
      v_artifact_type := 'gps_track';
    ELSE
      RAISE EXCEPTION 'The % evidence workflow is not wired to completed shift stops',
        replace(v_obligation.proof_artifact_type, '_', ' ');
    END IF;

    INSERT INTO public.obligation_proof_artifacts (
      organization_id,
      obligation_id,
      artifact_type,
      source_table,
      source_record_id,
      captured_at,
      notes,
      created_by,
      client_request_id,
      metadata
    )
    VALUES (
      v_agreement.provider_organization_id,
      v_obligation.id,
      v_artifact_type,
      'shift_stops',
      v_stop.id,
      v_stop.actual_departed_at,
      nullif(trim(p_notes), ''),
      v_actor,
      p_client_request_id,
      jsonb_build_object(
        'service_agreement_id', v_agreement.id,
        'shift_id', v_stop.shift_id,
        'site_id', v_stop.site_id,
        'site_name', v_stop.site_name,
        'officer_name', v_stop.officer_name,
        'arrived_at', v_stop.actual_arrived_at,
        'departed_at', v_stop.actual_departed_at,
        'required_artifact_type', v_obligation.proof_artifact_type,
        'gps_point_count', v_gps_point_count
      )
    )
    RETURNING * INTO v_artifact;

    v_receipt := jsonb_build_object(
      'action', v_action,
      'artifact_id', v_artifact.id,
      'obligation_id', v_obligation.id,
      'source_record_id', v_stop.id,
      'status', v_artifact.status,
      'captured_at', v_artifact.captured_at,
      'replayed', false
    );

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    )
    VALUES (
      v_agreement.provider_organization_id,
      v_actor,
      'crm_obligation_proof_attached',
      'obligation_proof_artifacts',
      v_artifact.id,
      jsonb_build_object(
        'client_request_id', p_client_request_id,
        'obligation_id', v_obligation.id,
        'source_table', 'shift_stops',
        'source_record_id', v_stop.id,
        'required_artifact_type', v_obligation.proof_artifact_type,
        'result', v_receipt
      )
    );
  ELSE
    IF p_artifact_id IS NULL OR p_expected_updated_at IS NULL THEN
      RAISE EXCEPTION 'Artifact identity and expected update time are required';
    END IF;
    IF length(trim(coalesce(p_withdrawal_reason, ''))) < 5 THEN
      RAISE EXCEPTION 'Withdrawal reason must contain at least 5 characters';
    END IF;

    SELECT opa.*
    INTO v_artifact
    FROM public.obligation_proof_artifacts opa
    WHERE opa.id = p_artifact_id
      AND opa.obligation_id = v_obligation.id
      AND opa.organization_id = v_agreement.provider_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Proof artifact not found';
    END IF;
    IF v_artifact.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Proof artifact changed; refresh before withdrawing it';
    END IF;
    IF v_artifact.status <> 'active' THEN
      RAISE EXCEPTION 'Only active proof can be withdrawn';
    END IF;

    UPDATE public.obligation_proof_artifacts
    SET
      status = 'withdrawn',
      withdrawn_at = now(),
      withdrawn_by = v_actor,
      withdrawal_reason = trim(p_withdrawal_reason),
      updated_at = now()
    WHERE id = v_artifact.id
    RETURNING * INTO v_artifact;

    v_receipt := jsonb_build_object(
      'action', v_action,
      'artifact_id', v_artifact.id,
      'obligation_id', v_obligation.id,
      'source_record_id', NULL,
      'status', v_artifact.status,
      'withdrawn_at', v_artifact.withdrawn_at,
      'replayed', false
    );

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    )
    VALUES (
      v_agreement.provider_organization_id,
      v_actor,
      'crm_obligation_proof_withdrawn',
      'obligation_proof_artifacts',
      v_artifact.id,
      jsonb_build_object(
        'client_request_id', p_client_request_id,
        'obligation_id', v_obligation.id,
        'previous_status', 'active',
        'resulting_status', v_artifact.status,
        'withdrawal_reason', v_artifact.withdrawal_reason,
        'result', v_receipt
      )
    );
  END IF;

  RETURN v_receipt;
END;
$$;

CREATE UNIQUE INDEX idx_audit_crm_obligation_proof_request
  ON public.audit_log (organization_id, ((metadata->>'client_request_id')))
  WHERE action IN ('crm_obligation_proof_attached', 'crm_obligation_proof_withdrawn')
    AND target_table = 'obligation_proof_artifacts'
    AND metadata->>'client_request_id' IS NOT NULL;

REVOKE ALL ON TABLE public.obligation_proof_artifacts FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.get_crm_obligation_proof_register(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_crm_obligation_proof_register(uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.manage_crm_obligation_proof(
  text, uuid, uuid, uuid, uuid, timestamptz, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_crm_obligation_proof(
  text, uuid, uuid, uuid, uuid, timestamptz, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_crm_obligation_proof_register(uuid) IS
  'Returns reviewed proof history and only contract-aligned eligible sources for a provider administrator.';
COMMENT ON FUNCTION public.manage_crm_obligation_proof(text, uuid, uuid, uuid, uuid, timestamptz, text, text) IS
  'Replay-safe provider-admin attachment or withdrawal of validated contract proof. Withdrawals preserve history.';