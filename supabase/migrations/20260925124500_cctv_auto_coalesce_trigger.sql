-- Enforce event semantics at the write boundary as well as in the worker. This keeps deduplication live
-- during staggered worker deployments and makes retries/alternate service writers follow the same rule.

CREATE OR REPLACE FUNCTION public.cctv_auto_coalesce_stationary_vehicle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.coalesce_cctv_stationary_vehicle_observations(NEW.inference_job_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cctv_auto_coalesce_stationary_vehicle ON public.cctv_entity_observations;
CREATE TRIGGER trg_cctv_auto_coalesce_stationary_vehicle
AFTER INSERT ON public.cctv_entity_observations
FOR EACH ROW
WHEN (NEW.entity_kind = 'vehicle')
EXECUTE FUNCTION public.cctv_auto_coalesce_stationary_vehicle();

REVOKE ALL ON FUNCTION public.cctv_auto_coalesce_stationary_vehicle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cctv_auto_coalesce_stationary_vehicle() TO service_role;
