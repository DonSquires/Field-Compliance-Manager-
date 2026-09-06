DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO definition
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass
     AND conname = 'notifications_category_check';
  IF definition IS NULL THEN
    RAISE EXCEPTION 'Expected notifications_category_check does not exist';
  END IF;
  IF definition NOT LIKE '%video_review%' THEN
    ALTER TABLE public.notifications DROP CONSTRAINT notifications_category_check;
    ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check
      CHECK (category = ANY (ARRAY[
        'credential_expiry'::text, 'sla_breach'::text, 'report_ready'::text,
        'report_reviewed'::text, 'leave_decision'::text, 'timesheet_decision'::text,
        'breach_decision'::text, 'debrief_followup'::text, 'noise_review'::text,
        'welfare'::text, 'dispatch'::text, 'roster'::text, 'open_job'::text,
        'video_review'::text, 'system'::text, 'schema_change_request'::text,
        'bob_conversation'::text, 'bob_self_memory'::text
      ]));
  END IF;
END $$;