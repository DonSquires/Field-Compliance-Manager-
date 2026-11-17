-- The assigned-officer projection calls this as its owner; clients must not
-- retrieve the legacy narrative directly, bypassing private review.
REVOKE ALL ON FUNCTION public.get_officer_patrol_stops(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.get_officer_patrol_stops(uuid) IS
  'Internal legacy stop source. Officers use get_officer_patrol_stops_sanitized; narrative requires private review.';