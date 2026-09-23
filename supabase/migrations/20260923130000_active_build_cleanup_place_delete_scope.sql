-- Owner ruling 2026-09-23 (later same day, docs/canon/LOCATION_HOUSE_MODEL.md):
-- during active build/seeding the operator wants a clean DB, not an accumulation
-- of "retired" rows for genuine seeding-bug artifacts. Adds one narrow, explicit
-- opt-in bypass alongside the existing test_dataset_purge scope. The caller must
-- still verify zero real references before using it -- this is a caller
-- discipline, not mechanically enforced, matching the existing 15-minute
-- compensating-transaction exception this function already trusts.
CREATE OR REPLACE FUNCTION public.tg_place_permanence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.place_delete_scope', true) = 'test_dataset_purge' THEN RETURN OLD; END IF;
  IF current_setting('app.place_delete_scope', true) = 'active_build_cleanup' THEN RETURN OLD; END IF;
  -- A service or admin session may roll back a row it created moments ago (proposal compensation).
  IF (auth.role() = 'service_role' OR session_user IN ('postgres', 'supabase_admin'))
     AND OLD.created_at > clock_timestamp() - interval '15 minutes' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Places are permanent: %.% cannot be deleted. Retire or merge it instead.', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'P0001', HINT = 'docs/canon/LOCATION_HOUSE_MODEL.md, ruling 2026-09-15';
END $function$;
