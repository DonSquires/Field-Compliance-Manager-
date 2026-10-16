// Rollback-only live verification for manage_bob_message_feedback.
// Uses throwaway test identities inside one transaction that always rolls back.
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE is required');

async function sql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 900)}`);
  return text ? JSON.parse(text) : [];
}

const script = `
BEGIN;

CREATE TEMP TABLE verification_result (step text, outcome text) ON COMMIT DROP;

DO $verify$
DECLARE
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_other_user uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_assistant_message uuid := gen_random_uuid();
  v_user_message uuid := gen_random_uuid();
  v_feedback public.bob_message_feedback%ROWTYPE;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'Bob feedback rollback verification', 'service_provider');

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password, created_at, updated_at
  )
  VALUES
    (
      v_user,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      'atlas-bob-feedback+' || v_user || '@invalid.test',
      '',
      now(),
      now()
    ),
    (
      v_other_user,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      'atlas-bob-feedback+' || v_other_user || '@invalid.test',
      '',
      now(),
      now()
    );

  INSERT INTO public.user_profiles (id, organization_id, role, email)
  VALUES
    (v_user, v_org, 'officer', 'atlas-bob-feedback+' || v_user || '@invalid.test'),
    (v_other_user, v_org, 'officer', 'atlas-bob-feedback+' || v_other_user || '@invalid.test');

  INSERT INTO public.bob_conversations (id, organization_id, user_id, module_key, title)
  VALUES (v_conversation, v_org, v_user, 'operations', 'Rollback feedback verification');

  INSERT INTO public.bob_messages (
    id, organization_id, conversation_id, role, content
  )
  VALUES
    (v_assistant_message, v_org, v_conversation, 'assistant', 'Rollback-only assistant reply'),
    (v_user_message, v_org, v_conversation, 'user', 'Rollback-only user prompt');

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text,
    true
  );

  v_feedback := public.manage_bob_message_feedback(v_assistant_message, 'up', 'ignored for helpful');
  INSERT INTO verification_result VALUES (
    'helpful',
    CASE
      WHEN v_feedback.message_id = v_assistant_message
       AND v_feedback.conversation_id = v_conversation
       AND v_feedback.organization_id = v_org
       AND v_feedback.user_id = v_user
       AND v_feedback.rating = 'up'
       AND v_feedback.note IS NULL
      THEN 'PASS derived tenant receipt'
      ELSE 'FAIL incorrect helpful receipt'
    END
  );

  v_feedback := public.manage_bob_message_feedback(
    v_assistant_message,
    'down',
    'Show the selected operating branch.'
  );
  INSERT INTO verification_result VALUES (
    'improvement',
    CASE
      WHEN v_feedback.rating = 'down'
       AND v_feedback.note = 'Show the selected operating branch.'
       AND (SELECT count(*) FROM public.bob_message_feedback WHERE message_id = v_assistant_message AND user_id = v_user) = 1
      THEN 'PASS updated one persisted receipt'
      ELSE 'FAIL feedback update'
    END
  );

  BEGIN
    PERFORM public.manage_bob_message_feedback(v_assistant_message, 'sideways', NULL);
    INSERT INTO verification_result VALUES ('rating', 'FAIL invalid rating accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('rating', 'PASS refused: ' || SQLERRM);
  END;

  BEGIN
    PERFORM public.manage_bob_message_feedback(v_user_message, 'up', NULL);
    INSERT INTO verification_result VALUES ('message_role', 'FAIL user message accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('message_role', 'PASS refused: ' || SQLERRM);
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_other_user, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.manage_bob_message_feedback(v_assistant_message, 'up', NULL);
    INSERT INTO verification_result VALUES ('conversation_owner', 'FAIL another user rated the reply');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('conversation_owner', 'PASS refused: ' || SQLERRM);
  END;

  INSERT INTO verification_result VALUES (
    'direct_write_privilege',
    CASE
      WHEN NOT has_table_privilege('authenticated', 'public.bob_message_feedback', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.bob_message_feedback', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.bob_message_feedback', 'DELETE')
      THEN 'PASS direct writes revoked'
      ELSE 'FAIL authenticated still has a direct write privilege'
    END
  );
END;
$verify$;

SELECT step, outcome FROM verification_result ORDER BY step;

ROLLBACK;
`;

const rows = await sql(script);
for (const row of rows) console.log(`${row.step}: ${row.outcome}`);

const retained = await sql(`
  SELECT
    (SELECT count(*) FROM public.user_profiles WHERE email LIKE 'atlas-bob-feedback+%@invalid.test') AS test_profiles,
    (SELECT count(*) FROM public.bob_conversations WHERE title = 'Rollback feedback verification') AS test_conversations,
    (SELECT count(*) FROM public.bob_messages WHERE content LIKE 'Rollback-only %') AS test_messages
`);
console.log('retained after rollback:', JSON.stringify(retained[0]));
