ALTER TABLE public.staff_training_records
  DROP CONSTRAINT staff_training_records_training_type_check;

ALTER TABLE public.staff_training_records
  ADD CONSTRAINT staff_training_records_training_type_check
  CHECK (
    training_type IN (
      'internal',
      'external',
      'online',
      'certification',
      'induction',
      'refresher',
      'assessment'
    )
  );