-- The governed process-officer-scan pipeline resolves the current zone rule,
-- calls calculate_vehicle_compliance(), stores the verdict on the observation,
-- and creates the matching breach alert. This older NCC-specific helper had no
-- caller or dependent and accepted an arbitrary organization ID while running
-- as SECURITY DEFINER.
DROP FUNCTION IF EXISTS public.check_repeat_stay(
  text,
  double precision,
  double precision,
  uuid,
  integer,
  integer,
  timestamp with time zone
);