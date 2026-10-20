create or replace function public.bob_match_knowledge (
  query_embedding public.vector,
  match_count     integer       default 5,
  scope_org_id    uuid          default null::uuid
)
  returns table (
    id         uuid,
    category   text,
    key        text,
    title      text,
    content    text,
    tags       text[],
    similarity double precision
  )
  language sql
  security definer
  set search_path to 'public'
  AS $function$
  select
    c.id, c.category, c.key, c.title, c.content, c.tags,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.bob_knowledge_cards c
  where c.is_active
    and c.embedding is not null
    and (c.organization_id is null or c.organization_id = scope_org_id)
  order by c.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$function$;

grant execute on function "public"."bob_match_knowledge"(public.vector, integer, uuid) to "postgres", "service_role";

comment on function "public"."bob_match_knowledge"(public.vector, integer, uuid) is 'Semantic knowledge retrieval for Bob RAG. Returns closest active cards by cosine similarity to the query embedding, scoped to platform-canonical + the caller''s org cards. Read-only.';

revoke all on function "public"."bob_match_knowledge"(public.vector, integer, uuid) from public;
