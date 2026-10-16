-- The ownership/history-aware onboarding workflow and operating-branch rate
-- command are the single production APIs. Remove their narrower predecessors
-- rather than leaving parallel authenticated paths callable.
DROP FUNCTION IF EXISTS public.get_crm_onboarding_queue();

DROP FUNCTION IF EXISTS public.manage_crm_onboarding_stage(
  uuid,
  integer,
  text,
  timestamp with time zone
);

DROP FUNCTION IF EXISTS public.manage_rate_rule(
  uuid,
  text,
  uuid,
  timestamp with time zone,
  text,
  text,
  text,
  numeric,
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  text,
  date,
  date,
  integer
);