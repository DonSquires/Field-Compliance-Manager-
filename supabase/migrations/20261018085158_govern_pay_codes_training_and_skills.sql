INSERT INTO public.reference_codes (
  organization_id,
  code_type,
  code,
  name,
  is_active,
  sort_order,
  created_by,
  updated_by
)
SELECT
  rule.organization_id,
  'pay_item',
  trim(rule.pay_code),
  initcap(replace(replace(trim(rule.pay_code), '_', ' '), '-', ' ')),
  true,
  row_number() OVER (PARTITION BY rule.organization_id ORDER BY trim(rule.pay_code)) * 10,
  rule.created_by,
  rule.updated_by
FROM (
  SELECT DISTINCT ON (organization_id, trim(pay_code))
    organization_id,
    pay_code,
    created_by,
    updated_by
  FROM public.rate_rules
  WHERE rule_kind = 'pay'
    AND nullif(trim(coalesce(pay_code, '')), '') IS NOT NULL
  ORDER BY organization_id, trim(pay_code), created_at
) rule
ON CONFLICT (organization_id, code_type, code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.manage_pay_code(
  p_action text,
  p_pay_code_id uuid DEFAULT NULL,
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
  v_code text := upper(nullif(trim(coalesce(p_code, '')), ''));
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_row public.reference_codes%rowtype;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Signed-in payroll administrator required';
  END IF;

  SELECT profile.organization_id
  INTO v_organization_id
  FROM public.user_profiles profile
  WHERE profile.id = v_actor
    AND profile.deactivated_at IS NULL
    AND profile.role IN ('grand_master', 'master', 'admin');

  IF v_organization_id IS NULL OR NOT public.is_admin_for_org(v_organization_id) THEN
    RAISE EXCEPTION 'Organisation payroll administrator required';
  END IF;

  IF p_action = 'create' THEN
    IF v_code IS NULL OR v_name IS NULL OR length(v_code) > 32 OR length(v_name) > 120
      OR v_code !~ '^[A-Z0-9][A-Z0-9_-]*$' THEN
      RAISE EXCEPTION 'Enter a pay code using letters, numbers, underscores, or hyphens and a display name';
    END IF;

    INSERT INTO public.reference_codes (
      organization_id, code_type, code, name, is_active, sort_order, created_by, updated_by
    ) VALUES (
      v_organization_id, 'pay_item', v_code, v_name, true,
      coalesce((
        SELECT max(code.sort_order) + 10
        FROM public.reference_codes code
        WHERE code.organization_id = v_organization_id
          AND code.code_type = 'pay_item'
      ), 10),
      v_actor, v_actor
    )
    RETURNING * INTO v_row;

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_organization_id, v_actor, 'pay_code_created', 'reference_codes', v_row.id,
      jsonb_build_object('code', v_row.code, 'name', v_row.name)
    );
    RETURN v_row;
  END IF;

  IF p_action = 'deactivate' THEN
    SELECT *
    INTO v_row
    FROM public.reference_codes code
    WHERE code.id = p_pay_code_id
      AND code.organization_id = v_organization_id
      AND code.code_type = 'pay_item'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pay code not found in this organisation';
    END IF;
    IF NOT v_row.is_active THEN
      RAISE EXCEPTION 'Pay code is already inactive';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.rate_rules rule
      WHERE rule.organization_id = ANY(public.get_descendant_organizations(v_organization_id))
        AND rule.rule_kind = 'pay'
        AND rule.active
        AND rule.pay_code = v_row.code
    ) THEN
      RAISE EXCEPTION 'Deactivate or move every active pay rule using this pay code first';
    END IF;

    UPDATE public.reference_codes
    SET is_active = false,
        updated_by = v_actor
    WHERE id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_organization_id, v_actor, 'pay_code_deactivated', 'reference_codes', v_row.id,
      jsonb_build_object('code', v_row.code, 'name', v_row.name)
    );
    RETURN v_row;
  END IF;

  RAISE EXCEPTION 'Unsupported pay-code action';
END;
$$;

