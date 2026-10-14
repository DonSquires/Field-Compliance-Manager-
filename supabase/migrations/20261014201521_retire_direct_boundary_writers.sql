-- All human boundary changes now stage through propose_boundary and are
-- applied only by accept_boundary_proposal, with verify_boundary remaining an
-- explicit decision. These older direct writers bypass that review ledger and
-- can leave verification state inconsistent with the changed geometry.

DROP FUNCTION IF EXISTS public.save_site_boundary(
  uuid,
  uuid,
  text,
  double precision,
  double precision
);

DROP FUNCTION IF EXISTS public.save_zone_boundary(
  uuid,
  uuid,
  text,
  double precision,
  double precision
);