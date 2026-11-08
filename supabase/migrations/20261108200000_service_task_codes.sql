-- Task (service) codes become organisation-owned data.
-- rate_rules.service_type and shifts.service_type were free text, so pay and
-- billing rules carrying words like "Security Officer" silently never matched a
-- shift. Tasks now come from one catalogue: module_catalog, the organisation's
-- (or a parent's) active reference_codes of code_type 'service_code', and the
-- task codes its rostered work units and shifts already use. Every picker reads
-- list_service_codes; every rate_rules write and shift task change is checked
-- against the same catalogue.

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
    SELECT m.module_key, NULL, 'module', 2 FROM public.module_catalog m WHERE m.active
    UNION ALL
    SELECT DISTINCT u.service_type, NULL, 'rostered', 3
      FROM public.roster_work_units u
     WHERE u.organization_id = p_organization_id AND u.active AND u.service_type IS NOT NULL
    UNION ALL
    SELECT DISTINCT s.service_type, NULL, 'in_use', 4
      FROM public.shifts s
     WHERE s.organization_id = p_organization_id AND s.service_type IS NOT NULL
  )
  SELECT DISTINCT ON (c.code) c.code,
    coalesce(c.name, upper(left(replace(c.code, '_', ' '), 1)) || substr(replace(c.code, '_', ' '), 2)),
    c.source
    FROM candidates c
   WHERE nullif(btrim(c.code), '') IS NOT NULL
   ORDER BY c.code, c.rank
$function$;
COMMENT ON FUNCTION public.service_code_catalog(uuid) IS
  'Internal: task codes valid for an organisation (registered service_code reference codes on it or a parent, active modules, codes its work units and shifts use). Callers must authorise; UI uses list_service_codes.';
