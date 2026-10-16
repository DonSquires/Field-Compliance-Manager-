-- Officer patrol work now uses get_officer_patrol_stops() for the complete
-- assigned-stop brief and manage_officer_patrol_stop() for guarded attendance
-- actions and receipts. These older public SECURITY DEFINER helpers had no
-- current caller or database dependent and exposed only partial stop context.
DROP FUNCTION IF EXISTS public.patrol_stop_coords(uuid);
DROP FUNCTION IF EXISTS public.patrol_stop_module_keys(uuid);