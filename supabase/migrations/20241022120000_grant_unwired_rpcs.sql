-- Grant EXECUTE permission on unwired RPCs to the appropriate roles.
-- This migration addresses Atlas gap_report entries where RPCs exist in the schema
-- but are not wired (i.e., not granted to the client roles). Adding these grants
-- enables the web UI and edge functions to invoke the functions without permission
-- errors, fixing the observed data flow and UI UX gaps.

-- Grant for bob_ingest_knowledge_card_384
GRANT EXECUTE ON FUNCTION public.bob_ingest_knowledge_card_384(
    in_organization_id uuid,
    in_category text,
    in_key text,
    in_title text,
    in_content text,
    in_embedding_384 vector,
    in_tags text[],
    in_source text,
    in_is_active boolean
) TO anon, authenticated, service_role;

-- Grant for bob_match_knowledge_for_assistant_384
GRANT EXECUTE ON FUNCTION public.bob_match_knowledge_for_assistant_384(
    in_organization_id uuid,
    in_query_embedding vector,
    in_top_k integer,
    in_category text,
    in_key text
) TO anon, authenticated, service_role;

-- Grant for claim_document_source_ingestion
GRANT EXECUTE ON FUNCTION public.claim_document_source_ingestion(
    in_document_id uuid,
    in_source text
) TO anon, authenticated, service_role;

-- Grant for compact_cctv_inference_results
GRANT EXECUTE ON FUNCTION public.compact_cctv_inference_results(
    in_job_id uuid
) TO anon, authenticated, service_role;

-- Grant for compact_cctv_observation_thumbnail
GRANT EXECUTE ON FUNCTION public.compact_cctv_observation_thumbnail(
    in_observation_id uuid
) TO anon, authenticated, service_role;

-- Add additional grants as needed for other unwired RPCs identified by Atlas.
