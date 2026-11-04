-- A verified COA may reconcile an identical unverified imported row, without
-- weakening the roster gate for any other credential.
CREATE OR REPLACE FUNCTION public.staff_credential_has_verified_match(p_credential_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_credentials source
    JOIN public.staff_credentials verified
      ON verified.staff_id = source.staff_id
    WHERE source.id = p_credential_id
      AND source.verified IS FALSE
      AND verified.verified IS TRUE
      AND nullif(btrim(source.credential_number), '') IS NOT NULL
      AND nullif(btrim(verified.credential_number), '') = nullif(btrim(source.credential_number), '')
      AND verified.expiry_date IS NOT DISTINCT FROM source.expiry_date
      AND (source.issued_date IS NULL OR verified.issued_date = source.issued_date)
      AND (
        source.credential_type = verified.credential_type
        OR (
          source.credential_type IN ('certificate_of_authority', 'security_licence')
          AND verified.credential_type IN ('certificate_of_authority', 'security_licence')
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.staff_credentials replacement
        WHERE replacement.replaces_credential_id = verified.id
      )
  );
$function$;
REVOKE ALL ON FUNCTION public.staff_credential_has_verified_match(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_credential_has_verified_match(uuid) TO postgres;
COMMENT ON FUNCTION public.staff_credential_has_verified_match(uuid) IS
  'True only when this unverified credential matches an active verified credential for the same staff member by number, issue/expiry dates and canonical credential type.';

CREATE OR REPLACE FUNCTION public.get_operating_branch_roster_staff(p_operating_organization_id uuid)
RETURNS TABLE(user_id uuid, staff_id uuid, display_name text, email text, employment_type text, work_ready boolean, credential_expiry date, credential_verified boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.user_can_operate_organization(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized operating branch required';
  END IF;
  IF NOT public.is_admin_for_org(p_operating_organization_id)
     AND NOT EXISTS(
       SELECT 1 FROM public.staff_branch_authorisations manager_assignment
       WHERE manager_assignment.user_id = v_actor
         AND manager_assignment.branch_org_id = p_operating_organization_id
         AND manager_assignment.status = 'active'
         AND manager_assignment.role_at_branch = 'branch_manager'
     )
     AND NOT EXISTS(
       SELECT 1 FROM public.resolve_access_grants(v_actor,p_operating_organization_id) authority_grant
       WHERE authority_grant.area = 'roster_impact_approve'
         AND authority_grant.level IN ('approve','adjust','manage')
     ) THEN
    RAISE EXCEPTION 'Branch roster authority required';
  END IF;

  RETURN QUERY
  SELECT user_profile.id,staff.id,user_profile.display_name,user_profile.email,staff.employment_type,staff.work_ready,min(credential.expiry_date),bool_and(credential.verified)
  FROM public.staff_branch_authorisations assignment
  JOIN public.user_profiles user_profile ON user_profile.id=assignment.user_id AND user_profile.deactivated_at IS NULL
  JOIN public.staff_profiles staff ON staff.id=coalesce(user_profile.id,staff.user_id) OR staff.user_id=user_profile.id
  LEFT JOIN public.staff_credentials credential
    ON credential.staff_id=staff.id
   AND NOT EXISTS (
     SELECT 1 FROM public.staff_credentials replacement
     WHERE replacement.replaces_credential_id=credential.id
   )
   AND NOT public.staff_credential_has_verified_match(credential.id)
  WHERE assignment.branch_org_id=p_operating_organization_id
    AND assignment.status='active'
    AND assignment.can_be_rostered
    AND (assignment.ends_on IS NULL OR assignment.ends_on>=current_date)
    AND (assignment.starts_on IS NULL OR assignment.starts_on<=current_date)
  GROUP BY user_profile.id,staff.id,user_profile.display_name,user_profile.email,staff.employment_type,staff.work_ready

  UNION

  -- A standalone organisation's own staff (no branch structure required): the
  -- person's home organization_id IS the org being rostered, and they are not
  -- already returned above via an explicit branch grant.
  SELECT user_profile.id,staff.id,user_profile.display_name,user_profile.email,staff.employment_type,staff.work_ready,min(credential.expiry_date),bool_and(credential.verified)
  FROM public.user_profiles user_profile
  JOIN public.staff_profiles staff ON staff.id=coalesce(user_profile.id,staff.user_id) OR staff.user_id=user_profile.id
  LEFT JOIN public.staff_credentials credential
    ON credential.staff_id=staff.id
   AND NOT EXISTS (
     SELECT 1 FROM public.staff_credentials replacement
     WHERE replacement.replaces_credential_id=credential.id
   )
   AND NOT public.staff_credential_has_verified_match(credential.id)
  WHERE user_profile.organization_id=p_operating_organization_id
    AND user_profile.deactivated_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.staff_branch_authorisations existing
      WHERE existing.user_id=user_profile.id
        AND existing.branch_org_id=p_operating_organization_id
        AND existing.status='active'
        AND existing.can_be_rostered
        AND (existing.ends_on IS NULL OR existing.ends_on>=current_date)
        AND (existing.starts_on IS NULL OR existing.starts_on<=current_date)
    )
  GROUP BY user_profile.id,staff.id,user_profile.display_name,user_profile.email,staff.employment_type,staff.work_ready

  ORDER BY 3 NULLS LAST,4;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_operating_branch_roster_staff(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_operating_branch_roster_staff(uuid) TO postgres, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.preview_roster_assignment(
  p_staff_id uuid,
  p_scheduled_start timestamp with time zone,
  p_scheduled_end timestamp with time zone,
  p_exclude_slot_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_rules public.organization_fatigue_rules%rowtype;
  v_load record;
  v_credentials jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_scheduled_start IS NULL OR p_scheduled_end IS NULL OR p_scheduled_end <= p_scheduled_start THEN
    RAISE EXCEPTION 'The shift must end after it starts';
  END IF;
  SELECT * INTO v_staff FROM public.staff_profiles sp WHERE sp.id = p_staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;
  -- Whoever may roster this person may see their load: the employer's administrators, or an administrator of a branch they are authorised at.
  IF NOT (public.is_admin_for_org(v_staff.organization_id) OR EXISTS (
      SELECT 1 FROM public.staff_branch_authorisations a
      WHERE a.user_id = coalesce(v_staff.user_id, v_staff.id)
        AND a.status = 'active'
        AND public.is_admin_for_org(a.branch_org_id))) THEN
    RAISE EXCEPTION 'Not authorised to roster this staff member';
  END IF;

  SELECT r.* INTO v_rules FROM public.organization_fatigue_rules r WHERE r.organization_id = v_staff.organization_id;
  SELECT * INTO v_load FROM public.roster_assignment_load(p_staff_id, p_scheduled_start, p_scheduled_end, p_exclude_slot_id);

  SELECT coalesce(jsonb_agg(jsonb_build_object('credential_type', c.credential_type, 'expiry_date', c.expiry_date, 'verified', c.verified) ORDER BY c.expiry_date NULLS LAST), '[]'::jsonb)
  INTO v_credentials
  FROM public.staff_credentials c
  WHERE c.staff_id = v_staff.id
    AND NOT EXISTS (SELECT 1 FROM public.staff_credentials n WHERE n.replaces_credential_id = c.id)
    AND NOT public.staff_credential_has_verified_match(c.id)
    AND (NOT c.verified OR (c.expiry_date IS NOT NULL AND c.expiry_date < (p_scheduled_end AT TIME ZONE 'Pacific/Auckland')::date));

  RETURN jsonb_build_object(
    'staff_id', v_staff.id,
    'work_ready', v_staff.work_ready,
    'rules', CASE WHEN v_rules.organization_id IS NULL THEN NULL ELSE jsonb_build_object(
      'min_rest_hours_between_shifts', v_rules.min_rest_hours_between_shifts,
      'max_hours_per_week', v_rules.max_hours_per_week,
      'max_consecutive_days', v_rules.max_consecutive_days,
      'enforced', v_rules.enforced) END,
    'rest_hours', v_load.rest_hours,
    'week_start', v_load.week_start,
    'week_hours', v_load.week_hours,
    'consecutive_days', v_load.consecutive_days,
    'availability_conflict', public.staff_has_roster_availability_conflict(v_staff.id, p_scheduled_start, p_scheduled_end),
    'conflict', public.staff_fatigue_conflict(v_staff.id, p_scheduled_start, p_scheduled_end, p_exclude_slot_id),
    'credential_warnings', v_credentials
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.preview_roster_assignment(uuid, timestamp with time zone, timestamp with time zone, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_roster_assignment(uuid, timestamp with time zone, timestamp with time zone, uuid) TO postgres, authenticated, service_role;
COMMENT ON FUNCTION public.preview_roster_assignment(uuid, timestamp with time zone, timestamp with time zone, uuid) IS
  'Before a roster slot is created or edited: the officer''s rest, roster-week hours and days in a row with this slot, the employer''s rules (or null when none are set), the sentence the roster would refuse on, an availability clash, and credentials unverified or expiring before the shift ends. An unverified row with an exact active verified match is treated as the same credential, not an additional blocker.';