-- A PM packet extends the existing isolated research lane, never private chat context.
CREATE OR REPLACE FUNCTION public.builder_chat_send_pm(
  p_thread_id uuid,
  p_content text,
  p_client_request_id text,
  p_purpose text DEFAULT 'pm',
  p_evidence_summary text DEFAULT '',
  p_files jsonb DEFAULT '[]'::jsonb,
  p_urls jsonb DEFAULT '[]'::jsonb,
  p_web_search boolean DEFAULT false,
  p_allow_cloud boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_id uuid;
  v_existing public.builder_chat_messages%ROWTYPE;
  v_hash text;
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('pm', 'qa', 'technical_review') THEN
    RAISE EXCEPTION 'Cloud PM purpose must be pm, qa or technical_review';
  END IF;
  IF p_evidence_summary IS NULL OR char_length(p_evidence_summary) > 6000 THEN
    RAISE EXCEPTION 'Reviewed evidence summary must be at most 6000 characters';
  END IF;
  v_hash := encode(extensions.digest(convert_to(p_evidence_summary, 'UTF8'), 'sha256'), 'hex');
  PERFORM 1 FROM public.builder_chat_threads
    WHERE id = p_thread_id AND created_by = v_user AND status <> 'closed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Open Builder chat not found for this owner'; END IF;
  SELECT * INTO v_existing FROM public.builder_chat_messages
    WHERE thread_id = p_thread_id AND client_request_id = p_client_request_id;
  IF FOUND AND (
    v_existing.payload->>'pm_purpose' IS DISTINCT FROM p_purpose
    OR v_existing.payload->>'evidence_summary' IS DISTINCT FROM p_evidence_summary
  ) THEN
    RAISE EXCEPTION 'Request id was already used with different PM purpose or summary';
  END IF;
  -- The existing function enforces ownership, consent, attachment scope and exact retries.
  v_id := public.builder_chat_send_research(
    p_thread_id, p_content, p_client_request_id, p_files, p_urls, p_web_search, p_allow_cloud
  );
  UPDATE public.builder_chat_messages SET payload =
    payload || jsonb_build_object('pm_purpose', p_purpose, 'evidence_summary', p_evidence_summary,
      'research_consent', (payload->'research_consent') || jsonb_build_object(
        'pm_purpose', p_purpose, 'evidence_summary_sha256', v_hash))
    WHERE id = v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_chat_send_pm(uuid, text, text, text, text, jsonb, jsonb, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.builder_chat_send_pm(uuid, text, text, text, text, jsonb, jsonb, boolean, boolean) TO authenticated;

COMMENT ON FUNCTION public.builder_chat_send_pm(uuid, text, text, text, text, jsonb, jsonb, boolean, boolean) IS
  'Owner-approved isolated Ollama Cloud PM/QA packet. Fixed purpose model, human-reviewed non-sensitive summary, no private history/source or automatic inference fallback. Advisory briefs do not create jobs.';
