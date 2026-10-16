CREATE OR REPLACE FUNCTION public.manage_bob_message_feedback(
  p_message_id uuid,
  p_rating text,
  p_note text DEFAULT NULL
)
RETURNS public.bob_message_feedback
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_message public.bob_messages%ROWTYPE;
  v_conversation public.bob_conversations%ROWTYPE;
  v_note text := NULLIF(btrim(p_note), '');
  v_feedback public.bob_message_feedback%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_rating NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'Rating must be up or down';
  END IF;

  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Feedback note must be 1000 characters or fewer';
  END IF;

  SELECT *
  INTO v_message
  FROM public.bob_messages
  WHERE id = p_message_id;

  IF v_message.id IS NULL OR v_message.role <> 'assistant' THEN
    RAISE EXCEPTION 'Assistant message not found';
  END IF;

  SELECT *
  INTO v_conversation
  FROM public.bob_conversations
  WHERE id = v_message.conversation_id
    AND organization_id = v_message.organization_id;

  IF v_conversation.id IS NULL
     OR v_conversation.user_id <> v_actor
     OR NOT public.org_access_allowed(v_message.organization_id) THEN
    RAISE EXCEPTION 'Message feedback is not authorized';
  END IF;

  INSERT INTO public.bob_message_feedback (
    organization_id,
    conversation_id,
    message_id,
    user_id,
    rating,
    note
  )
  VALUES (
    v_message.organization_id,
    v_message.conversation_id,
    v_message.id,
    v_actor,
    p_rating,
    CASE WHEN p_rating = 'down' THEN v_note ELSE NULL END
  )
  ON CONFLICT (message_id, user_id) DO UPDATE
  SET rating = EXCLUDED.rating,
      note = EXCLUDED.note
  RETURNING * INTO v_feedback;

  RETURN v_feedback;
END;
$function$;

COMMENT ON FUNCTION public.manage_bob_message_feedback(uuid, text, text) IS
  'Records or updates the caller feedback for one assistant reply in their own Bob conversation. Organization, conversation, and user are derived from the persisted message.';

REVOKE ALL ON FUNCTION public.manage_bob_message_feedback(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_bob_message_feedback(uuid, text, text) TO authenticated, service_role;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.bob_message_feedback FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.bob_message_feedback TO authenticated;
GRANT ALL ON TABLE public.bob_message_feedback TO service_role;