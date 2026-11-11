-- Owner direction: give Builder jobs, Vibe sessions and Bob conversations
-- stable, human-readable references without changing their access policies.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.bob_assign_human_reference_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  sequence_name regclass;
BEGIN
  IF NEW.human_reference_number IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Human reference numbers are allocated automatically';
  END IF;
  sequence_name := pg_catalog.pg_get_serial_sequence(
    pg_catalog.format('%I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME), 'human_reference_number'
  )::regclass;
  IF sequence_name IS NULL THEN
    RAISE EXCEPTION 'Human reference sequence is not configured for %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;
  NEW.human_reference_number := pg_catalog.nextval(sequence_name);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.bob_guard_human_reference_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.human_reference_number IS DISTINCT FROM OLD.human_reference_number THEN
    RAISE EXCEPTION 'Human reference numbers are immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bob_assign_human_reference_number()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bob_guard_human_reference_number()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS bob_messages_first_user_history_idx
  ON public.bob_messages (conversation_id, organization_id, created_at, id)
  WHERE role = 'user';

ALTER TABLE public.bob_conversations
  ADD COLUMN IF NOT EXISTS title_manually_set boolean NOT NULL DEFAULT false;
ALTER TABLE public.builder_vibe_sessions
  ADD COLUMN IF NOT EXISTS title_manually_set boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bob_conversations.title_manually_set IS
  'An owner explicitly chose the conversation title; first-message naming must not replace it.';
COMMENT ON COLUMN public.builder_vibe_sessions.title_manually_set IS
  'An owner explicitly chose the session title; first-message naming must not replace it.';

CREATE OR REPLACE FUNCTION public.builder_vibe_session_open(p_title text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
  v_id uuid;
  v_title text := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(p_title), ''), 'Untitled vibe session'), 160);
BEGIN
  INSERT INTO public.builder_vibe_sessions (created_by, title, title_manually_set)
  VALUES (v_user, v_title, nullif(pg_catalog.btrim(p_title), '') IS NOT NULL)
  RETURNING id INTO v_id;
  INSERT INTO public.builder_vibe_messages (session_id, role, kind, content, created_by)
  VALUES (v_id, 'system', 'status', 'Session opened. Bob will branch from the current main on your first message.', v_user);
  RETURN v_id;
END;
$$;

