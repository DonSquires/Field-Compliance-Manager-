-- Custodian foundation: governed retention classification, legal holds, and
-- immutable custody actions. Execution/purge remains a separate worker concern.

CREATE TABLE IF NOT EXISTS public.custodian_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  hold_key text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  placed_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  placed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT custodian_legal_holds_status_check CHECK (status IN ('active', 'released')),
  CONSTRAINT custodian_legal_holds_release_check CHECK (
    (status = 'active' AND released_by IS NULL AND released_at IS NULL)
    OR (status = 'released' AND released_by IS NOT NULL AND released_at IS NOT NULL AND nullif(trim(release_reason), '') IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS custodian_legal_holds_active_key
  ON public.custodian_legal_holds (organization_id, hold_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.custodian_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_table text NOT NULL,
  target_id uuid,
  reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.custodian_legal_holds IS
  'Evidence Custodian legal/investigation holds. Active holds block ordinary retention expiry for their scoped records.';
COMMENT ON TABLE public.custodian_actions IS
  'Append-only Evidence Custodian custody decisions: holds, releases, classification, candidate review, export, redaction, and deletion outcomes.';

ALTER TABLE public.evidence_items
  ADD COLUMN IF NOT EXISTS retention_class text,
  ADD COLUMN IF NOT EXISTS retention_until timestamptz,
  ADD COLUMN IF NOT EXISTS retention_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_reason text;

ALTER TABLE public.evidence_items
  DROP CONSTRAINT IF EXISTS evidence_items_retention_class_check;
ALTER TABLE public.evidence_items
  ADD CONSTRAINT evidence_items_retention_class_check CHECK (
    retention_class IS NULL OR retention_class IN ('interaction_permanent', 'observation_30_day', 'canonical_indefinite', 'legal_hold', 'policy_defined')
  );

ALTER TABLE public.custodian_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custodian_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY custodian_legal_holds_select ON public.custodian_legal_holds
  FOR SELECT USING (public.org_access_allowed(organization_id));
CREATE POLICY custodian_actions_select ON public.custodian_actions
  FOR SELECT USING (public.org_access_allowed(organization_id));
REVOKE INSERT, UPDATE, DELETE ON public.custodian_legal_holds FROM public, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.custodian_actions FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.custodian_manage_legal_hold(
  p_action text,
  p_hold_id uuid DEFAULT NULL,
  p_hold_key text DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_scope jsonb DEFAULT '{}'::jsonb,
  p_release_reason text DEFAULT NULL
) RETURNS public.custodian_legal_holds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_hold public.custodian_legal_holds%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT organization_id INTO v_org FROM public.user_profiles
    WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN
    RAISE EXCEPTION 'Active organization administrator required';
  END IF;

  IF p_action = 'place' THEN
    IF nullif(trim(p_hold_key), '') IS NULL OR nullif(trim(p_title), '') IS NULL OR nullif(trim(p_reason), '') IS NULL THEN
      RAISE EXCEPTION 'hold_key, title, and reason are required';
    END IF;
    INSERT INTO public.custodian_legal_holds (
      organization_id, hold_key, title, reason, scope, placed_by
    ) VALUES (
      v_org, trim(p_hold_key), trim(p_title), trim(p_reason), coalesce(p_scope, '{}'::jsonb), v_actor
    ) RETURNING * INTO v_hold;
    UPDATE public.evidence_items e
      SET retention_hold = true, retention_class = 'legal_hold', retention_reason = trim(p_reason)
      WHERE e.organization_id = v_org
        AND (p_scope = '{}'::jsonb OR e.metadata @> coalesce(p_scope, '{}'::jsonb));
    INSERT INTO public.custodian_actions (organization_id, actor_user_id, action, target_table, target_id, reason, metadata)
      VALUES (v_org, v_actor, 'legal_hold_placed', 'custodian_legal_holds', v_hold.id, trim(p_reason), coalesce(p_scope, '{}'::jsonb));
    RETURN v_hold;
  ELSIF p_action = 'release' THEN
    IF p_hold_id IS NULL OR nullif(trim(p_release_reason), '') IS NULL THEN
      RAISE EXCEPTION 'hold_id and release_reason are required';
    END IF;
    UPDATE public.custodian_legal_holds
      SET status = 'released', released_by = v_actor, released_at = clock_timestamp(), release_reason = trim(p_release_reason), updated_at = clock_timestamp()
      WHERE id = p_hold_id AND organization_id = v_org AND status = 'active'
      RETURNING * INTO v_hold;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active legal hold not found'; END IF;
    INSERT INTO public.custodian_actions (organization_id, actor_user_id, action, target_table, target_id, reason, metadata)
      VALUES (v_org, v_actor, 'legal_hold_released', 'custodian_legal_holds', v_hold.id, trim(p_release_reason), jsonb_build_object('hold_key', v_hold.hold_key));
    RETURN v_hold;
  ELSE
    RAISE EXCEPTION 'Unsupported Custodian legal hold action %', p_action;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.custodian_retention_candidates(
  p_organization_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
) RETURNS TABLE (
  target_table text,
  target_id uuid,
  organization_id uuid,
  retention_until timestamptz,
  retention_class text,
  retention_reason text,
  blocked_by_hold boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT 'observations'::text, o.id, o.organization_id, o.retention_until,
    CASE WHEN o.retention_hold THEN 'legal_hold' ELSE 'observation_30_day' END,
    o.retention_reason, o.retention_hold
  FROM public.observations o
  WHERE (p_organization_id IS NULL OR o.organization_id = p_organization_id)
    AND o.retention_until IS NOT NULL
    AND o.retention_until <= clock_timestamp()
  ORDER BY o.retention_until ASC
  LIMIT greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

REVOKE ALL ON FUNCTION public.custodian_manage_legal_hold(text, uuid, text, text, text, jsonb, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custodian_manage_legal_hold(text, uuid, text, text, text, jsonb, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.custodian_retention_candidates(uuid, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.custodian_retention_candidates(uuid, integer) TO authenticated, service_role;
