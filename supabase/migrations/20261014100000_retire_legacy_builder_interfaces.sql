-- Retire Builder interfaces superseded by the current aggregate review,
-- canonical approvals workbench, and fixed-profile isolated workers.

DROP FUNCTION IF EXISTS public.builder_claim_security_review(
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer
);

DROP FUNCTION IF EXISTS public.get_builder_approvals_activity(
  integer,
  integer,
  text[],
  text[]
);

DROP TABLE IF EXISTS public.builder_protected_variables;
