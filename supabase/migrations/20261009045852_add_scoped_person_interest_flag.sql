CREATE OR REPLACE FUNCTION public.raise_scoped_person_interest_flag(
	p_organization_id uuid,
	p_client_request_id uuid,
	p_canonical_person_id uuid,
	p_alert_level text,
	p_reason text
) RETURNS public.entity_flags
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	v_actor uuid := auth.uid();
	v_reason text := nullif(trim(coalesce(p_reason, '')), '');
	v_flag public.entity_flags%rowtype;
BEGIN
	IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
	IF v_actor IS NULL OR NOT private.rnm_admin_for_organization(p_organization_id) THEN
		RAISE EXCEPTION 'R&M administrator access to this organization is required';
	END IF;
	SELECT * INTO v_flag
	FROM public.entity_flags
	WHERE organization_id = p_organization_id
		AND client_request_id = p_client_request_id;
	IF FOUND THEN
		IF v_flag.entity_type <> 'person'
			OR v_flag.entity_id <> p_canonical_person_id
			OR v_flag.flag_type <> 'poi'
			OR v_flag.hazard_class IS NOT NULL THEN
			RAISE EXCEPTION 'client_request_id was already used for a different flag';
		END IF;
		RETURN v_flag;
	END IF;
	IF p_alert_level IS NULL OR p_alert_level NOT IN ('low', 'medium', 'high', 'critical') THEN
		RAISE EXCEPTION 'Severity must be low, medium, high or critical';
	END IF;
	IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'A reason and supporting basis of at least 5 characters is required'; END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM public.canonical_person_links cpl
		JOIN public.person_records pr
			ON pr.id = cpl.source_id
			AND pr.organization_id = cpl.organization_id
			AND pr.review_state = 'verified'
		JOIN public.canonical_people cp
			ON cp.id = cpl.canonical_person_id
			AND cp.review_state = 'verified'
			AND cp.status = 'active'
		WHERE cpl.organization_id = p_organization_id
			AND cpl.source_table = 'person_records'
			AND cpl.canonical_person_id = p_canonical_person_id
	) THEN RAISE EXCEPTION 'Select a verified person record with a verified canonical identity in this organization'; END IF;

	PERFORM 1 FROM public.canonical_people cp
	WHERE cp.id = p_canonical_person_id
	FOR UPDATE;
	IF EXISTS (
		SELECT 1 FROM public.entity_flags
		WHERE organization_id = p_organization_id
			AND entity_type = 'person'
			AND entity_id = p_canonical_person_id
			AND flag_type = 'poi'
			AND active
			AND hazard_class IS NULL
	) THEN RAISE EXCEPTION 'An active person-of-interest flag already exists for this organization'; END IF;

	INSERT INTO public.entity_flags (
		organization_id, entity_type, entity_id, flag_type, alert_level, reason,
		hazard_class, active, raised_by, client_request_id
	) VALUES (
		p_organization_id, 'person', p_canonical_person_id, 'poi', p_alert_level,
		v_reason, NULL, true, v_actor, p_client_request_id
	)
	RETURNING * INTO v_flag;

	INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
	VALUES (
		p_organization_id, v_actor, 'entity_flag_raised', 'entity_flags', v_flag.id,
		jsonb_build_object(
			'entity_type', v_flag.entity_type,
			'entity_id', v_flag.entity_id,
			'flag_type', v_flag.flag_type,
			'alert_level', v_flag.alert_level,
			'client_request_id', p_client_request_id
		)
	);
	RETURN v_flag;
END;
$function$;

REVOKE ALL ON FUNCTION public.raise_scoped_person_interest_flag(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.raise_scoped_person_interest_flag(uuid, uuid, uuid, text, text) TO authenticated;
