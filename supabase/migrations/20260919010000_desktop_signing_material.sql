-- FCM Desktop code-signing material lives in Supabase Vault, not in GitHub (owner direction 2026-09-19).
--
-- GitHub Actions builds the Windows installer but never holds the private key. The signing step runs on the
-- protected side (VPS or an operator's Codespace) with the service role: scripts/desktop-signing/sign-and-publish.mjs
-- fetches the PFX through desktop_signing_material(), signs with osslsigncode + RFC 3161 timestamp, verifies,
-- publishes the signed installer + manifest + public certificate to desktop-releases, and the PFX is wiped.
--
-- Vault secret names (set through the Dashboard Vault UI or set_desktop_signing_material):
--   desktop_signing_pfx_base64    the PFX file, base64
--   desktop_signing_pfx_password  its password
-- Every read of the material is audited (names only, never values).

CREATE OR REPLACE FUNCTION public.set_desktop_signing_material(p_pfx_base64 text, p_password text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE v_pfx_id uuid; v_pw_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF p_pfx_base64 IS NULL OR p_pfx_base64 !~ '^[A-Za-z0-9+/=\s]{200,}$' THEN RAISE EXCEPTION 'A base64-encoded PFX is required'; END IF;
  IF nullif(p_password, '') IS NULL THEN RAISE EXCEPTION 'The PFX password is required'; END IF;

  SELECT id INTO v_pfx_id FROM vault.secrets WHERE name = 'desktop_signing_pfx_base64';
  IF v_pfx_id IS NULL THEN
    v_pfx_id := vault.create_secret(regexp_replace(p_pfx_base64, '\s', '', 'g'), 'desktop_signing_pfx_base64', coalesce(p_note, 'FCM Desktop code-signing PFX (base64)'));
  ELSE
    PERFORM vault.update_secret(v_pfx_id, regexp_replace(p_pfx_base64, '\s', '', 'g'), 'desktop_signing_pfx_base64', coalesce(p_note, 'FCM Desktop code-signing PFX (base64)'));
  END IF;
  SELECT id INTO v_pw_id FROM vault.secrets WHERE name = 'desktop_signing_pfx_password';
  IF v_pw_id IS NULL THEN
    v_pw_id := vault.create_secret(p_password, 'desktop_signing_pfx_password', 'FCM Desktop code-signing PFX password');
  ELSE
    PERFORM vault.update_secret(v_pw_id, p_password, 'desktop_signing_pfx_password', 'FCM Desktop code-signing PFX password');
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (NULL, auth.uid(), 'desktop_signing_material_set', 'vault.secrets', v_pfx_id,
          jsonb_build_object('pfx_base64_length', length(p_pfx_base64), 'session_user', session_user, 'note', p_note));
  RETURN jsonb_build_object('stored', true, 'names', jsonb_build_array('desktop_signing_pfx_base64', 'desktop_signing_pfx_password'));
END $$;
REVOKE ALL ON FUNCTION public.set_desktop_signing_material(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_desktop_signing_material(text, text, text) TO service_role;
COMMENT ON FUNCTION public.set_desktop_signing_material(text, text, text) IS
  'Service-only: stores/rotates the FCM Desktop code-signing PFX (base64) and password in Vault under fixed names. Audited (lengths only).';

CREATE OR REPLACE FUNCTION public.desktop_signing_material()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE v_pfx text; v_pw text;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT decrypted_secret INTO v_pfx FROM vault.decrypted_secrets WHERE name = 'desktop_signing_pfx_base64' LIMIT 1;
  SELECT decrypted_secret INTO v_pw FROM vault.decrypted_secrets WHERE name = 'desktop_signing_pfx_password' LIMIT 1;
  IF v_pfx IS NULL OR v_pw IS NULL THEN
    RAISE EXCEPTION 'Desktop signing material is not in Vault. Add desktop_signing_pfx_base64 and desktop_signing_pfx_password (Dashboard → Vault) or call set_desktop_signing_material.';
  END IF;
  -- Every read is on the record: who (session/service), when, what names. Never the values.
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (NULL, auth.uid(), 'desktop_signing_material_read', 'vault.secrets', NULL,
          jsonb_build_object('names', jsonb_build_array('desktop_signing_pfx_base64', 'desktop_signing_pfx_password'), 'session_user', session_user, 'read_at', clock_timestamp()));
  RETURN jsonb_build_object('pfx_base64', v_pfx, 'pfx_password', v_pw);
END $$;
REVOKE ALL ON FUNCTION public.desktop_signing_material() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.desktop_signing_material() TO service_role;
COMMENT ON FUNCTION public.desktop_signing_material() IS
  'Service-only: returns the FCM Desktop code-signing PFX (base64) and password from Vault for the protected-side signing step. Every read is audited by name.';
