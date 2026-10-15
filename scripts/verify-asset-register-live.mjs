// Rollback-only live verification for manage_asset.
// Uses a throwaway test identity and assets inside one transaction that always
// rolls back. No real user is impersonated and no verification record persists.
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
  v_update_request uuid := gen_random_uuid();
  v_asset public.assets%rowtype;
  v_replay public.assets%rowtype;
  v_updated public.assets%rowtype;
BEGIN
  SELECT o.id
    INTO v_org
    FROM public.organizations o
   WHERE o.active
   ORDER BY o.created_at
   LIMIT 1;
  IF v_org IS NULL THEN
    INSERT INTO verification_result VALUES ('fixture', 'SKIP no active organization');
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
    'atlas-asset-verification+' || v_user || '@invalid.test',
    '',
    now(),
    now()
  );
  INSERT INTO public.user_profiles (id, organization_id, role, email)
  VALUES (
    v_user,
    v_org,
    'admin',
    'atlas-asset-verification+' || v_user || '@invalid.test'
  );
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text,
    true
  );

  v_asset := public.manage_asset(
    v_create_request,
    'create',
    NULL,
    NULL,
    'radio',
    'Atlas verification radio',
    'atlas-radio-001',
    NULL,
    'Motorola',
    'R7',
    2026,
    'available',
    current_date + 90,
    'Rollback-only verification'
  );
  INSERT INTO verification_result VALUES (
    'create',
    CASE
      WHEN v_asset.id IS NOT NULL
       AND v_asset.serial_number = 'ATLAS-RADIO-001'
       AND v_asset.status = 'available'
      THEN 'PASS normalized and created ' || v_asset.id
      ELSE 'FAIL create result'
    END
  );

  v_replay := public.manage_asset(
    v_create_request,
    'create',
    NULL,
    NULL,
    'radio',
    'Atlas verification radio',
    'atlas-radio-001',
    NULL,
    'Motorola',
    'R7',
    2026,
    'available',
    current_date + 90,
    'Rollback-only verification'
  );
  INSERT INTO verification_result VALUES (
    'create_replay',
    CASE
      WHEN v_replay.id = v_asset.id
       AND v_replay.updated_at = v_asset.updated_at
      THEN 'PASS same receipt returned'
      ELSE 'FAIL replay changed the record'
    END
  );
  INSERT INTO verification_result
  SELECT
    'create_replay_audit',
    CASE WHEN count(*) = 1 THEN 'PASS one audit row' ELSE 'FAIL ' || count(*) || ' audit rows' END
  FROM public.audit_log
  WHERE metadata ->> 'client_request_id' = v_create_request::text;

  v_updated := public.manage_asset(
    v_update_request,
    'update',
    v_asset.id,
    v_asset.updated_at,
    'radio',
    'Atlas verification radio',
    'ATLAS-RADIO-001',
    NULL,
    'Motorola',
    'R7',
    2026,
    'maintenance',
    current_date + 60,
    'Bench inspection required'
  );
  INSERT INTO verification_result VALUES (
    'update',
    CASE
      WHEN v_updated.id = v_asset.id
       AND v_updated.status = 'maintenance'
       AND v_updated.updated_at > v_asset.updated_at
      THEN 'PASS optimistic update'
      ELSE 'FAIL update result'
    END
  );

  v_replay := public.manage_asset(
    v_update_request,
    'update',
    v_asset.id,
    v_asset.updated_at,
    'radio',
    'Atlas verification radio',
    'ATLAS-RADIO-001',
    NULL,
    'Motorola',
    'R7',
    2026,
    'maintenance',
    current_date + 60,
    'Bench inspection required'
  );
  INSERT INTO verification_result VALUES (
    'update_replay',
    CASE
      WHEN v_replay.updated_at = v_updated.updated_at
      THEN 'PASS same update receipt returned'
      ELSE 'FAIL update replay changed the record'
    END
  );

  BEGIN
    PERFORM public.manage_asset(
      gen_random_uuid(), 'update', v_asset.id, v_asset.updated_at, 'radio',
      'Atlas verification radio', 'ATLAS-RADIO-001', NULL, 'Motorola', 'R7',
      2026, 'available', current_date + 60, NULL
    );
    INSERT INTO verification_result VALUES ('stale', 'FAIL stale update accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('stale', 'PASS refused: ' || SQLERRM);
  END;

  BEGIN
    PERFORM public.manage_asset(
      gen_random_uuid(), 'create', NULL, NULL, 'radio',
      'Duplicate verification radio', 'atlas-radio-001', NULL, NULL, NULL,
      NULL, 'available', NULL, NULL
    );
    INSERT INTO verification_result VALUES ('duplicate_identifier', 'FAIL duplicate accepted');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO verification_result VALUES ('duplicate_identifier', 'PASS refused duplicate serial number');
  END;

  BEGIN
    PERFORM public.manage_asset(
      gen_random_uuid(), 'create', NULL, NULL, 'radio',
      'Invalid in-use radio', 'atlas-radio-002', NULL, NULL, NULL,
      NULL, 'in_use', NULL, NULL
    );
    INSERT INTO verification_result VALUES ('in_use_gate', 'FAIL direct in-use accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('in_use_gate', 'PASS refused: ' || SQLERRM);
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.manage_asset(
      gen_random_uuid(), 'create', NULL, NULL, 'radio',
      'Unauthorized radio', 'atlas-radio-003', NULL, NULL, NULL,
      NULL, 'available', NULL, NULL
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
    (SELECT count(*) FROM public.assets WHERE name LIKE 'Atlas verification%') AS test_assets,
    (SELECT count(*) FROM public.user_profiles WHERE email LIKE 'atlas-asset-verification+%') AS test_profiles,
    (SELECT count(*) FROM public.audit_log WHERE metadata ->> 'record' LIKE '%Atlas verification%') AS test_audit_rows
`);
console.log('retained after rollback:', JSON.stringify(retained[0]));
