-- Fixes a real gap found 2026-09-24 while live-verifying R&M's Roster page against
-- R&M's own real data: get_operating_branch_roster_staff only ever matched staff via
-- staff_branch_authorisations, a data model built entirely around multi-branch/
-- franchise structures. A standalone service provider (no branches at all, e.g. R&M)
-- has zero staff_branch_authorisations rows, so this RPC always returned empty for
-- them, regardless of how many real staff/shifts actually exist - and the frontend's
-- own gate (RosterOperationsPage.tsx) additionally refused to even call it unless the
-- operating context's authority_basis was 'branch_authorisation', so a standalone
-- org's own admin viewing their OWN organisation directly ('organisation_home') could
-- never see their roster staff at all. Confirmed live: R&M's admin, viewing R&M
-- itself, saw "0 rosterable staff" while the Field Operations page's own separate
-- "officers on duty" count correctly showed 1 (a real shift created this session).
--
-- Fix (additive only - never narrows the existing branch-based match):
--   1. This migration: also match a user_profiles row whose organization_id IS the
--      operating org directly (a standalone org's own staff), in addition to the
--      existing staff_branch_authorisations-based match. Every existing branch/
--      franchise customer's results are byte-identical - this only adds rows that
--      were never returned before.
--   2. apps/web/src/pages/RosterOperationsPage.tsx (companion frontend change): the
--      gate now blocks only 'corporate_oversight' (a read-only view spanning every
--      branch at once - no single roster to run), not 'organisation_home' too.

CREATE OR REPLACE FUNCTION "public"."get_operating_branch_roster_staff"(p_operating_organization_id uuid)
 RETURNS TABLE(user_id uuid, staff_id uuid, display_name text, email text, employment_type text, work_ready boolean, credential_expiry date, credential_verified boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
  LEFT JOIN public.staff_credentials credential ON credential.staff_id=staff.id
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
  LEFT JOIN public.staff_credentials credential ON credential.staff_id=staff.id
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
