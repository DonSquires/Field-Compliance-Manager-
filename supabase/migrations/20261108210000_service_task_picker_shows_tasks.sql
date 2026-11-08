-- The task picker listed every platform module (HR, CRM, invoicing, Bob
-- assistant...) as a payable task because module_catalog has no category.
-- Pickers now show registered tasks plus codes the organisation actually uses
-- (its rules, up the organisation chain, and its work units and shifts).
-- Module keys stay valid for existing writers, and an administrator can
-- register one by name (for example "Noise control") with + New task.

CREATE OR REPLACE FUNCTION public.service_code_catalog(p_organization_id uuid)
 RETURNS TABLE(code text, name text, source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH RECURSIVE chain AS (
    SELECT o.id, o.parent_organization_id, 0 AS depth
      FROM public.organizations o WHERE o.id = p_organization_id
    UNION ALL
    SELECT parent.id, parent.parent_organization_id, chain.depth + 1
      FROM public.organizations parent JOIN chain ON parent.id = chain.parent_organization_id
     WHERE chain.depth < 20
  ), candidates AS (
    SELECT rc.code, rc.name, 'registered'::text AS source, 1 AS rank
      FROM public.reference_codes rc JOIN chain ON chain.id = rc.organization_id
     WHERE rc.code_type = 'service_code' AND rc.is_active
    UNION ALL
    SELECT DISTINCT r.service_type, NULL, 'in_use', 2
      FROM public.rate_rules r JOIN chain ON chain.id = r.organization_id
     WHERE r.active AND r.service_type IS NOT NULL
    UNION ALL
    SELECT DISTINCT u.service_type, NULL, 'rostered', 3
      FROM public.roster_work_units u
     WHERE u.organization_id = p_organization_id AND u.active AND u.service_type IS NOT NULL
    UNION ALL
    SELECT DISTINCT s.service_type, NULL, 'in_use', 4
      FROM public.shifts s
     WHERE s.organization_id = p_organization_id AND s.service_type IS NOT NULL
    UNION ALL
    SELECT m.module_key, NULL, 'module', 9 FROM public.module_catalog m WHERE m.active
  )
  SELECT DISTINCT ON (c.code) c.code,
    coalesce(c.name, upper(left(replace(c.code, '_', ' '), 1)) || substr(replace(c.code, '_', ' '), 2)),
    c.source
    FROM candidates c
   WHERE nullif(btrim(c.code), '') IS NOT NULL
   ORDER BY c.code, c.rank
$function$;
COMMENT ON FUNCTION public.service_code_catalog(uuid) IS
  'Internal: task codes valid for an organisation (registered service_code reference codes on it or a parent, codes its rules, work units and shifts use, then active modules). Callers must authorise; UI uses list_service_codes.';
REVOKE ALL ON FUNCTION public.service_code_catalog(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_code_catalog(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.list_service_codes(p_organization_id uuid)
 RETURNS TABLE(code text, name text, source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT (
    public.user_can_operate_organization(p_organization_id)
    OR public.is_admin_for_org(p_organization_id)
    OR EXISTS (SELECT 1 FROM public.user_profiles u WHERE u.id = auth.uid()
                 AND u.organization_id = p_organization_id AND u.deactivated_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'You cannot read task codes for this organisation' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT c.code, c.name, c.source FROM public.service_code_catalog(p_organization_id) c
                WHERE c.source <> 'module' ORDER BY c.name;
END
$function$;
COMMENT ON FUNCTION public.list_service_codes(uuid) IS
  'Task codes an organisation offers on pay rules, billing rules and shifts: registered tasks and tasks already in use, with human names. Signed-in members or operators of the organisation only.';
REVOKE ALL ON FUNCTION public.list_service_codes(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_service_codes(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_service_code(
  p_action text, p_name text DEFAULT NULL, p_code text DEFAULT NULL, p_organization_id uuid DEFAULT NULL)
 RETURNS public.reference_codes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_organization_id uuid;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_code text := btrim(regexp_replace(lower(coalesce(nullif(btrim(coalesce(p_code, '')), ''), p_name, '')), '[^a-z0-9]+', '_', 'g'), '_');
  v_row public.reference_codes%rowtype;
BEGIN
  -- The task belongs to the organisation whose rules use it (a branch or client), not the editor's home.
  SELECT coalesce(p_organization_id, profile.organization_id) INTO v_organization_id
    FROM public.user_profiles profile
   WHERE profile.id = v_actor AND profile.deactivated_at IS NULL;
  IF v_organization_id IS NULL OR NOT public.is_admin_for_org(v_organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;

  IF v_code = '' OR v_code !~ '^[a-z][a-z0-9_]{1,63}$' THEN
    RAISE EXCEPTION 'Give the task a name that starts with a letter, for example "Camera review"';
  END IF;

  IF p_action = 'create' THEN
    IF v_name IS NULL OR length(v_name) > 120 THEN RAISE EXCEPTION 'Give the task a name of up to 120 characters'; END IF;
    SELECT * INTO v_row FROM public.reference_codes
     WHERE organization_id = v_organization_id AND code_type = 'service_code' AND code = v_code FOR UPDATE;
    IF FOUND AND v_row.is_active THEN RETURN v_row; END IF;
    IF FOUND THEN
      UPDATE public.reference_codes SET is_active = true, name = v_name, updated_by = v_actor
       WHERE id = v_row.id RETURNING * INTO v_row;
    ELSE
      INSERT INTO public.reference_codes (organization_id, code_type, code, name, is_active, sort_order, created_by, updated_by)
      VALUES (v_organization_id, 'service_code', v_code, v_name, true,
        coalesce((SELECT max(sort_order) + 10 FROM public.reference_codes
                   WHERE organization_id = v_organization_id AND code_type = 'service_code'), 10),
        v_actor, v_actor)
      RETURNING * INTO v_row;
    END IF;
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_organization_id, v_actor, 'service_code_created', 'reference_codes', v_row.id,
      jsonb_build_object('code', v_row.code, 'name', v_row.name));
    RETURN v_row;
  END IF;

  IF p_action = 'deactivate' THEN
    SELECT * INTO v_row FROM public.reference_codes
     WHERE organization_id = v_organization_id AND code_type = 'service_code' AND code = v_code AND is_active FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active task code not found in this organisation'; END IF;
    IF EXISTS (SELECT 1 FROM public.rate_rules r
                WHERE r.organization_id = ANY(public.get_descendant_organizations(v_organization_id))
                  AND r.active AND r.service_type = v_code)
      OR EXISTS (SELECT 1 FROM public.roster_work_units u
                WHERE u.organization_id = ANY(public.get_descendant_organizations(v_organization_id))
                  AND u.active AND u.service_type = v_code) THEN
      RAISE EXCEPTION 'Move every active rate rule and work unit off this task first';
    END IF;
    UPDATE public.reference_codes SET is_active = false, updated_by = v_actor WHERE id = v_row.id RETURNING * INTO v_row;
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_organization_id, v_actor, 'service_code_deactivated', 'reference_codes', v_row.id,
      jsonb_build_object('code', v_row.code, 'name', v_row.name));
    RETURN v_row;
  END IF;

  RAISE EXCEPTION 'Unsupported task code action';
END
$function$;
COMMENT ON FUNCTION public.manage_service_code(text, text, text, uuid) IS
  'Administrators of the target organisation (default: their own) add (idempotent, code derived from the name) or retire task codes used by pay rules, billing rules and shifts. Audited.';
REVOKE ALL ON FUNCTION public.manage_service_code(text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_service_code(text, text, text, uuid) TO authenticated, service_role;
