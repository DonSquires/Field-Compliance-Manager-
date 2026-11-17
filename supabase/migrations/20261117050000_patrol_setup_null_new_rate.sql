-- The Responsible run dialog sends unused billing choices as JSON null. save_location_patrol_setup
-- forwards billing->'new_rate', which is the jsonb value 'null' rather than SQL NULL, so the base
-- billing function treated every agreement or existing-rate choice as a request to create a rate.
CREATE OR REPLACE FUNCTION public.save_location_patrol_billing_selection(p_provider_id uuid, p_location_id uuid, p_client_request_id uuid, p_service_agreement_location_id uuid, p_service_agreement_module_id uuid, p_rate_type text, p_source text, p_rate_rule_id uuid, p_effective_from date, p_expected_selection_id uuid, p_expected_updated_at timestamp with time zone, p_new_rate jsonb, p_billing_unit_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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
    p_expected_selection_id,p_expected_updated_at,nullif(p_new_rate,'null'::jsonb));
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

REVOKE ALL ON FUNCTION public.save_location_patrol_billing_selection(uuid,uuid,uuid,uuid,uuid,text,text,uuid,date,uuid,timestamp with time zone,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_location_patrol_billing_selection(uuid,uuid,uuid,uuid,uuid,text,text,uuid,date,uuid,timestamp with time zone,jsonb,text) TO postgres, authenticated;
