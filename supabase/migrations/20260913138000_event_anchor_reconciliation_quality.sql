-- Reconciliation overlay for the read-only projection. It makes historical
-- checkpoint/facet mismatches enumerable without mutating old events.
CREATE OR REPLACE VIEW public.house_event_anchor_reconciliation
WITH (security_invoker = true)
AS
SELECT
  p.*,
  CASE
    WHEN p.source_table <> 'location_events' OR p.checkpoint_id IS NULL THEN 'not_applicable'
    WHEN cp.id IS NULL THEN 'invalid_missing_checkpoint'
    WHEN cp.organization_id IS DISTINCT FROM p.organization_id THEN 'invalid_organization'
    WHEN cp.client_site_id IS NOT NULL AND p.client_site_id = cp.client_site_id AND p.zone_id IS NULL THEN 'valid'
    WHEN cp.zone_id IS NOT NULL AND p.zone_id = cp.zone_id AND p.client_site_id IS NULL THEN 'valid'
    ELSE 'invalid_facet_mismatch'
  END AS checkpoint_consistency,
  CASE
    WHEN p.source_table = 'location_events' AND p.checkpoint_id IS NOT NULL AND (
      cp.id IS NULL
      OR cp.organization_id IS DISTINCT FROM p.organization_id
      OR (cp.client_site_id IS NOT NULL AND (p.client_site_id IS DISTINCT FROM cp.client_site_id OR p.zone_id IS NOT NULL))
      OR (cp.zone_id IS NOT NULL AND (p.zone_id IS DISTINCT FROM cp.zone_id OR p.client_site_id IS NOT NULL))
    ) THEN 'checkpoint_facet_mismatch'
    ELSE p.unresolved_reason
  END AS reconciliation_reason
FROM public.house_event_anchor_projection p
LEFT JOIN public.location_events e
  ON p.source_table = 'location_events' AND e.id = p.event_id
LEFT JOIN public.patrol_checkpoints cp ON cp.id = e.checkpoint_id;

COMMENT ON VIEW public.house_event_anchor_reconciliation IS
  'Read-only event anchor quality overlay. Adds checkpoint consistency and explicit reconciliation reasons; never rewrites historical events.';

REVOKE ALL ON public.house_event_anchor_reconciliation FROM anon;
GRANT SELECT ON public.house_event_anchor_reconciliation TO authenticated, service_role;
