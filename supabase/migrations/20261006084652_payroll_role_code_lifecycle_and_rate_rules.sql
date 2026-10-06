CREATE OR REPLACE FUNCTION public.manage_pay_role_code(
	p_action text,
	p_role_code_id uuid DEFAULT NULL,
	p_code text DEFAULT NULL,
	p_name text DEFAULT NULL
)
RETURNS public.reference_codes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_actor uuid := auth.uid();
	v_organization_id uuid;
	v_code text := nullif(trim(coalesce(p_code, '')), '');
	v_name text := nullif(trim(coalesce(p_name, '')), '');
	v_row public.reference_codes%rowtype;
BEGIN
	IF v_actor IS NULL THEN
		RAISE EXCEPTION 'Signed-in payroll administrator required';
	END IF;

	SELECT profile.organization_id INTO v_organization_id
	FROM public.user_profiles profile
	WHERE profile.id = v_actor
		AND profile.deactivated_at IS NULL
		AND profile.role IN ('grand_master', 'master', 'admin');

	IF v_organization_id IS NULL OR NOT public.is_admin_for_org(v_organization_id) THEN
		RAISE EXCEPTION 'Organisation payroll administrator required';
	END IF;

	IF p_action = 'create' THEN
		IF v_code IS NULL OR v_name IS NULL OR length(v_code) > 32 OR length(v_name) > 120
			OR v_code !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' THEN
			RAISE EXCEPTION 'Enter a code (letters, numbers, underscores or hyphens) and a name';
		END IF;

		INSERT INTO public.reference_codes (
			organization_id, code_type, code, name, is_active, sort_order, created_by, updated_by
		) VALUES (
			v_organization_id, 'role_code', v_code, v_name, true,
			coalesce((SELECT max(code.sort_order) + 10 FROM public.reference_codes code
				WHERE code.organization_id = v_organization_id AND code.code_type = 'role_code'), 10),
			v_actor, v_actor
		) RETURNING * INTO v_row;

		INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
		VALUES (v_organization_id, v_actor, 'pay_role_code_created', 'reference_codes', v_row.id,
			jsonb_build_object('code', v_row.code, 'name', v_row.name));
		RETURN v_row;
	END IF;

	IF p_action = 'deactivate' THEN
		SELECT * INTO v_row
		FROM public.reference_codes code
		WHERE code.id = p_role_code_id
			AND code.organization_id = v_organization_id
			AND code.code_type = 'role_code'
		FOR UPDATE;
		IF NOT FOUND THEN RAISE EXCEPTION 'Payroll role code not found in this organisation'; END IF;
		IF NOT v_row.is_active THEN RAISE EXCEPTION 'Payroll role code is already inactive'; END IF;
		IF EXISTS (
			SELECT 1 FROM public.staff_profiles staff
			WHERE staff.organization_id = v_organization_id AND staff.role_code = v_row.code
		) THEN
			RAISE EXCEPTION 'Remove this payroll role from all staff before deactivating it';
		END IF;

		UPDATE public.reference_codes
		SET is_active = false, updated_by = v_actor
		WHERE id = v_row.id
		RETURNING * INTO v_row;

		INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
		VALUES (v_organization_id, v_actor, 'pay_role_code_deactivated', 'reference_codes', v_row.id,
			jsonb_build_object('code', v_row.code, 'name', v_row.name));
		RETURN v_row;
	END IF;

	RAISE EXCEPTION 'Unsupported payroll role-code action';
END;
$$;

