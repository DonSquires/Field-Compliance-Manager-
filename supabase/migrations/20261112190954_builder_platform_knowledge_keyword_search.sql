BEGIN;

CREATE OR REPLACE FUNCTION public.bob_search_platform_knowledge(p_terms text[], p_limit integer DEFAULT 4)
RETURNS TABLE(id uuid, key text, title text, content text, source text, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF p_terms IS NULL OR pg_catalog.cardinality(p_terms) NOT BETWEEN 1 AND 12
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_terms) term
      WHERE term IS NULL OR pg_catalog.length(term) NOT BETWEEN 3 AND 1000 OR term !~ '^[a-z0-9_]+$')
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 6 THEN
    RAISE EXCEPTION 'Use 1-12 lowercase keyword terms and a result limit of 1-6' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT card.id, card.key, card.title, card.content, card.source, card.updated_at
  FROM public.bob_knowledge_cards card
  CROSS JOIN LATERAL (
    SELECT pg_catalog.sum(
      CASE WHEN pg_catalog.strpos(pg_catalog.lower(coalesce(card.title, '')), term) > 0 THEN 4 ELSE 0 END
      + CASE WHEN pg_catalog.strpos(pg_catalog.lower(coalesce(card.key, '')), term) > 0 THEN 3 ELSE 0 END
      + CASE WHEN pg_catalog.strpos(pg_catalog.lower(coalesce(card.content, '')), term) > 0 THEN 1 ELSE 0 END
    ) AS score
    FROM pg_catalog.unnest(p_terms) term
  ) ranked
  WHERE card.organization_id IS NULL AND card.is_active AND ranked.score > 0
  ORDER BY ranked.score DESC, card.key, card.id
  LIMIT p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.bob_search_platform_knowledge(text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bob_search_platform_knowledge(text[], integer) TO service_role;
COMMENT ON FUNCTION public.bob_search_platform_knowledge(text[], integer) IS
  'Server-only read of active platform guidance. Rank all keyword matches before limiting; never reads tenant or inactive cards.';

COMMIT;