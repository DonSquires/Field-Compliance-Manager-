-- Draft quotes are created for the explicitly selected operating provider.
-- The older function inferred the actor's home organization and could not
-- represent branch accountability, governed prospects, or agreement
-- variations.

DROP FUNCTION IF EXISTS public.create_crm_draft_quote(
  uuid,
  uuid,
  text,
  numeric,
  date,
  text
);