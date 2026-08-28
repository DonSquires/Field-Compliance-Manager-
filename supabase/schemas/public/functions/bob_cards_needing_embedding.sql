create or replace function public.bob_cards_needing_embedding (
  match_limit integer default 25
)
  returns table (
    id      uuid,
    title   text,
    content text
  )
  language sql
  security definer
  set search_path to 'public'
  AS $function$
  select c.id, c.title, c.content
  from public.bob_knowledge_cards c
  where c.is_active
    and (
      c.embedding is null
      or c.embedded_at is null
      or c.embedded_at < c.updated_at
    )
  order by c.embedded_at asc nulls first, c.updated_at asc
  limit greatest(1, least(match_limit, 100));
$function$;

grant execute on function "public"."bob_cards_needing_embedding"(integer) to "anon", "authenticated", "postgres", "service_role";

comment on function "public"."bob_cards_needing_embedding"(integer) is 'Bob RAG embed backfill: active cards that are new or whose content changed since last embed (embedding IS NULL OR embedded_at IS NULL OR embedded_at < updated_at). Stalest-first. Service-role only.';

revoke all on function "public"."bob_cards_needing_embedding"(integer) from public;
