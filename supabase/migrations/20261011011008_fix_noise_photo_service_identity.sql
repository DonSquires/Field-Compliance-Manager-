-- Execution is already restricted to service_role by the function ACL. The
-- singular request.jwt.claim.role GUC is not populated for Supabase secret-key
-- requests, so retaining that redundant check rejects legitimate projections.
DO $$
DECLARE
  v_definition text;
  v_original text :=
    'IF coalesce(current_setting(''request.jwt.claim.role'', true), '''') <> ''service_role'' THEN
    RAISE EXCEPTION ''Service identity required'';
  END IF;';
BEGIN
  SELECT pg_get_functiondef(
    'public.record_noise_photo_perception_envelope(uuid,jsonb)'::regprocedure
  )
  INTO v_definition;

  IF position(v_original IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected noise projection service identity guard was not found';
  END IF;

  EXECUTE replace(v_definition, v_original, '');
END;
$$;

REVOKE ALL ON FUNCTION public.record_noise_photo_perception_envelope(uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_noise_photo_perception_envelope(uuid,jsonb)
  TO service_role;

DO $$
DECLARE
  v_definition text;
  v_original text :=
    'SELECT organization_id INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL';
  v_replacement text :=
    'SELECT user_profiles.organization_id INTO v_org
  FROM public.user_profiles
  WHERE user_profiles.id = v_actor AND user_profiles.deactivated_at IS NULL';
BEGIN
  SELECT pg_get_functiondef(
    'public.submit_officer_noise_assessment_v2(uuid,timestamptz,text,text,text,smallint,smallint,smallint,text,uuid,text,text,text,date,boolean,boolean,boolean,text,text,boolean,uuid,uuid,double precision,double precision,jsonb,jsonb)'::regprocedure
  )
  INTO v_definition;

  IF position(v_original IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected noise assessment profile lookup was not found';
  END IF;

  EXECUTE replace(v_definition, v_original, v_replacement);
END;
$$;