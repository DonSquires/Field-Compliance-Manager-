CREATE UNIQUE INDEX IF NOT EXISTS idx_noise_assessments_job_number_unique
  ON public.noise_assessments (job_number)
  WHERE job_number IS NOT NULL;

REVOKE ALL ON FUNCTION public.generate_noise_job_number()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_noise_job_number()
  TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.assign_noise_job_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF nullif(trim(coalesce(NEW.job_number, '')), '') IS NULL THEN
    NEW.job_number := public.generate_noise_job_number();
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_noise_job_number()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_noise_job_number()
  TO postgres, service_role;

DROP TRIGGER IF EXISTS noise_assessments_assign_job_number
  ON public.noise_assessments;
CREATE TRIGGER noise_assessments_assign_job_number
  BEFORE INSERT ON public.noise_assessments
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_noise_job_number();