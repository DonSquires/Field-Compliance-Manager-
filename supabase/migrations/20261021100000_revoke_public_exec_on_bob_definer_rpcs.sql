-- Bob service-role-only SECURITY DEFINER RPCs were executable by anon (and most by
-- authenticated) via PostgREST /rpc. bob_execute_read_query runs arbitrary SELECTs
-- with RLS bypassed and has no caller check in its body. Every legitimate caller is
-- a service-role edge function, so restrict EXECUTE to service_role (and postgres).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.bob_execute_read_query(text,integer,integer)',
    'public.bob_cards_needing_embedding(integer)',
    'public.bob_cards_needing_embedding_count()',
    'public.bob_atlas_flow_reach(text,text,text,integer)',
    'public.bob_inspect_schema(text[],boolean)',
    'public.bob_match_knowledge(public.vector,integer,uuid)',
    'public.bob_recall_prior_context(text,uuid,integer,integer)',
    'public.bob_search_reference_documents(text,text,uuid,text,text,text[],boolean,integer)',
    'public.bob_site_risk(uuid,integer,boolean,uuid[])',
    'public.bob_ingest_knowledge_card_384(uuid,text,text,text,text,public.vector,text[],text,boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;
