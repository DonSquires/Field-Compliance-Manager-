CREATE OR REPLACE FUNCTION public.get_staff_readiness_assessment(p_organization_id uuid)
RETURNS TABLE(staff_id uuid, user_id uuid, work_ready boolean, identity_status text, employment_status text, credential_status text, training_status text, blockers text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $function$
BEGIN
  IF NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Not authorised to assess staff readiness';
  END IF;

  RETURN QUERY
  SELECT sp.id,
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
      WHEN sp.start_date IS NULL THEN 'missing_start_date'
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
      CASE
        WHEN sp.start_date IS NULL THEN 'Employment start date is not set'
        WHEN sp.start_date > current_date THEN 'Employment has not started'
      END,
      CASE
        WHEN sp.end_date IS NOT NULL AND sp.end_date < current_date THEN 'Employment has ended'
      END,
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
GRANT EXECUTE ON FUNCTION public.get_staff_readiness_assessment(uuid) TO postgres, authenticated, service_role;