REVOKE ALL ON FUNCTION public.manage_pay_code(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_pay_code(text, uuid, text, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_payroll_setup_readiness(
  p_operating_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_payroll_organization_id uuid;
  v_result jsonb;
BEGIN
  SELECT profile.organization_id
  INTO v_payroll_organization_id
  FROM public.user_profiles profile
  WHERE profile.id = v_actor
    AND profile.deactivated_at IS NULL
    AND profile.role IN ('grand_master', 'master', 'admin');

  IF v_payroll_organization_id IS NULL
    OR NOT public.user_can_operate_organization(p_operating_organization_id)
    OR NOT public.is_admin_for_org(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized payroll administrator required';
  END IF;

  SELECT jsonb_build_object(
    'payroll_organization_id', v_payroll_organization_id,
    'operating_organization_id', p_operating_organization_id,
    'active_pay_code_count', (
      SELECT count(*)
      FROM public.reference_codes code
      WHERE code.organization_id = v_payroll_organization_id
        AND code.code_type = 'pay_item'
        AND code.is_active
    ),
    'unassigned_staff_count', (
      SELECT count(*)
      FROM public.staff_profiles staff
      WHERE staff.organization_id = v_payroll_organization_id
        AND staff.end_date IS NULL
        AND staff.role_code IS NULL
    ),
    'rules_without_active_pay_code', (
      SELECT count(*)
      FROM public.rate_rules rule
      WHERE rule.organization_id = p_operating_organization_id
        AND rule.rule_kind = 'pay'
        AND rule.active
        AND NOT EXISTS (
          SELECT 1
          FROM public.reference_codes code
          WHERE code.organization_id = v_payroll_organization_id
            AND code.code_type = 'pay_item'
            AND code.code = rule.pay_code
            AND code.is_active
        )
    ),
    'roles', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'code', role.code,
          'name', role.name,
          'staff_count', (
            SELECT count(*)
            FROM public.staff_profiles staff
            WHERE staff.organization_id = v_payroll_organization_id
              AND staff.end_date IS NULL
              AND staff.role_code = role.code
          ),
          'specific_rule_count', (
            SELECT count(*)
            FROM public.rate_rules rule
            WHERE rule.organization_id = p_operating_organization_id
              AND rule.rule_kind = 'pay'
              AND rule.active
              AND rule.role_code = role.code
          ),
          'fallback_rule_count', (
            SELECT count(*)
            FROM public.rate_rules rule
            WHERE rule.organization_id = p_operating_organization_id
              AND rule.rule_kind = 'pay'
              AND rule.active
              AND rule.role_code IS NULL
          ),
          'status', CASE
            WHEN EXISTS (
              SELECT 1 FROM public.rate_rules rule
              WHERE rule.organization_id = p_operating_organization_id
                AND rule.rule_kind = 'pay'
                AND rule.active
                AND rule.role_code = role.code
            ) THEN 'ready'
            WHEN EXISTS (
              SELECT 1 FROM public.rate_rules rule
              WHERE rule.organization_id = p_operating_organization_id
                AND rule.rule_kind = 'pay'
                AND rule.active
                AND rule.role_code IS NULL
            ) THEN 'fallback'
            ELSE 'missing_rule'
          END
        )
        ORDER BY role.sort_order, role.code
      )
      FROM public.reference_codes role
      WHERE role.organization_id = v_payroll_organization_id
        AND role.code_type = 'role_code'
        AND role.is_active
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_payroll_setup_readiness(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_payroll_setup_readiness(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_operating_branch_rate_rule(
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
  v_pay_code text := upper(nullif(trim(coalesce(p_pay_code, '')), ''));
  v_role_code text := nullif(trim(coalesce(p_role_code, '')), '');
  v_rule_kind text;
BEGIN
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;
  IF NOT public.user_can_operate_organization(p_operating_organization_id)
    OR NOT public.is_admin_for_org(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized operating branch finance administrator required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.organizations branch
    WHERE branch.id = p_operating_organization_id
      AND branch.organization_type IN ('owner', 'service_provider', 'branch')
      AND branch.active
  ) THEN
    RAISE EXCEPTION 'Active operating organisation not found';
  END IF;

  SELECT profile.organization_id
  INTO v_actor_organization_id
  FROM public.user_profiles profile
  WHERE profile.id = v_actor
    AND profile.deactivated_at IS NULL;

  IF p_action = 'create' THEN
    IF v_name IS NULL OR p_rule_kind NOT IN ('pay', 'billing')
      OR p_rate_type NOT IN (
        'hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage',
        'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout',
        'higher_duties_flat', 'per_visit', 'per_notice'
      )
      OR p_amount IS NULL OR p_amount < 0 THEN
      RAISE EXCEPTION 'Rule name, kind, rate type, and a non-negative amount are required';
    END IF;
    v_rule_kind := p_rule_kind;
  ELSE
    SELECT *
    INTO v_rule
    FROM public.rate_rules rule
    WHERE rule.id = p_rate_rule_id
      AND rule.organization_id = p_operating_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rate rule not found in this operating branch';
    END IF;
    IF p_expected_updated_at IS NOT NULL AND v_rule.updated_at <> p_expected_updated_at THEN
      RAISE EXCEPTION 'Rate rule changed since it was opened';
    END IF;
    v_rule_kind := v_rule.rule_kind;
    IF v_rule_kind = 'pay' AND v_pay_code IS NULL THEN
      v_pay_code := v_rule.pay_code;
    END IF;
  END IF;

  IF p_day_category IS NOT NULL
    AND p_day_category NOT IN ('weekday', 'weekend', 'public_holiday', 'night') THEN
    RAISE EXCEPTION 'Unsupported day category';
  END IF;
  IF p_effective_to IS NOT NULL AND p_effective_from IS NOT NULL
    AND p_effective_to < p_effective_from THEN
    RAISE EXCEPTION 'Effective end cannot precede effective start';
  END IF;
  IF v_role_code IS NOT NULL AND (
    v_rule_kind <> 'pay'
    OR NOT EXISTS (
      SELECT 1
      FROM public.reference_codes code
      WHERE code.organization_id = v_actor_organization_id
        AND code.code_type = 'role_code'
        AND code.code = v_role_code
        AND code.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Payroll role must be active in your payroll organisation';
  END IF;
  IF v_rule_kind = 'pay' AND p_action <> 'deactivate' AND (
    v_pay_code IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.reference_codes code
      WHERE code.organization_id = v_actor_organization_id
        AND code.code_type = 'pay_item'
        AND code.code = v_pay_code
        AND code.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Choose an active payroll pay code before saving a pay rule';
  END IF;

  IF p_action = 'create' THEN
    SELECT *
    INTO v_rule
    FROM public.rate_rules rule
    WHERE rule.organization_id = p_operating_organization_id
      AND rule.client_request_id = p_client_request_id;
    IF FOUND THEN
      RETURN v_rule;
    END IF;

    INSERT INTO public.rate_rules (
      organization_id, rule_kind, name, rate_type, amount, pay_code, role_code,
      service_type, job_type, client_org_id, site_id, zone_id, day_category,
      effective_from, effective_to, priority, active, created_by, updated_by, client_request_id
    ) VALUES (
      p_operating_organization_id, p_rule_kind, v_name, p_rate_type, p_amount,
      CASE WHEN p_rule_kind = 'pay' THEN v_pay_code ELSE nullif(trim(coalesce(p_pay_code, '')), '') END,
      v_role_code,
      nullif(trim(coalesce(p_service_type, '')), ''),
      nullif(trim(coalesce(p_job_type, '')), ''),
      p_client_org_id, p_site_id, p_zone_id, p_day_category, p_effective_from,
      p_effective_to, coalesce(p_priority, 0), true, v_actor, v_actor, p_client_request_id
    )
    RETURNING * INTO v_rule;
  ELSIF p_action = 'update' THEN
    IF v_name IS NULL OR p_rate_type NOT IN (
      'hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage',
      'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout',
      'higher_duties_flat', 'per_visit', 'per_notice'
    ) OR p_amount IS NULL OR p_amount < 0 THEN
      RAISE EXCEPTION 'Rule name, rate type, and non-negative amount are required';
    END IF;

    UPDATE public.rate_rules
    SET name = v_name,
        rate_type = p_rate_type,
        amount = p_amount,
        pay_code = CASE
          WHEN v_rule_kind = 'pay' THEN v_pay_code
          ELSE nullif(trim(coalesce(p_pay_code, '')), '')
        END,
        role_code = CASE
          WHEN v_rule_kind = 'billing' THEN NULL
          WHEN p_role_code IS NULL THEN v_rule.role_code
          ELSE v_role_code
        END,
        service_type = nullif(trim(coalesce(p_service_type, '')), ''),
        job_type = nullif(trim(coalesce(p_job_type, '')), ''),
        client_org_id = p_client_org_id,
        site_id = p_site_id,
        zone_id = p_zone_id,
        day_category = p_day_category,
        effective_from = p_effective_from,
        effective_to = p_effective_to,
        priority = coalesce(p_priority, 0),
        updated_by = v_actor
    WHERE id = v_rule.id
    RETURNING * INTO v_rule;
  ELSIF p_action = 'deactivate' THEN
    UPDATE public.rate_rules
    SET active = false,
        updated_by = v_actor
    WHERE id = v_rule.id
      AND active
    RETURNING * INTO v_rule;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rate rule is already inactive';
    END IF;
  ELSIF p_action = 'reactivate' THEN
    UPDATE public.rate_rules
    SET active = true,
        updated_by = v_actor
    WHERE id = v_rule.id
      AND NOT active
    RETURNING * INTO v_rule;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rate rule is already active';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported rate rule action';
  END IF;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_rule.organization_id, v_actor, 'operating_branch_rate_rule_managed', 'rate_rules', v_rule.id,
    jsonb_build_object(
      'action', p_action,
      'rule_kind', v_rule.rule_kind,
      'rate_type', v_rule.rate_type,
      'amount', v_rule.amount,
      'pay_code', v_rule.pay_code,
      'role_code', v_rule.role_code,
      'client_request_id', p_client_request_id
    )
  );
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

ALTER TABLE public.staff_training_records
  ADD COLUMN IF NOT EXISTS client_request_id uuid,
  ADD COLUMN IF NOT EXISTS supersedes_training_record_id uuid
    REFERENCES public.staff_training_records(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_training_records_request
  ON public.staff_training_records (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_staff_training(
  p_client_request_id uuid,
  p_staff_id uuid,
  p_training_name text,
  p_training_type text,
  p_provider text,
  p_completed_date date,
  p_expiry_date date DEFAULT NULL,
  p_passed boolean DEFAULT NULL,
  p_score numeric DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_supersedes_training_record_id uuid DEFAULT NULL
)
RETURNS public.staff_training_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_previous public.staff_training_records%rowtype;
  v_record public.staff_training_records%rowtype;
  v_training_name text := nullif(trim(coalesce(p_training_name, '')), '');
  v_training_type text := lower(nullif(trim(coalesce(p_training_type, '')), ''));
BEGIN
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;

  SELECT *
  INTO v_staff
  FROM public.staff_profiles staff
  WHERE staff.id = p_staff_id
  FOR UPDATE;

  IF NOT FOUND OR NOT public.is_admin_for_org(v_staff.organization_id) THEN
    RAISE EXCEPTION 'Organisation training administrator required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));

  SELECT *
  INTO v_record
  FROM public.staff_training_records record
  WHERE record.client_request_id = p_client_request_id
    AND record.organization_id = v_staff.organization_id
    AND record.staff_id = v_staff.id;
  IF FOUND THEN
    RETURN v_record;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.staff_training_records record
    WHERE record.client_request_id = p_client_request_id
  ) THEN
    RAISE EXCEPTION 'client_request_id has already been used for another training record';
  END IF;

  IF v_training_name IS NULL THEN
    RAISE EXCEPTION 'Training name is required';
  END IF;
  IF v_training_type NOT IN ('induction', 'internal', 'external', 'refresher', 'assessment') THEN
    RAISE EXCEPTION 'Unsupported training type';
  END IF;
  IF p_completed_date IS NULL THEN
    RAISE EXCEPTION 'Completion date is required';
  END IF;
  IF p_expiry_date IS NOT NULL AND p_expiry_date < p_completed_date THEN
    RAISE EXCEPTION 'Training expiry cannot precede completion';
  END IF;
  IF p_score IS NOT NULL AND (p_score < 0 OR p_score > 100) THEN
    RAISE EXCEPTION 'Training score must be between 0 and 100';
  END IF;

  IF p_supersedes_training_record_id IS NOT NULL THEN
    SELECT *
    INTO v_previous
    FROM public.staff_training_records record
    WHERE record.id = p_supersedes_training_record_id
      AND record.organization_id = v_staff.organization_id
      AND record.staff_id = v_staff.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Previous training record not found for this staff member';
    END IF;
  END IF;

  INSERT INTO public.staff_training_records (
    organization_id,
    staff_id,
    officer_id,
    training_name,
    training_type,
    provider,
    completed_date,
    expiry_date,
    passed,
    score,
    notes,
    recorded_by,
    client_request_id,
    supersedes_training_record_id
  ) VALUES (
    v_staff.organization_id,
    v_staff.id,
    v_staff.user_id,
    v_training_name,
    v_training_type,
    nullif(trim(coalesce(p_provider, '')), ''),
    p_completed_date,
    p_expiry_date,
    p_passed,
    p_score,
    nullif(trim(coalesce(p_notes, '')), ''),
    v_actor,
    p_client_request_id,
    p_supersedes_training_record_id
  )
  RETURNING * INTO v_record;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_staff.organization_id,
    v_actor,
    CASE WHEN p_supersedes_training_record_id IS NULL
      THEN 'staff_training_recorded'
      ELSE 'staff_training_renewed'
    END,
    'staff_training_records',
    v_record.id,
    jsonb_build_object(
      'staff_id', v_staff.id,
      'training_name', v_record.training_name,
      'training_type', v_record.training_type,
      'completed_date', v_record.completed_date,
      'expiry_date', v_record.expiry_date,
      'supersedes_training_record_id', p_supersedes_training_record_id,
      'client_request_id', p_client_request_id
    )
  );

  RETURN v_record;
END;
$$;

REVOKE ALL ON FUNCTION public.record_staff_training(
  uuid, uuid, text, text, text, date, date, boolean, numeric, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_staff_training(
  uuid, uuid, text, text, text, date, date, boolean, numeric, text, uuid
) TO authenticated, service_role;

ALTER TABLE public.staff_skills
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.assign_roster_skill_to_staff(
  p_staff_id uuid,
  p_skill_id uuid,
  p_proficiency_level text,
  p_certified boolean DEFAULT false,
  p_certification_expiry date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.staff_skills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_skill public.roster_skill_catalog%rowtype;
  v_row public.staff_skills%rowtype;
  v_created boolean := false;
BEGIN
  SELECT organization_id
  INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor
    AND deactivated_at IS NULL;

  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN
    RAISE EXCEPTION 'Roster administrator required';
  END IF;
  IF p_proficiency_level NOT IN ('basic', 'competent', 'proficient', 'expert') THEN
    RAISE EXCEPTION 'Unsupported proficiency level';
  END IF;

  SELECT *
  INTO v_skill
  FROM public.roster_skill_catalog
  WHERE id = p_skill_id
    AND organization_id = v_org
    AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active catalog skill required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_profiles
    WHERE id = p_staff_id
      AND organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'Staff profile not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_staff_id::text || ':' || p_skill_id::text, 0));

  SELECT *
  INTO v_row
  FROM public.staff_skills skill
  WHERE skill.staff_id = p_staff_id
    AND skill.skill_id = p_skill_id
  ORDER BY skill.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.staff_skills
    SET skill_name = v_skill.skill_name,
        skill_category = v_skill.skill_category,
        proficiency_level = p_proficiency_level,
        certified = coalesce(p_certified, false),
        certification_expiry = p_certification_expiry,
        notes = nullif(trim(coalesce(p_notes, '')), ''),
        updated_at = now()
    WHERE id = v_row.id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.staff_skills (
      staff_id, organization_id, skill_id, skill_name, skill_category,
      proficiency_level, certified, certification_expiry, notes
    ) VALUES (
      p_staff_id, v_org, v_skill.id, v_skill.skill_name, v_skill.skill_category,
      p_proficiency_level, coalesce(p_certified, false), p_certification_expiry,
      nullif(trim(coalesce(p_notes, '')), '')
    )
    RETURNING * INTO v_row;
    v_created := true;
  END IF;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_org,
    v_actor,
    CASE WHEN v_created THEN 'roster_skill_assigned_to_staff' ELSE 'roster_staff_skill_updated' END,
    'staff_skills',
    v_row.id,
    jsonb_build_object(
      'staff_id', p_staff_id,
      'skill_id', p_skill_id,
      'proficiency_level', p_proficiency_level,
      'certified', coalesce(p_certified, false),
      'certification_expiry', p_certification_expiry
    )
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_roster_skill_to_staff(
  uuid, uuid, text, boolean, date, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assign_roster_skill_to_staff(
  uuid, uuid, text, boolean, date, text
) TO authenticated, service_role;