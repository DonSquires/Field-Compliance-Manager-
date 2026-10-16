// Rollback-only live verification for manage_notice_template.
// Uses a throwaway test identity inside one transaction that always rolls back.
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
  v_org uuid;
  v_user uuid := gen_random_uuid();
  v_create_request uuid := gen_random_uuid();
  v_version_request uuid := gen_random_uuid();
  v_first jsonb;
  v_replay jsonb;
  v_second jsonb;
  v_first_id uuid;
  v_second_id uuid;
BEGIN
  SELECT o.id
    INTO v_org
    FROM public.organizations o
   WHERE o.active
     AND NOT EXISTS (
       SELECT 1
       FROM public.notice_templates t
       WHERE t.organization_id = o.id
         AND t.module_key = 'freedom_camping'
         AND t.notice_type = 'written_warning'
         AND t.is_active
     )
   ORDER BY o.created_at
   LIMIT 1;
  IF v_org IS NULL THEN
    INSERT INTO verification_result VALUES ('fixture', 'SKIP no eligible active organization');
    RETURN;
  END IF;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password, created_at, updated_at
  )
  VALUES (
    v_user,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'atlas-notice-verification+' || v_user || '@invalid.test',
    '',
    now(),
    now()
  );
  INSERT INTO public.user_profiles (id, organization_id, role, email)
  VALUES (
    v_user,
    v_org,
    'admin',
    'atlas-notice-verification+' || v_user || '@invalid.test'
  );
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text,
    true
  );

  v_first := public.manage_notice_template(
    v_org,
    v_create_request,
    'freedom_camping',
    'written_warning',
    '<p>Rollback-only notice {{notice_number}}</p>',
    NULL,
    NULL,
    'Atlas verification authority',
    'Freedom Camping Act 2011',
    's 20',
    'Verification bylaw',
    NULL,
    NULL,
    'Rollback-only footer',
    'governed://atlas-verification/notice-source',
    false
  );
  v_first_id := (v_first #>> '{template,id}')::uuid;
  INSERT INTO verification_result VALUES (
    'create',
    CASE
      WHEN v_first_id IS NOT NULL
       AND (v_first #>> '{template,version}')::integer = 1
       AND (v_first #>> '{template,is_active}')::boolean
       AND NOT (v_first ->> 'replayed')::boolean
      THEN 'PASS created immutable v1'
      ELSE 'FAIL create receipt'
    END
  );

  v_replay := public.manage_notice_template(
    v_org,
    v_create_request,
    'freedom_camping',
    'written_warning',
    '<p>Rollback-only notice {{notice_number}}</p>',
    NULL,
    NULL,
    'Atlas verification authority',
    'Freedom Camping Act 2011',
    's 20',
    'Verification bylaw',
    NULL,
    NULL,
    'Rollback-only footer',
    'governed://atlas-verification/notice-source',
    false
  );
  INSERT INTO verification_result VALUES (
    'create_replay',
    CASE
      WHEN (v_replay #>> '{template,id}')::uuid = v_first_id
       AND (v_replay ->> 'replayed')::boolean
      THEN 'PASS same v1 receipt returned'
      ELSE 'FAIL replay changed the record'
    END
  );

  v_second := public.manage_notice_template(
    v_org,
    v_version_request,
    'freedom_camping',
    'written_warning',
    '<p>Rollback-only notice v2 {{notice_number}}</p>',
    v_first_id,
    1,
    'Atlas verification authority',
    'Freedom Camping Act 2011',
    's 20',
    'Verification bylaw',
    NULL,
    NULL,
    'Rollback-only footer v2',
    'governed://atlas-verification/notice-source-v2',
    false
  );
  v_second_id := (v_second #>> '{template,id}')::uuid;
  INSERT INTO verification_result
  SELECT
    'version',
    CASE
      WHEN v_second_id IS NOT NULL
       AND v_second_id <> v_first_id
       AND (v_second #>> '{template,version}')::integer = 2
       AND NOT first_row.is_active
       AND second_row.is_active
      THEN 'PASS retained v1 and activated v2'
      ELSE 'FAIL version transition'
    END
  FROM public.notice_templates first_row
  JOIN public.notice_templates second_row ON second_row.id = v_second_id
  WHERE first_row.id = v_first_id;

  BEGIN
    PERFORM public.manage_notice_template(
      v_org, gen_random_uuid(), 'freedom_camping', 'written_warning',
      '<p>Stale version</p>', v_first_id, 1,
      'Atlas verification authority', 'Freedom Camping Act 2011', 's 20',
      NULL, NULL, NULL, NULL, 'governed://atlas-verification/stale', false
    );
    INSERT INTO verification_result VALUES ('stale', 'FAIL stale version accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('stale', 'PASS refused: ' || SQLERRM);
  END;

  BEGIN
    PERFORM public.manage_notice_template(
      v_org, gen_random_uuid(), 'freedom_camping', 'notice_to_vacate',
      '<script>alert(1)</script>', NULL, NULL,
      'Atlas verification authority', 'Freedom Camping Act 2011', NULL,
      NULL, NULL, NULL, NULL, 'governed://atlas-verification/unsafe', false
    );
    INSERT INTO verification_result VALUES ('unsafe_html', 'FAIL unsafe HTML accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('unsafe_html', 'PASS refused: ' || SQLERRM);
  END;

  BEGIN
    PERFORM public.manage_notice_template(
      v_org, gen_random_uuid(), 'freedom_camping', 'notice_to_vacate',
      '<p>Missing source</p>', NULL, NULL,
      'Atlas verification authority', 'Freedom Camping Act 2011', NULL,
      NULL, NULL, NULL, NULL, NULL, false
    );
    INSERT INTO verification_result VALUES ('source', 'FAIL missing source accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('source', 'PASS refused: ' || SQLERRM);
  END;

  INSERT INTO verification_result
  SELECT
    'audit',
    CASE
      WHEN count(*) = 2
       AND bool_or(metadata ? 'previous')
       AND bool_and(metadata ? 'resulting')
      THEN 'PASS two full version receipts'
      ELSE 'FAIL audit evidence'
    END
  FROM public.audit_log
  WHERE metadata ->> 'client_request_id' IN (
    v_create_request::text,
    v_version_request::text
  );

  INSERT INTO verification_result VALUES (
    'direct_write_privilege',
    CASE
      WHEN NOT has_table_privilege('authenticated', 'public.notice_templates', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.notice_templates', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.notice_templates', 'DELETE')
      THEN 'PASS direct writes revoked'
      ELSE 'FAIL authenticated still has a direct write privilege'
    END
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.manage_notice_template(
      v_org, gen_random_uuid(), 'freedom_camping', 'notice_to_vacate',
      '<p>Unauthorized</p>', NULL, NULL,
      'Atlas verification authority', 'Freedom Camping Act 2011', NULL,
      NULL, NULL, NULL, NULL, 'governed://atlas-verification/unauthorized', false
    );
    INSERT INTO verification_result VALUES ('authorization', 'FAIL unknown identity accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('authorization', 'PASS refused: ' || SQLERRM);
  END;
END;
$verify$;

SELECT step, outcome FROM verification_result ORDER BY step;

ROLLBACK;
`;

const rows = await sql(script);
for (const row of rows) console.log(`${row.step}: ${row.outcome}`);

const retained = await sql(`
  SELECT
    (SELECT count(*) FROM public.notice_templates WHERE source_document_url LIKE 'governed://atlas-verification/%') AS test_templates,
    (SELECT count(*) FROM public.user_profiles WHERE email LIKE 'atlas-notice-verification+%') AS test_profiles,
    (SELECT count(*) FROM public.audit_log WHERE metadata ->> 'client_request_id' IN (
      SELECT client_request_id::text
      FROM public.notice_templates
      WHERE source_document_url LIKE 'governed://atlas-verification/%'
    )) AS test_audit_rows
`);
console.log('retained after rollback:', JSON.stringify(retained[0]));
