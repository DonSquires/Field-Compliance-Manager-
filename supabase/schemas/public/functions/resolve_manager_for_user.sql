create or replace function public.resolve_manager_for_user (
  p_user_id        uuid,
  p_context_org_id uuid
)
  returns table (
    manager_user_id   uuid,
    resolution_source text
  )
  language plpgsql
  stable
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_manager_id     uuid;
  v_source         text;
  v_home_org_id    uuid;
  v_walk_org_id    uuid;
  v_parent_org_id  uuid;
BEGIN
  -- ── Step 1: Branch-specific line_manager at context org ──
  SELECT sr.reports_to_user_id INTO v_manager_id
  FROM public.staff_reporting sr
  WHERE sr.user_id = p_user_id
    AND sr.scope_org_id = p_context_org_id
    AND sr.relationship_type = 'line_manager'
    AND sr.effective_to IS NULL
  LIMIT 1;

  IF v_manager_id IS NOT NULL THEN
    manager_user_id := v_manager_id;
    resolution_source := 'branch_line_manager';
    RETURN NEXT;
    RETURN;
  END IF;

  -- ── Step 2: Org-wide line_manager (at user's home org) ──
  SELECT up.organization_id INTO v_home_org_id
  FROM public.user_profiles up
  WHERE up.id = p_user_id;

  IF v_home_org_id IS NOT NULL AND v_home_org_id <> p_context_org_id THEN
    SELECT sr.reports_to_user_id INTO v_manager_id
    FROM public.staff_reporting sr
    WHERE sr.user_id = p_user_id
      AND sr.scope_org_id = v_home_org_id
      AND sr.relationship_type = 'line_manager'
      AND sr.effective_to IS NULL
    LIMIT 1;

    IF v_manager_id IS NOT NULL THEN
      manager_user_id := v_manager_id;
      resolution_source := 'org_wide_line_manager';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- ── Step 3: Team lead fallback ──
  SELECT t.team_lead_user_id INTO v_manager_id
  FROM public.team_members tm
  JOIN public.teams t ON tm.team_id = t.id
  WHERE tm.user_id = p_user_id
    AND tm.left_at IS NULL
    AND t.status = 'active'
    AND (t.scope_org_id = p_context_org_id OR t.scope_org_id IS NULL)
    AND t.team_lead_user_id IS NOT NULL
    AND t.team_lead_user_id <> p_user_id  -- prevent self-reference
  LIMIT 1;

  IF v_manager_id IS NOT NULL THEN
    manager_user_id := v_manager_id;
    resolution_source := 'team_lead';
    RETURN NEXT;
    RETURN;
  END IF;

  -- ── Step 4: Branch manager by role_at_branch + org tree walk (Q2) ──
  -- Start at the context org, then walk up parent_organization_id
  v_walk_org_id := p_context_org_id;

  LOOP
    SELECT sba.user_id INTO v_manager_id
    FROM public.staff_branch_authorisations sba
    WHERE sba.branch_org_id = v_walk_org_id
      AND sba.role_at_branch = 'branch_manager'
      AND sba.status = 'active'
      AND sba.user_id <> p_user_id  -- prevent self-reference
    LIMIT 1;

    IF v_manager_id IS NOT NULL THEN
      manager_user_id := v_manager_id;
      resolution_source := CASE
        WHEN v_walk_org_id = p_context_org_id THEN 'branch_manager'
        ELSE 'tree_walk_branch_manager'
      END;
      RETURN NEXT;
      RETURN;
    END IF;

    -- Walk up the org tree
    SELECT o.parent_organization_id INTO v_parent_org_id
    FROM public.organizations o
    WHERE o.id = v_walk_org_id;

    -- No parent or reached the root -- stop walking
    IF v_parent_org_id IS NULL THEN
      EXIT;
    END IF;

    v_walk_org_id := v_parent_org_id;
  END LOOP;

  -- ── Step 5: No manager found ──
  RETURN;
END;
$function$;

grant execute on function "public"."resolve_manager_for_user"(uuid, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."resolve_manager_for_user"(uuid, uuid) is '4-step manager resolver with org-tree walk fallback. Returns (manager_user_id, resolution_source). Steps: (1) branch-specific line_manager, (2) org-wide line_manager, (3) team lead, (4) branch_manager by role + tree walk. Returns zero rows if none found. SECURITY DEFINER for system-level consumers (speak-up, welfare). #224.';
