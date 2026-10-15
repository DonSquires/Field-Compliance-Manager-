// Rollback-only live verification for manage_location_module_assignment.
// Creates a throwaway test identity inside one transaction that always ROLLBACKs,
// so no real user is impersonated and no live row is retained.
//   node scripts/verify-location-module-assignment-live.mjs
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE is required');

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 900)}`);
  return text ? JSON.parse(text) : [];
}

const script = `
BEGIN;

CREATE TEMP TABLE verification_result (step text, outcome text) ON COMMIT DROP;

DO $v$
DECLARE
  v_agreement uuid;
  v_provider uuid;
  v_client uuid;
  v_house uuid;
  v_module text;
  v_test_user uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_updated timestamptz;
  v_first public.location_module_assignments%rowtype;
  v_replay public.location_module_assignments%rowtype;
BEGIN
  -- Pick a live agreement that already satisfies every containment check.
  SELECT sa.id, sa.provider_organization_id, sa.client_organization_id, l.id, sam.module_key
    INTO v_agreement, v_provider, v_client, v_house, v_module
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam
      ON sam.service_agreement_id = sa.id AND sam.enabled
    JOIN public.service_agreement_locations sal
      ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    LEFT JOIN public.client_sites cs ON cs.id = sal.site_id
    LEFT JOIN public.location_zones z ON z.id = sal.zone_id
    JOIN public.locations l
      ON l.id = coalesce(cs.location_id, z.location_id)
     AND l.organization_id = sa.client_organization_id
   WHERE sa.invitation_status = 'accepted'
     AND sa.starts_on <= current_date
     AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
   LIMIT 1;
  IF v_agreement IS NULL THEN
    INSERT INTO verification_result VALUES ('fixture', 'SKIP no agreement satisfies the containment checks');
    RETURN;
  END IF;
  INSERT INTO verification_result VALUES ('fixture', 'agreement ' || v_agreement || ' module ' || v_module);

  -- Throwaway identity: a dedicated test admin, never a real person's account.
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
  VALUES (v_test_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'atlas-verification+' || v_test_user || '@invalid.test', '', now(), now());
  INSERT INTO public.user_profiles (id, organization_id, role, email)
  VALUES (v_test_user, v_provider, 'admin', 'atlas-verification+' || v_test_user || '@invalid.test');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_test_user, 'role', 'authenticated')::text, true);

  IF auth.uid() IS DISTINCT FROM v_test_user THEN
    INSERT INTO verification_result VALUES ('identity', 'FAIL auth.uid() did not resolve to the test identity');
    RETURN;
  END IF;

  SELECT lma.updated_at INTO v_updated
    FROM public.location_module_assignments lma
   WHERE lma.location_id = v_house AND lma.module_key = v_module AND lma.service_agreement_id = v_agreement;

  -- 1. Save
  v_first := public.manage_location_module_assignment(
    v_request, v_house, v_agreement, v_module, v_updated, false, current_date, NULL);
  INSERT INTO verification_result VALUES ('save',
    CASE WHEN v_first.id IS NOT NULL AND v_first.enabled = false THEN 'PASS turned off, id ' || v_first.id ELSE 'FAIL' END);

  -- 2. Replay with the same client_request_id returns the same record, no second write
  v_replay := public.manage_location_module_assignment(
    v_request, v_house, v_agreement, v_module, v_updated, false, current_date, NULL);
  INSERT INTO verification_result VALUES ('replay',
    CASE WHEN v_replay.id = v_first.id AND v_replay.updated_at = v_first.updated_at
         THEN 'PASS same receipt returned' ELSE 'FAIL replay produced a different record' END);
  INSERT INTO verification_result
  SELECT 'replay_no_duplicate',
         CASE WHEN count(*) = 1 THEN 'PASS one audit row' ELSE 'FAIL ' || count(*) || ' audit rows' END
    FROM public.audit_log
   WHERE action = 'location_module_assignment_set'
     AND metadata ->> 'client_request_id' = v_request::text;

  -- 3. Same request id reused for a different module is refused
  BEGIN
    PERFORM public.manage_location_module_assignment(
      v_request, v_house, v_agreement, v_module || '_other', v_first.updated_at, true, current_date, NULL);
    INSERT INTO verification_result VALUES ('replay_mismatch', 'FAIL reuse was accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('replay_mismatch', 'PASS refused: ' || SQLERRM);
  END;

  -- 4. Stale expected timestamp is refused
  BEGIN
    PERFORM public.manage_location_module_assignment(
      gen_random_uuid(), v_house, v_agreement, v_module, v_updated, true, current_date, NULL);
    INSERT INTO verification_result VALUES ('stale', 'FAIL stale edit was accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('stale', 'PASS refused: ' || SQLERRM);
  END;

  -- 5. A module that is not enabled on the agreement is refused
  BEGIN
    PERFORM public.manage_location_module_assignment(
      gen_random_uuid(), v_house, v_agreement, 'module_that_is_not_on_this_agreement', NULL, true, current_date, NULL);
    INSERT INTO verification_result VALUES ('module_gate', 'FAIL ungoverned module was accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('module_gate', 'PASS refused: ' || SQLERRM);
  END;

  -- 6. End date before start date is refused
  BEGIN
    PERFORM public.manage_location_module_assignment(
      gen_random_uuid(), v_house, v_agreement, v_module, v_first.updated_at, true, current_date, current_date - 1);
    INSERT INTO verification_result VALUES ('date_order', 'FAIL reversed window was accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('date_order', 'PASS refused: ' || SQLERRM);
  END;

  -- 7. A non-admin identity is refused
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.manage_location_module_assignment(
      gen_random_uuid(), v_house, v_agreement, v_module, v_first.updated_at, true, current_date, NULL);
    INSERT INTO verification_result VALUES ('authorization', 'FAIL unknown identity was accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO verification_result VALUES ('authorization', 'PASS refused: ' || SQLERRM);
  END;
END;
$v$;

SELECT step, outcome FROM verification_result;

ROLLBACK;
`;

const rows = await sql(script);
for (const row of rows) console.log(`${row.step}: ${row.outcome}`);

const retained = await sql(`
  select
    (select count(*) from public.location_module_assignments where created_by is not null) as assignments_with_actor,
    (select count(*) from public.user_profiles where email like 'atlas-verification+%') as test_profiles,
    (select count(*) from public.audit_log where action = 'location_module_assignment_set') as assignment_audit_rows
`);
console.log('retained after rollback:', JSON.stringify(retained[0]));