DO $$
DECLARE
  target record;
  sequence_name regclass;
  greatest_number bigint;
  has_existing_rows boolean;
  number_identity "char";
  number_has_default boolean;
  reference_generated "char";
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('builder_jobs', 'BB-'),
      ('builder_vibe_sessions', 'VB-'),
      ('bob_conversations', 'BOB-')
    ) AS targets(table_name, prefix)
  LOOP
    SELECT a.attidentity, a.atthasdef
      INTO number_identity, number_has_default
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = pg_catalog.to_regclass(pg_catalog.format('public.%I', target.table_name))
       AND a.attname = 'human_reference_number'
       AND NOT a.attisdropped;

    IF NOT FOUND THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I ADD COLUMN human_reference_number bigint',
        target.table_name
      );
      EXECUTE pg_catalog.format(
        'WITH ordered AS (
           SELECT id, row_number() OVER (ORDER BY created_at, id) AS reference_number
             FROM public.%1$I
         )
         UPDATE public.%1$I AS record
            SET human_reference_number = ordered.reference_number
           FROM ordered
          WHERE record.id = ordered.id',
        target.table_name
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I ALTER COLUMN human_reference_number SET NOT NULL',
        target.table_name
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I ALTER COLUMN human_reference_number SET DEFAULT 0',
        target.table_name
      );
      EXECUTE pg_catalog.format(
        'CREATE SEQUENCE public.%I AS bigint OWNED BY public.%I.human_reference_number',
        target.table_name || '_human_reference_number_seq', target.table_name
      );
      EXECUTE pg_catalog.format(
        'SELECT coalesce(max(human_reference_number), 1), max(human_reference_number) IS NOT NULL FROM public.%I',
        target.table_name
      ) INTO greatest_number, has_existing_rows;
      sequence_name := pg_catalog.pg_get_serial_sequence(
        pg_catalog.format('public.%I', target.table_name), 'human_reference_number'
      )::regclass;
      PERFORM pg_catalog.setval(sequence_name, greatest_number, has_existing_rows);
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I ADD COLUMN human_reference text GENERATED ALWAYS AS (%L || human_reference_number::text) STORED',
        target.table_name, target.prefix
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (human_reference)',
        target.table_name, target.table_name || '_human_reference_key'
      );
      IF target.table_name = 'builder_vibe_sessions' THEN
        WITH first_requests AS (
          SELECT DISTINCT ON (message.session_id) message.session_id,
            pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(message.content, '[[:space:]]+', ' ', 'g')), 160) AS title
          FROM public.builder_vibe_messages AS message
          WHERE message.role = 'owner' AND message.kind = 'message'
            AND coalesce(message.payload->>'action', 'message') = 'message'
            AND pg_catalog.btrim(pg_catalog.regexp_replace(message.content, '[[:space:]]+', ' ', 'g')) <> ''
          ORDER BY message.session_id, message.seq, message.id
        )
        UPDATE public.builder_vibe_sessions AS session
           SET title = first_requests.title
          FROM first_requests
         WHERE session.id = first_requests.session_id
           AND session.title = 'Untitled vibe session';
      ELSIF target.table_name = 'bob_conversations' THEN
        WITH first_requests AS (
          SELECT DISTINCT ON (message.conversation_id) message.conversation_id,
            pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(message.content, '[[:space:]]+', ' ', 'g')), 160) AS title
          FROM public.bob_messages AS message
          JOIN public.bob_conversations AS conversation
            ON conversation.id = message.conversation_id
           AND conversation.organization_id = message.organization_id
          WHERE message.role = 'user'
            AND pg_catalog.btrim(pg_catalog.regexp_replace(message.content, '[[:space:]]+', ' ', 'g')) <> ''
          ORDER BY message.conversation_id, message.created_at, message.id
        )
        UPDATE public.bob_conversations AS conversation
           SET title = first_requests.title
          FROM first_requests
         WHERE conversation.id = first_requests.conversation_id
           AND (conversation.title IS NULL OR conversation.title IN ('Bob Operations', 'Bob Builder'));
      END IF;
    ELSE
      SELECT a.attgenerated
        INTO reference_generated
        FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass(pg_catalog.format('public.%I', target.table_name))
         AND a.attname = 'human_reference'
         AND NOT a.attisdropped;
      sequence_name := pg_catalog.pg_get_serial_sequence(
        pg_catalog.format('public.%I', target.table_name), 'human_reference_number'
      )::regclass;
      IF number_identity <> ''
         OR number_has_default IS DISTINCT FROM true
         OR reference_generated IS DISTINCT FROM 's'
         OR sequence_name IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint c
            WHERE c.conrelid = pg_catalog.to_regclass(pg_catalog.format('public.%I', target.table_name))
              AND c.conname = target.table_name || '_human_reference_key'
              AND c.contype = 'u'
         ) THEN
        RAISE EXCEPTION 'Human reference columns for % are incomplete or incompatible', target.table_name;
      END IF;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
      sequence_name
    );
    EXECUTE pg_catalog.format(
      'CREATE OR REPLACE TRIGGER bob_human_reference_assign
       BEFORE INSERT ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.bob_assign_human_reference_number()',
      target.table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE OR REPLACE TRIGGER bob_human_reference_immutable
       BEFORE UPDATE OF human_reference_number ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.bob_guard_human_reference_number()',
      target.table_name
    );
    EXECUTE pg_catalog.format(
      'COMMENT ON COLUMN public.%I.human_reference IS %L',
      target.table_name, 'Stable human-readable reference; allocated independently for this type of record.'
    );
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS builder_jobs_created_id_history_idx
  ON public.builder_jobs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS bob_conversations_user_org_mode_history_idx
  ON public.bob_conversations (user_id, organization_id, module_key, updated_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.bob_list_conversations(
  p_organization_id uuid,
  p_module_key text,
  p_search text,
  p_filter text,
  p_cursor_updated_at timestamptz,
  p_cursor_id uuid,
  p_page_size integer
)
RETURNS TABLE (
  id uuid,
  human_reference text,
  title text,
  pinned boolean,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  search_term text := pg_catalog.btrim(coalesce(p_search, ''));
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR p_module_key IS NULL
     OR p_filter IS NULL OR p_filter NOT IN ('all', 'pinned', 'archived')
     OR p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 100
     OR pg_catalog.char_length(search_term) > 160 THEN
    RAISE EXCEPTION 'Invalid Bob history request';
  END IF;
  IF (p_cursor_updated_at IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid Bob history cursor';
  END IF;

  RETURN QUERY
  SELECT conversation.id, conversation.human_reference, conversation.title,
    conversation.pinned, conversation.archived_at, conversation.created_at, conversation.updated_at
  FROM public.bob_conversations AS conversation
  WHERE conversation.organization_id = p_organization_id
    AND conversation.user_id = auth.uid()
    AND conversation.module_key = p_module_key
    AND (
      (p_filter = 'archived' AND conversation.archived_at IS NOT NULL)
      OR (p_filter = 'all' AND conversation.archived_at IS NULL)
      OR (p_filter = 'pinned' AND conversation.archived_at IS NULL AND conversation.pinned)
    )
    AND (search_term = ''
      OR pg_catalog.strpos(pg_catalog.lower(coalesce(conversation.title, '')), pg_catalog.lower(search_term)) > 0
      OR pg_catalog.strpos(pg_catalog.lower(conversation.human_reference), pg_catalog.lower(search_term)) > 0)
    AND (p_cursor_updated_at IS NULL
      OR (conversation.updated_at, conversation.id) < (p_cursor_updated_at, p_cursor_id))
  ORDER BY conversation.updated_at DESC, conversation.id DESC
  LIMIT p_page_size + 1;
END;
$$;

REVOKE ALL ON FUNCTION public.bob_list_conversations(uuid, text, text, text, timestamptz, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bob_list_conversations(uuid, text, text, text, timestamptz, uuid, integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.bob_name_first_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  first_title text := pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(NEW.content, '[[:space:]]+', ' ', 'g')), 160);
BEGIN
  IF NEW.role = 'user' AND first_title <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.bob_messages AS earlier
        WHERE earlier.conversation_id = NEW.conversation_id
          AND earlier.organization_id = NEW.organization_id
          AND earlier.role = 'user'
          AND pg_catalog.btrim(pg_catalog.regexp_replace(earlier.content, '[[:space:]]+', ' ', 'g')) <> ''
          AND (earlier.created_at, earlier.id) < (NEW.created_at, NEW.id)
     ) THEN
    UPDATE public.bob_conversations SET title = first_title
     WHERE id = NEW.conversation_id AND organization_id = NEW.organization_id
       AND (user_id = auth.uid() OR pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER'))
       AND NOT title_manually_set
       AND (title IS NULL OR title IN ('Bob Operations', 'Bob Builder'));
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bob_name_first_request()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE TRIGGER bob_name_first_request
  AFTER INSERT ON public.bob_messages
  FOR EACH ROW EXECUTE FUNCTION public.bob_name_first_request();

CREATE OR REPLACE FUNCTION public.bob_rename_conversation(
  p_conversation_id uuid,
  p_organization_id uuid,
  p_module_key text,
  p_expected_title text,
  p_title text
)
RETURNS public.bob_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  conversation public.bob_conversations%ROWTYPE;
  next_title text := pg_catalog.btrim(p_title);
BEGIN
  IF actor IS NULL OR p_organization_id IS NULL OR NOT (
    public.is_grand_master()
    OR coalesce(p_organization_id = ANY(public.accessible_org_ids()), false)
  ) THEN
    RAISE EXCEPTION 'Bob conversation is unavailable';
  END IF;
  IF p_conversation_id IS NULL OR p_module_key IS NULL OR next_title IS NULL
     OR next_title !~ '[^[:space:]]' OR pg_catalog.char_length(next_title) > 160 THEN
    RAISE EXCEPTION 'A valid Bob conversation title is required';
  END IF;

  SELECT * INTO conversation FROM public.bob_conversations
   WHERE id = p_conversation_id AND organization_id = p_organization_id
     AND user_id = actor AND module_key = p_module_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bob conversation is unavailable';
  END IF;
  IF conversation.title = next_title AND conversation.title_manually_set THEN
    RETURN conversation;
  END IF;
  IF conversation.title IS DISTINCT FROM p_expected_title THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'Bob conversation title changed; refresh before saving';
  END IF;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (conversation.organization_id, actor, 'bob_conversation_renamed', 'bob_conversations', conversation.id,
    pg_catalog.jsonb_build_object('previous_title', conversation.title, 'title', next_title));
  UPDATE public.bob_conversations SET title = next_title, title_manually_set = true, updated_at = pg_catalog.clock_timestamp()
    WHERE id = conversation.id RETURNING * INTO conversation;
  RETURN conversation;
END;
$$;

REVOKE ALL ON FUNCTION public.bob_rename_conversation(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bob_rename_conversation(uuid, uuid, text, text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.builder_vibe_name_first_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  first_title text := pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(NEW.content, '[[:space:]]+', ' ', 'g')), 160);
BEGIN
  IF NEW.role = 'owner' AND NEW.kind = 'message'
     AND coalesce(NEW.payload->>'action', 'message') = 'message'
     AND first_title <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.builder_vibe_messages AS earlier
        WHERE earlier.session_id = NEW.session_id AND earlier.role = 'owner' AND earlier.kind = 'message'
          AND coalesce(earlier.payload->>'action', 'message') = 'message'
          AND pg_catalog.btrim(pg_catalog.regexp_replace(earlier.content, '[[:space:]]+', ' ', 'g')) <> ''
          AND (earlier.seq, earlier.id) < (NEW.seq, NEW.id)
     ) THEN
    UPDATE public.builder_vibe_sessions SET title = first_title
     WHERE id = NEW.session_id AND NOT title_manually_set AND title = 'Untitled vibe session';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_vibe_name_first_request()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE TRIGGER builder_vibe_name_first_request
  AFTER INSERT ON public.builder_vibe_messages
  FOR EACH ROW EXECUTE FUNCTION public.builder_vibe_name_first_request();

CREATE OR REPLACE FUNCTION public.builder_vibe_rename_session(
  p_session_id uuid,
  p_expected_title text,
  p_title text
)
RETURNS public.builder_vibe_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := public.builder_vibe_require_owner();
  session public.builder_vibe_sessions%ROWTYPE;
  next_title text := pg_catalog.btrim(p_title);
BEGIN
  IF p_session_id IS NULL OR p_expected_title IS NULL OR next_title IS NULL
     OR next_title !~ '[^[:space:]]' OR pg_catalog.char_length(next_title) > 160 THEN
    RAISE EXCEPTION 'A valid Vibe session title is required';
  END IF;

  SELECT * INTO session FROM public.builder_vibe_sessions
    WHERE id = p_session_id AND created_by = actor FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vibe session is unavailable';
  END IF;
  IF session.title = next_title AND session.title_manually_set THEN
    RETURN session;
  END IF;
  IF session.title IS DISTINCT FROM p_expected_title THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'Vibe session title changed; refresh before saving';
  END IF;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (NULL, actor, 'builder_vibe_session_renamed', 'builder_vibe_sessions', session.id,
    pg_catalog.jsonb_build_object('previous_title', session.title, 'title', next_title));
  UPDATE public.builder_vibe_sessions SET title = next_title, title_manually_set = true, updated_at = pg_catalog.clock_timestamp()
    WHERE id = session.id RETURNING * INTO session;
  RETURN session;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_vibe_rename_session(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_vibe_rename_session(uuid, text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.builder_rename_job(
  p_job_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_expected_title text,
  p_title text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  job public.builder_jobs%ROWTYPE;
  next_title text := pg_catalog.btrim(p_title);
BEGIN
  IF p_job_id IS NULL OR p_organization_id IS NULL OR p_actor_user_id IS NULL
     OR p_expected_title IS NULL OR next_title IS NULL
     OR next_title !~ '[^[:space:]]' OR pg_catalog.char_length(next_title) > 200 THEN
    RAISE EXCEPTION 'A valid Builder job title is required';
  END IF;

  SELECT * INTO job FROM public.builder_jobs
    WHERE id = p_job_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Builder job is unavailable';
  END IF;
  IF job.title = next_title THEN
    RETURN job;
  END IF;
  IF job.title IS DISTINCT FROM p_expected_title THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'Builder job title changed; refresh before saving';
  END IF;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (job.organization_id, p_actor_user_id, 'builder_job_renamed', 'builder_jobs', job.id,
    pg_catalog.jsonb_build_object('previous_title', job.title, 'title', next_title));
  UPDATE public.builder_jobs SET title = next_title, updated_at = pg_catalog.clock_timestamp()
    WHERE id = job.id RETURNING * INTO job;
  RETURN job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_rename_job(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_rename_job(uuid, uuid, uuid, text, text)
  TO service_role;

COMMIT;