-- Geofence Workbench now owns one cross-entity review queue and stages every
-- human boundary change through propose_boundary / accept_boundary_proposal.
-- The older CRM-only queue and direct point-radius mutator are unreachable and
-- preserve a conflicting geometry authority.

DROP FUNCTION IF EXISTS public.manage_crm_site_boundary(
  uuid,
  text,
  text,
  double precision,
  double precision,
  double precision
);

DROP FUNCTION IF EXISTS public.get_crm_site_boundary_queue();