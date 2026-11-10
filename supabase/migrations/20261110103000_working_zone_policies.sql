CREATE OR REPLACE FUNCTION public.get_working_zone_policy(p_zone_id uuid, p_operating_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor public.user_profiles%rowtype;
  v_zone public.location_zones%rowtype;
  v_policy public.zone_compliance_matrix%rowtype;
  v_parking public.parking_rule_matrix%rowtype;
  v_provider uuid;
BEGIN
  SELECT * INTO v_actor FROM public.user_profiles WHERE id = auth.uid() AND deactivated_at IS NULL;
  v_provider := coalesce(p_operating_organization_id, v_actor.organization_id);
  SELECT * INTO v_zone FROM public.location_zones WHERE id = p_zone_id;
  IF v_actor.id IS NULL OR v_zone.id IS NULL OR v_provider IS NULL OR NOT public.is_admin_for_org(v_provider)
     OR NOT public.crm_actor_can_manage_location(v_zone.location_id) THEN
    RAISE EXCEPTION 'Active administrator authority for this working zone is required';
  END IF;
  IF v_zone.module_key NOT IN ('parking_enforcement', 'freedom_camping') THEN
    RAISE EXCEPTION 'Select a Parking or Freedom Camping working zone';
  END IF;
  SELECT * INTO v_policy FROM public.zone_compliance_matrix
    WHERE zone_id = v_zone.id AND organization_id = v_provider AND is_current
    ORDER BY version DESC LIMIT 1;
  SELECT * INTO v_parking FROM public.parking_rule_matrix
    WHERE zone_id = v_zone.id AND organization_id = v_provider AND is_current
    ORDER BY version DESC LIMIT 1;
  RETURN jsonb_build_object(
    'zone_id', v_zone.id, 'module_key', v_zone.module_key, 'organization_id', v_zone.organization_id,
    'configuration_version', v_zone.configuration_version,
    'configured', CASE WHEN v_zone.module_key = 'parking_enforcement'
      THEN v_zone.parking_time_limit_minutes IS NOT NULL AND v_zone.parking_signage_photo_url IS NOT NULL
      ELSE v_policy.id IS NOT NULL END,
    'policy_version', CASE WHEN v_zone.module_key = 'freedom_camping' THEN v_policy.version ELSE coalesce(v_parking.version, v_zone.configuration_version) END,
    'policy', CASE WHEN v_zone.module_key = 'parking_enforcement' THEN jsonb_build_object(
      'time_limit_minutes', v_zone.parking_time_limit_minutes,
      'disabled_multiplier', v_zone.parking_disabled_multiplier,
      'grace_period_minutes', coalesce(v_parking.grace_period_minutes, 0),
      'signage_photo_path', v_zone.parking_signage_photo_url,
      'source_ref', v_zone.bylaw_clause, 'source_url', v_zone.bylaw_source_url
    ) ELSE jsonb_build_object(
      'max_consecutive_nights', v_policy.max_consecutive_nights,
      'max_nights_per_month', v_policy.max_nights_per_month,
      'scv_required', coalesce(v_policy.scv_required, false),
      'source_ref', v_policy.bylaw_clause, 'source_url', v_policy.bylaw_source_url,
      'notes', v_policy.notes
    ) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_working_zone_policy(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_working_zone_policy(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_working_zone_policy(
  p_request_id uuid, p_zone_id uuid, p_expected_version integer, p_policy jsonb, p_operating_organization_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor public.user_profiles%rowtype;
  v_provider uuid;
  v_zone public.location_zones%rowtype;
  v_previous public.zone_compliance_matrix%rowtype;
  v_parking public.parking_rule_matrix%rowtype;
  v_replay public.audit_log%rowtype;
  v_source text := nullif(btrim(p_policy ->> 'source_ref'), '');
  v_source_url text := nullif(btrim(p_policy ->> 'source_url'), '');
  v_consecutive integer := nullif(p_policy ->> 'max_consecutive_nights', '')::integer;
  v_monthly integer := nullif(p_policy ->> 'max_nights_per_month', '')::integer;
  v_scv boolean := coalesce((p_policy ->> 'scv_required')::boolean, false);
  v_version integer;
  v_grace integer := coalesce(nullif(p_policy ->> 'grace_period_minutes', '')::integer, 0);
  v_receipt jsonb;
BEGIN
  SELECT * INTO v_actor FROM public.user_profiles WHERE id = auth.uid() AND deactivated_at IS NULL;
  v_provider := coalesce(p_operating_organization_id, v_actor.organization_id);
  SELECT * INTO v_zone FROM public.location_zones WHERE id = p_zone_id FOR UPDATE;
  IF v_actor.id IS NULL OR v_zone.id IS NULL OR v_provider IS NULL OR NOT public.is_admin_for_org(v_provider)
     OR NOT public.crm_actor_can_manage_location(v_zone.location_id) THEN
    RAISE EXCEPTION 'Active administrator authority for this working zone is required';
  END IF;
  IF p_request_id IS NULL OR p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' THEN
    RAISE EXCEPTION 'Policy request identity and structured policy are required';
  END IF;
  SELECT * INTO v_replay FROM public.audit_log
    WHERE organization_id = v_provider AND actor_user_id = v_actor.id
      AND action = 'working_zone_policy_saved' AND metadata ->> 'request_id' = p_request_id::text
    LIMIT 1;
  IF FOUND THEN
    IF v_replay.target_id IS DISTINCT FROM p_zone_id OR v_replay.metadata -> 'policy' IS DISTINCT FROM p_policy THEN
      RAISE EXCEPTION 'Policy request identity was already used for different input';
    END IF;
    RETURN v_replay.metadata -> 'receipt';
  END IF;
  IF p_expected_version IS NULL OR v_zone.configuration_version <> p_expected_version THEN
    RAISE EXCEPTION 'Working zone changed; reload its policy before saving';
  END IF;
  IF v_source IS NULL OR char_length(v_source) > 2000 OR coalesce((p_policy ->> 'source_confirmed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Record the policy source and confirm that the entered rules match it';
  END IF;
  IF v_source_url IS NOT NULL AND (v_source_url !~ '^https?://' OR char_length(v_source_url) > 2000 OR v_source_url ~ '^https?://[^/]*@') THEN
    RAISE EXCEPTION 'Policy source URL must be an HTTP or HTTPS address without credentials';
  END IF;
  IF v_zone.module_key = 'parking_enforcement' THEN
    IF v_grace NOT BETWEEN 0 AND 1440 THEN RAISE EXCEPTION 'Parking grace period must be between 0 and 1440 minutes'; END IF;
    SELECT * INTO v_zone FROM public.manage_parking_zone_rule(
      p_request_id, v_zone.id, p_expected_version, (p_policy ->> 'time_limit_minutes')::integer,
      (p_policy ->> 'disabled_multiplier')::numeric, 'manual', p_policy ->> 'signage_photo_path'
    );
    UPDATE public.location_zones SET bylaw_clause = v_source, bylaw_source_url = v_source_url WHERE id = v_zone.id;
    SELECT * INTO v_parking FROM public.parking_rule_matrix
      WHERE organization_id = v_provider AND zone_id = v_zone.id AND is_current
      ORDER BY version DESC LIMIT 1;
    SELECT coalesce(max(version), 0) + 1 INTO v_version FROM public.parking_rule_matrix
      WHERE organization_id = v_provider AND zone_id = v_zone.id;
    UPDATE public.parking_rule_matrix SET is_current = false
      WHERE organization_id = v_provider AND zone_id = v_zone.id AND is_current;
    INSERT INTO public.parking_rule_matrix(organization_id, zone_id, version, is_current, effective_from,
      time_limit_minutes, grace_period_minutes, disabled_multiplier, legislative_text, require_photo_evidence,
      infringement_fee, auto_escalate_overstay, notes, created_by)
    VALUES (v_provider, v_zone.id, v_version, true, current_date, v_zone.parking_time_limit_minutes,
      v_grace, v_zone.parking_disabled_multiplier, v_source, true, v_parking.infringement_fee,
      coalesce(v_parking.auto_escalate_overstay, false), v_parking.notes, v_actor.id);
  ELSIF v_zone.module_key = 'freedom_camping' THEN
    IF (v_consecutive IS NOT NULL AND v_consecutive NOT BETWEEN 0 AND 366)
       OR (v_monthly IS NOT NULL AND v_monthly NOT BETWEEN 0 AND 31)
       OR (v_consecutive IS NOT NULL AND v_monthly IS NOT NULL AND v_consecutive > v_monthly) THEN
      RAISE EXCEPTION 'Camping night limits must be valid and the consecutive limit cannot exceed the monthly limit';
    END IF;
    IF v_zone.rule_type = 'overnight_limited' AND v_consecutive IS NULL AND v_monthly IS NULL THEN
      RAISE EXCEPTION 'An overnight-limited policy requires at least one night limit';
    END IF;
    IF char_length(coalesce(p_policy ->> 'notes', '')) > 12000 THEN RAISE EXCEPTION 'Policy wording is too long'; END IF;
    SELECT * INTO v_previous FROM public.zone_compliance_matrix
      WHERE zone_id = v_zone.id AND organization_id = v_provider AND is_current
      ORDER BY version DESC LIMIT 1;
    SELECT coalesce(max(version), 0) + 1 INTO v_version FROM public.zone_compliance_matrix
      WHERE zone_id = v_zone.id AND organization_id = v_provider;
    UPDATE public.zone_compliance_matrix SET is_current = false
      WHERE zone_id = v_zone.id AND organization_id = v_provider AND is_current;
    INSERT INTO public.zone_compliance_matrix(
      organization_id, zone_id, version, is_current, max_consecutive_nights, max_nights_per_month,
      scv_required, effective_from, bylaw_clause, bylaw_source_url, notes, created_by,
      max_nights_per_year, allowed_vehicle_types, no_camping_start_time, no_camping_end_time, restricted_from_date, restricted_to_date
    ) VALUES (
      v_provider, v_zone.id, v_version, true, v_consecutive, v_monthly,
      v_scv, current_date, v_source, v_source_url, nullif(btrim(p_policy ->> 'notes'), ''), v_actor.id,
      v_previous.max_nights_per_year, coalesce(v_previous.allowed_vehicle_types, ARRAY['self_contained','tent','campervan']::text[]),
      v_previous.no_camping_start_time, v_previous.no_camping_end_time, v_previous.restricted_from_date, v_previous.restricted_to_date
    );
    UPDATE public.location_zones SET nightly_limit_consecutive = v_consecutive,
      nightly_limit_monthly = v_monthly, scv_required = v_scv, bylaw_clause = v_source,
      bylaw_source_url = v_source_url, configuration_version = configuration_version + 1
      WHERE id = v_zone.id;
  ELSE
    RAISE EXCEPTION 'Select a Parking or Freedom Camping working zone';
  END IF;
  v_receipt := public.get_working_zone_policy(v_zone.id, v_provider);
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_provider, v_actor.id, 'working_zone_policy_saved', 'location_zones', v_zone.id,
      jsonb_build_object('request_id', p_request_id, 'policy', p_policy, 'previous_policy_id', v_previous.id,
        'location_id', v_zone.location_id, 'receipt', v_receipt));
  RETURN v_receipt;
END;
$$;

REVOKE ALL ON FUNCTION public.save_working_zone_policy(uuid, uuid, integer, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_working_zone_policy(uuid, uuid, integer, jsonb, uuid) TO authenticated, service_role;