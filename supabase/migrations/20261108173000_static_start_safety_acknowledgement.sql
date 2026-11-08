CREATE OR REPLACE FUNCTION public.require_stop_safety_acknowledgement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_briefing jsonb;
  v_whole_briefing jsonb;
  v_officer uuid;
  v_single_static boolean := false;
BEGIN
  IF NEW.status = 'on_scene' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'on_scene') THEN
    SELECT officer_user_id,
      TG_OP = 'UPDATE' AND service_type = 'static_guarding' AND NEW.module_key = 'static_guarding'
        AND (SELECT count(*) FROM public.shift_stops WHERE shift_id = NEW.shift_id) = 1
      INTO v_officer, v_single_static
    FROM public.shifts WHERE id = NEW.shift_id;
    v_briefing := public.build_shift_safety_briefing(NEW.shift_id, NEW.id);
    IF v_single_static THEN
      v_whole_briefing := public.build_shift_safety_briefing(NEW.shift_id, NULL);
      v_single_static := (v_whole_briefing->'hazards') @> (v_briefing->'hazards')
        AND (v_whole_briefing->'warnings') @> (v_briefing->'warnings')
        AND (v_whole_briefing->'places') @> (v_briefing->'places');
    END IF;
    IF (v_briefing->>'item_count')::integer > 0 AND NOT EXISTS (
      SELECT 1 FROM public.safety_briefing_acknowledgements a
      WHERE a.shift_id = NEW.shift_id AND a.officer_user_id = v_officer
        AND ((a.shift_stop_id = NEW.id AND a.briefing_hash = v_briefing->>'briefing_hash')
          OR (a.shift_stop_id IS NULL AND v_single_static
            AND a.briefing_hash = v_whole_briefing->>'briefing_hash'))
    ) THEN
      RAISE EXCEPTION 'Read and acknowledge the current risks for this stop before recording arrival.'
        USING ERRCODE = 'P0001', HINT = 'safety_briefing_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.require_stop_safety_acknowledgement() IS
  'Arrival requires the assigned officer''s current stop briefing receipt. A single static stop also accepts a current whole-shift receipt only when that briefing contains every current stop hazard, warning and place; patrol and multi-stop work retain stop-specific acknowledgement.';

REVOKE ALL ON FUNCTION public.require_stop_safety_acknowledgement() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.require_stop_safety_acknowledgement() TO postgres, service_role;