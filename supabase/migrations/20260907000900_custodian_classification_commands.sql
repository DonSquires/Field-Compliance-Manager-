-- Custodian classification commands: explicit, auditable retention decisions.

ALTER TABLE public.evidence_items
  ADD COLUMN IF NOT EXISTS retention_until timestamptz;

CREATE OR REPLACE FUNCTION public.custodian_classify_observation(
  p_observation_id uuid,
  p_retention_class text,
  p_reason text
) RETURNS public.observations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_item public.observations%rowtype;
  v_org uuid;
  v_until timestamptz;
  v_hold boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_retention_class NOT IN ('interaction_permanent', 'observation_30_day', 'canonical_indefinite', 'legal_hold') THEN
    RAISE EXCEPTION 'Unsupported Custodian retention class %', p_retention_class;
  END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Custodian classification reason is required'; END IF;
  SELECT * INTO v_item FROM public.observations WHERE id = p_observation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Observation not found'; END IF;
  v_org := v_item.organization_id;
  IF NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active organization administrator required'; END IF;
  IF p_retention_class = 'observation_30_day' THEN v_until := clock_timestamp() + interval '30 days'; END IF;
  IF p_retention_class = 'legal_hold' THEN v_hold := true; END IF;
  UPDATE public.observations
    SET retention_until = v_until,
        retention_reason = trim(p_reason),
        retention_hold = v_hold,
        retention_hold_days = NULL
    WHERE observations.id = p_observation_id
    RETURNING * INTO v_item;
  INSERT INTO public.custodian_actions (organization_id, actor_user_id, action, target_table, target_id, reason, metadata)
    VALUES (v_org, v_actor, 'observation_retention_classified', 'observations', p_observation_id, trim(p_reason), jsonb_build_object('retention_class', p_retention_class, 'retention_until', v_until, 'retention_hold', v_hold));
  RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION public.custodian_classify_evidence(
  p_evidence_id uuid,
  p_retention_class text,
  p_reason text
) RETURNS public.evidence_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_item public.evidence_items%rowtype;
  v_days integer;
  v_until timestamptz;
  v_hold boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_retention_class NOT IN ('interaction_permanent', 'observation_30_day', 'canonical_indefinite', 'legal_hold') THEN
    RAISE EXCEPTION 'Unsupported Custodian retention class %', p_retention_class;
  END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Custodian classification reason is required'; END IF;
  SELECT * INTO v_item FROM public.evidence_items WHERE id = p_evidence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evidence item not found'; END IF;
  IF NOT public.is_admin_for_org(v_item.organization_id) AND v_item.captured_by_user_id <> v_actor THEN
    RAISE EXCEPTION 'Not authorised to classify this evidence';
  END IF;
  IF p_retention_class = 'observation_30_day' THEN v_days := 30; v_until := clock_timestamp() + interval '30 days'; END IF;
  IF p_retention_class = 'legal_hold' THEN v_hold := true; END IF;
  UPDATE public.evidence_items
    SET retention_class = p_retention_class,
        retention_days = v_days,
        retention_until = v_until,
        retention_hold = v_hold,
        retention_reason = trim(p_reason)
    WHERE evidence_items.id = p_evidence_id
    RETURNING * INTO v_item;
  INSERT INTO public.custodian_actions (organization_id, actor_user_id, action, target_table, target_id, reason, metadata)
    VALUES (v_item.organization_id, v_actor, 'evidence_retention_classified', 'evidence_items', p_evidence_id, trim(p_reason), jsonb_build_object('retention_class', p_retention_class, 'retention_until', v_until, 'retention_hold', v_hold));
  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.custodian_classify_observation(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.custodian_classify_observation(uuid, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.custodian_classify_evidence(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.custodian_classify_evidence(uuid, text, text) TO authenticated, service_role;