REVOKE ALL ON FUNCTION public.service_code_catalog(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_code_catalog(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.is_known_service_code(p_organization_id uuid, p_code text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.service_code_catalog(p_organization_id) c WHERE c.code = p_code)
$function$;
REVOKE ALL ON FUNCTION public.is_known_service_code(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_known_service_code(uuid, text) TO service_role;

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
  RETURN QUERY SELECT c.code, c.name, c.source FROM public.service_code_catalog(p_organization_id) c ORDER BY c.name;
END
$function$;
COMMENT ON FUNCTION public.list_service_codes(uuid) IS
  'Task codes an organisation can use on pay rules, billing rules and shifts, with human names. Signed-in members or operators of the organisation only.';
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
    IF EXISTS (SELECT 1 FROM public.module_catalog m WHERE m.module_key = v_code) THEN
      RAISE EXCEPTION '"%" is already a module task; choose it from the list', replace(v_code, '_', ' ');
    END IF;
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

-- Register the well-formed task codes already in use so nothing in use becomes invalid.
INSERT INTO public.reference_codes (organization_id, code_type, code, name, is_active, sort_order)
SELECT used.organization_id, 'service_code', used.code,
       upper(left(replace(used.code, '_', ' '), 1)) || substr(replace(used.code, '_', ' '), 2), true, 10
  FROM (
    SELECT organization_id, service_type AS code FROM public.rate_rules WHERE active AND service_type IS NOT NULL
    UNION SELECT organization_id, service_type FROM public.roster_work_units WHERE service_type IS NOT NULL
    UNION SELECT organization_id, service_type FROM public.shifts WHERE service_type IS NOT NULL
  ) used
 WHERE used.code ~ '^[a-z][a-z0-9_]{1,63}$'
   AND NOT EXISTS (SELECT 1 FROM public.module_catalog m WHERE m.module_key = used.code)
ON CONFLICT (organization_id, code_type, code) DO NOTHING;

-- Owner decisions (2026-11-08) for live rules whose "task" held something that is not a task.
-- Guard 30: the words were a payroll role, not a task. Same $30 and pay code as the default, so no pay change.
UPDATE public.rate_rules SET role_code = 'SECURITY_OFFICER', service_type = NULL
 WHERE id = '537a7504-61e8-49b0-84ce-bd66a8f31d83' AND service_type = 'Security Officer';
-- Operations Manager: Don Squires Field's own rate ($35/h, changed later through Pay review).
UPDATE public.rate_rules SET staff_id = 'fa236e30-a89a-4302-944c-8e903201ba8a', service_type = NULL,
       name = 'Don Squires Field · Operations Manager · hourly'
 WHERE id = '6e82159c-9fb7-406b-a083-b954ed7144bd' AND service_type = 'Security'
   AND EXISTS (SELECT 1 FROM public.staff_profiles sp
                WHERE sp.id = 'fa236e30-a89a-4302-944c-8e903201ba8a' AND sp.organization_id = rate_rules.organization_id);
-- The organisation-wide "Don Squires Field" rule is superseded by his own rate above.
UPDATE public.rate_rules SET active = false
 WHERE id = 'd3a665f9-fe48-4cf1-9fa4-49c8469dca0e' AND active AND staff_id IS NULL
   AND EXISTS (SELECT 1 FROM public.rate_rules r WHERE r.id = '6e82159c-9fb7-406b-a083-b954ed7144bd' AND r.staff_id IS NOT NULL);
-- Iron Eagle "Pay test" was a test rule.
UPDATE public.rate_rules SET active = false
 WHERE id = 'd32bb481-2c3c-4b32-b5c9-8955f09fcaa2' AND active AND service_type = 'MPP';

-- Remaining free-text tasks: same words as an existing code are corrected to it (e.g. "Static guarding");
-- anything else is registered as its own task under its original wording, so behaviour is unchanged.
WITH free_text AS (
  SELECT r.id, r.organization_id, btrim(r.service_type) AS words,
         btrim(regexp_replace(lower(btrim(r.service_type)), '[^a-z0-9]+', '_', 'g'), '_') AS slug
    FROM public.rate_rules r
   WHERE r.active AND r.service_type IS NOT NULL AND r.service_type !~ '^[a-z][a-z0-9_]{1,63}$'
)
INSERT INTO public.reference_codes (organization_id, code_type, code, name, is_active, sort_order)
SELECT DISTINCT ON (f.organization_id, f.slug) f.organization_id, 'service_code', f.slug, f.words, true, 10
  FROM free_text f
 WHERE f.slug ~ '^[a-z][a-z0-9_]{1,63}$'
   AND NOT public.is_known_service_code(f.organization_id, f.slug)
ON CONFLICT (organization_id, code_type, code) DO NOTHING;

WITH free_text AS (
  SELECT r.id, r.service_type AS before_value,
         btrim(regexp_replace(lower(btrim(r.service_type)), '[^a-z0-9]+', '_', 'g'), '_') AS slug,
         r.organization_id
    FROM public.rate_rules r
   WHERE r.active AND r.service_type IS NOT NULL AND r.service_type !~ '^[a-z][a-z0-9_]{1,63}$'
), corrected AS (
  UPDATE public.rate_rules r SET service_type = f.slug
    FROM free_text f
   WHERE r.id = f.id AND public.is_known_service_code(f.organization_id, f.slug)
  RETURNING r.id, r.organization_id, f.before_value, f.slug
)
INSERT INTO public.audit_log (organization_id, action, target_table, target_id, metadata)
SELECT c.organization_id, 'rate_rule_task_code_normalised', 'rate_rules', c.id,
       jsonb_build_object('from', c.before_value, 'to', c.slug, 'migration', '20261108200000')
  FROM corrected c;

INSERT INTO public.audit_log (organization_id, action, target_table, target_id, metadata)
SELECT r.organization_id, 'rate_rule_owner_correction', 'rate_rules', r.id,
       jsonb_build_object('migration', '20261108200000', 'decided_by', 'owner', 'decision', d.decision)
  FROM (VALUES
    ('537a7504-61e8-49b0-84ce-bd66a8f31d83'::uuid, 'Task "Security Officer" was a role: now the SECURITY_OFFICER role rate for all tasks'),
    ('6e82159c-9fb7-406b-a083-b954ed7144bd'::uuid, 'Task "Security" removed: Operations Manager is Don Squires Field''s own $35/h rate'),
    ('d3a665f9-fe48-4cf1-9fa4-49c8469dca0e'::uuid, 'Organisation-wide Don Squires Field rule ended: superseded by his own rate'),
    ('d32bb481-2c3c-4b32-b5c9-8955f09fcaa2'::uuid, 'Pay test rule ended')
  ) AS d(id, decision)
  JOIN public.rate_rules r ON r.id = d.id
 WHERE NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.target_id = d.id AND a.action = 'rate_rule_owner_correction');

-- Staff pay rates validate tasks against the shared catalogue.
CREATE OR REPLACE FUNCTION public.manage_staff_pay_rate(
  p_client_request_id uuid,
  p_action text,
  p_staff_id uuid,
  p_rate_rule_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_rate_type text DEFAULT 'hourly',
  p_amount numeric DEFAULT NULL,
  p_pay_code text DEFAULT NULL,
  p_service_type text DEFAULT NULL,
  p_effective_from date DEFAULT NULL,
  p_effective_to date DEFAULT NULL,
  p_reason text DEFAULT NULL
)
 RETURNS public.rate_rules
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_old public.rate_rules%rowtype;
  v_rule public.rate_rules%rowtype;
  v_name text;
  v_pay_code text := upper(nullif(btrim(coalesce(p_pay_code, '')), ''));
  v_service text := nullif(btrim(coalesce(p_service_type, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_from date := coalesce(p_effective_from, current_date);
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_action NOT IN ('create', 'review', 'end') THEN RAISE EXCEPTION 'Unsupported staff pay action'; END IF;
  IF v_reason IS NULL OR length(v_reason) > 2000 THEN RAISE EXCEPTION 'A reason is required for every pay change'; END IF;

  SELECT * INTO v_staff FROM public.staff_profiles WHERE id = p_staff_id;
  IF NOT FOUND OR NOT public.is_timesheet_payroll_admin(v_staff.organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_rule FROM public.rate_rules
   WHERE organization_id = v_staff.organization_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_rule.staff_id IS DISTINCT FROM v_staff.id THEN RAISE EXCEPTION 'Request ID already used for another pay rule'; END IF;
    RETURN v_rule;
  END IF;
  SELECT rr.* INTO v_rule FROM public.audit_log a JOIN public.rate_rules rr ON rr.id = a.target_id
   WHERE a.organization_id = v_staff.organization_id AND a.action = 'staff_pay_rate_ended'
     AND a.metadata->>'client_request_id' = p_client_request_id::text;
  IF FOUND THEN RETURN v_rule; END IF;

  IF p_action IN ('review', 'end') THEN
    SELECT * INTO v_old FROM public.rate_rules
     WHERE id = p_rate_rule_id AND staff_id = v_staff.id AND organization_id = v_staff.organization_id
     FOR UPDATE;
    IF NOT FOUND OR NOT v_old.active THEN RAISE EXCEPTION 'Active staff pay rate not found'; END IF;
    IF p_expected_updated_at IS NOT NULL AND v_old.updated_at <> p_expected_updated_at THEN
      RAISE EXCEPTION 'This pay rate changed since it was opened; reload';
    END IF;
  END IF;

  IF p_action = 'end' THEN
    IF p_effective_to IS NULL THEN RAISE EXCEPTION 'Choose the last day this rate applies'; END IF;
    IF v_old.effective_from IS NOT NULL AND p_effective_to < v_old.effective_from THEN
      RAISE EXCEPTION 'The end date cannot precede the start of the rate';
    END IF;
    UPDATE public.rate_rules SET effective_to = p_effective_to, updated_by = v_actor
     WHERE id = v_old.id RETURNING * INTO v_rule;
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_staff.organization_id, v_actor, 'staff_pay_rate_ended', 'rate_rules', v_rule.id,
      jsonb_build_object('client_request_id', p_client_request_id, 'staff_id', v_staff.id,
        'effective_to', p_effective_to, 'reason', v_reason));
    RETURN v_rule;
  END IF;

  IF p_action = 'review' THEN
    v_service := CASE WHEN p_service_type IS NULL THEN v_old.service_type ELSE v_service END;
    v_pay_code := coalesce(v_pay_code, v_old.pay_code);
  END IF;

  IF p_rate_type NOT IN ('hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage',
      'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout',
      'higher_duties_flat', 'per_visit', 'per_notice')
    OR p_amount IS NULL OR p_amount < 0 OR p_amount > 100000 OR p_amount = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Choose a rate type and a non-negative amount';
  END IF;
  IF p_effective_to IS NOT NULL AND p_effective_to < v_from THEN
    RAISE EXCEPTION 'Effective end cannot precede effective start';
  END IF;
  IF v_pay_code IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.reference_codes code
     WHERE code.organization_id = v_staff.organization_id AND code.code_type = 'pay_item'
       AND code.code = v_pay_code AND code.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active payroll pay code';
  END IF;
  IF v_service IS NOT NULL
    AND v_service IS DISTINCT FROM v_old.service_type
    AND NOT public.is_known_service_code(v_staff.organization_id, v_service)
  THEN
    RAISE EXCEPTION 'Choose a task from the list, or add it as a new task first';
  END IF;

  IF p_action = 'review' THEN
    IF v_old.effective_from IS NOT NULL AND v_from <= v_old.effective_from THEN
      RAISE EXCEPTION 'A pay review must start after the current rate started';
    END IF;
    UPDATE public.rate_rules SET effective_to = v_from - 1, updated_by = v_actor
     WHERE id = v_old.id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.rate_rules rr
     WHERE rr.staff_id = v_staff.id AND rr.organization_id = v_staff.organization_id AND rr.active
       AND rr.rate_type = p_rate_type
       AND rr.service_type IS NOT DISTINCT FROM v_service
       AND (rr.effective_to IS NULL OR rr.effective_to >= v_from)
       AND (p_effective_to IS NULL OR rr.effective_from IS NULL OR rr.effective_from <= p_effective_to)
  ) THEN
    RAISE EXCEPTION 'This person already has a % rate for that task in this period; use Pay review to change it', replace(p_rate_type, '_', ' ');
  END IF;

  SELECT coalesce(nullif(btrim(u.display_name), ''), v_staff.employee_number, 'Staff member')
    INTO v_name
    FROM public.user_profiles u WHERE u.id = coalesce(v_staff.user_id, v_staff.id);
  v_name := coalesce(v_name, v_staff.employee_number, 'Staff member') || ' · '
    || coalesce(replace(v_service, '_', ' '), 'all work') || ' · ' || replace(p_rate_type, '_', ' ');

  INSERT INTO public.rate_rules (
    organization_id, rule_kind, name, rate_type, amount, pay_code, staff_id, service_type,
    effective_from, effective_to, priority, active, created_by, updated_by, client_request_id
  ) VALUES (
    v_staff.organization_id, 'pay', left(v_name, 200), p_rate_type, p_amount, v_pay_code, v_staff.id, v_service,
    v_from, p_effective_to, 0, true, v_actor, v_actor, p_client_request_id
  ) RETURNING * INTO v_rule;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_staff.organization_id, v_actor,
    CASE WHEN p_action = 'review' THEN 'staff_pay_rate_reviewed' ELSE 'staff_pay_rate_created' END,
    'rate_rules', v_rule.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'staff_id', v_staff.id,
      'previous_rate_rule_id', v_old.id, 'previous_amount', v_old.amount, 'amount', p_amount,
      'rate_type', p_rate_type, 'pay_code', v_pay_code, 'service_type', v_service,
      'effective_from', v_from, 'effective_to', p_effective_to, 'reason', v_reason));
  RETURN v_rule;
END
$function$;
COMMENT ON FUNCTION public.manage_staff_pay_rate(uuid, text, uuid, uuid, timestamptz, text, numeric, text, text, date, date, text) IS
  'Employer payroll administrators create, review (end the current rate and start a new one) or end a staff member''s pay rate. Pay codes come from active pay_item reference codes and tasks from service_code_catalog. Audited and idempotent on client_request_id.';
REVOKE ALL ON FUNCTION public.manage_staff_pay_rate(uuid, text, uuid, uuid, timestamptz, text, numeric, text, text, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_staff_pay_rate(uuid, text, uuid, uuid, timestamptz, text, numeric, text, text, date, date, text) TO authenticated, service_role;

-- Every writer of rate_rules (branch rule editor, staff pay rates, approved Bob proposals) and every
-- task change on a shift goes through the same catalogue.
CREATE OR REPLACE FUNCTION public.tg_require_known_service_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  NEW.service_type := nullif(btrim(coalesce(NEW.service_type, '')), '');
  IF NEW.service_type IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.service_type IS DISTINCT FROM OLD.service_type)
    AND NOT public.is_known_service_code(NEW.organization_id, NEW.service_type) THEN
    RAISE EXCEPTION 'Task "%" is not a task code for this organisation. Choose one from the list or add it as a new task first.', NEW.service_type
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.tg_require_known_service_code() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_rate_rules_known_service_code ON public.rate_rules;
CREATE TRIGGER trg_rate_rules_known_service_code
  BEFORE INSERT OR UPDATE OF service_type ON public.rate_rules
  FOR EACH ROW EXECUTE FUNCTION public.tg_require_known_service_code();

DROP TRIGGER IF EXISTS trg_shifts_known_service_code ON public.shifts;
CREATE TRIGGER trg_shifts_known_service_code
  BEFORE UPDATE OF service_type ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.tg_require_known_service_code();
