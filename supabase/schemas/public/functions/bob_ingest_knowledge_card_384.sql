create or replace function public.bob_ingest_knowledge_card_384 (
  in_organization_id uuid,
  in_category        text,
  in_key             text,
  in_title           text,
  in_content         text,
  in_embedding_384   public.vector,
  in_tags            text[]        default '{}'::text[],
  in_source          text          default null::text,
  in_is_active       boolean       default true
)
  returns uuid
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.bob_knowledge_cards (
    organization_id,
    category,
    key,
    title,
    content,
    tags,
    source,
    is_active,
    embedding_384,
    embedding_model,
    embedded_at
  )
  VALUES (
    in_organization_id,
    in_category,
    in_key,
    in_title,
    in_content,
    COALESCE(in_tags, '{}'),
    in_source,
    COALESCE(in_is_active, true),
    in_embedding_384,
    'gte-small',
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

grant execute
  on function "public"."bob_ingest_knowledge_card_384"(uuid, text, text, text, text, public.vector, text[], text, boolean)
  to public, "anon", "authenticated", "postgres", "service_role";
