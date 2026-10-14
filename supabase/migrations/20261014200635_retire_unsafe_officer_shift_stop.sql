-- stop_officer_shift predated the governed end-shift workflow and could mark
-- an in-progress shift complete without a debrief or checks for open stops,
-- required tasks, dispatch work, welfare alerts, or linked roster state.
-- complete_officer_shift is the sole officer completion authority.

DROP FUNCTION IF EXISTS public.stop_officer_shift(uuid, text);