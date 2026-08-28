create or replace function public.can_approve_action (
  p_user_id       uuid,
  p_action_org_id uuid
)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_role text;
BEGIN
  SELECT up.role INTO v_role
  FROM user_profiles up
  WHERE up.id = p_user_id;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- grand_master can approve anything
  IF v_role = 'grand_master' THEN
    RETURN true;
  END IF;

  -- master/admin: check tree-based access
  IF v_role IN ('master', 'admin') THEN
    -- Use a direct check mirroring is_admin_for_org but parameterized by user
    RETURN EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = p_user_id
        AND (
          -- master: descendant tree
          (up.role = 'master' AND (
            p_action_org_id = ANY(get_descendant_organizations(up.employer_organization_id))
            OR p_action_org_id = ANY(get_descendant_organizations(up.organization_id))
            -- Agreement-based (0271 Model A)
            OR EXISTS (
              SELECT 1 FROM service_agreements sa
              WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
                AND sa.client_organization_id = p_action_org_id
                AND (up.organization_id = sa.provider_organization_id
                     OR up.employer_organization_id = sa.provider_organization_id)
            )
          ))
          OR
          -- admin: direct org or descendant tree
          (up.role = 'admin' AND (
            up.organization_id = p_action_org_id
            OR p_action_org_id = ANY(get_descendant_organizations(up.organization_id))
            -- Agreement-based (0271 Model A)
            OR EXISTS (
              SELECT 1 FROM service_agreements sa
              WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
                AND sa.client_organization_id = p_action_org_id
                AND (up.organization_id = sa.provider_organization_id
                     OR up.employer_organization_id = sa.provider_organization_id)
            )
          ))
        )
    );
  END IF;

  RETURN false;
END;
$function$;

grant execute on function "public"."can_approve_action"(uuid, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."can_approve_action"(uuid, uuid) is 'Tree-based authorization check: can user p_user_id approve actions for org p_action_org_id? Mirrors is_admin_for_org logic but parameterized by user_id (not auth.uid()). Used by bob-proposal-approver edge function. #16/#18.';
