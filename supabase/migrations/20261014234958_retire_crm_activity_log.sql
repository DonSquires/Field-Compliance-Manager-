DO $$
DECLARE
  v_has_rows boolean;
BEGIN
  IF to_regclass('public.crm_activity_log') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.crm_activity_log)'
  INTO v_has_rows;

  IF v_has_rows THEN
    RAISE EXCEPTION
      'crm_activity_log contains rows; migrate them to crm_account_activities before retirement';
  END IF;

  EXECUTE 'DROP TABLE public.crm_activity_log';
END;
$$;