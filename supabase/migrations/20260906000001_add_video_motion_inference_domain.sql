DO $$
DECLARE
  target_table text;
  target_constraint text;
  constraint_definition text;
BEGIN
  FOR target_table, target_constraint IN
    VALUES
      ('inference_jobs', 'inference_jobs_domain_check'),
      ('inference_results', 'inference_results_domain_check')
  LOOP
    SELECT pg_get_constraintdef(constraint_row.oid)
      INTO constraint_definition
      FROM pg_constraint AS constraint_row
      INNER JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
      INNER JOIN pg_namespace AS schema_name ON schema_name.oid = relation.relnamespace
     WHERE schema_name.nspname = 'public'
       AND relation.relname = target_table
       AND constraint_row.conname = target_constraint;

    IF constraint_definition IS NULL THEN
      RAISE EXCEPTION 'Expected constraint public.% does not exist', target_constraint;
    END IF;

    IF constraint_definition NOT LIKE '%video_motion%' THEN
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT %I',
        target_table,
        target_constraint
      );
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (domain = ANY (ARRAY[''vehicle''::text, ''face''::text, ''identity_document''::text, ''ocr''::text, ''audio''::text, ''bob_reasoning''::text, ''video_motion''::text]))',
        target_table,
        target_constraint
      );
    END IF;
  END LOOP;
END $$;