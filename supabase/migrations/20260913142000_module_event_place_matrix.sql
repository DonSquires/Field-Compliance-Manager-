-- Read-only module scope matrix: place anchor precedence across modules, rules,
-- and geofence/jurisdiction context, without altering historical event data.
CREATE OR REPLACE VIEW public.module_event_place_matrix
WITH (security_invoker = true)
AS
WITH module_catalog AS (
  SELECT
    om.organization_id,
    om.module_key,
    om.enabled,
    (
      SELECT mrs.name
      FROM public.module_rule_sets mrs
      WHERE mrs.organization_id = om.organization_id
        AND mrs.module_key = om.module_key
      ORDER BY mrs.created_at DESC
      LIMIT 1
    ) AS rule_set_name,
    (
      SELECT jrs.name
      FROM public.jurisdiction_rule_sets jrs
      WHERE jrs.organization_id = om.organization_id
        AND jrs.module_key = om.module_key
      ORDER BY jrs.created_at DESC
      LIMIT 1
    ) AS jurisdiction_rule_set_name
  FROM public.organization_modules om
),
anchor_counts AS (
  SELECT
    p.organization_id,
    p.module_key,
    p.anchor_kind,
    COUNT(*) AS event_count
  FROM public.house_event_anchor_projection p
  WHERE p.module_key IS NOT NULL
  GROUP BY p.organization_id, p.module_key, p.anchor_kind
),
module_anchor_summary AS (
  SELECT
    organization_id,
    module_key,
    anchor_kind,
    MAX(event_count) AS event_count
  FROM anchor_counts
  GROUP BY organization_id, module_key, anchor_kind
)
SELECT
  mc.organization_id,
  mc.module_key,
  mc.enabled,
  mc.rule_set_name,
  mc.jurisdiction_rule_set_name,
  CASE
    WHEN mc.module_key IS NULL THEN 'unsupported'
    WHEN EXISTS (
      SELECT 1
      FROM public.house_event_anchor_projection p
      WHERE p.organization_id = mc.organization_id
        AND p.module_key = mc.module_key
        AND p.anchor_kind = 'checkpoint'
    ) THEN 'checkpoint'
    WHEN EXISTS (
      SELECT 1
      FROM public.house_event_anchor_projection p
      WHERE p.organization_id = mc.organization_id
        AND p.module_key = mc.module_key
        AND p.anchor_kind = 'site'
    ) THEN 'site'
    WHEN EXISTS (
      SELECT 1
      FROM public.house_event_anchor_projection p
      WHERE p.organization_id = mc.organization_id
        AND p.module_key = mc.module_key
        AND p.anchor_kind = 'zone'
    ) THEN 'zone'
    WHEN EXISTS (
      SELECT 1
      FROM public.house_event_anchor_projection p
      WHERE p.organization_id = mc.organization_id
        AND p.module_key = mc.module_key
        AND p.anchor_kind = 'house'
    ) THEN 'house'
    ELSE 'unresolved'
  END AS dominant_anchor_kind,
  COALESCE((
    SELECT SUM(mas.event_count)
    FROM module_anchor_summary mas
    WHERE mas.organization_id = mc.organization_id
      AND mas.module_key = mc.module_key
  ), 0) AS total_event_count,
  COALESCE((
    SELECT SUM(CASE WHEN mas.anchor_kind = 'unresolved' THEN mas.event_count ELSE 0 END)
    FROM module_anchor_summary mas
    WHERE mas.organization_id = mc.organization_id
      AND mas.module_key = mc.module_key
  ), 0) AS unresolved_event_count,
  COALESCE((
    SELECT SUM(CASE WHEN mas.anchor_kind = 'checkpoint' THEN mas.event_count ELSE 0 END)
    FROM module_anchor_summary mas
    WHERE mas.organization_id = mc.organization_id
      AND mas.module_key = mc.module_key
  ), 0) AS checkpoint_event_count,
  COALESCE((
    SELECT SUM(CASE WHEN mas.anchor_kind = 'site' THEN mas.event_count ELSE 0 END)
    FROM module_anchor_summary mas
    WHERE mas.organization_id = mc.organization_id
      AND mas.module_key = mc.module_key
  ), 0) AS site_event_count,
  COALESCE((
    SELECT SUM(CASE WHEN mas.anchor_kind = 'zone' THEN mas.event_count ELSE 0 END)
    FROM module_anchor_summary mas
    WHERE mas.organization_id = mc.organization_id
      AND mas.module_key = mc.module_key
  ), 0) AS zone_event_count
FROM module_catalog mc
ORDER BY mc.organization_id, mc.module_key;

COMMENT ON VIEW public.module_event_place_matrix IS
  'Read-only module rule and place-anchor matrix for enterprise reconciliation. Classifies current event coverage by module and place anchor precedence without mutating history.';

REVOKE ALL ON public.module_event_place_matrix FROM anon;
GRANT SELECT ON public.module_event_place_matrix TO authenticated, service_role;
