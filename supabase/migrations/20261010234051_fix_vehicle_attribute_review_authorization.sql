DO $$
DECLARE
  v_signature regprocedure :=
    'public.confirm_cctv_vehicle_attributes(uuid,text,text,text,text,text,text,text,integer)'::regprocedure;
  v_definition text;
  v_invalid_call text :=
    'public.has_role(v_actor, v_org, ARRAY[''super_admin'',''admiral'',''admin'',''manager''])';
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF position(v_invalid_call IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected legacy vehicle review authorization expression was not found';
  END IF;

  v_definition := replace(
    v_definition,
    v_invalid_call,
    'public.is_admin_for_org(v_org)'
  );
  EXECUTE v_definition;
END;
$$;

COMMENT ON FUNCTION public.confirm_cctv_vehicle_attributes(
  uuid, text, text, text, text, text, text, text, integer
) IS
  'The sole human authority for CCTV-derived make, model, colour, body type and year. Review requires the established organization administrator access predicate.';