-- Close a live cross-tenant read path through org-scoped reporting views.
--
-- Evidence (live catalog, 2026-10-19):
--   * role postgres has rolbypassrls = true and owns every public view;
--   * the base tables (observations, location_events, organizations,
--     investigations, service_agreements, service_agreement_locations,
--     client_sites, site_financial_config, person_permits,
--     person_permit_vehicles) all have relrowsecurity = true but
--     relforcerowsecurity = false, so the owner bypasses their policies;
--   * the views below carry no security_invoker reloption, do not filter on
--     auth.uid()/entitlement themselves, and are GRANT SELECT to authenticated.
-- Net effect: any authenticated user of any organisation could read every
-- organisation's rows through these views, even though the base tables are
-- correctly org-scoped. That contradicts each view's own documented intent
-- ("Org-visible ... projection", "RLS inherits from service_agreement_locations").
--
-- ALTER VIEW ... SET (security_invoker = true) is used rather than CREATE OR
-- REPLACE so the shipped view definitions stay byte-identical and only the
-- execution context changes. Every base table already exposes SELECT policies
-- to authenticated, so no legitimate access is withdrawn - callers simply stop
-- seeing other tenants' rows. service_role retains rolbypassrls, so governed
-- service-role read paths are unaffected.
--
-- Deliberately NOT changed: canonical_person_public, canonical_scv_public and
-- canonical_vehicle_public. Those are documented, intentional definer
-- projections over platform-wide Tier 0 registers ("Definer view over
-- canonical_people, which stays Bob-only at the table"), not org-scoped data.

ALTER VIEW public.investigations_summary SET (security_invoker = true);
ALTER VIEW public.location_visibility_for_viewer SET (security_invoker = true);
ALTER VIEW public.organization_tree SET (security_invoker = true);
ALTER VIEW public.patrol_travel_km_summary SET (security_invoker = true);
ALTER VIEW public.person_permits_fieldwork SET (security_invoker = true);
ALTER VIEW public.v_service_agreement_readiness SET (security_invoker = true);

COMMENT ON VIEW public.organization_tree IS 'Recursive organisation hierarchy (id, parent, depth, root, path). Inherits RLS from organizations via security_invoker.';
COMMENT ON VIEW public.patrol_travel_km_summary IS 'Real recorded travel km per officer/place/month, unioned from observations and location_events.distance_km. Read-only reporting aggregate for cost-of-service and vehicle-usage tracking - not part of the finance/invoicing write pipeline. Inherits RLS from observations and location_events via security_invoker.';
COMMENT ON VIEW public.v_service_agreement_readiness IS 'Per-agreement readiness projection over service_agreements, service_agreement_locations, client_sites and site_financial_config. Inherits RLS from those base tables via security_invoker.';
