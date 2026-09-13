-- Read-only RPC for live place-first rule selection. Resolves the effective rule set
-- from the current geofence and module context, without mutating any history.
CREATE OR REPLACE FUNCTION public.resolve_active_rules(
  p_organization_id uuid,
  p_module_key text,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_at timestamptz DEFAULT now()
)
RETURNS TABLE (
  organization_id uuid,
  module_key text,
  enabled boolean,
  dominant_anchor_kind text,
  active_zone_id uuid,
  active_site_id uuid,
  active_location_id uuid,
  governing_jurisdiction_id uuid,
  governing_jurisdiction_name text,
  module_rule_set_id uuid,
  module_rule_set_name text,
  evidence_requirements jsonb,
  approval_policy jsonb,
  report_template_code text,
  jurisdiction_rule_set_id uuid,
  jurisdiction_rule_set_name text,
  jurisdiction_name text,
  jurisdiction_rules jsonb,
  resolution_status text,
  effective_rules jsonb,
  policy_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public AS $$
DECLARE
  v_zone_id uuid := p_zone_id;
  v_site_id uuid := p_site_id;
  v_location_id uuid := p_location_id;
  v_rule jsonb := '{}'::jsonb;
  v_jur_id uuid := NULL;
  v_jur_name text := NULL;
  v_module_rule_set_id uuid := NULL;
  v_module_rule_set_name text := NULL;
  v_module_evidence_requirements jsonb := '{}'::jsonb;
  v_module_approval_policy jsonb := '{}'::jsonb;
  v_module_report_template_code text := NULL;
  v_jurisdiction_rule_set_id uuid := NULL;
  v_jurisdiction_rule_set_name text := NULL;
  v_jurisdiction_name text := NULL;
  v_jurisdiction_rules jsonb := '{}'::jsonb;
  v_resolution text := 'outside_all_geofences';
  v_enabled boolean := false;
  v_anchor text := 'unresolved';
BEGIN
  IF p_organization_id IS NULL OR NULLIF(trim(COALESCE(p_module_key, '')), '') IS NULL THEN
    RETURN;
  END IF;

  SELECT om.enabled INTO v_enabled
  FROM public.organization_modules om
  WHERE om.organization_id = p_organization_id
    AND om.module_key = p_module_key
  LIMIT 1;

  IF v_enabled IS NULL THEN
    v_enabled := false;
  END IF;

  IF p_zone_id IS NOT NULL THEN
    SELECT z.id, z.site_id, z.location_id, z.jurisdiction_rule_set_id,
           COALESCE(jrs.name, 'jurisdiction_rules'), jrs.jurisdiction_name, COALESCE(jrs.rules, '{}'::jsonb),
           COALESCE(z.module_key, p_module_key),
           CASE WHEN z.boundary IS NOT NULL THEN 'zone' ELSE 'unresolved' END
      INTO v_zone_id, v_site_id, v_location_id, v_jurisdiction_rule_set_id,
           v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules,
           p_module_key, v_anchor
    FROM public.location_zones z
    LEFT JOIN public.jurisdiction_rule_sets jrs
      ON jrs.id = z.jurisdiction_rule_set_id
    WHERE z.id = p_zone_id
    LIMIT 1;

    v_resolution := 'resolved';
  ELSIF p_site_id IS NOT NULL THEN
    SELECT cs.id, cs.location_id, COALESCE(z.jurisdiction_rule_set_id, NULL),
           COALESCE(jrs.name, 'jurisdiction_rules'), jrs.jurisdiction_name, COALESCE(jrs.rules, '{}'::jsonb),
           'site'
      INTO v_site_id, v_location_id, v_jurisdiction_rule_set_id,
           v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules, v_anchor
    FROM public.client_sites cs
    LEFT JOIN public.location_zones z ON z.site_id = cs.id AND z.module_key = p_module_key
    LEFT JOIN public.jurisdiction_rule_sets jrs ON jrs.id = z.jurisdiction_rule_set_id
    WHERE cs.id = p_site_id
    LIMIT 1;

    v_resolution := 'resolved';
  ELSIF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    SELECT rc.matched_zone_id, rc.site_id, rc.client_org_id, rc.governing_jurisdiction_id,
           rc.governing_jurisdiction_name, rc.effective_rules, rc.resolution_status
      INTO v_zone_id, v_site_id, v_location_id, v_jur_id, v_jur_name, v_rule, v_resolution
    FROM public.resolve_context(p_lat, p_lng, p_organization_id, p_module_key, p_at) rc
    LIMIT 1;

    IF v_zone_id IS NOT NULL THEN
      SELECT z.location_id INTO v_location_id FROM public.location_zones z WHERE z.id = v_zone_id LIMIT 1;
    END IF;

    v_anchor := CASE WHEN v_zone_id IS NOT NULL THEN 'zone' WHEN v_site_id IS NOT NULL THEN 'site' ELSE 'unresolved' END;
  END IF;

  SELECT mrs.id, mrs.name, mrs.evidence_requirements, mrs.approval_policy, mrs.report_template_code
    INTO v_module_rule_set_id, v_module_rule_set_name, v_module_evidence_requirements, v_module_approval_policy, v_module_report_template_code
  FROM public.module_rule_sets mrs
  WHERE mrs.organization_id = p_organization_id
    AND mrs.module_key = p_module_key
  ORDER BY mrs.created_at DESC
  LIMIT 1;

  IF v_jurisdiction_rule_set_id IS NULL AND p_organization_id IS NOT NULL AND p_module_key IS NOT NULL THEN
    SELECT jrs.id, jrs.name, jrs.jurisdiction_name, jrs.rules
      INTO v_jurisdiction_rule_set_id, v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules
    FROM public.jurisdiction_rule_sets jrs
    WHERE jrs.organization_id = p_organization_id
      AND jrs.module_key = p_module_key
    ORDER BY jrs.created_at DESC
    LIMIT 1;
  END IF;

  IF v_rule = '{}'::jsonb THEN
    v_rule := COALESCE(v_jurisdiction_rules, '{}'::jsonb);
  END IF;

  RETURN QUERY
  SELECT
    p_organization_id,
    p_module_key,
    v_enabled,
    v_anchor,
    v_zone_id,
    v_site_id,
    v_location_id,
    v_jur_id,
    v_jur_name,
    v_module_rule_set_id,
    v_module_rule_set_name,
    v_module_evidence_requirements,
    v_module_approval_policy,
    v_module_report_template_code,
    v_jurisdiction_rule_set_id,
    v_jurisdiction_rule_set_name,
    v_jurisdiction_name,
    v_jurisdiction_rules,
    v_resolution,
    v_rule,
    CASE
      WHEN v_enabled = false THEN 'disabled'
      WHEN v_resolution IN ('unresolved_no_geofence','unresolved_invalid','unresolved_unverified','outside_all_geofences') THEN 'needs_resolution'
      WHEN v_module_rule_set_id IS NULL THEN 'missing_module_rule_set'
      WHEN v_jurisdiction_rule_set_id IS NULL THEN 'missing_jurisdiction_rule_set'
      ELSE 'effective_rules_ready'
    END AS policy_status;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_active_rules(uuid, text, double precision, double precision, uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_active_rules(uuid, text, double precision, double precision, uuid, uuid, uuid, timestamptz) TO authenticated, service_role;
