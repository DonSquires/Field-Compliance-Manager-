CREATE OR REPLACE FUNCTION public.set_staff_employment_setup(
  p_staff_id uuid,
  p_expected_employment_type text,
  p_expected_start_date date,
  p_expected_end_date date,
  p_expected_role_code text,
  p_employment_type text,
  p_start_date date,
  p_end_date date DEFAULT NULL,
  p_role_code text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.staff_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_employment_type text := nullif(trim(coalesce(p_employment_type, '')), '');
  v_role_code text := nullif(trim(coalesce(p_role_code, '')), '');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_previous jsonb;
BEGIN
  SELECT *
  INTO v_staff
  FROM public.staff_profiles
  WHERE id = p_staff_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff profile not found';
  END IF;
  IF NOT public.is_admin_for_org(v_staff.organization_id) THEN
    RAISE EXCEPTION 'Not authorised to manage staff employment';
  END IF;
  IF v_staff.employment_type IS DISTINCT FROM nullif(trim(coalesce(p_expected_employment_type, '')), '')
    OR v_staff.start_date IS DISTINCT FROM p_expected_start_date
    OR v_staff.end_date IS DISTINCT FROM p_expected_end_date
    OR v_staff.role_code IS DISTINCT FROM nullif(trim(coalesce(p_expected_role_code, '')), '') THEN
    RAISE EXCEPTION 'Staff employment changed; reload before saving';
  END IF;
  IF v_employment_type NOT IN ('permanent', 'part_time', 'casual', 'contractor', 'volunteer') THEN
    RAISE EXCEPTION 'A supported employment type is required';
  END IF;
  IF p_start_date IS NULL THEN
    RAISE EXCEPTION 'Employment start date is required';
  END IF;
  IF p_end_date IS NOT NULL AND p_end_date < p_start_date THEN
    RAISE EXCEPTION 'Employment end date cannot precede the start date';
  END IF;
  IF v_role_code IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.reference_codes code
    WHERE code.organization_id = v_staff.organization_id
      AND code.code_type = 'role_code'
      AND code.code = v_role_code
      AND code.is_active
  ) THEN
    RAISE EXCEPTION 'An active organization payroll role is required';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Employment setup reason is required';
  END IF;

  v_previous := jsonb_build_object(
    'employment_type', v_staff.employment_type,
    'start_date', v_staff.start_date,
    'end_date', v_staff.end_date,
    'role_code', v_staff.role_code
  );

  UPDATE public.staff_profiles
  SET employment_type = v_employment_type,
      start_date = p_start_date,
      end_date = p_end_date,
      role_code = v_role_code
  WHERE id = v_staff.id
  RETURNING * INTO v_staff;

  INSERT INTO public.audit_log(
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_staff.organization_id,
    v_actor,
    'staff_employment_setup_saved',
    'staff_profiles',
    v_staff.id,
    jsonb_build_object(
      'previous', v_previous,
      'current', jsonb_build_object(
        'employment_type', v_staff.employment_type,
        'start_date', v_staff.start_date,
        'end_date', v_staff.end_date,
        'role_code', v_staff.role_code
      ),
      'reason', v_reason
    )
  );

  RETURN v_staff;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_staff_employment_setup(uuid, text, date, date, text, text, date, date, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_staff_employment_setup(uuid, text, date, date, text, text, date, date, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_staff_onboarding_readiness(p_organization_id uuid)
RETURNS TABLE(
  ledger_id uuid,
  staff_id uuid,
  user_id uuid,
  display_name text,
  current_stage text,
  status text,
  version integer,
  target_start date,
  identity_status text,
  employment_status text,
  evidence_status text,
  supervision_status text,
  induction_status text,
  work_status text,
  blockers text[],
  next_action text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Not authorised to assess staff onboarding';
  END IF;

  RETURN QUERY
  SELECT
    l.id,
    sp.id,
    sp.user_id,
    coalesce(up.display_name, up.email, 'Unnamed staff'),
    l.current_stage,
    l.status,
    l.version,
    l.target_start,
    CASE
      WHEN up.id IS NOT NULL
        AND up.deactivated_at IS NULL
        AND up.email IS NOT NULL
        AND up.display_name IS NOT NULL THEN 'complete'
      ELSE 'blocked'
    END,
    CASE
      WHEN sp.employment_type IS NOT NULL
        AND sp.start_date IS NOT NULL
        AND (sp.end_date IS NULL OR sp.end_date >= current_date)
        AND sp.role_code IS NOT NULL THEN 'complete'
      ELSE 'blocked'
    END,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM public.staff_credentials c
        WHERE c.staff_id = sp.id
          AND c.verified
          AND (c.expiry_date IS NULL OR c.expiry_date >= current_date)
      )
      AND EXISTS (SELECT 1 FROM public.staff_documents d WHERE d.staff_id = sp.id)
      AND EXISTS (SELECT 1 FROM public.staff_skills sk WHERE sk.staff_id = sp.id) THEN 'complete'
      ELSE 'blocked'
    END,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM public.staff_reporting sr
        WHERE sr.user_id = coalesce(sp.user_id, sp.id)
          AND sr.scope_org_id = p_organization_id
          AND sr.relationship_type = 'line_manager'
          AND sr.effective_to IS NULL
      ) THEN 'complete'
      ELSE 'blocked'
    END,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM public.staff_training_records tr
        WHERE tr.staff_id = sp.id
          AND tr.training_type = 'induction'
          AND coalesce(tr.passed, true)
          AND (tr.expiry_date IS NULL OR tr.expiry_date >= current_date)
      ) THEN 'complete'
      ELSE 'blocked'
    END,
    CASE WHEN sp.work_ready THEN 'ready' ELSE 'blocked' END,
    array_remove(ARRAY[
      CASE WHEN up.id IS NULL OR up.deactivated_at IS NOT NULL OR up.email IS NULL OR up.display_name IS NULL THEN 'Complete active identity and invitation' END,
      CASE WHEN sp.employment_type IS NULL THEN 'Select an employment type' END,
      CASE WHEN sp.start_date IS NULL THEN 'Set a current employment start date' END,
      CASE WHEN sp.end_date IS NOT NULL AND sp.end_date < current_date THEN 'Employment has ended' END,
      CASE WHEN sp.role_code IS NULL THEN 'Assign a payroll role' END,
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM public.staff_credentials c
        WHERE c.staff_id = sp.id
          AND c.verified
          AND (c.expiry_date IS NULL OR c.expiry_date >= current_date)
      ) THEN 'Verify a current credential' END,
      CASE WHEN NOT EXISTS (SELECT 1 FROM public.staff_documents d WHERE d.staff_id = sp.id) THEN 'Upload an employment or credential document' END,
      CASE WHEN NOT EXISTS (SELECT 1 FROM public.staff_skills sk WHERE sk.staff_id = sp.id) THEN 'Record at least one staff skill' END,
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM public.staff_reporting sr
        WHERE sr.user_id = coalesce(sp.user_id, sp.id)
          AND sr.scope_org_id = p_organization_id
          AND sr.relationship_type = 'line_manager'
          AND sr.effective_to IS NULL
      ) THEN 'Assign a line manager' END,
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM public.staff_training_records tr
        WHERE tr.staff_id = sp.id
          AND tr.training_type = 'induction'
          AND coalesce(tr.passed, true)
          AND (tr.expiry_date IS NULL OR tr.expiry_date >= current_date)
      ) THEN 'Record completed induction' END,
      CASE WHEN NOT sp.work_ready THEN 'Complete human work-readiness review' END
    ], NULL)::text[],
    CASE
      WHEN up.id IS NULL OR up.deactivated_at IS NOT NULL OR up.email IS NULL OR up.display_name IS NULL THEN 'Complete identity'
      WHEN sp.employment_type IS NULL OR sp.start_date IS NULL OR (sp.end_date IS NOT NULL AND sp.end_date < current_date) OR sp.role_code IS NULL THEN 'Complete employment setup'
      WHEN NOT EXISTS (
        SELECT 1 FROM public.staff_credentials c
        WHERE c.staff_id = sp.id
          AND c.verified
          AND (c.expiry_date IS NULL OR c.expiry_date >= current_date)
      ) THEN 'Verify credential'
      WHEN NOT EXISTS (SELECT 1 FROM public.staff_documents d WHERE d.staff_id = sp.id) THEN 'Upload evidence'
      WHEN NOT EXISTS (SELECT 1 FROM public.staff_skills sk WHERE sk.staff_id = sp.id) THEN 'Record skill'
      WHEN NOT EXISTS (
        SELECT 1 FROM public.staff_reporting sr
        WHERE sr.user_id = coalesce(sp.user_id, sp.id)
          AND sr.scope_org_id = p_organization_id
          AND sr.relationship_type = 'line_manager'
          AND sr.effective_to IS NULL
      ) THEN 'Assign line manager'
      WHEN NOT EXISTS (
        SELECT 1 FROM public.staff_training_records tr
        WHERE tr.staff_id = sp.id
          AND tr.training_type = 'induction'
          AND coalesce(tr.passed, true)
          AND (tr.expiry_date IS NULL OR tr.expiry_date >= current_date)
      ) THEN 'Record induction'
      WHEN NOT sp.work_ready THEN 'Review work readiness'
      ELSE 'Ready'
    END
  FROM public.staff_onboarding_ledgers l
  JOIN public.staff_profiles sp ON sp.id = l.staff_id
  LEFT JOIN public.user_profiles up ON up.id = coalesce(sp.user_id, sp.id)
  WHERE l.organization_id = p_organization_id
  ORDER BY l.current_stage, up.display_name NULLS LAST;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_staff_onboarding_readiness(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_staff_onboarding_readiness(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_staff_readiness_assessment(p_organization_id uuid)
RETURNS TABLE(
  staff_id uuid,
  user_id uuid,
  work_ready boolean,
  identity_status text,
  employment_status text,
  credential_status text,
  training_status text,
  blockers text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Not authorised to assess staff readiness';
  END IF;

  RETURN QUERY
  SELECT
    sp.id,
    sp.user_id,
    sp.work_ready,
    CASE
      WHEN up.id IS NULL THEN 'unlinked'
      WHEN up.deactivated_at IS NOT NULL THEN 'deactivated'
      WHEN up.role NOT IN ('officer', 'admin_officer') THEN 'not_field_role'
      ELSE 'active'
    END,
    CASE
      WHEN sp.end_date IS NOT NULL AND sp.end_date < current_date THEN 'ended'
      WHEN sp.employment_type IS NULL THEN 'missing_employment_type'
      WHEN sp.start_date IS NULL THEN 'missing_start_date'
      WHEN sp.role_code IS NULL THEN 'missing_pay_role'
      WHEN sp.start_date > current_date THEN 'not_started'
      ELSE 'current'
    END,
    CASE
      WHEN up.role NOT IN ('officer', 'admin_officer') THEN 'not_applicable'
      WHEN NOT EXISTS (
        SELECT 1 FROM public.staff_credentials c
        WHERE c.staff_id = sp.id
          AND c.verified
          AND (c.expiry_date IS NULL OR c.expiry_date >= current_date)
      ) THEN 'missing_valid'
      WHEN EXISTS (
        SELECT 1 FROM public.staff_credentials c
        WHERE c.staff_id = sp.id
          AND (NOT c.verified OR (c.expiry_date IS NOT NULL AND c.expiry_date < current_date))
      ) THEN 'attention'
      ELSE 'current'
    END,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM public.staff_training_records tr
        WHERE tr.staff_id = sp.id
          AND (tr.passed = false OR (tr.expiry_date IS NOT NULL AND tr.expiry_date < current_date))
      ) THEN 'attention'
      ELSE 'clear'
    END,
    array_remove(ARRAY[
      CASE
        WHEN up.id IS NULL THEN 'Identity is not linked'
        WHEN up.deactivated_at IS NOT NULL THEN 'User access is deactivated'
        WHEN up.role NOT IN ('officer', 'admin_officer') THEN 'User is not assigned a field role'
      END,
      CASE WHEN sp.employment_type IS NULL THEN 'Employment type is not set' END,
      CASE
        WHEN sp.start_date IS NULL THEN 'Employment start date is not set'
        WHEN sp.start_date > current_date THEN 'Employment has not started'
      END,
      CASE WHEN sp.end_date IS NOT NULL AND sp.end_date < current_date THEN 'Employment has ended' END,
      CASE WHEN sp.role_code IS NULL THEN 'Payroll role is not assigned' END,
      CASE
        WHEN up.role IN ('officer', 'admin_officer')
          AND NOT EXISTS (
            SELECT 1 FROM public.staff_credentials c
            WHERE c.staff_id = sp.id
              AND c.verified
              AND (c.expiry_date IS NULL OR c.expiry_date >= current_date)
          ) THEN 'No verified current credential'
      END
    ], NULL)::text[]
  FROM public.staff_profiles sp
  LEFT JOIN public.user_profiles up ON up.id = sp.user_id
  WHERE sp.organization_id = p_organization_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_staff_readiness_assessment(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_staff_readiness_assessment(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_user_spine_readiness(p_organization_id uuid)
RETURNS TABLE(
  user_id uuid,
  identity_status text,
  employment_status text,
  access_status text,
  credential_status text,
  work_status text,
  blockers text[],
  next_action text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Not authorised to assess users';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    CASE WHEN u.deactivated_at IS NOT NULL THEN 'deactivated' WHEN u.email IS NULL OR u.display_name IS NULL THEN 'incomplete' ELSE 'active' END,
    CASE
      WHEN u.role IN ('officer', 'admin_officer') AND sp.id IS NULL THEN 'missing'
      WHEN sp.id IS NULL THEN 'not_applicable'
      WHEN sp.end_date IS NOT NULL AND sp.end_date < current_date THEN 'ended'
      WHEN sp.employment_type IS NULL OR sp.start_date IS NULL OR sp.role_code IS NULL THEN 'incomplete'
      ELSE 'current'
    END,
    CASE
      WHEN u.role IN ('grand_master', 'master', 'admin', 'admin_officer')
        AND NOT EXISTS (
          SELECT 1 FROM public.preset_assignments pa
          WHERE pa.user_id = u.id
            AND pa.scope_org_id = u.organization_id
            AND pa.status = 'active'
        ) THEN 'missing_preset'
      ELSE 'role_scoped'
    END,
    CASE
      WHEN u.role IN ('officer', 'admin_officer')
        AND sp.id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_credentials c
          WHERE c.staff_id = sp.id
            AND c.verified
            AND (c.expiry_date IS NULL OR c.expiry_date >= current_date)
        ) THEN 'missing_valid'
      WHEN u.role IN ('officer', 'admin_officer') THEN 'current'
      ELSE 'not_applicable'
    END,
    CASE
      WHEN u.role IN ('officer', 'admin_officer') AND coalesce(sp.work_ready, false) THEN 'ready'
      WHEN u.role IN ('officer', 'admin_officer') THEN 'blocked'
      ELSE 'not_applicable'
    END,
    array_remove(ARRAY[
      CASE WHEN u.deactivated_at IS NOT NULL THEN 'Reactivate the identity before assigning work' END,
      CASE WHEN u.display_name IS NULL OR u.email IS NULL THEN 'Complete the identity profile' END,
      CASE WHEN u.role IN ('officer', 'admin_officer') AND sp.id IS NULL THEN 'Create the employment profile' END,
      CASE WHEN sp.id IS NOT NULL AND sp.employment_type IS NULL THEN 'Select an employment type' END,
      CASE WHEN sp.id IS NOT NULL AND sp.start_date IS NULL THEN 'Set an employment start date' END,
      CASE WHEN sp.id IS NOT NULL AND sp.role_code IS NULL THEN 'Assign a payroll role' END,
      CASE
        WHEN u.role IN ('grand_master', 'master', 'admin', 'admin_officer')
          AND NOT EXISTS (
            SELECT 1 FROM public.preset_assignments pa
            WHERE pa.user_id = u.id
              AND pa.scope_org_id = u.organization_id
              AND pa.status = 'active'
          ) THEN 'Assign an access preset'
      END,
      CASE
        WHEN u.role IN ('officer', 'admin_officer')
          AND sp.id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.staff_credentials c
            WHERE c.staff_id = sp.id
              AND c.verified
              AND (c.expiry_date IS NULL OR c.expiry_date >= current_date)
          ) THEN 'Verify a current credential'
      END,
      CASE WHEN u.role IN ('officer', 'admin_officer') AND sp.id IS NOT NULL AND NOT sp.work_ready THEN 'Complete work-readiness review' END
    ], NULL),
    CASE
      WHEN u.deactivated_at IS NOT NULL THEN 'Reactivate identity'
      WHEN u.display_name IS NULL OR u.email IS NULL THEN 'Complete identity profile'
      WHEN u.role IN ('officer', 'admin_officer') AND sp.id IS NULL THEN 'Create employment profile'
      WHEN sp.id IS NOT NULL AND (sp.employment_type IS NULL OR sp.start_date IS NULL OR sp.role_code IS NULL) THEN 'Complete employment setup'
      WHEN u.role IN ('grand_master', 'master', 'admin', 'admin_officer')
        AND NOT EXISTS (
          SELECT 1 FROM public.preset_assignments pa
          WHERE pa.user_id = u.id
            AND pa.scope_org_id = u.organization_id
            AND pa.status = 'active'
        ) THEN 'Assign access preset'
      WHEN u.role IN ('officer', 'admin_officer')
        AND sp.id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_credentials c
          WHERE c.staff_id = sp.id
            AND c.verified
            AND (c.expiry_date IS NULL OR c.expiry_date >= current_date)
        ) THEN 'Verify credential'
      WHEN u.role IN ('officer', 'admin_officer') AND sp.id IS NOT NULL AND NOT sp.work_ready THEN 'Review work readiness'
      ELSE 'Ready for assigned responsibilities'
    END
  FROM public.user_profiles u
  LEFT JOIN public.staff_profiles sp ON sp.user_id = u.id OR sp.id = u.id
  WHERE u.organization_id = p_organization_id
  ORDER BY u.display_name NULLS LAST, u.email;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_user_spine_readiness(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_spine_readiness(uuid) TO authenticated, service_role;