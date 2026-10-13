-- Keep structural FK reach separate from weak source references and return one
-- nearest path per reachable node.

CREATE OR REPLACE FUNCTION public.bob_atlas_fk_reach(
  p_from_type text,
  p_from_name text,
  p_max_depth integer DEFAULT 8
)
RETURNS TABLE(
  entity_type text,
  entity_name text,
  depth integer,
  edge_kind text,
  edge_from text,
  edge_to text,
  path text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH RECURSIVE walk AS (
    SELECT
      p_from_type::text AS entity_type,
      p_from_name::text AS entity_name,
      0 AS depth,
      NULL::text AS edge_kind,
      NULL::text AS edge_from,
      NULL::text AS edge_to,
      ARRAY[p_from_type || ':' || p_from_name]::text[] AS path
    UNION ALL
    SELECT
      neighbour.entity_type,
      neighbour.entity_name,
      walk.depth + 1,
      edge.edge_kind,
      edge.source_type || ':' || edge.source_name,
      edge.target_type || ':' || edge.target_name,
      walk.path || (neighbour.entity_type || ':' || neighbour.entity_name)
    FROM walk
    JOIN public.bob_app_map_edges edge
      ON edge.retirement_status = 'live'
     AND edge.edge_kind = 'fk_references'
     AND (
          (edge.source_type = walk.entity_type AND edge.source_name = walk.entity_name)
       OR (edge.target_type = walk.entity_type AND edge.target_name = walk.entity_name)
     )
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN edge.source_type = walk.entity_type AND edge.source_name = walk.entity_name
            THEN edge.target_type
          ELSE edge.source_type
        END AS entity_type,
        CASE
          WHEN edge.source_type = walk.entity_type AND edge.source_name = walk.entity_name
            THEN edge.target_name
          ELSE edge.source_name
        END AS entity_name
    ) neighbour
    WHERE walk.depth < LEAST(GREATEST(COALESCE(p_max_depth, 8), 1), 20)
      AND NOT (neighbour.entity_type || ':' || neighbour.entity_name) = ANY(walk.path)
  ),
  nearest AS (
    SELECT DISTINCT ON (walk.entity_type, walk.entity_name)
      walk.entity_type,
      walk.entity_name,
      walk.depth,
      walk.edge_kind,
      walk.edge_from,
      walk.edge_to,
      walk.path
    FROM walk
    WHERE walk.depth > 0
    ORDER BY walk.entity_type, walk.entity_name, walk.depth, cardinality(walk.path), walk.path
  )
  SELECT
    nearest.entity_type,
    nearest.entity_name,
    nearest.depth,
    nearest.edge_kind,
    nearest.edge_from,
    nearest.edge_to,
    nearest.path
  FROM nearest
  ORDER BY nearest.depth, nearest.entity_type, nearest.entity_name;
$function$;

COMMENT ON FUNCTION public.bob_atlas_fk_reach(text, text, integer)
IS 'Atlas blast-radius: undirected live fk_references adjacency only, cycle-guarded and deduplicated to the nearest path per node. Structural relation is not proof of data flow.';

REVOKE ALL ON FUNCTION public.bob_atlas_fk_reach(text, text, integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bob_atlas_fk_reach(text, text, integer)
TO postgres, service_role;
