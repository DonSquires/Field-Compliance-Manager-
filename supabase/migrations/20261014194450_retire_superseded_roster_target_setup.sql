-- Retire two home-organization-only setup RPCs superseded by the operating
-- organization authorities used by RosterTargetsPage. The replacements enforce
-- both branch operating authority and organization administration before
-- writing the same canonical tables.
--
-- Verified before drop: neither legacy function has an application, Edge
-- Function, script, or database-function caller. create_roster_work_unit and
-- create_roster_slot remain because they still have live database/UI callers.

DROP FUNCTION IF EXISTS public.create_cost_centre(text, text);
DROP FUNCTION IF EXISTS public.create_organization_workplace(text, text);