-- Adds the one governed write path this build was missing: a real, human-
-- authored narrative event on an investigation timeline. The original
-- migration (20260907001000) only ever inserts investigation_events as a
-- side-effect of create_investigation ('investigation_opened') or
-- link_investigation_entity ('entity_linked') - there was no way to record
-- an actual case note (a phone call, an email received, a Police liaison
-- update) without one of those two triggering actions. Found building out
-- real casework (Wrattens' Post/Carr trespass disputes) - the real content
-- IS a sequence of narrative events, not just open/link actions.
CREATE OR REPLACE FUNCTION public.add_investigation_event(
  p_investigation_id uuid,
  p_event_type text,
  p_description text,
  p_occurred_at timestamptz DEFAULT NULL
) RETURNS public.investigation_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_item public.investigations%rowtype; v_event public.investigation_events%rowtype;
BEGIN
  SELECT * INTO v_item FROM public.investigations WHERE id = p_investigation_id FOR SHARE;
  IF NOT FOUND OR v_actor IS NULL OR NOT (public.is_admin_for_org(v_item.organization_id) OR v_item.lead_user_id = v_actor) THEN
    RAISE EXCEPTION 'Investigation access denied';
  END IF;
  IF nullif(trim(p_event_type),'') IS NULL THEN RAISE EXCEPTION 'event_type is required'; END IF;
  IF nullif(trim(p_description),'') IS NULL THEN RAISE EXCEPTION 'description is required'; END IF;
  INSERT INTO public.investigation_events (investigation_id, organization_id, event_type, description, created_by, created_at)
  VALUES (p_investigation_id, v_item.organization_id, trim(p_event_type), trim(p_description), v_actor, coalesce(p_occurred_at, clock_timestamp()))
  RETURNING * INTO v_event;
  RETURN v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.add_investigation_event(uuid,text,text,timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_investigation_event(uuid,text,text,timestamptz) TO authenticated, service_role;
COMMENT ON FUNCTION public.add_investigation_event IS 'Records a human-authored narrative event on an investigation timeline (a case note, a call, correspondence received). Gated the same as reading the timeline: admin-for-org or the investigation''s own assigned lead.';
