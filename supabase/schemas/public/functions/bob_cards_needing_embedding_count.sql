create or replace function public.bob_cards_needing_embedding_count()
  returns bigint
  language sql
  security definer
  set search_path to 'public'
  AS $function$
  select count(*)
  from public.bob_knowledge_cards c
  where c.is_active
    and (
      c.embedding is null
      or c.embedded_at is null
      or c.embedded_at < c.updated_at
    );
$function$;

grant execute on function "public"."bob_cards_needing_embedding_count"() to "postgres", "service_role";

comment on function "public"."bob_cards_needing_embedding_count"() is 'Count of active cards needing (re-)embedding, using the same predicate as bob_cards_needing_embedding. Feeds the embed job pending==0 stop condition.';

revoke all on function "public"."bob_cards_needing_embedding_count"() from public;
