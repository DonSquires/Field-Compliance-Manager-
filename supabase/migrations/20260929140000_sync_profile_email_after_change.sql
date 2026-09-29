-- A confirmed email change lands in auth.users; user_profiles.email is the copy the console reads.
-- Nothing syncs the two, so the person whose address changed brings their own profile back into step.

CREATE OR REPLACE FUNCTION public.sync_my_profile_email()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_email text := nullif(lower(trim(coalesce(auth.email(), ''))), '');
  v_row public.user_profiles%rowtype;
BEGIN
  IF v_actor IS NULL OR v_email IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_row FROM public.user_profiles WHERE id = v_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF lower(coalesce(v_row.email, '')) = v_email THEN RETURN v_row.email; END IF;

  UPDATE public.user_profiles SET email = v_email WHERE id = v_actor;
  PERFORM public.log_user_management_action(
    v_row.organization_id, v_actor, 'user_email_change_confirmed', v_actor,
    jsonb_build_object('email', v_row.email), jsonb_build_object('email', v_email),
    jsonb_build_object('source', 'auth_session'));
  RETURN v_email;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_my_profile_email() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_my_profile_email() TO authenticated, service_role;
COMMENT ON FUNCTION public.sync_my_profile_email() IS
  'Brings the caller''s own user_profiles.email up to the address they are actually signed in with, after a confirmed email change. Acts only on auth.uid() and records the catch-up in the identity audit trail.';
