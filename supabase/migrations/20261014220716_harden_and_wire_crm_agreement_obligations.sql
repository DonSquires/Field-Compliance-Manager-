DROP FUNCTION IF EXISTS public.manage_crm_agreement_obligation(
  uuid, text, uuid, timestamptz, text, text, text, integer, boolean, text,
  integer, text, uuid, jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_crm_agreement_obligation_request
  ON public.audit_log (
    organization_id,
    ((metadata->>'client_request_id'))
  )
  WHERE action IN (
    'crm_agreement_obligation_save',
    'crm_agreement_obligation_deactivate'
  )
    AND target_table = 'agreement_obligations'
    AND metadata->>'client_request_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION public.manage_crm_agreement_obligation(
  p_client_request_id uuid,
  p_agreement_id uuid,
  p_action text,
  p_obligation_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_obligation_code text DEFAULT NULL,
  p_obligation_type text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_sla_target_minutes integer DEFAULT NULL,
  p_requires_proof boolean DEFAULT false,
  p_proof_artifact_type text DEFAULT NULL,
  p_escalation_minutes integer DEFAULT NULL,
  p_escalation_contact text DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_frequency_rule jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_obligation public.agreement_obligations%rowtype;
  v_receipt public.audit_log%rowtype;
  v_code text := upper(nullif(btrim(p_obligation_code), ''));
  v_previous jsonb;
BEGIN
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;

  SELECT sa.*
  INTO v_agreement
  FROM public.service_agreements sa
  WHERE sa.id = p_agreement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service agreement not found';
  END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;
  IF v_agreement.agreement_type <> 'operational'
     OR v_agreement.invitation_status <> 'accepted' THEN
    RAISE EXCEPTION 'Only accepted operational agreements can be configured';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('save', 'deactivate') THEN
    RAISE EXCEPTION 'Unsupported obligation action';
  END IF;

  SELECT a.*
  INTO v_receipt
  FROM public.audit_log a
  WHERE a.organization_id = v_agreement.provider_organization_id
    AND a.target_table = 'agreement_obligations'
    AND a.action IN (
      'crm_agreement_obligation_save',
      'crm_agreement_obligation_deactivate'
    )
    AND a.metadata->>'client_request_id' = p_client_request_id::text;

  IF FOUND THEN
    IF v_receipt.metadata->>'agreement_id' <> p_agreement_id::text
       OR v_receipt.metadata->>'request_action' <> p_action THEN
      RAISE EXCEPTION 'client_request_id was already used for another obligation command';
    END IF;
    SELECT ao.*
    INTO v_obligation
    FROM public.agreement_obligations ao
    WHERE ao.id = v_receipt.target_id
      AND ao.service_agreement_id = v_agreement.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Agreement obligation receipt no longer resolves';
    END IF;
    RETURN to_jsonb(v_obligation);
  END IF;

  IF p_obligation_id IS NOT NULL THEN
    SELECT ao.*
    INTO v_obligation
    FROM public.agreement_obligations ao
    WHERE ao.id = p_obligation_id
      AND ao.service_agreement_id = v_agreement.id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Agreement obligation not found';
    END IF;
    IF p_expected_updated_at IS NULL
       OR v_obligation.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Agreement obligation changed since it was opened';
    END IF;
    v_previous := jsonb_build_object(
      'obligation_code', v_obligation.obligation_code,
      'obligation_type', v_obligation.obligation_type,
      'site_id', v_obligation.site_id,
      'active', v_obligation.active
    );
  END IF;

  IF p_action = 'deactivate' THEN
    IF p_obligation_id IS NULL THEN
      RAISE EXCEPTION 'Agreement obligation required';
    END IF;
    UPDATE public.agreement_obligations
    SET active = false,
        updated_at = clock_timestamp()
    WHERE id = v_obligation.id
    RETURNING * INTO v_obligation;
  ELSE
    IF v_code IS NULL OR v_code !~ '^[A-Z0-9][A-Z0-9._-]{1,63}$' THEN
      RAISE EXCEPTION 'Obligation code must be 2-64 letters, numbers, dots, dashes, or underscores';
    END IF;
    IF nullif(btrim(p_description), '') IS NULL THEN
      RAISE EXCEPTION 'Obligation description required';
    END IF;
    IF p_obligation_type IS NULL
       OR p_obligation_type NOT IN (
         'response_time',
         'patrol_frequency',
         'report_delivery',
         'incident_escalation',
         'compliance_check',
         'custom'
       ) THEN
      RAISE EXCEPTION 'Valid obligation type required';
    END IF;
    IF p_sla_target_minutes IS NOT NULL AND p_sla_target_minutes < 1 THEN
      RAISE EXCEPTION 'SLA target must be positive';
    END IF;
    IF p_escalation_minutes IS NOT NULL AND p_escalation_minutes < 1 THEN
      RAISE EXCEPTION 'Escalation time must be positive';
    END IF;
    IF coalesce(p_requires_proof, false)
       AND (
         p_proof_artifact_type IS NULL
         OR p_proof_artifact_type NOT IN (
           'photo', 'gps_track', 'report', 'signature', 'timestamp', 'other'
         )
       ) THEN
      RAISE EXCEPTION 'Proof artifact type required';
    END IF;
    IF p_site_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.service_agreement_locations sal
      WHERE sal.service_agreement_id = v_agreement.id
        AND sal.site_id = p_site_id
        AND sal.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Obligation site must be in active agreement coverage';
    END IF;
    IF p_obligation_type = 'patrol_frequency' THEN
      IF p_frequency_rule IS NULL
         OR jsonb_typeof(p_frequency_rule) <> 'object'
         OR coalesce(p_frequency_rule->>'period', '') NOT IN (
           'shift', 'day', 'week', 'month'
         )
         OR coalesce(p_frequency_rule->>'minimum_count', '') !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'Patrol frequency requires a positive minimum count per shift, day, week, or month';
      END IF;
    ELSIF p_frequency_rule IS NOT NULL THEN
      RAISE EXCEPTION 'Frequency rule is only valid for patrol frequency obligations';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.agreement_obligations ao
      WHERE ao.service_agreement_id = v_agreement.id
        AND ao.obligation_code = v_code
        AND ao.id IS DISTINCT FROM p_obligation_id
    ) THEN
      RAISE EXCEPTION 'Obligation code already exists for this agreement';
    END IF;

    IF p_obligation_id IS NULL THEN
      INSERT INTO public.agreement_obligations(
        service_agreement_id,
        obligation_code,
        obligation_type,
        description,
        sla_target_minutes,
        requires_proof,
        proof_artifact_type,
        escalation_minutes,
        escalation_contact,
        site_id,
        frequency_rule,
        active
      )
      VALUES (
        v_agreement.id,
        v_code,
        p_obligation_type,
        btrim(p_description),
        p_sla_target_minutes,
        coalesce(p_requires_proof, false),
        CASE WHEN coalesce(p_requires_proof, false)
          THEN p_proof_artifact_type ELSE NULL END,
        p_escalation_minutes,
        nullif(btrim(p_escalation_contact), ''),
        p_site_id,
        p_frequency_rule,
        true
      )
      RETURNING * INTO v_obligation;
    ELSE
      UPDATE public.agreement_obligations
      SET obligation_code = v_code,
          obligation_type = p_obligation_type,
          description = btrim(p_description),
          sla_target_minutes = p_sla_target_minutes,
          requires_proof = coalesce(p_requires_proof, false),
          proof_artifact_type = CASE WHEN coalesce(p_requires_proof, false)
            THEN p_proof_artifact_type ELSE NULL END,
          escalation_minutes = p_escalation_minutes,
          escalation_contact = nullif(btrim(p_escalation_contact), ''),
          site_id = p_site_id,
          frequency_rule = p_frequency_rule,
          active = true,
          updated_at = clock_timestamp()
      WHERE id = v_obligation.id
      RETURNING * INTO v_obligation;
    END IF;
  END IF;

  INSERT INTO public.audit_log(
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_agreement.provider_organization_id,
    v_actor,
    'crm_agreement_obligation_' || p_action,
    'agreement_obligations',
    v_obligation.id,
    jsonb_build_object(
      'agreement_id', v_agreement.id,
      'client_request_id', p_client_request_id,
      'request_action', p_action,
      'previous', v_previous,
      'result', jsonb_build_object(
        'obligation_code', v_obligation.obligation_code,
        'obligation_type', v_obligation.obligation_type,
        'site_id', v_obligation.site_id,
        'active', v_obligation.active
      )
    )
  );

  RETURN to_jsonb(v_obligation);
