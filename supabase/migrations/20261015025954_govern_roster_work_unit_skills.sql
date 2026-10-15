CREATE UNIQUE INDEX idx_audit_roster_work_unit_skill_request
  ON public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  WHERE action = 'roster_work_unit_skill_ids_updated'
    AND target_table = 'roster_work_units'
    AND (metadata ->> 'client_request_id') IS NOT NULL;

DROP FUNCTION public.manage_roster_work_unit_skill_requirements(uuid, text[]);
DROP FUNCTION public.manage_roster_work_unit_skill_ids(uuid, uuid[]);

CREATE FUNCTION public.manage_roster_work_unit_skill_ids(
  p_client_request_id uuid,
  p_work_unit_id uuid,
  p_expected_updated_at timestamptz,
  p_required_skill_ids uuid[]
)
RETURNS public.roster_work_units
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_unit public.roster_work_units%rowtype;
  v_receipt public.audit_log%rowtype;
  v_requested_ids uuid[];
  v_skill_ids uuid[];
  v_skill_names text[];
  v_previous_ids uuid[];
  v_previous_names text[];
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Active user required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;
  IF p_work_unit_id IS NULL THEN
    RAISE EXCEPTION 'Work unit is required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('roster-work-unit-skills:' || p_client_request_id::text, 0)
  );

  SELECT coalesce(array_agg(DISTINCT requested_id ORDER BY requested_id), '{}'::uuid[])
    INTO v_requested_ids
    FROM unnest(coalesce(p_required_skill_ids, '{}'::uuid[])) AS requested_id;

  SELECT rwu.*
    INTO v_unit
    FROM public.roster_work_units rwu
   WHERE rwu.id = p_work_unit_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work unit not found';
  END IF;
  IF NOT public.is_admin_for_org(v_unit.organization_id) THEN
    RAISE EXCEPTION 'Roster administrator required';
  END IF;

  SELECT al.*
    INTO v_receipt
    FROM public.audit_log al
   WHERE al.organization_id = v_unit.organization_id
     AND al.action = 'roster_work_unit_skill_ids_updated'
     AND al.target_table = 'roster_work_units'
     AND al.metadata ->> 'client_request_id' = p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt.target_id IS DISTINCT FROM v_unit.id
       OR v_receipt.metadata -> 'requested_skill_ids' IS DISTINCT FROM to_jsonb(v_requested_ids) THEN
      RAISE EXCEPTION 'client_request_id has already been used for different work-unit skill requirements';
    END IF;
    RETURN jsonb_populate_record(
      NULL::public.roster_work_units,
      v_receipt.metadata -> 'record'
    );
  END IF;

  IF p_expected_updated_at IS NULL
     OR v_unit.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Work unit changed after it was opened. Reload it before saving required skills.';
  END IF;

  SELECT
    coalesce(array_agg(rsc.id ORDER BY rsc.id), '{}'::uuid[]),
    coalesce(array_agg(rsc.skill_name ORDER BY rsc.skill_name), '{}'::text[])
    INTO v_skill_ids, v_skill_names
    FROM public.roster_skill_catalog rsc
   WHERE rsc.organization_id = v_unit.organization_id
     AND rsc.active
     AND rsc.id = ANY(v_requested_ids);

  IF cardinality(v_skill_ids) <> cardinality(v_requested_ids) THEN
    RAISE EXCEPTION 'One or more selected skills are inactive or outside this organisation';
  END IF;

  v_previous_ids := v_unit.required_skill_ids;
  v_previous_names := v_unit.required_skill_names;

  UPDATE public.roster_work_units
     SET required_skill_ids = v_skill_ids,
         required_skill_names = v_skill_names,
         updated_at = now()
   WHERE id = v_unit.id
  RETURNING * INTO v_unit;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_unit.organization_id,
    v_actor,
    'roster_work_unit_skill_ids_updated',
    'roster_work_units',
    v_unit.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'requested_skill_ids', v_requested_ids,
      'previous_skill_ids', v_previous_ids,
      'previous_skill_names', v_previous_names,
      'resulting_skill_ids', v_unit.required_skill_ids,
      'resulting_skill_names', v_unit.required_skill_names,
      'record', to_jsonb(v_unit)
    )
  );

  RETURN v_unit;
END;
$function$;

COMMENT ON FUNCTION public.manage_roster_work_unit_skill_ids(
  uuid,
  uuid,
  timestamptz,
  uuid[]
) IS 'Replay-safe, optimistic roster work-unit skill configuration. Accepts only active organization catalog IDs, updates the names projection, and records before/after evidence.';

REVOKE ALL ON FUNCTION public.manage_roster_work_unit_skill_ids(
  uuid,
  uuid,
  timestamptz,
  uuid[]
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_roster_work_unit_skill_ids(
  uuid,
  uuid,
  timestamptz,
  uuid[]
) TO postgres, authenticated, service_role;