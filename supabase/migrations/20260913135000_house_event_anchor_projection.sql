-- Read-only House/event projection. This intentionally does not mutate old
-- events; it makes deterministic Site/Zone/House resolution visible while the
-- write-time event-context migration is designed under issue #18.
CREATE OR REPLACE VIEW public.house_event_anchor_projection
WITH (security_invoker = true)
AS
SELECT
  'location_events'::text AS source_table,
  e.id AS event_id,
  e.organization_id,
  e.module_key,
  e.event_type,
  e.occurred_at,
  e.checkpoint_id,
  e.client_site_id,
  e.zone_id,
  COALESCE(z.location_id, s.location_id) AS location_id,
  CASE
    WHEN e.checkpoint_id IS NOT NULL THEN 'checkpoint'
    WHEN e.client_site_id IS NOT NULL THEN 'site'
    WHEN e.zone_id IS NOT NULL THEN 'zone'
    WHEN COALESCE(z.location_id, s.location_id) IS NOT NULL THEN 'house'
    ELSE 'unresolved'
  END AS anchor_kind,
  CASE
    WHEN e.checkpoint_id IS NULL AND e.client_site_id IS NULL AND e.zone_id IS NULL THEN 'no_checkpoint_site_or_zone'
    WHEN COALESCE(z.location_id, s.location_id) IS NULL THEN 'facet_has_no_house_link'
    ELSE NULL
  END AS unresolved_reason
FROM public.location_events e
LEFT JOIN public.client_sites s ON s.id = e.client_site_id
LEFT JOIN public.location_zones z ON z.id = e.zone_id

UNION ALL

SELECT
  'observations', o.id, o.organization_id, o.module_key, 'observation', o.observed_at,
  NULL, o.site_id, o.zone_id, COALESCE(o.location_id, z.location_id, s.location_id),
  CASE
    WHEN o.site_id IS NOT NULL THEN 'site'
    WHEN o.zone_id IS NOT NULL THEN 'zone'
    WHEN COALESCE(o.location_id, z.location_id, s.location_id) IS NOT NULL THEN 'house'
    ELSE 'unresolved'
  END,
  CASE
    WHEN o.site_id IS NULL AND o.zone_id IS NULL AND o.location_id IS NULL THEN 'no_site_zone_or_house'
    WHEN COALESCE(o.location_id, z.location_id, s.location_id) IS NULL THEN 'facet_has_no_house_link'
    ELSE NULL
  END
FROM public.observations o
LEFT JOIN public.client_sites s ON s.id = o.site_id
LEFT JOIN public.location_zones z ON z.id = o.zone_id

UNION ALL

SELECT
  'noise_assessments', n.id, n.organization_id, 'noise_control', 'noise_assessment', n.assessed_at,
  NULL, n.site_id, NULL, n.location_id,
  CASE WHEN n.site_id IS NOT NULL THEN 'site' WHEN n.location_id IS NOT NULL THEN 'house' ELSE 'unresolved' END,
  CASE WHEN n.site_id IS NULL AND n.location_id IS NULL THEN 'no_site_or_house' WHEN n.location_id IS NULL THEN 'site_has_no_house_link' ELSE NULL END
FROM public.noise_assessments n

UNION ALL

SELECT
  'dispatch_jobs', d.id, d.organization_id, d.module_key, d.job_type, d.created_at,
  NULL, d.client_site_id, NULL, s.location_id,
  CASE WHEN d.client_site_id IS NOT NULL THEN 'site' WHEN s.location_id IS NOT NULL THEN 'house' ELSE 'unresolved' END,
  CASE WHEN d.client_site_id IS NULL AND s.location_id IS NULL THEN 'no_site_or_house' WHEN s.location_id IS NULL THEN 'site_has_no_house_link' ELSE NULL END
FROM public.dispatch_jobs d
LEFT JOIN public.client_sites s ON s.id = d.client_site_id;

COMMENT ON VIEW public.house_event_anchor_projection IS
  'Read-only normalized event/place projection. Anchor precedence: checkpoint, Site, Zone, House fallback, unresolved. Does not replace immutable event context; supports issue #18 backfill and reconciliation.';

REVOKE ALL ON public.house_event_anchor_projection FROM anon;
GRANT SELECT ON public.house_event_anchor_projection TO authenticated, service_role;
