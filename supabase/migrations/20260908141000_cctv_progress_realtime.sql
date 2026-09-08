DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.inference_jobs;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;
