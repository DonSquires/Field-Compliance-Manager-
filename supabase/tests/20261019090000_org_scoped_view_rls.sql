-- Truth table for 20261019090000_enforce_org_scoped_view_rls.
--
-- Proves that the org-scoped reporting views no longer leak across tenants,
-- using a SYNTHETIC identity that holds no organisation entitlement at all.
-- No real user is impersonated: the subject is a random uuid that appears in
-- no membership table, so org_access_allowed() is false for every org.
--
-- Expected: such a caller reads zero rows from every org-scoped view, while
-- the documented platform-wide Tier 0 definer registers keep working.
--
-- Run with:
--   supabase db query --linked --file supabase/tests/20261019090000_org_scoped_view_rls.sql
-- Self-rollbacks; writes nothing.

BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL [%]', p_label;
  END IF;
  RAISE NOTICE 'ok [%]', p_label;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.as_unentitled(p_user uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.view_is_invoker(p_view text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce('security_invoker=true' = ANY(c.reloptions), false)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = p_view AND c.relkind = 'v';
$$;

-- 1. Structural guard: every org-scoped reporting view runs as the invoker.
DO $$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'investigations_summary',
    'location_visibility_for_viewer',
    'organization_tree',
    'patrol_travel_km_summary',
    'person_permits_fieldwork',
    'v_service_agreement_readiness'
  ] LOOP
    PERFORM pg_temp.check(
      format('%s runs with security_invoker', v),
      pg_temp.view_is_invoker(v)
    );
  END LOOP;
END
$$;

-- 2. The documented platform-wide Tier 0 registers stay definer on purpose.
--    Guards against an over-broad future "lock everything down" sweep that
--    would silently blind officers to the public self-containment register.
DO $$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'canonical_person_public',
    'canonical_scv_public',
    'canonical_vehicle_public'
  ] LOOP
    PERFORM pg_temp.check(
      format('%s remains an intentional definer register', v),
      NOT pg_temp.view_is_invoker(v)
    );
  END LOOP;
END
$$;

-- 3. Behavioural: an authenticated caller with no entitlement reads nothing.
--
-- patrol_travel_km_summary is probed with an organisation filter rather than a
-- bare count(*). Once RLS is genuinely enforced, org_access_allowed() and
-- has_location_access() are evaluated per row, so an unbounded aggregate over
-- the whole observations/location_events history exceeds the statement timeout.
-- A report screen always scopes by organisation, so the scoped probe is both
-- the realistic shape and the discriminating one: the same filter returned 1965
-- rows to a definer-run view and must now return 0 to an unentitled caller.
DO $$
DECLARE
  synthetic_user uuid := gen_random_uuid();
  probe_org uuid;
  n bigint;
BEGIN
  SELECT organization_id INTO probe_org
    FROM public.observations
   WHERE distance_km IS NOT NULL AND organization_id IS NOT NULL
   LIMIT 1;

  PERFORM pg_temp.as_unentitled(synthetic_user);

  SELECT count(*) INTO n FROM public.patrol_travel_km_summary
   WHERE organization_id = probe_org;
  PERFORM pg_temp.check('patrol_travel_km_summary leaks no rows cross-tenant', n = 0);

  SELECT count(*) INTO n FROM public.organization_tree;
  PERFORM pg_temp.check('organization_tree leaks no rows cross-tenant', n = 0);

  SELECT count(*) INTO n FROM public.investigations_summary;
  PERFORM pg_temp.check('investigations_summary leaks no rows cross-tenant', n = 0);

  SELECT count(*) INTO n FROM public.v_service_agreement_readiness;
  PERFORM pg_temp.check('v_service_agreement_readiness leaks no rows cross-tenant', n = 0);

  SELECT count(*) INTO n FROM public.location_visibility_for_viewer;
  PERFORM pg_temp.check('location_visibility_for_viewer leaks no rows cross-tenant', n = 0);

  SELECT count(*) INTO n FROM public.person_permits_fieldwork;
  PERFORM pg_temp.check('person_permits_fieldwork leaks no rows cross-tenant', n = 0);

  RESET ROLE;
END
$$;

-- 4. service_role keeps its governed read path (rolbypassrls), so the fix does
--    not break edge functions or governed diagnostics.
DO $$
BEGIN
  PERFORM pg_temp.check(
    'service_role retains bypassrls for governed reads',
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role')
  );
END
$$;

ROLLBACK;