REVOKE ALL ON FUNCTION public.manage_pay_role_code(text, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_pay_role_code(text, uuid, text, text) TO authenticated, service_role;

DROP FUNCTION public.manage_operating_branch_rate_rule(
	uuid, uuid, text, uuid, timestamptz, text, text, text, numeric, text,
	text, text, uuid, uuid, uuid, text, date, date, integer
);

CREATE FUNCTION public.manage_operating_branch_rate_rule(
	p_operating_organization_id uuid,
	p_client_request_id uuid,
	p_action text,
	p_rate_rule_id uuid DEFAULT NULL,
	p_expected_updated_at timestamptz DEFAULT NULL,
	p_rule_kind text DEFAULT NULL,
	p_name text DEFAULT NULL,
	p_rate_type text DEFAULT NULL,
	p_amount numeric DEFAULT NULL,
	p_pay_code text DEFAULT NULL,
	p_service_type text DEFAULT NULL,
	p_job_type text DEFAULT NULL,
	p_client_org_id uuid DEFAULT NULL,
	p_site_id uuid DEFAULT NULL,
	p_zone_id uuid DEFAULT NULL,
	p_day_category text DEFAULT NULL,
	p_effective_from date DEFAULT NULL,
	p_effective_to date DEFAULT NULL,
	p_priority integer DEFAULT 0,
	p_role_code text DEFAULT NULL
)
RETURNS public.rate_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_actor uuid := auth.uid();
	v_actor_organization_id uuid;
	v_rule public.rate_rules%rowtype;
	v_name text := nullif(trim(coalesce(p_name, '')), '');
	v_role_code text := nullif(trim(coalesce(p_role_code, '')), '');
	v_rule_kind text;
BEGIN
	IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
	IF NOT public.user_can_operate_organization(p_operating_organization_id)
		OR NOT public.is_admin_for_org(p_operating_organization_id) THEN
		RAISE EXCEPTION 'Active authorized operating branch finance administrator required';
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM public.organizations branch
		WHERE branch.id = p_operating_organization_id
			AND branch.organization_type IN ('owner', 'service_provider', 'branch')
			AND branch.active
	) THEN RAISE EXCEPTION 'Active operating organisation not found'; END IF;

	SELECT profile.organization_id INTO v_actor_organization_id
	FROM public.user_profiles profile
	WHERE profile.id = v_actor AND profile.deactivated_at IS NULL;

	IF p_action = 'create' THEN
		IF v_name IS NULL OR p_rule_kind NOT IN ('pay', 'billing')
			OR p_rate_type NOT IN ('hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage', 'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout', 'higher_duties_flat', 'per_visit', 'per_notice')
			OR p_amount IS NULL OR p_amount < 0 THEN
			RAISE EXCEPTION 'Rule name, kind, rate type, and a non-negative amount are required';
		END IF;
		v_rule_kind := p_rule_kind;
	ELSE
		SELECT * INTO v_rule
		FROM public.rate_rules rule
		WHERE rule.id = p_rate_rule_id AND rule.organization_id = p_operating_organization_id
		FOR UPDATE;
		IF NOT FOUND THEN RAISE EXCEPTION 'Rate rule not found in this operating branch'; END IF;
		IF p_expected_updated_at IS NOT NULL AND v_rule.updated_at <> p_expected_updated_at THEN
			RAISE EXCEPTION 'Rate rule changed since it was opened';
		END IF;
		v_rule_kind := v_rule.rule_kind;
	END IF;

	IF p_day_category IS NOT NULL AND p_day_category NOT IN ('weekday', 'weekend', 'public_holiday', 'night') THEN
		RAISE EXCEPTION 'Unsupported day category';
	END IF;
	IF p_effective_to IS NOT NULL AND p_effective_from IS NOT NULL AND p_effective_to < p_effective_from THEN
		RAISE EXCEPTION 'Effective end cannot precede effective start';
	END IF;
	IF v_role_code IS NOT NULL AND (v_rule_kind <> 'pay' OR NOT EXISTS (
		SELECT 1 FROM public.reference_codes code
		WHERE code.organization_id = v_actor_organization_id
			AND code.code_type = 'role_code'
			AND code.code = v_role_code
			AND code.is_active
	)) THEN
		RAISE EXCEPTION 'Pay role code must be active in your payroll organisation';
	END IF;

	IF p_action = 'create' THEN
		SELECT * INTO v_rule
		FROM public.rate_rules rule
		WHERE rule.organization_id = p_operating_organization_id
			AND rule.client_request_id = p_client_request_id;
		IF FOUND THEN RETURN v_rule; END IF;

		INSERT INTO public.rate_rules (
			organization_id, rule_kind, name, rate_type, amount, pay_code, role_code,
			service_type, job_type, client_org_id, site_id, zone_id, day_category,
			effective_from, effective_to, priority, active, created_by, updated_by, client_request_id
		) VALUES (
			p_operating_organization_id, p_rule_kind, v_name, p_rate_type, p_amount,
			nullif(trim(coalesce(p_pay_code, '')), ''), v_role_code,
			nullif(trim(coalesce(p_service_type, '')), ''), nullif(trim(coalesce(p_job_type, '')), ''),
			p_client_org_id, p_site_id, p_zone_id, p_day_category, p_effective_from,
			p_effective_to, coalesce(p_priority, 0), true, v_actor, v_actor, p_client_request_id
		) RETURNING * INTO v_rule;
	ELSIF p_action = 'update' THEN
		IF v_name IS NULL OR p_rate_type NOT IN ('hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage', 'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout', 'higher_duties_flat', 'per_visit', 'per_notice')
			OR p_amount IS NULL OR p_amount < 0 THEN
			RAISE EXCEPTION 'Rule name, rate type, and non-negative amount are required';
		END IF;
		UPDATE public.rate_rules
		SET name = v_name, rate_type = p_rate_type, amount = p_amount,
			pay_code = nullif(trim(coalesce(p_pay_code, '')), ''),
			role_code = CASE WHEN v_rule_kind = 'billing' THEN NULL WHEN p_role_code IS NULL THEN v_rule.role_code ELSE v_role_code END,
			service_type = nullif(trim(coalesce(p_service_type, '')), ''),
			job_type = nullif(trim(coalesce(p_job_type, '')), ''),
			client_org_id = p_client_org_id, site_id = p_site_id, zone_id = p_zone_id,
			day_category = p_day_category, effective_from = p_effective_from,
			effective_to = p_effective_to, priority = coalesce(p_priority, 0), updated_by = v_actor
		WHERE id = v_rule.id RETURNING * INTO v_rule;
	ELSIF p_action = 'deactivate' THEN
		UPDATE public.rate_rules SET active = false, updated_by = v_actor
		WHERE id = v_rule.id AND active RETURNING * INTO v_rule;
		IF NOT FOUND THEN RAISE EXCEPTION 'Rate rule is already inactive'; END IF;
	ELSIF p_action = 'reactivate' THEN
		UPDATE public.rate_rules SET active = true, updated_by = v_actor
		WHERE id = v_rule.id AND NOT active RETURNING * INTO v_rule;
		IF NOT FOUND THEN RAISE EXCEPTION 'Rate rule is already active'; END IF;
	ELSE
		RAISE EXCEPTION 'Unsupported rate rule action';
	END IF;

	INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
	VALUES (v_rule.organization_id, v_actor, 'operating_branch_rate_rule_managed', 'rate_rules', v_rule.id,
		jsonb_build_object('action', p_action, 'rule_kind', v_rule.rule_kind, 'rate_type', v_rule.rate_type,
			'amount', v_rule.amount, 'role_code', v_rule.role_code, 'client_request_id', p_client_request_id));
	RETURN v_rule;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_operating_branch_rate_rule(
	uuid, uuid, text, uuid, timestamptz, text, text, text, numeric, text,
	text, text, uuid, uuid, uuid, text, date, date, integer, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_operating_branch_rate_rule(
	uuid, uuid, text, uuid, timestamptz, text, text, text, numeric, text,
	text, text, uuid, uuid, uuid, text, date, date, integer, text
) TO authenticated, service_role;
