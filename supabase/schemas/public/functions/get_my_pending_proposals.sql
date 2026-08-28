create or replace function public.get_my_pending_proposals (
  p_limit integer default 20
)
  returns table (
    id               uuid,
    action_type      text,
    status           text,
    bob_reasoning    text,
    confidence_score real,
    context_table    text,
    created_at       timestamp with time zone,
    proposed_payload jsonb,
    amended_payload  jsonb,
    organization_id  uuid,
    triggered_by     uuid,
    user_id          uuid
  )
  language plpgsql
  stable
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_role    text;
  v_org_id  uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT up.role, up.organization_id
  INTO v_role, v_org_id
  FROM user_profiles up
  WHERE up.id = v_user_id;

  IF v_role IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.action_type,
    a.status,
    a.bob_reasoning,
    a.confidence_score,
    a.context_table,
    a.created_at,
    a.proposed_payload,
    a.amended_payload,
    a.organization_id,
    a.triggered_by,
    a.user_id
  FROM bob_agentic_actions a
  WHERE a.status IN ('pending', 'pending_approval', 'proposed')
    AND (
      -- Actions I triggered
      a.triggered_by = v_user_id
      -- Actions attributed to me (backward compat)
      OR a.user_id = v_user_id
      -- Actions explicitly assigned to me
      OR a.assigned_approver_id = v_user_id
      -- I am an eligible approver by tree/role
      OR (v_role = 'grand_master')
      OR (v_role IN ('master', 'admin') AND is_admin_for_org(a.organization_id))
    )
  ORDER BY a.created_at DESC
  LIMIT p_limit;
END;
$function$;

grant execute on function "public"."get_my_pending_proposals"(integer) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."get_my_pending_proposals"(integer) is 'Tree-aware per-user bell query for pending bob_agentic_actions. Returns proposals the calling user can see: triggered_by me, user_id me, assigned to me, or I am an eligible approver by org tree. #18/#16.';
