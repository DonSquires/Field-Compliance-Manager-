-- Behavioural truth table for 20260919010000_desktop_signing_material.sql.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_service() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SET LOCAL ROLE service_role;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL ROLE postgres;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok   [%]', p_label;
END $$;

DO $$
DECLARE
  v_admin uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_pfx text := repeat('QUJDREVGR0hJSktMTU5PUA==', 12);
  v_result jsonb;
  v_error text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type) VALUES (v_org, 'T_SIGNING_ORG', 'service_provider');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name) VALUES (v_admin, v_org, 'grand_master', 'SigningGM');

  BEGIN
    PERFORM pg_temp.as_service();
    PERFORM public.desktop_signing_material();
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('reading before anything is stored says exactly what to add and where', v_error LIKE '%not in Vault%desktop_signing_pfx_base64%');

  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.set_desktop_signing_material(v_pfx, 'pw', NULL);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('even a grand master browser session cannot store signing material', v_error LIKE '%Service identity required%' OR v_error LIKE '%permission denied%');

  BEGIN
    PERFORM pg_temp.as_service();
    PERFORM public.set_desktop_signing_material('not base64!', 'pw', NULL);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a malformed PFX is refused', v_error LIKE '%base64-encoded PFX is required%');

  PERFORM pg_temp.as_service();
  v_result := public.set_desktop_signing_material(v_pfx || E'\n', 'correct horse', 'truth table');
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the service stores both secrets under the fixed names',
    (v_result->>'stored')::boolean AND (SELECT count(*) FROM vault.secrets WHERE name IN ('desktop_signing_pfx_base64', 'desktop_signing_pfx_password')) = 2);
  PERFORM pg_temp.check('storing is audited with lengths only, never the value',
    EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'desktop_signing_material_set' AND (a.metadata->>'pfx_base64_length')::int > 0 AND a.metadata::text NOT LIKE '%' || left(v_pfx, 40) || '%'));

  PERFORM pg_temp.as_service();
  v_result := public.desktop_signing_material();
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the service reads the material back, whitespace stripped from the PFX',
    v_result->>'pfx_base64' = v_pfx AND v_result->>'pfx_password' = 'correct horse');
  PERFORM pg_temp.check('every read is audited by name only',
    EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'desktop_signing_material_read' AND a.metadata->'names' ? 'desktop_signing_pfx_base64' AND a.metadata::text NOT LIKE '%correct horse%'));

  PERFORM pg_temp.as_service();
  PERFORM public.set_desktop_signing_material(v_pfx, 'rotated', 'rotation');
  v_result := public.desktop_signing_material();
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('rotation updates in place rather than creating duplicates',
    v_result->>'pfx_password' = 'rotated' AND (SELECT count(*) FROM vault.secrets WHERE name IN ('desktop_signing_pfx_base64', 'desktop_signing_pfx_password')) = 2);

  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.desktop_signing_material();
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a browser session can never read the signing material', v_error LIKE '%Service identity required%' OR v_error LIKE '%permission denied%');
END $$;
ROLLBACK;
