-- Organization settings now writes through update_operating_branch_profile,
-- which binds the mutation to the explicitly selected authorized operating
-- organization. The older function silently derives the actor's home
-- organization and is a conflicting authority in a multi-branch workspace.

DROP FUNCTION IF EXISTS public.update_organization_profile(
  timestamptz,
  text,
  text,
  text,
  text,
  text
);