END;
$$;

REVOKE ALL ON FUNCTION public.manage_crm_agreement_obligation(
  uuid, uuid, text, uuid, timestamptz, text, text, text, integer, boolean,
  text, integer, text, uuid, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_crm_agreement_obligation(
  uuid, uuid, text, uuid, timestamptz, text, text, text, integer, boolean,
  text, integer, text, uuid, jsonb
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_crm_agreement_setup(p_agreement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
BEGIN
  SELECT sa.*
  INTO v_agreement
  FROM public.service_agreements sa
  WHERE sa.id = p_agreement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service agreement not found';
  END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;

  RETURN jsonb_build_object(
    'agreement', jsonb_build_object(
      'id', v_agreement.id,
      'name', v_agreement.name,
      'client_organization_id', v_agreement.client_organization_id,
      'invitation_status', v_agreement.invitation_status,
      'enabled_modules', v_agreement.enabled_modules,
      'client_portal_reports_enabled', v_agreement.client_portal_reports_enabled,
      'monthly_report_template_code', v_agreement.monthly_report_template_code,
      'client_portal_finance_enabled', v_agreement.client_portal_finance_enabled
    ),
    'sites', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'address', s.address,
        'boundary_status', s.boundary_status,
        'boundary_verification', s.boundary_verification,
        'linked', sal.id IS NOT NULL,
        'link_status', sal.status
      ) ORDER BY s.name), '[]'::jsonb)
      FROM public.client_sites s
      LEFT JOIN public.service_agreement_locations sal
        ON sal.service_agreement_id = v_agreement.id
       AND sal.site_id = s.id
      WHERE s.client_organization_id = v_agreement.client_organization_id
        AND s.active
    ),
    'zones', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', z.id,
        'name', z.name,
        'address', NULL,
        'boundary_status', z.boundary_status,
        'boundary_verification', z.boundary_verification,
        'linked', sal.id IS NOT NULL,
        'link_status', sal.status
      ) ORDER BY z.name), '[]'::jsonb)
      FROM public.location_zones z
      LEFT JOIN public.service_agreement_locations sal
        ON sal.service_agreement_id = v_agreement.id
       AND sal.zone_id = z.id
      WHERE z.organization_id = v_agreement.client_organization_id
        AND z.is_active
    ),
    'modules', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'module_key', mc.module_key,
        'enabled', coalesce(sam.enabled, false),
        'sla_minutes', sam.sla_minutes,
        'allows_client_submission', coalesce(sam.allows_client_submission, false),
        'allows_auto_dispatch', coalesce(sam.allows_auto_dispatch, false)
      ) ORDER BY mc.module_key), '[]'::jsonb)
      FROM public.module_catalog mc
      LEFT JOIN public.service_agreement_modules sam
        ON sam.service_agreement_id = v_agreement.id
       AND sam.module_key = mc.module_key
      WHERE mc.active
    ),
    'report_templates', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'template_code', rt.template_code,
        'name', rt.name,
        'module_key', rt.module_key
      ) ORDER BY rt.name), '[]'::jsonb)
      FROM public.report_templates rt
      WHERE rt.organization_id = v_agreement.provider_organization_id
    ),
    'obligations', (
      SELECT coalesce(jsonb_agg(to_jsonb(ao) ORDER BY ao.active DESC, ao.obligation_code), '[]'::jsonb)
      FROM public.agreement_obligations ao
      WHERE ao.service_agreement_id = v_agreement.id
    )
  );
END;
$$;