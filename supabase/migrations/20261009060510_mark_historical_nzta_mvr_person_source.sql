CREATE OR REPLACE FUNCTION public.manage_identity_person_record(
	p_organization_id uuid,
	p_person_record_id uuid,
	p_action text,
	p_fields jsonb,
	p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
	v_result jsonb;
	v_person_id uuid;
	v_security jsonb;
	v_nzta_mvr_sourced boolean;
BEGIN
	IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
		RAISE EXCEPTION 'Identity registry administrator access required';
	END IF;
	IF p_fields ? 'nzta_mvr_sourced'
		 AND jsonb_typeof(p_fields->'nzta_mvr_sourced') <> 'boolean' THEN
		RAISE EXCEPTION 'NZTA source marker must be a boolean';
	END IF;

	v_result := public.manage_identity_person(
		p_organization_id, p_person_record_id, p_action, p_fields, p_reason
	);
	IF p_action NOT IN ('create', 'update') THEN RETURN v_result; END IF;
	v_person_id := (v_result->>'person_record_id')::uuid;

	v_security := jsonb_strip_nulls(jsonb_build_object(
		'security_licence_number', nullif(trim(p_fields->>'security_licence_number'), ''),
		'security_licence_expiry', nullif(p_fields->>'security_licence_expiry', '')::date,
		'security_licence_authority', nullif(trim(p_fields->>'security_licence_authority'), ''),
		'security_endorsements', nullif(trim(p_fields->>'security_endorsements'), '')
	));
	IF v_security <> '{}'::jsonb THEN
		UPDATE public.person_records
		SET metadata = metadata || jsonb_build_object(
			'profile_details', coalesce(metadata->'profile_details', '{}'::jsonb) || v_security
		)
		WHERE id = v_person_id AND organization_id = p_organization_id;
	END IF;

	IF p_fields ? 'nzta_mvr_sourced' THEN
		v_nzta_mvr_sourced := (p_fields->>'nzta_mvr_sourced')::boolean;
		UPDATE public.person_records
		SET metadata = metadata || jsonb_build_object(
			'profile_details', coalesce(metadata->'profile_details', '{}'::jsonb)
				|| jsonb_build_object('nzta_mvr_sourced', v_nzta_mvr_sourced)
		)
		WHERE id = v_person_id AND organization_id = p_organization_id;
	END IF;

	RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_identity_person_record(uuid, uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_identity_person_record(uuid, uuid, text, jsonb, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.manage_identity_person_record(uuid, uuid, text, jsonb, text) IS
	'Administrator identity-person write path. Preserves the explicit NZTA MVR source marker as historical provenance only; it does not represent current authority.';
