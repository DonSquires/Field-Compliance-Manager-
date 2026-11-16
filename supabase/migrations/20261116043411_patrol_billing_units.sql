CREATE TABLE public.patrol_billing_units (
  code text PRIMARY KEY,
  label text NOT NULL,
  rate_type text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (code,rate_type)
);
COMMENT ON TABLE public.patrol_billing_units IS
  'Supported patrol billing calculations and display labels, not another monetary rate store.';
INSERT INTO public.patrol_billing_units(code,label,rate_type) VALUES
  ('per_visit','Per completed visit','per_visit'),
  ('per_shift','Per patrol shift at this place','flat'),
  ('per_service_day','Per NZ service day','daily'),
  ('hourly_officer','Hourly (officer-hours)','hourly'),
  ('hourly_coverage','Hourly (site coverage)','hourly');
ALTER TABLE public.patrol_billing_units ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.patrol_billing_units FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.patrol_billing_units TO authenticated,service_role;
CREATE POLICY patrol_billing_units_read ON public.patrol_billing_units
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.agreement_place_rate_selections
  ADD COLUMN billing_unit_code text,
  ADD CONSTRAINT agreement_place_rate_selections_patrol_unit_fkey
    FOREIGN KEY (billing_unit_code,rate_type)
    REFERENCES public.patrol_billing_units(code,rate_type);
COMMENT ON COLUMN public.agreement_place_rate_selections.billing_unit_code IS
  'Explicit patrol calculation basis. NULL preserves a generic or legacy rate choice and is not an hourly patrol billing default.';
CREATE INDEX agreement_place_rate_selections_patrol_unit_idx
  ON public.agreement_place_rate_selections(billing_unit_code,rate_type);

CREATE FUNCTION public.save_location_patrol_billing_selection(
  p_provider_id uuid,p_location_id uuid,p_client_request_id uuid,
  p_service_agreement_location_id uuid,p_service_agreement_module_id uuid,p_rate_type text,
  p_source text,p_rate_rule_id uuid,p_effective_from date,p_expected_selection_id uuid,
  p_expected_updated_at timestamptz,p_new_rate jsonb,p_billing_unit_code text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_unit public.patrol_billing_units%rowtype;
  v_saved jsonb;
  v_selection public.agreement_place_rate_selections%rowtype;
BEGIN
  SELECT * INTO v_unit FROM public.patrol_billing_units u
    WHERE u.code=p_billing_unit_code AND u.rate_type=p_rate_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose a patrol charging unit matching the rate type; hourly billing needs an explicit basis'
      USING ERRCODE='22023';
  END IF;

  v_saved := public.save_location_billing_selection(
    p_provider_id,p_location_id,p_client_request_id,p_service_agreement_location_id,
    p_service_agreement_module_id,p_rate_type,p_source,p_rate_rule_id,p_effective_from,
    p_expected_selection_id,p_expected_updated_at,p_new_rate);
  SELECT * INTO STRICT v_selection FROM public.agreement_place_rate_selections s
    WHERE s.id=(v_saved->'selection'->>'id')::uuid FOR UPDATE;

  IF (v_saved->>'replayed')::boolean THEN
    IF v_selection.billing_unit_code IS DISTINCT FROM p_billing_unit_code THEN
      RAISE EXCEPTION 'Patrol billing replay conflicts with a different payload; use a new request'
        USING ERRCODE='22023';
    END IF;
  ELSE
    IF NOT v_unit.active THEN
      RAISE EXCEPTION 'Choose an active patrol charging unit' USING ERRCODE='22023';
    END IF;
    UPDATE public.agreement_place_rate_selections
      SET billing_unit_code=p_billing_unit_code,updated_at=clock_timestamp()
      WHERE id=v_selection.id RETURNING * INTO v_selection;
    INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES (p_provider_id,auth.uid(),'location_patrol_billing_selection_saved',
      'agreement_place_rate_selections',v_selection.id,
      jsonb_build_object('client_request_id',p_client_request_id,
        'location_id',p_location_id,'billing_unit_code',p_billing_unit_code,
        'rate_type',p_rate_type,'effective_from',p_effective_from));
  END IF;
  RETURN jsonb_set(v_saved,'{selection}',to_jsonb(v_selection)-'request_fingerprint');
END;
$function$;
REVOKE ALL ON FUNCTION public.save_location_patrol_billing_selection(
  uuid,uuid,uuid,uuid,uuid,text,text,uuid,date,uuid,timestamptz,jsonb,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_location_patrol_billing_selection(
  uuid,uuid,uuid,uuid,uuid,text,text,uuid,date,uuid,timestamptz,jsonb,text)
  TO authenticated;
