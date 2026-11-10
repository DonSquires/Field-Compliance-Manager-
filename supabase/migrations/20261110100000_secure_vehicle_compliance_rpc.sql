REVOKE ALL ON FUNCTION public.calculate_vehicle_compliance(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evaluate_parking_compliance(uuid, uuid, text, boolean, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.calculate_vehicle_compliance(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_parking_compliance(uuid, uuid, text, boolean, integer) TO service_role;

COMMENT ON FUNCTION public.calculate_vehicle_compliance(text, uuid, uuid) IS
  'Service-only vehicle compliance evaluator. Called after active caller and place authorization in process-officer-scan; never expose this definer function directly to authenticated clients.';
COMMENT ON FUNCTION public.evaluate_parking_compliance(uuid, uuid, text, boolean, integer) IS
  'Service-only Parking compliance evaluator. Called after active caller and place authorization in process-officer-scan; never expose this definer function directly to authenticated clients.';