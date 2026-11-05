DO $patch$
DECLARE
  v_signature regprocedure := 'public.record_officer_breadcrumb(uuid,timestamp with time zone,double precision,double precision,double precision,double precision,double precision,text,uuid,text)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_before text := 'AND up.role IN (''officer'', ''scan_operator'')';
  v_after text := 'AND up.role IN (''officer'', ''admin_officer'', ''scan_operator'')';
BEGIN
  IF length(v_definition) - length(replace(v_definition, v_before, '')) <> length(v_before) THEN
    RAISE EXCEPTION 'Cannot safely update record_officer_breadcrumb: expected role gate not found exactly once';
  END IF;

  EXECUTE replace(v_definition, v_before, v_after);
END;
$patch$;