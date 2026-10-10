BEGIN;

DO $migration$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.import_human_authored_trespass_notice(uuid,text,timestamptz,text,text,text,text,text,text,text,text,text,uuid,uuid,uuid,text)'::regprocedure
  )
  INTO v_definition;

  IF position('public.zones z' IN v_definition) > 0 THEN
    EXECUTE replace(v_definition, 'public.zones z', 'public.location_zones z');
  END IF;
END;
$migration$;

COMMIT;