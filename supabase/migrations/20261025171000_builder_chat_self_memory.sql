-- Reuse Bob's graduated diary. A memory is not an approved fact or a conduct score.
CREATE OR REPLACE FUNCTION public.builder_chat_remember(
  p_message_id uuid,
  p_content text,
  p_memory_type text DEFAULT 'builder_note'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.builder_chat_messages%ROWTYPE;
  v_memory_id uuid;
  v_text text;
BEGIN
  IF p_content IS NULL OR char_length(btrim(p_content)) NOT BETWEEN 1 AND 2000
     OR p_memory_type IS NULL OR p_memory_type NOT IN ('reflection', 'builder_note') THEN
    RAISE EXCEPTION 'Diary entry requires bounded content and reflection or builder_note type';
  END IF;
  SELECT m.* INTO v_message FROM public.builder_chat_messages m
    JOIN public.builder_chat_threads t ON t.id = m.thread_id
    WHERE m.id = p_message_id AND m.role = 'owner'
      AND m.created_by = t.created_by
      AND (public.is_platform_owner(m.created_by) OR EXISTS (
        SELECT 1 FROM public.user_profiles p WHERE p.id = m.created_by AND p.role::text = 'grand_master'))
      AND m.status IN ('claimed', 'done')
      AND m.payload->>'pm_purpose' IN ('pm', 'qa', 'technical_review')
      AND m.payload->'research_consent'->>'allowed' = 'true';
  IF NOT FOUND THEN RAISE EXCEPTION 'Approved owner PM message not found'; END IF;
  v_text := btrim(p_content) || E'\n\n[Bob Builder Chat self-memory; unverified reflection, not approved knowledge.'
    || ' Source message: ' || p_message_id::text || '; thread: ' || v_message.thread_id::text || ']';
  v_memory_id := substring(encode(extensions.digest(
    'builder-chat-memory:' || p_message_id::text || ':' || p_memory_type || ':' || btrim(p_content),
    'sha256'), 'hex') FROM 1 FOR 32)::uuid;
  INSERT INTO public.bob_self_memory(id, memory_text, memory_kind, proposed_by, status)
    VALUES (v_memory_id, v_text, p_memory_type, '00000000-0000-0000-0000-00000000b0b0', 'kept')
    ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.bob_self_memory WHERE id = v_memory_id
    AND memory_text = v_text AND memory_kind = p_memory_type
    AND proposed_by = '00000000-0000-0000-0000-00000000b0b0' AND status = 'kept') THEN
    RAISE EXCEPTION 'Diary receipt conflicts with an existing immutable entry';
  END IF;
  RETURN v_memory_id;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_chat_remember(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_chat_remember(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.builder_chat_remember(uuid, text, text) IS
  'Service worker append-only reuse of Bob own diary from an approved owner PM turn. Retry-safe, no approval/bell for memory writes, no approved knowledge or conduct promotion. No tenant-specific data belongs in this global diary.';
