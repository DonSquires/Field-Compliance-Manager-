-- Parking needs the same versioned/effective-dated rule model as freedom
-- camping, but with parking-specific semantics. Legacy parking_module_config
-- remains the fallback while organizations migrate/configure this matrix.
CREATE TABLE IF NOT EXISTS public.parking_rule_matrix (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  zone_id uuid REFERENCES public.location_zones(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL DEFAULT current_date,
  effective_to date,
  time_limit_minutes integer NOT NULL,
  grace_period_minutes integer NOT NULL DEFAULT 5,
  disabled_multiplier numeric(6,2) NOT NULL DEFAULT 1,
  infringement_fee numeric(10,2),
  legislative_text text,
  require_photo_evidence boolean NOT NULL DEFAULT true,
  auto_escalate_overstay boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.user_profiles(id),
  CONSTRAINT parking_rule_matrix_time_limit_check CHECK (time_limit_minutes > 0),
  CONSTRAINT parking_rule_matrix_grace_check CHECK (grace_period_minutes >= 0),
  CONSTRAINT parking_rule_matrix_multiplier_check CHECK (disabled_multiplier >= 1),
  CONSTRAINT parking_rule_matrix_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT parking_rule_matrix_scope_version_key UNIQUE (organization_id, zone_id, version)
);

CREATE INDEX IF NOT EXISTS idx_parking_rule_matrix_lookup
  ON public.parking_rule_matrix (organization_id, zone_id, is_current, effective_from DESC);

ALTER TABLE public.parking_rule_matrix ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS parking_rule_matrix_select ON public.parking_rule_matrix;
CREATE POLICY parking_rule_matrix_select ON public.parking_rule_matrix
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
DROP POLICY IF EXISTS parking_rule_matrix_insert ON public.parking_rule_matrix;
CREATE POLICY parking_rule_matrix_insert ON public.parking_rule_matrix
  FOR INSERT TO authenticated WITH CHECK (public.is_admin_for_org(organization_id));
DROP POLICY IF EXISTS parking_rule_matrix_update ON public.parking_rule_matrix;
CREATE POLICY parking_rule_matrix_update ON public.parking_rule_matrix
  FOR UPDATE TO authenticated USING (public.is_admin_for_org(organization_id))
  WITH CHECK (public.is_admin_for_org(organization_id));

REVOKE ALL ON TABLE public.parking_rule_matrix FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.parking_rule_matrix TO authenticated;
GRANT ALL ON TABLE public.parking_rule_matrix TO service_role;

CREATE OR REPLACE FUNCTION public.evaluate_parking_compliance(
  p_org_id uuid,
  p_zone_id uuid,
  p_plate text,
  p_is_disabled_bay boolean DEFAULT false,
  p_sign_time_limit_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule record;
  v_legacy_zone_limit integer;
  v_legacy_multiplier numeric;
  v_legacy_org_default integer;
  v_legacy_grace integer;
  v_effective_limit integer;
  v_grace integer;
  v_multiplier numeric;
  v_chalk record;
  v_minutes_elapsed numeric;
  v_is_overstay boolean := false;
  v_is_repeat boolean;
  v_repeat_count integer;
BEGIN
  SELECT * INTO v_rule
  FROM public.parking_rule_matrix
  WHERE organization_id = p_org_id
    AND is_current
    AND effective_from <= current_date
    AND (effective_to IS NULL OR effective_to >= current_date)
    AND (zone_id = p_zone_id OR zone_id IS NULL)
  ORDER BY (zone_id IS NULL), effective_from DESC, version DESC
  LIMIT 1;

  SELECT parking_time_limit_minutes, parking_disabled_multiplier INTO v_legacy_zone_limit, v_legacy_multiplier
  FROM public.location_zones WHERE id = p_zone_id;
  SELECT default_time_limit_minutes, grace_period_minutes INTO v_legacy_org_default, v_legacy_grace
  FROM public.parking_module_config WHERE organization_id = p_org_id;

  v_effective_limit := COALESCE(p_sign_time_limit_minutes, v_rule.time_limit_minutes, v_legacy_zone_limit, v_legacy_org_default, 60);
  v_grace := COALESCE(v_rule.grace_period_minutes, v_legacy_grace, 5);
  v_multiplier := COALESCE(v_rule.disabled_multiplier, v_legacy_multiplier, 1);
  IF p_is_disabled_bay THEN v_effective_limit := round(v_effective_limit * v_multiplier); END IF;

  SELECT * INTO v_chalk FROM public.parking_chalk_records
  WHERE organization_id = p_org_id AND plate = upper(p_plate) AND status = 'active'
    AND (p_zone_id IS NULL OR zone_id = p_zone_id)
  ORDER BY chalked_at DESC LIMIT 1;

  IF v_chalk.id IS NOT NULL THEN
    v_minutes_elapsed := extract(epoch FROM (now() - v_chalk.chalked_at)) / 60.0;
    v_is_overstay := v_minutes_elapsed > (v_effective_limit + v_grace);
  END IF;

  SELECT count(*) INTO v_repeat_count FROM public.parking_chalk_records
  WHERE organization_id = p_org_id AND plate = upper(p_plate)
    AND chalked_at >= date_trunc('day', current_timestamp AT TIME ZONE 'Pacific/Auckland') AT TIME ZONE 'Pacific/Auckland'
    AND status != 'compliant' AND (v_chalk.id IS NULL OR id != v_chalk.id);
  v_is_repeat := v_repeat_count > 0;

  RETURN jsonb_build_object(
    'verdict', CASE WHEN v_is_overstay AND v_is_repeat THEN 'repeat_offender' WHEN v_is_overstay THEN 'overstay' WHEN v_chalk.id IS NOT NULL THEN 'watch' ELSE 'clear' END,
    'effective_limit_minutes', v_effective_limit, 'grace_period_minutes', v_grace,
    'chalked_at', v_chalk.chalked_at, 'minutes_elapsed', v_minutes_elapsed,
    'is_overstay', v_is_overstay, 'is_repeat', v_is_repeat, 'repeat_count', v_repeat_count,
    'recommended_action', CASE WHEN v_is_overstay THEN 'infringement' WHEN v_chalk.id IS NOT NULL THEN 'warning' ELSE 'none' END,
    'rule_matrix_id', v_rule.id, 'rule_matrix_version', v_rule.version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_parking_compliance(uuid,uuid,text,boolean,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluate_parking_compliance(uuid,uuid,text,boolean,integer) TO authenticated, service_role;
