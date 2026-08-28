create or replace function public.bob_match_knowledge_for_assistant_384 (
  in_query_embedding public.vector,
  in_match_threshold double precision default 0.72,
  in_match_count     integer          default 8,
  in_org_id          uuid             default null::uuid
)
  returns table (
    id              uuid,
    organization_id uuid,
    category        text,
    key             text,
    title           text,
    content         text,
    tags            text[],
    source          text,
    similarity      double precision
  )
  language sql
  stable
  AS $function$
  SELECT
    c.id,
    c.organization_id,
    c.category,
    c.key,
    c.title,
    c.content,
    c.tags,
    c.source,
    1 - (c.embedding_384 <=> in_query_embedding) AS similarity
  FROM public.bob_knowledge_cards c
  WHERE c.is_active = true
    AND c.embedding_384 IS NOT NULL
    AND (
      c.organization_id = in_org_id
      OR c.organization_id IS NULL
    )
    AND 1 - (c.embedding_384 <=> in_query_embedding) >= in_match_threshold
  ORDER BY c.embedding_384 <=> in_query_embedding
  LIMIT GREATEST(in_match_count, 1);
$function$;

grant execute
  on function "public"."bob_match_knowledge_for_assistant_384"(public.vector, double precision, integer, uuid)
  to public, "anon", "authenticated", "postgres", "service_role";
