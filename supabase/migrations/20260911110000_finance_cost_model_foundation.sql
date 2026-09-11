CREATE TABLE IF NOT EXISTS public.finance_cost_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.finance_cost_categories(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  direct_or_indirect text NOT NULL CHECK (direct_or_indirect IN ('direct','indirect')),
  fixed_or_variable text NOT NULL CHECK (fixed_or_variable IN ('fixed','variable')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS public.finance_cost_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cost_category_id uuid NOT NULL REFERENCES public.finance_cost_categories(id) ON DELETE RESTRICT,
  name text NOT NULL,
  amount numeric(14,4) NOT NULL CHECK (amount >= 0),
  unit text NOT NULL,
  currency text NOT NULL DEFAULT 'NZD',
  allocation_driver text,
  effective_from date NOT NULL,
  effective_to date,
  source_reference text,
  confidence text NOT NULL DEFAULT 'entered' CHECK (confidence IN ('entered','estimated','imported','approved')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_id uuid REFERENCES public.finance_cost_assumptions(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS public.finance_asset_cost_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE RESTRICT,
  acquisition_cost numeric(14,2) NOT NULL CHECK (acquisition_cost >= 0),
  setup_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (setup_cost >= 0),
  residual_value numeric(14,2) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  useful_life_months integer NOT NULL CHECK (useful_life_months > 0),
  useful_life_km numeric(14,2) CHECK (useful_life_km IS NULL OR useful_life_km > 0),
  productive_hours_per_year numeric(10,2) CHECK (productive_hours_per_year IS NULL OR productive_hours_per_year > 0),
  depreciation_method text NOT NULL DEFAULT 'straight_line' CHECK (depreciation_method IN ('straight_line','declining_balance','units_of_production')),
  in_service_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source_reference text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (residual_value <= acquisition_cost + setup_cost),
  UNIQUE (organization_id, asset_id, version)
);

CREATE TABLE IF NOT EXISTS public.finance_asset_depreciation_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_profile_id uuid NOT NULL REFERENCES public.finance_asset_cost_profiles(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  opening_value numeric(14,2) NOT NULL CHECK (opening_value >= 0),
  depreciation_amount numeric(14,2) NOT NULL CHECK (depreciation_amount >= 0),
  accumulated_depreciation numeric(14,2) NOT NULL CHECK (accumulated_depreciation >= 0),
  closing_value numeric(14,2) NOT NULL CHECK (closing_value >= 0),
  method text NOT NULL,
  source_profile_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cost_profile_id, period_start, period_end)
);

ALTER TABLE public.finance_cost_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_cost_assumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_asset_cost_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_asset_depreciation_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_cost_categories_select ON public.finance_cost_categories FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_cost_assumptions_select ON public.finance_cost_assumptions FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_asset_cost_profiles_select ON public.finance_asset_cost_profiles FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_asset_depreciation_schedules_select ON public.finance_asset_depreciation_schedules FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.finance_cost_categories, public.finance_cost_assumptions, public.finance_asset_cost_profiles, public.finance_asset_depreciation_schedules FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_cost_categories, public.finance_cost_assumptions, public.finance_asset_cost_profiles, public.finance_asset_depreciation_schedules TO authenticated;
GRANT ALL ON TABLE public.finance_cost_categories, public.finance_cost_assumptions, public.finance_asset_cost_profiles, public.finance_asset_depreciation_schedules TO service_role;

CREATE OR REPLACE FUNCTION public.calculate_finance_quote_cost(p_inputs jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_hours numeric := greatest(0, coalesce((p_inputs->>'labour_hours')::numeric, 0));
  v_km numeric := greatest(0, coalesce((p_inputs->>'vehicle_km')::numeric, 0));
  v_base numeric := greatest(0, coalesce((p_inputs->>'base_hourly_rate')::numeric, 0));
  v_oncost numeric := greatest(0, coalesce((p_inputs->>'labour_oncost_pct')::numeric, 0));
  v_leave numeric := greatest(0, coalesce((p_inputs->>'leave_provision_pct')::numeric, 0));
  v_vehicle_fixed numeric := greatest(0, coalesce((p_inputs->>'vehicle_fixed_annual')::numeric, 0));
  v_vehicle_hours numeric := greatest(0, coalesce((p_inputs->>'vehicle_productive_hours')::numeric, 0));
  v_vehicle_km_rate numeric := greatest(0, coalesce((p_inputs->>'vehicle_variable_per_km')::numeric, 0));
  v_acquisition_cost numeric := greatest(0, coalesce((p_inputs->>'asset_acquisition_cost')::numeric, 0));
  v_setup_cost numeric := greatest(0, coalesce((p_inputs->>'asset_setup_cost')::numeric, 0));
  v_residual_value numeric := greatest(0, coalesce((p_inputs->>'asset_residual_value')::numeric, 0));
  v_useful_life_months numeric := greatest(0, coalesce((p_inputs->>'asset_useful_life_months')::numeric, 0));
  v_depreciation numeric := 0;
  v_equipment numeric := greatest(0, coalesce((p_inputs->>'equipment_cost')::numeric, 0));
  v_direct numeric := greatest(0, coalesce((p_inputs->>'direct_operating_cost')::numeric, 0));
  v_overhead_pct numeric := greatest(0, coalesce((p_inputs->>'overhead_pct')::numeric, 0));
  v_margin_pct numeric := greatest(0, least(99.99, coalesce((p_inputs->>'target_margin_pct')::numeric, 0)));
  v_labour numeric;
  v_vehicle numeric;
  v_direct_cost numeric;
  v_overhead numeric;
  v_true_cost numeric;
  v_charge numeric;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  IF v_hours <= 0 THEN RAISE EXCEPTION 'Labour hours are required'; END IF;
  IF v_base <= 0 THEN RAISE EXCEPTION 'Base hourly rate is required'; END IF;
  IF v_km > 0 AND v_vehicle_km_rate <= 0 THEN RAISE EXCEPTION 'Vehicle per-km cost is required when travel is entered'; END IF;
  IF v_vehicle_fixed > 0 AND v_vehicle_hours <= 0 THEN RAISE EXCEPTION 'Vehicle productive hours are required for fixed vehicle cost'; END IF;
  IF v_acquisition_cost + v_setup_cost > 0 AND v_useful_life_months <= 0 THEN RAISE EXCEPTION 'Asset useful life is required when an acquisition cost is entered'; END IF;
  IF v_residual_value > v_acquisition_cost + v_setup_cost THEN RAISE EXCEPTION 'Asset residual value cannot exceed capitalized cost'; END IF;

  v_labour := v_hours * v_base * (1 + (v_oncost + v_leave) / 100);
  v_depreciation := (v_acquisition_cost + v_setup_cost - v_residual_value) / nullif(v_useful_life_months / 12, 0);
  v_vehicle := v_hours * ((v_vehicle_fixed + v_depreciation) / nullif(v_vehicle_hours, 0)) + v_km * v_vehicle_km_rate;
  v_direct_cost := v_labour + v_vehicle + v_equipment + v_direct;
  v_overhead := v_direct_cost * v_overhead_pct / 100;
  v_true_cost := round(v_direct_cost + v_overhead, 2);
  v_charge := round(greatest(coalesce((p_inputs->>'client_charge')::numeric, 0), v_true_cost / nullif(1 - v_margin_pct / 100, 0)), 2);

  RETURN jsonb_build_object(
    'organization_id', v_org,
    'currency', coalesce(p_inputs->>'currency', 'NZD'),
    'true_cost', v_true_cost,
    'client_charge', v_charge,
    'gross_margin', round(v_charge - v_true_cost, 2),
    'gross_margin_pct', round((v_charge - v_true_cost) / nullif(v_charge, 0) * 100, 2),
    'breakdown', jsonb_build_object('loaded_labour', round(v_labour, 2), 'vehicle_travel', round(v_vehicle, 2), 'depreciation_annual', round(v_depreciation, 2), 'equipment', round(v_equipment, 2), 'direct_operating', round(v_direct, 2), 'allocated_overhead', round(v_overhead, 2)),
    'inputs', p_inputs,
    'basis', 'server_calculated_estimate',
    'approval_required', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_finance_quote_cost(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_finance_quote_cost(jsonb) TO authenticated, service_role;
