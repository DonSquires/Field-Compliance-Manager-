-- Version approval is staged here. The legacy resolver continues to use only
-- the original active rows until the separately governed Task 3 cut-over.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Existing audit triggers require review before rate-card lifecycle installation';
  END IF;
END $$;

-- Row triggers cannot protect history from TRUNCATE or caller-installed triggers.
REVOKE TRUNCATE, TRIGGER ON public.rate_rules, public.service_agreements
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE TRIGGER ON public.audit_log FROM PUBLIC, anon, authenticated, service_role;
DO $$
BEGIN
  IF pg_catalog.has_table_privilege('anon', 'public.audit_log', 'TRIGGER')
    OR pg_catalog.has_table_privilege('authenticated', 'public.audit_log', 'TRIGGER')
    OR pg_catalog.has_table_privilege('service_role', 'public.audit_log', 'TRIGGER') THEN
    RAISE EXCEPTION 'Application roles must not install shared audit triggers';
  END IF;
END $$;

CREATE POLICY rate_card_audit_finance_select ON public.audit_log AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    pg_catalog.lower(pg_catalog.left(action, 10)) <> 'rate_card_'
    OR (coalesce(public.user_can_operate_organization(organization_id), false)
      AND coalesce(public.is_admin_for_org(organization_id), false))
  );

ALTER TABLE public.rate_rules
  ADD COLUMN asset_id uuid REFERENCES public.assets(id) ON DELETE RESTRICT,
  ADD COLUMN rate_card_line_enabled boolean;
CREATE INDEX rate_rules_asset_id_idx ON public.rate_rules (asset_id) WHERE asset_id IS NOT NULL;
CREATE UNIQUE INDEX assets_rate_card_scope_key ON public.assets (id, organization_id);
ALTER TABLE public.rate_rules ADD CONSTRAINT rate_rules_asset_organization_fkey
  FOREIGN KEY (asset_id, organization_id) REFERENCES public.assets(id, organization_id) ON DELETE RESTRICT;

-- NULL on legacy and unversioned rows means their existing active state.
-- Leave it NULL for legacy writers and avoid changing the resolver's timestamp tie-breaker.

CREATE UNIQUE INDEX rate_cards_one_active_payroll_role
  ON public.rate_cards (organization_id, payroll_role_code)
  WHERE active AND kind = 'pay' AND payroll_role_code IS NOT NULL;

ALTER TABLE public.rate_card_versions
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN review_state text NOT NULL DEFAULT 'editing'
    CHECK (review_state IN ('editing', 'submitted', 'rejected', 'approved', 'closed')),
  ADD COLUMN submitted_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN decided_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text,
  ADD COLUMN base_version_id uuid REFERENCES public.rate_card_versions(id) ON DELETE RESTRICT;
UPDATE public.rate_card_versions
  SET review_state = CASE WHEN status IN ('approved', 'superseded') THEN 'approved' ELSE 'closed' END
  WHERE status <> 'draft';
CREATE UNIQUE INDEX rate_card_versions_one_approved
  ON public.rate_card_versions (rate_card_id) WHERE status = 'approved';
CREATE INDEX rate_card_versions_submitted_by_idx ON public.rate_card_versions (submitted_by);
CREATE INDEX rate_card_versions_decided_by_idx ON public.rate_card_versions (decided_by);

CREATE TABLE public.rate_card_request_receipts (
  client_request_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  operation text NOT NULL,
  fingerprint jsonb NOT NULL,
  result jsonb NOT NULL,
  audit_log_id uuid NOT NULL UNIQUE,
  target_table text NOT NULL,
  target_id uuid NOT NULL,
  audit_created_at timestamptz NOT NULL,
  audit_metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.rate_card_request_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_card_request_receipts FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public._rate_card_write_context (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  version_id uuid NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, version_id)
);
ALTER TABLE public._rate_card_write_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._rate_card_write_context FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public._rate_card_copy_context (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  draft_version_id uuid NOT NULL,
  previous_version_id uuid NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, draft_version_id)
);
ALTER TABLE public._rate_card_copy_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._rate_card_copy_context FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public._rate_card_audit_context (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  audit_log_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_table text NOT NULL,
  target_id uuid NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, audit_log_id)
);
ALTER TABLE public._rate_card_audit_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._rate_card_audit_context FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_rate_card_audit_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.lower(pg_catalog.left(NEW.action, 10)) = 'rate_card_'
      AND NOT EXISTS (
        SELECT 1 FROM public._rate_card_audit_context context
        WHERE context.backend_pid = pg_catalog.pg_backend_pid()
          AND context.transaction_id = pg_catalog.txid_current()
          AND context.audit_log_id = NEW.id
          AND context.organization_id = NEW.organization_id
          AND context.actor_user_id = NEW.actor_user_id
          AND context.action = NEW.action
          AND context.target_table = NEW.target_table
          AND context.target_id = NEW.target_id
          AND context.metadata = NEW.metadata
          AND context.created_at = NEW.created_at
      ) THEN
      RAISE EXCEPTION 'Rate-card audit actions require governed evidence' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF pg_catalog.lower(pg_catalog.left(OLD.action, 10)) = 'rate_card_'
      OR pg_catalog.lower(pg_catalog.left(NEW.action, 10)) = 'rate_card_' THEN
      RAISE EXCEPTION 'Rate-card audit evidence is immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_catalog.lower(pg_catalog.left(OLD.action, 10)) = 'rate_card_' THEN
    RAISE EXCEPTION 'Rate-card audit evidence is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.guard_rate_card_audit_evidence() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_rate_card_audit_evidence
  BEFORE INSERT OR UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.guard_rate_card_audit_evidence();

-- The card tables have no browser writes. Service-role writes also have to go
-- through the owner-definer RPCs, so they cannot silently skip receipts.
CREATE OR REPLACE FUNCTION public.guard_rate_card_governed_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
  IF current_user <> v_owner THEN
    RAISE EXCEPTION 'Rate-card writes require a governed finance operation' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_rate_card_governed_write() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_rate_cards_governed_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.rate_cards
  FOR EACH ROW EXECUTE FUNCTION public.guard_rate_card_governed_write();
CREATE TRIGGER guard_rate_card_versions_governed_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION public.guard_rate_card_governed_write();

CREATE OR REPLACE FUNCTION public.guard_agreement_rate_card_selection()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  selection_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    selection_changed := NEW.rate_card_id IS NOT NULL;
  ELSE
    selection_changed := NEW.rate_card_id IS DISTINCT FROM OLD.rate_card_id;
  END IF;
  IF selection_changed AND current_user <> pg_catalog.pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.service_agreements'::regclass)
  ) THEN
    RAISE EXCEPTION 'Rate-card selection requires a governed provider finance operation'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_rate_card_version_history()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Approved rate-card versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF OLD.status = 'approved' AND NEW.status = 'superseded'
      AND NEW.effective_to IS NOT NULL
      AND (OLD.effective_from IS NULL OR NEW.effective_to >= OLD.effective_from)
      AND (OLD.effective_to IS NULL OR NEW.effective_to <= OLD.effective_to)
      AND (to_jsonb(NEW) - ARRAY['status', 'effective_to', 'updated_at'])
          = (to_jsonb(OLD) - ARRAY['status', 'effective_to', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Approved rate-card versions are immutable';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_rate_card_version_history() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_rate_card_version_history
  BEFORE UPDATE OR DELETE ON public.rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION public.guard_rate_card_version_history();

CREATE OR REPLACE FUNCTION public._rate_card_approved_scope_matches(p_rule public.rate_rules)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.rate_card_versions draft
    JOIN public.rate_card_versions approved
      ON approved.id = draft.base_version_id AND approved.rate_card_id = draft.rate_card_id
      AND approved.status = 'approved'
    JOIN public.rate_cards card ON card.id = draft.rate_card_id
    JOIN public.rate_rules prior
      ON prior.rate_card_version_id = approved.id AND prior.rate_line_key = (p_rule).rate_line_key
      AND prior.organization_id = card.organization_id
    WHERE draft.id = (p_rule).rate_card_version_id AND draft.status = 'draft'
      AND card.organization_id = (p_rule).organization_id
      AND (to_jsonb(p_rule) - ARRAY['id', 'rate_card_version_id', 'active',
        'created_at', 'updated_at', 'created_by', 'updated_by', 'client_request_id',
        'amount', 'name', 'rate_group', 'rate_card_line_enabled'])
        IS NOT DISTINCT FROM
        (to_jsonb(prior) - ARRAY['id', 'rate_card_version_id', 'active',
          'created_at', 'updated_at', 'created_by', 'updated_by', 'client_request_id',
          'amount', 'name', 'rate_group', 'rate_card_line_enabled'])
  )
$$;
REVOKE ALL ON FUNCTION public._rate_card_approved_scope_matches(public.rate_rules)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_require_known_service_code()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_identical_copy boolean := false;
BEGIN
  NEW.service_type := nullif(btrim(coalesce(NEW.service_type, '')), '');
  IF NEW.service_type IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.service_type IS DISTINCT FROM OLD.service_type)
    AND NOT public.is_known_service_code(NEW.organization_id, NEW.service_type) THEN
    IF TG_OP = 'INSERT' AND TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'rate_rules' THEN
      SELECT EXISTS (
        SELECT 1
        FROM public._rate_card_copy_context context
        JOIN public.rate_card_versions draft
          ON draft.id = context.draft_version_id AND draft.status = 'draft'
          AND draft.base_version_id = context.previous_version_id
        JOIN public.rate_card_versions approved
          ON approved.id = context.previous_version_id AND approved.status = 'approved'
          AND approved.rate_card_id = draft.rate_card_id
        JOIN public.rate_cards card ON card.id = draft.rate_card_id
        JOIN public.rate_rules prior
          ON prior.rate_card_version_id = approved.id AND prior.rate_line_key = NEW.rate_line_key
          AND prior.organization_id = card.organization_id
        WHERE context.backend_pid = pg_catalog.pg_backend_pid()
          AND context.transaction_id = pg_catalog.txid_current()
          AND context.draft_version_id = NEW.rate_card_version_id
          AND card.organization_id = NEW.organization_id AND NOT NEW.active
          AND NEW.rate_card_line_enabled IS NOT DISTINCT FROM coalesce(prior.rate_card_line_enabled, prior.active)
          AND (to_jsonb(NEW) - ARRAY['id', 'rate_card_version_id', 'active',
            'created_at', 'updated_at', 'created_by', 'updated_by', 'client_request_id',
            'rate_card_line_enabled'])
            IS NOT DISTINCT FROM
            (to_jsonb(prior) - ARRAY['id', 'rate_card_version_id', 'active',
              'created_at', 'updated_at', 'created_by', 'updated_by', 'client_request_id',
              'rate_card_line_enabled'])
      ) INTO v_identical_copy;
    END IF;
    IF NOT v_identical_copy THEN
      RAISE EXCEPTION 'Task "%" is not a task code for this organisation. Choose one from the list or add it as a new task first.', NEW.service_type
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_rate_card_line_history()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_status text;
  v_review_state text;
  v_owner name;
  v_version_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.rate_card_version_id IS DISTINCT FROM NEW.rate_card_version_id THEN
    RAISE EXCEPTION 'Rate-card line version identity is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.rate_card_version_id IS NOT NULL
    AND OLD.rate_line_key IS DISTINCT FROM NEW.rate_line_key THEN
    RAISE EXCEPTION 'Rate-card line lineage is immutable';
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.rate_card_version_id IS NOT NULL THEN
    SELECT status, review_state INTO v_status, v_review_state
      FROM public.rate_card_versions WHERE id = OLD.rate_card_version_id;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Approved rate-card lines are immutable';
    END IF;
    IF v_review_state = 'submitted' THEN
      RAISE EXCEPTION 'Submitted rate-card lines are immutable until a decision';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.rate_card_version_id IS NOT NULL THEN
    SELECT status, review_state INTO v_status, v_review_state
      FROM public.rate_card_versions WHERE id = NEW.rate_card_version_id;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Approved rate-card lines are immutable';
    END IF;
    IF v_review_state = 'submitted' THEN
      RAISE EXCEPTION 'Submitted rate-card lines are immutable until a decision';
    END IF;
    IF NEW.active THEN
      RAISE EXCEPTION 'Draft rate-card lines cannot be active in the legacy resolver';
    END IF;
  END IF;
  IF (TG_OP <> 'INSERT' AND OLD.rate_card_version_id IS NOT NULL)
    OR (TG_OP <> 'DELETE' AND NEW.rate_card_version_id IS NOT NULL) THEN
    SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
    IF current_user <> v_owner THEN
      RAISE EXCEPTION 'Draft rate-card writes require a governed finance operation' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN
      v_version_id := OLD.rate_card_version_id;
    ELSE
      v_version_id := NEW.rate_card_version_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public._rate_card_write_context context
      WHERE context.backend_pid = pg_catalog.pg_backend_pid()
        AND context.transaction_id = pg_catalog.txid_current()
        AND context.version_id = v_version_id) THEN
      RAISE EXCEPTION 'Draft rate-card writes require a governed revision' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.service_type IS NOT NULL
      AND NOT public.is_known_service_code(NEW.organization_id, NEW.service_type)
      AND NOT public._rate_card_approved_scope_matches(NEW)
      AND NOT (OLD.rate_card_line_enabled IS TRUE AND NEW.rate_card_line_enabled IS FALSE
        AND (to_jsonb(NEW) - ARRAY['rate_card_line_enabled', 'updated_at', 'updated_by'])
          IS NOT DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['rate_card_line_enabled', 'updated_at', 'updated_by'])) THEN
      RAISE EXCEPTION 'A retired task code can only retain its approved scope' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_rate_card_line_history() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_rate_card_line_history
  BEFORE INSERT OR UPDATE OR DELETE ON public.rate_rules
  FOR EACH ROW EXECUTE FUNCTION public.guard_rate_card_line_history();

-- Freeze the actual witnesses for both existing authorization predicates.
-- Do not infer branch authority from the broader accessible-organization set.
CREATE OR REPLACE FUNCTION public._rate_card_lock_actor_authority(p_organization_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner oid;
  v_bypass_rls boolean;
  v_actor public.user_profiles%ROWTYPE;
  v_current uuid := p_organization_id;
  v_parent uuid;
  v_type text;
  v_target_type text;
  v_active boolean;
  v_ancestors uuid[] := ARRAY[]::uuid[];
  v_operable boolean := false;
  v_admin boolean := false;
  v_witness boolean;
BEGIN
  SELECT oid, rolsuper OR rolbypassrls INTO v_owner, v_bypass_rls
    FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF v_owner IS DISTINCT FROM
      (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.user_profiles'::regclass)
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN ('public.user_profiles'::regclass, 'public.organizations'::regclass,
        'public.service_agreements'::regclass, 'public.staff_branch_authorisations'::regclass)
        AND (NOT pg_catalog.has_table_privilege(v_owner, c.oid, 'SELECT')
          OR NOT pg_catalog.has_table_privilege(v_owner, c.oid, 'UPDATE')
          OR (c.relrowsecurity AND NOT (v_bypass_rls
            OR (c.relowner = v_owner AND NOT c.relforcerowsecurity))))
    ) THEN
    RAISE EXCEPTION 'Cannot establish complete finance authority visibility';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.get_operating_organization_contexts()', 'b9e0b4b1624e565853ed489a5a9e50a6'),
      ('public.user_can_operate_organization(uuid)', '9f9d6a53e68a19ea407af68b29b80f19'),
      ('public.is_admin_for_org(uuid)', 'caaa07e2cc834bd49995a2ae4cdc839e'),
      ('public.get_descendant_organizations(uuid)', 'c07967e0f30d8c0458b327ab193ab8cd')
    ) AS expected(signature, body_hash)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR pg_catalog.md5(p.prosrc) IS DISTINCT FROM expected.body_hash
      OR p.prosecdef IS DISTINCT FROM true
      OR p.provolatile IS DISTINCT FROM 's'::"char"
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
      OR p.proowner IS DISTINCT FROM v_owner
  ) THEN
    RAISE EXCEPTION 'Cannot establish current finance authority';
  END IF;

  SELECT * INTO v_actor FROM public.user_profiles
    WHERE id = auth.uid() FOR SHARE NOWAIT;
  IF NOT FOUND OR v_actor.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'Active authorized operating branch finance administrator required' USING ERRCODE = '42501';
  END IF;
  LOOP
    IF v_current IS NULL OR v_current = ANY(v_ancestors) THEN
      RAISE EXCEPTION 'Cannot establish operating organization ancestry';
    END IF;
    SELECT parent_organization_id, organization_type, active INTO v_parent, v_type, v_active
      FROM public.organizations WHERE id = v_current FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cannot establish operating organization ancestry'; END IF;
    v_ancestors := pg_catalog.array_append(v_ancestors, v_current);
    IF v_current = p_organization_id THEN
      IF NOT v_active OR v_type NOT IN ('owner', 'service_provider', 'branch') THEN
        RAISE EXCEPTION 'Active authorized operating branch finance administrator required' USING ERRCODE = '42501';
      END IF;
      v_target_type := v_type;
    END IF;
    EXIT WHEN v_parent IS NULL;
    v_current := v_parent;
  END LOOP;

  IF v_actor.role IN ('grand_master', 'master', 'admin', 'admin_officer') THEN
    v_operable := (v_target_type IN ('owner', 'service_provider')
        AND v_actor.organization_id = p_organization_id)
      OR (v_target_type = 'branch'
        AND coalesce(v_actor.employer_organization_id, v_actor.organization_id) = ANY(v_ancestors));
    v_admin := v_actor.role = 'grand_master'
      OR (v_actor.role = 'master' AND
        (v_actor.employer_organization_id = ANY(v_ancestors)
          OR v_actor.organization_id = ANY(v_ancestors)))
      OR (v_actor.role IN ('admin', 'admin_officer')
        AND v_actor.organization_id = ANY(v_ancestors));
  END IF;

  IF NOT coalesce(v_operable, false) AND v_target_type = 'branch' THEN
    SELECT true INTO v_witness FROM public.staff_branch_authorisations assignment
      WHERE assignment.user_id = v_actor.id AND assignment.branch_org_id = p_organization_id
        AND assignment.status = 'active'
      ORDER BY assignment.id LIMIT 1 FOR SHARE NOWAIT;
    v_operable := coalesce(v_witness, false);
  END IF;
  IF NOT coalesce(v_admin, false) AND v_actor.role IN ('master', 'admin', 'admin_officer') THEN
    SELECT true INTO v_witness FROM public.service_agreements agreement
      WHERE agreement.client_organization_id = p_organization_id
        AND agreement.agreement_type = 'operational'
        AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
        AND (agreement.provider_organization_id = v_actor.organization_id
          OR agreement.provider_organization_id = v_actor.employer_organization_id)
      ORDER BY agreement.id LIMIT 1 FOR SHARE NOWAIT;
    v_admin := coalesce(v_witness, false);
  END IF;
  IF NOT coalesce(v_operable, false) OR NOT coalesce(v_admin, false)
    OR NOT coalesce(public.user_can_operate_organization(p_organization_id), false)
    OR NOT coalesce(public.is_admin_for_org(p_organization_id), false) THEN
    RAISE EXCEPTION 'Active authorized operating branch finance administrator required' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._rate_card_lock_actor_authority(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._rate_card_request_begin(
  p_organization_id uuid, p_request_id uuid, p_operation text, p_fingerprint jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_receipt public.rate_card_request_receipts%ROWTYPE;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF auth.uid() IS NULL
    OR NOT coalesce(public.user_can_operate_organization(p_organization_id), false)
    OR NOT coalesce(public.is_admin_for_org(p_organization_id), false)
    OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id
      AND o.active AND o.organization_type IN ('owner', 'service_provider', 'branch')) THEN
    RAISE EXCEPTION 'Active authorized operating branch finance administrator required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rate-card-request:' || p_request_id::text, 0));
  SELECT * INTO v_receipt FROM public.rate_card_request_receipts WHERE client_request_id = p_request_id;
  IF FOUND THEN
    PERFORM public._rate_card_lock_actor_authority(p_organization_id);
    IF v_receipt.organization_id IS DISTINCT FROM p_organization_id
      OR v_receipt.actor_user_id IS DISTINCT FROM auth.uid()
      OR v_receipt.operation IS DISTINCT FROM p_operation
      OR v_receipt.fingerprint IS DISTINCT FROM p_fingerprint THEN
      RAISE EXCEPTION 'Request ID was already used with a different actor or request';
    END IF;
    RETURN v_receipt.result;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._rate_card_request_begin(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._rate_card_request_finish(
  p_organization_id uuid, p_request_id uuid, p_operation text, p_fingerprint jsonb,
  p_target_table text, p_target_id uuid, p_metadata jsonb, p_result jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('client_request_id', p_request_id);
  v_audit_id uuid := gen_random_uuid();
  v_created_at timestamptz := now();
  v_audit public.audit_log%ROWTYPE;
BEGIN
  PERFORM public._rate_card_lock_actor_authority(p_organization_id);
  INSERT INTO public._rate_card_audit_context(backend_pid, transaction_id, audit_log_id,
    organization_id, actor_user_id, action, target_table, target_id, metadata, created_at)
  VALUES (pg_catalog.pg_backend_pid(), pg_catalog.txid_current(), v_audit_id,
    p_organization_id, v_actor, p_operation, p_target_table, p_target_id, v_metadata, v_created_at);
  INSERT INTO public.audit_log(id, organization_id, actor_user_id, action, target_table, target_id, metadata, created_at)
  VALUES (v_audit_id, p_organization_id, v_actor, p_operation, p_target_table, p_target_id, v_metadata, v_created_at)
  RETURNING * INTO v_audit;
  DELETE FROM public._rate_card_audit_context WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.txid_current() AND audit_log_id = v_audit_id;
  IF v_audit.id IS DISTINCT FROM v_audit_id OR v_audit.created_at IS DISTINCT FROM v_created_at
    OR v_audit.organization_id IS DISTINCT FROM p_organization_id
    OR v_audit.actor_user_id IS DISTINCT FROM v_actor
    OR v_audit.action IS DISTINCT FROM p_operation
    OR v_audit.target_table IS DISTINCT FROM p_target_table
    OR v_audit.target_id IS DISTINCT FROM p_target_id
    OR v_audit.metadata IS DISTINCT FROM v_metadata THEN
    RAISE EXCEPTION 'Rate-card audit evidence was not recorded as requested';
  END IF;
  INSERT INTO public.rate_card_request_receipts
    (client_request_id, organization_id, actor_user_id, operation, fingerprint, result,
      audit_log_id, target_table, target_id, audit_created_at, audit_metadata)
  VALUES (p_request_id, p_organization_id, v_actor, p_operation, p_fingerprint, p_result,
    v_audit.id, p_target_table, p_target_id, v_audit.created_at, v_metadata);
  RETURN p_result;
END $$;
REVOKE ALL ON FUNCTION public._rate_card_request_finish(uuid, uuid, text, jsonb, text, uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- Parameterised equivalents are safe only while their source predicates remain
-- exactly the reviewed catalog definitions. Any later change fails closed.
CREATE OR REPLACE FUNCTION public._rate_card_other_finance_exists(p_organization_id uuid, p_exclude_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner oid;
  v_bypass_rls boolean;
BEGIN
  SELECT oid, rolsuper OR rolbypassrls INTO v_owner, v_bypass_rls
    FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF v_owner IS DISTINCT FROM
      (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.user_profiles'::regclass)
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN ('public.user_profiles'::regclass, 'public.organizations'::regclass,
        'public.service_agreements'::regclass, 'public.staff_branch_authorisations'::regclass)
        AND (NOT pg_catalog.has_table_privilege(v_owner, c.oid, 'SELECT')
          OR (c.relrowsecurity AND NOT (v_bypass_rls
            OR (c.relowner = v_owner AND NOT c.relforcerowsecurity))))
    ) THEN
    RAISE EXCEPTION 'Cannot establish complete finance authority visibility for self-approval';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.get_operating_organization_contexts()', 'b9e0b4b1624e565853ed489a5a9e50a6'),
      ('public.user_can_operate_organization(uuid)', '9f9d6a53e68a19ea407af68b29b80f19'),
      ('public.is_admin_for_org(uuid)', 'caaa07e2cc834bd49995a2ae4cdc839e'),
      ('public.can_approve_action(uuid,uuid)', 'c733c070e95f56342ca5e8631bfbfdbc'),
      ('public.get_descendant_organizations(uuid)', 'c07967e0f30d8c0458b327ab193ab8cd')
    ) AS expected(signature, body_hash)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR pg_catalog.md5(p.prosrc) IS DISTINCT FROM expected.body_hash
      OR p.prosecdef IS DISTINCT FROM true
      OR p.provolatile IS DISTINCT FROM 's'::"char"
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
      OR p.proowner IS DISTINCT FROM v_owner
  ) THEN
    RAISE EXCEPTION 'Cannot establish current finance authority for self-approval; use another approver';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.user_profiles profile
    JOIN public.organizations target ON target.id = p_organization_id AND target.active
    WHERE profile.id <> p_exclude_user_id
      AND profile.deactivated_at IS NULL
      AND public.can_approve_action(profile.id, p_organization_id)
      AND (
        (target.id = profile.organization_id AND target.organization_type IN ('owner', 'service_provider')
          AND profile.role IN ('grand_master', 'master', 'admin', 'admin_officer'))
        OR (target.organization_type = 'branch' AND (
          EXISTS (SELECT 1 FROM public.staff_branch_authorisations assignment
            WHERE assignment.user_id = profile.id AND assignment.branch_org_id = target.id
              AND assignment.status = 'active')
          OR (profile.role IN ('grand_master', 'master', 'admin', 'admin_officer')
            AND target.id = ANY(public.get_descendant_organizations(
              coalesce(profile.employer_organization_id, profile.organization_id))))
        ))
      )
  );
END $$;
REVOKE ALL ON FUNCTION public._rate_card_other_finance_exists(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._rate_card_group(p_service_type text, p_job_type text, p_rate_type text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN lower(concat_ws(' ', p_service_type, p_job_type, p_rate_type))
      ~ '(equipment|excavator|digger|hire|plant)' THEN 'Equipment & hire'
    WHEN p_rate_type IN ('per_km', 'per_hour_travel')
      OR lower(concat_ws(' ', p_service_type, p_job_type, p_rate_type)) ~ '(travel|distance|mileage)' THEN 'Travel'
    WHEN p_rate_type IN ('callout', 'oncall_flat')
      OR lower(concat_ws(' ', p_service_type, p_job_type, p_rate_type)) ~ '(response|callout|alarm)' THEN 'Response'
    WHEN p_rate_type IN ('hourly', 'daily', 'per_hour_allowance', 'higher_duties_flat')
      OR lower(concat_ws(' ', p_service_type, p_job_type, p_rate_type)) ~ '(labour|labor|patrol|guard|staff)' THEN 'Labour'
    ELSE 'Other' END
$$;
REVOKE ALL ON FUNCTION public._rate_card_group(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_rate_card(
  p_client_request_id uuid, p_operating_organization_id uuid, p_action text,
  p_rate_card_id uuid, p_kind text, p_name text, p_client_organization_id uuid,
  p_is_client_default boolean, p_service_agreement_id uuid,
  p_expected_card_updated_at timestamptz, p_expected_previous_card_id uuid,
  p_payroll_role_code text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_card public.rate_cards%ROWTYPE;
  v_agreement public.service_agreements%ROWTYPE;
  v_prior uuid;
  v_client_id uuid;
  v_before jsonb;
  v_result jsonb;
  v_fingerprint jsonb := jsonb_build_object(
    'organization_id', p_operating_organization_id, 'action', p_action,
    'rate_card_id', p_rate_card_id, 'kind', p_kind, 'name', p_name,
    'client_organization_id', p_client_organization_id, 'is_client_default', p_is_client_default,
    'service_agreement_id', p_service_agreement_id, 'expected_card_updated_at', p_expected_card_updated_at,
    'expected_previous_card_id', p_expected_previous_card_id, 'payroll_role_code', p_payroll_role_code);
  v_operation text := 'rate_card_' || coalesce(p_action, '');
BEGIN
  v_result := public._rate_card_request_begin(
    p_operating_organization_id, p_client_request_id, v_operation, v_fingerprint);
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;

  IF p_action = 'create' THEN
    IF p_rate_card_id IS NOT NULL OR p_service_agreement_id IS NOT NULL
      OR p_expected_card_updated_at IS NOT NULL
      OR p_kind NOT IN ('charge', 'pay') OR nullif(btrim(p_name), '') IS NULL
      OR length(btrim(p_name)) > 200 THEN
      RAISE EXCEPTION 'A valid new rate-card kind and name are required';
    END IF;
    IF p_kind = 'charge' THEN
      IF p_client_organization_id IS NULL OR p_payroll_role_code IS NOT NULL
        OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_client_organization_id
          AND o.organization_type = 'client' AND o.active)
        OR NOT EXISTS (SELECT 1 FROM public.service_agreements a
          WHERE a.provider_organization_id = p_operating_organization_id
            AND a.client_organization_id = p_client_organization_id AND a.agreement_type = 'operational') THEN
        RAISE EXCEPTION 'An active client with an operating-organisation agreement is required';
      END IF;
    ELSIF p_client_organization_id IS NOT NULL OR coalesce(p_is_client_default, false) THEN
      RAISE EXCEPTION 'Pay cards cannot have a client or client default';
    END IF;
    IF p_kind = 'pay' AND nullif(btrim(p_payroll_role_code), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.user_profiles profile
        JOIN public.reference_codes code ON code.organization_id = profile.organization_id
        WHERE profile.id = v_actor AND profile.deactivated_at IS NULL
          AND code.code_type = 'role_code' AND code.code = btrim(p_payroll_role_code) AND code.is_active
      ) THEN
      RAISE EXCEPTION 'Choose an active payroll role in your payroll organisation';
    END IF;
    IF coalesce(p_is_client_default, false) THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'rate-card-default:' || p_operating_organization_id::text || ':' || p_client_organization_id::text, 0));
      SELECT id INTO v_prior FROM public.rate_cards
        WHERE organization_id = p_operating_organization_id AND client_organization_id = p_client_organization_id
          AND active AND is_client_default FOR UPDATE;
      PERFORM public._rate_card_lock_actor_authority(p_operating_organization_id);
      IF v_prior IS DISTINCT FROM p_expected_previous_card_id THEN
        RAISE EXCEPTION 'Client default changed since it was opened';
      END IF;
      UPDATE public.rate_cards SET is_client_default = false, updated_by = v_actor,
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE id = v_prior;
    ELSIF p_expected_previous_card_id IS NOT NULL THEN
      RAISE EXCEPTION 'Unexpected previous default for a non-default card';
    END IF;
    PERFORM public._rate_card_lock_actor_authority(p_operating_organization_id);
    INSERT INTO public.rate_cards(organization_id, kind, name, client_organization_id,
      payroll_role_code, is_standard, is_client_default, created_by, updated_by)
    VALUES (p_operating_organization_id, p_kind, btrim(p_name), p_client_organization_id,
      nullif(btrim(p_payroll_role_code), ''), false, coalesce(p_is_client_default, false), v_actor, v_actor)
    RETURNING * INTO v_card;
    v_result := jsonb_build_object('card', to_jsonb(v_card), 'previous_default_card_id', v_prior);
    RETURN public._rate_card_request_finish(p_operating_organization_id, p_client_request_id,
      v_operation, v_fingerprint, 'rate_cards', v_card.id,
      jsonb_build_object('before_default_card_id', v_prior, 'after', to_jsonb(v_card)), v_result);

  ELSIF p_action = 'set_default' THEN
    SELECT client_organization_id INTO v_client_id FROM public.rate_cards
      WHERE id = p_rate_card_id AND organization_id = p_operating_organization_id;
    IF NOT FOUND OR v_client_id IS NULL THEN
      RAISE EXCEPTION 'Active client charge card not found in this operating organisation';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'rate-card-default:' || p_operating_organization_id::text || ':' || v_client_id::text, 0));
    SELECT * INTO v_card FROM public.rate_cards
      WHERE id = p_rate_card_id AND organization_id = p_operating_organization_id FOR UPDATE;
    IF NOT FOUND OR NOT v_card.active OR v_card.kind <> 'charge'
      OR v_card.client_organization_id IS NULL OR v_card.is_standard THEN
      RAISE EXCEPTION 'Active client charge card not found in this operating organisation';
    END IF;
    IF p_expected_card_updated_at IS NULL OR v_card.updated_at IS DISTINCT FROM p_expected_card_updated_at THEN
      RAISE EXCEPTION 'Rate card changed since it was opened';
    END IF;
    IF p_is_client_default IS NULL THEN RAISE EXCEPTION 'Choose the default state'; END IF;
    SELECT id INTO v_prior FROM public.rate_cards
      WHERE organization_id = p_operating_organization_id AND client_organization_id = v_card.client_organization_id
        AND active AND is_client_default FOR UPDATE;
    PERFORM public._rate_card_lock_actor_authority(p_operating_organization_id);
    IF v_prior IS DISTINCT FROM p_expected_previous_card_id THEN
      RAISE EXCEPTION 'Client default changed since it was opened';
    END IF;
    IF NOT p_is_client_default AND v_prior IS DISTINCT FROM v_card.id THEN
      RAISE EXCEPTION 'This rate card is not the current client default';
    END IF;
    v_before := to_jsonb(v_card);
    IF p_is_client_default AND v_prior IS NOT NULL AND v_prior <> v_card.id THEN
      UPDATE public.rate_cards SET is_client_default = false, updated_by = v_actor,
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE id = v_prior;
    END IF;
    UPDATE public.rate_cards SET is_client_default = p_is_client_default, updated_by = v_actor,
      updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      WHERE id = v_card.id RETURNING * INTO v_card;
    v_result := jsonb_build_object('card', to_jsonb(v_card), 'previous_default_card_id', v_prior);
    RETURN public._rate_card_request_finish(p_operating_organization_id, p_client_request_id,
      v_operation, v_fingerprint, 'rate_cards', v_card.id,
      jsonb_build_object('before', v_before, 'after', to_jsonb(v_card),
        'previous_default_card_id', v_prior), v_result);

  ELSIF p_action = 'link_agreement' THEN
    IF p_rate_card_id IS NOT NULL THEN
      SELECT * INTO v_card FROM public.rate_cards
        WHERE id = p_rate_card_id AND organization_id = p_operating_organization_id FOR UPDATE;
      IF NOT FOUND OR NOT v_card.active OR v_card.kind <> 'charge' OR v_card.client_organization_id IS NULL THEN
        RAISE EXCEPTION 'Active client charge card not found in this operating organisation';
      END IF;
      IF p_expected_card_updated_at IS NULL OR v_card.updated_at IS DISTINCT FROM p_expected_card_updated_at THEN
        RAISE EXCEPTION 'Rate card changed since it was opened';
      END IF;
    ELSIF p_expected_card_updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'A cleared card selection has no card revision';
    END IF;
    SELECT * INTO v_agreement FROM public.service_agreements
      WHERE id = p_service_agreement_id AND provider_organization_id = p_operating_organization_id
        AND agreement_type = 'operational' FOR UPDATE;
    IF NOT FOUND OR (p_rate_card_id IS NOT NULL
      AND v_agreement.client_organization_id IS DISTINCT FROM v_card.client_organization_id) THEN
      RAISE EXCEPTION 'Agreement is not in this operating organisation and client scope';
    END IF;
    PERFORM public._rate_card_lock_actor_authority(p_operating_organization_id);
    IF v_agreement.rate_card_id IS DISTINCT FROM p_expected_previous_card_id THEN
      RAISE EXCEPTION 'Agreement rate card changed since it was opened';
    END IF;
    v_prior := v_agreement.rate_card_id;
    UPDATE public.service_agreements SET rate_card_id = p_rate_card_id
      WHERE id = v_agreement.id RETURNING * INTO v_agreement;
    v_result := jsonb_build_object('agreement_id', v_agreement.id, 'rate_card_id', v_agreement.rate_card_id,
      'previous_rate_card_id', v_prior, 'card', CASE WHEN p_rate_card_id IS NULL THEN NULL ELSE to_jsonb(v_card) END);
    RETURN public._rate_card_request_finish(p_operating_organization_id, p_client_request_id,
      v_operation, v_fingerprint, 'service_agreements', v_agreement.id,
      jsonb_build_object('before_rate_card_id', v_prior, 'after_rate_card_id', v_agreement.rate_card_id), v_result);
  END IF;
  RAISE EXCEPTION 'Unsupported rate-card action';
END $$;
REVOKE ALL ON FUNCTION public.manage_rate_card(uuid, uuid, text, uuid, text, text, uuid, boolean, uuid, timestamptz, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_rate_card(uuid, uuid, text, uuid, text, text, uuid, boolean, uuid, timestamptz, uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.start_rate_card_version(
  p_client_request_id uuid, p_rate_card_id uuid, p_expected_version_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_card public.rate_cards%ROWTYPE;
  v_previous public.rate_card_versions%ROWTYPE;
  v_version public.rate_card_versions%ROWTYPE;
  v_result jsonb;
  v_org uuid;
  v_fingerprint jsonb := jsonb_build_object('rate_card_id', p_rate_card_id,
    'expected_version_id', p_expected_version_id);
BEGIN
  SELECT organization_id INTO v_org FROM public.rate_cards WHERE id = p_rate_card_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rate card not found'; END IF;
  v_result := public._rate_card_request_begin(v_org, p_client_request_id, 'rate_card_version_started', v_fingerprint);
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  SELECT * INTO v_card FROM public.rate_cards WHERE id = p_rate_card_id FOR UPDATE;
  PERFORM public._rate_card_lock_actor_authority(v_org);
  IF NOT v_card.active THEN RAISE EXCEPTION 'Rate card is not active'; END IF;
  SELECT * INTO v_previous FROM public.rate_card_versions
    WHERE rate_card_id = v_card.id AND status = 'approved' FOR UPDATE;
  IF v_previous.id IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'Approved rate-card version changed since it was opened';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rate_card_versions WHERE rate_card_id = v_card.id AND status = 'draft') THEN
    RAISE EXCEPTION 'A draft already exists for this rate card';
  END IF;
  INSERT INTO public.rate_card_versions(rate_card_id, version_number, status, review_state, created_by, base_version_id)
  SELECT v_card.id, coalesce(max(version_number), 0) + 1, 'draft', 'editing', auth.uid(), v_previous.id
  FROM public.rate_card_versions WHERE rate_card_id = v_card.id RETURNING * INTO v_version;
  IF v_previous.id IS NOT NULL THEN
    INSERT INTO public._rate_card_write_context(backend_pid, transaction_id, version_id)
    VALUES (pg_catalog.pg_backend_pid(), pg_catalog.txid_current(), v_version.id);
    INSERT INTO public._rate_card_copy_context(backend_pid, transaction_id, draft_version_id, previous_version_id)
    VALUES (pg_catalog.pg_backend_pid(), pg_catalog.txid_current(), v_version.id, v_previous.id);
    -- Preserve the existing resolver's final price tie-break across copies.
    INSERT INTO public.rate_rules(
      organization_id, rule_kind, name, rate_type, amount, pay_code, gl_account, role_code,
      region_code, service_type, module_key, job_code, job_type, client_org_id, site_id,
      vehicle_type, distance_min_km, distance_max_km, outside_area, day_category,
      effective_from, effective_to, priority, active, created_by, updated_by, updated_at, zone_id, staff_id,
      rate_card_version_id, rate_line_key, rate_group, asset_id, rate_card_line_enabled)
    SELECT organization_id, rule_kind, name, rate_type, amount, pay_code, gl_account, role_code,
      region_code, service_type, module_key, job_code, job_type, client_org_id, site_id,
      vehicle_type, distance_min_km, distance_max_km, outside_area, day_category,
      effective_from, effective_to, priority, false, auth.uid(), auth.uid(), updated_at, zone_id, staff_id,
      v_version.id, rate_line_key, rate_group, asset_id, coalesce(rate_card_line_enabled, active)
    FROM public.rate_rules WHERE rate_card_version_id = v_previous.id;
    DELETE FROM public._rate_card_copy_context WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.txid_current() AND draft_version_id = v_version.id;
    DELETE FROM public._rate_card_write_context WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.txid_current() AND version_id = v_version.id;
  END IF;
  v_result := jsonb_build_object('version', to_jsonb(v_version), 'previous_version_id', v_previous.id);
  RETURN public._rate_card_request_finish(v_org, p_client_request_id, 'rate_card_version_started',
    v_fingerprint, 'rate_card_versions', v_version.id,
    jsonb_build_object('previous_version_id', v_previous.id, 'version', to_jsonb(v_version)), v_result);
END $$;
REVOKE ALL ON FUNCTION public.start_rate_card_version(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_rate_card_version(uuid, uuid, uuid) TO authenticated;

-- A place on a new price needs an explicit, current contract for this branch.
-- Client cards additionally require that contract's client to match the card.
CREATE OR REPLACE FUNCTION public._rate_card_lock_place_scope(
  p_organization_id uuid, p_client_organization_id uuid, p_site_id uuid, p_zone_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_link uuid;
BEGIN
  IF p_site_id IS NOT NULL THEN
    PERFORM 1 FROM public.client_sites site
      WHERE site.id = p_site_id AND site.active FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Site scope is missing or retired'; END IF;
    SELECT link.id INTO v_link
      FROM public.service_agreement_locations link
      JOIN public.service_agreements agreement ON agreement.id = link.service_agreement_id
      WHERE link.site_id = p_site_id AND link.status = 'active'
        AND agreement.provider_organization_id = p_organization_id
        AND (p_client_organization_id IS NULL OR agreement.client_organization_id = p_client_organization_id)
        AND agreement.agreement_type = 'operational'
        AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
        AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
      ORDER BY agreement.id, link.id LIMIT 1 FOR SHARE OF agreement, link NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Site scope needs a current operating agreement'; END IF;
  END IF;
  IF p_zone_id IS NOT NULL THEN
    PERFORM 1 FROM public.location_zones zone
      WHERE zone.id = p_zone_id AND zone.is_active FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Zone scope is missing or retired'; END IF;
    SELECT link.id INTO v_link
      FROM public.service_agreement_locations link
      JOIN public.service_agreements agreement ON agreement.id = link.service_agreement_id
      WHERE link.zone_id = p_zone_id AND link.status = 'active'
        AND agreement.provider_organization_id = p_organization_id
        AND (p_client_organization_id IS NULL OR agreement.client_organization_id = p_client_organization_id)
        AND agreement.agreement_type = 'operational'
        AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
        AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
      ORDER BY agreement.id, link.id LIMIT 1 FOR SHARE OF agreement, link NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Zone scope needs a current operating agreement'; END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._rate_card_lock_place_scope(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- A new scope must keep one actual catalog witness until the write commits.
-- An identical approved predecessor does not depend on a still-current code.
CREATE OR REPLACE FUNCTION public._rate_card_lock_service_scope(p_rule public.rate_rules)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ancestors uuid[];
  v_witness uuid;
  v_module text;
  v_owner oid;
BEGIN
  IF p_rule.service_type IS NULL OR public._rate_card_approved_scope_matches(p_rule) THEN
    RETURN;
  END IF;
  SELECT oid INTO v_owner FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.is_known_service_code(uuid,text)', '78133c95703f83019783dcbf2d002a11'),
      ('public.service_code_catalog(uuid)', '911dc6000ee7d3c0709cc8ae2954359b')
    ) AS expected(signature, body_hash)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR pg_catalog.md5(p.prosrc) IS DISTINCT FROM expected.body_hash
      OR p.prosecdef IS DISTINCT FROM true
      OR p.provolatile IS DISTINCT FROM 's'::"char"
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR p.proowner IS DISTINCT FROM v_owner
  ) THEN
    RAISE EXCEPTION 'Cannot establish the current task code catalog';
  END IF;
  WITH RECURSIVE chain AS (
    SELECT o.id, o.parent_organization_id, 0 AS depth
      FROM public.organizations o WHERE o.id = p_rule.organization_id
    UNION ALL
    SELECT parent.id, parent.parent_organization_id, chain.depth + 1
      FROM public.organizations parent JOIN chain ON parent.id = chain.parent_organization_id
      WHERE chain.depth < 20
  )
  SELECT pg_catalog.array_agg(id) INTO v_ancestors FROM chain;

  SELECT rc.id INTO v_witness FROM public.reference_codes rc
    WHERE rc.organization_id = ANY(v_ancestors) AND rc.code_type = 'service_code'
      AND rc.is_active AND rc.code = p_rule.service_type
    ORDER BY rc.id LIMIT 1 FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    SELECT rule.id INTO v_witness FROM public.rate_rules rule
      WHERE rule.organization_id = ANY(v_ancestors) AND rule.active
        AND rule.service_type = p_rule.service_type
      ORDER BY rule.id LIMIT 1 FOR SHARE NOWAIT;
  END IF;
  IF NOT FOUND THEN
    SELECT unit.id INTO v_witness FROM public.roster_work_units unit
      WHERE unit.organization_id = p_rule.organization_id AND unit.active
        AND unit.service_type = p_rule.service_type
      ORDER BY unit.id LIMIT 1 FOR SHARE NOWAIT;
  END IF;
  IF NOT FOUND THEN
    SELECT shift.id INTO v_witness FROM public.shifts shift
      WHERE shift.organization_id = p_rule.organization_id
        AND shift.service_type = p_rule.service_type
      ORDER BY shift.id LIMIT 1 FOR SHARE NOWAIT;
  END IF;
  IF NOT FOUND THEN
    SELECT module.module_key INTO v_module FROM public.module_catalog module
      WHERE module.active AND module.module_key = p_rule.service_type
      FOR SHARE NOWAIT;
  END IF;
  IF NOT FOUND OR NOT public.is_known_service_code(p_rule.organization_id, p_rule.service_type) THEN
    RAISE EXCEPTION 'A retired task code can only retain its approved scope' USING ERRCODE = '23514';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._rate_card_lock_service_scope(public.rate_rules)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_rate_card_draft_line(
  p_client_request_id uuid, p_version_id uuid, p_expected_updated_at timestamptz,
  p_action text, p_rate_rule_id uuid, p_name text, p_rate_type text, p_amount numeric,
  p_rate_group text, p_scope jsonb, p_effective_from date, p_effective_to date, p_asset_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_card public.rate_cards%ROWTYPE;
  v_version public.rate_card_versions%ROWTYPE;
  v_rule public.rate_rules%ROWTYPE;
  v_old public.rate_rules%ROWTYPE;
  v_asset public.assets%ROWTYPE;
  v_payroll_organization_id uuid;
  v_scope jsonb := coalesce(p_scope, '{}'::jsonb);
  v_result jsonb;
  v_operation text := 'rate_card_line_' || coalesce(p_action, '');
  v_fingerprint jsonb := jsonb_build_object(
    'version_id', p_version_id, 'expected_updated_at', p_expected_updated_at,
    'action', p_action, 'rate_rule_id', p_rate_rule_id, 'name', p_name,
    'rate_type', p_rate_type, 'amount', p_amount, 'rate_group', p_rate_group,
    'scope', p_scope, 'effective_from', p_effective_from, 'effective_to', p_effective_to,
    'asset_id', p_asset_id);
BEGIN
  SELECT c.organization_id INTO v_org FROM public.rate_card_versions v
    JOIN public.rate_cards c ON c.id = v.rate_card_id WHERE v.id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rate-card draft not found'; END IF;
  v_result := public._rate_card_request_begin(v_org, p_client_request_id, v_operation, v_fingerprint);
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  SELECT c.* INTO v_card FROM public.rate_cards c JOIN public.rate_card_versions v ON v.rate_card_id = c.id
    WHERE v.id = p_version_id FOR UPDATE OF c;
  SELECT * INTO v_version FROM public.rate_card_versions WHERE id = p_version_id FOR UPDATE;
  PERFORM public._rate_card_lock_actor_authority(v_org);
  IF NOT v_card.active OR v_version.status <> 'draft' OR v_version.review_state = 'submitted' THEN
    RAISE EXCEPTION 'An editable rate-card draft is required';
  END IF;
  IF p_expected_updated_at IS NULL OR v_version.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Rate-card draft changed since it was opened';
  END IF;
  IF p_action NOT IN ('create', 'update', 'retire') OR p_action IS NULL THEN
    RAISE EXCEPTION 'Unsupported draft-line action';
  END IF;
  IF pg_catalog.jsonb_typeof(v_scope) <> 'object' OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(v_scope) AS key(name)
    WHERE key.name <> ALL (ARRAY[
      'pay_code', 'gl_account', 'role_code', 'region_code', 'service_type', 'module_key',
      'job_code', 'job_type', 'site_id', 'zone_id', 'vehicle_type', 'distance_min_km',
      'distance_max_km', 'outside_area', 'day_category', 'priority', 'staff_id'])
  ) THEN
    RAISE EXCEPTION 'Rate scope contains an unsupported field';
  END IF;
  IF p_action <> 'create' THEN
    SELECT * INTO v_rule FROM public.rate_rules
      WHERE id = p_rate_rule_id AND rate_card_version_id = v_version.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft rate line not found'; END IF;
    v_old := v_rule;
  ELSE
    IF p_rate_rule_id IS NOT NULL THEN RAISE EXCEPTION 'A new line cannot replace an existing ID'; END IF;
    v_rule.organization_id := v_org;
    v_rule.rule_kind := CASE WHEN v_card.kind = 'charge' THEN 'billing' ELSE 'pay' END;
    v_rule.client_org_id := v_card.client_organization_id;
    v_rule.rate_card_version_id := v_version.id;
    v_rule.rate_line_key := gen_random_uuid();
    v_rule.priority := 0;
    v_rule.active := false;
    v_rule.rate_card_line_enabled := true;
  END IF;

  INSERT INTO public._rate_card_write_context(backend_pid, transaction_id, version_id)
  VALUES (pg_catalog.pg_backend_pid(), pg_catalog.txid_current(), v_version.id);
  IF p_action = 'retire' THEN
    IF NOT v_rule.rate_card_line_enabled THEN RAISE EXCEPTION 'Draft line is already retired'; END IF;
    UPDATE public.rate_rules SET rate_card_line_enabled = false, updated_by = auth.uid()
      WHERE id = v_rule.id RETURNING * INTO v_rule;
  ELSE
    IF nullif(btrim(p_name), '') IS NULL OR length(btrim(p_name)) > 200
      OR p_rate_type NOT IN ('hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage',
        'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout', 'higher_duties_flat',
        'per_visit', 'per_notice')
      OR p_rate_type IS NULL OR p_amount IS NULL OR p_amount < 0 OR p_amount > 1000000000
      OR p_amount = 'NaN'::numeric THEN
      RAISE EXCEPTION 'A rate name, supported type and valid non-negative amount are required';
    END IF;
    IF p_effective_from IS NOT NULL AND p_effective_to IS NOT NULL AND p_effective_to < p_effective_from THEN
      RAISE EXCEPTION 'Line effective end cannot precede its start';
    END IF;
    v_rule.name := btrim(p_name);
    v_rule.rate_type := p_rate_type;
    v_rule.amount := p_amount;
    v_rule.effective_from := p_effective_from;
    v_rule.effective_to := p_effective_to;
    IF v_scope ? 'pay_code' THEN v_rule.pay_code := upper(nullif(btrim(v_scope->>'pay_code'), '')); END IF;
    IF v_scope ? 'gl_account' THEN v_rule.gl_account := nullif(btrim(v_scope->>'gl_account'), ''); END IF;
    IF v_scope ? 'role_code' THEN v_rule.role_code := nullif(btrim(v_scope->>'role_code'), ''); END IF;
    IF v_scope ? 'region_code' THEN v_rule.region_code := nullif(btrim(v_scope->>'region_code'), ''); END IF;
    IF v_scope ? 'service_type' THEN v_rule.service_type := nullif(btrim(v_scope->>'service_type'), ''); END IF;
    IF v_scope ? 'module_key' THEN v_rule.module_key := nullif(btrim(v_scope->>'module_key'), ''); END IF;
    IF v_scope ? 'job_code' THEN v_rule.job_code := nullif(btrim(v_scope->>'job_code'), ''); END IF;
    IF v_scope ? 'job_type' THEN v_rule.job_type := nullif(btrim(v_scope->>'job_type'), ''); END IF;
    IF v_scope ? 'site_id' THEN v_rule.site_id := (v_scope->>'site_id')::uuid; END IF;
    IF v_scope ? 'zone_id' THEN v_rule.zone_id := (v_scope->>'zone_id')::uuid; END IF;
    IF v_scope ? 'vehicle_type' THEN v_rule.vehicle_type := nullif(btrim(v_scope->>'vehicle_type'), ''); END IF;
    IF v_scope ? 'distance_min_km' THEN v_rule.distance_min_km := (v_scope->>'distance_min_km')::numeric; END IF;
    IF v_scope ? 'distance_max_km' THEN v_rule.distance_max_km := (v_scope->>'distance_max_km')::numeric; END IF;
    IF v_scope ? 'outside_area' THEN v_rule.outside_area := (v_scope->>'outside_area')::boolean; END IF;
    IF v_scope ? 'day_category' THEN v_rule.day_category := nullif(btrim(v_scope->>'day_category'), ''); END IF;
    IF v_scope ? 'priority' THEN v_rule.priority := coalesce((v_scope->>'priority')::integer, 0); END IF;
    IF v_scope ? 'staff_id' THEN v_rule.staff_id := (v_scope->>'staff_id')::uuid; END IF;
    IF v_rule.day_category IS NOT NULL AND v_rule.day_category NOT IN ('weekday', 'weekend', 'public_holiday', 'night')
      OR v_rule.distance_min_km < 0 OR v_rule.distance_max_km < 0
      OR v_rule.distance_min_km = 'NaN'::numeric OR v_rule.distance_max_km = 'NaN'::numeric
      OR (v_rule.distance_min_km IS NOT NULL AND v_rule.distance_max_km IS NOT NULL
        AND v_rule.distance_min_km > v_rule.distance_max_km) THEN
      RAISE EXCEPTION 'Invalid rate scope or distance bounds';
    END IF;
    IF v_rule.staff_id IS NOT NULL AND (
      v_rule.rule_kind <> 'pay'
      OR (v_rule.staff_id IS DISTINCT FROM v_old.staff_id AND NOT EXISTS (
        SELECT 1 FROM public.staff_profiles staff
        WHERE staff.id = v_rule.staff_id AND staff.organization_id = v_org
      ))
    ) THEN
      RAISE EXCEPTION 'Staff pay scope must belong to this operating organisation';
    END IF;
    IF v_rule.rule_kind = 'pay' THEN
      SELECT organization_id INTO v_payroll_organization_id FROM public.user_profiles
        WHERE id = auth.uid() AND deactivated_at IS NULL;
      IF v_rule.pay_code IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.reference_codes code WHERE code.organization_id = v_payroll_organization_id
          AND code.code_type = 'pay_item' AND code.code = v_rule.pay_code AND code.is_active
      ) THEN
        RAISE EXCEPTION 'Choose an active payroll pay code';
      END IF;
      IF v_rule.role_code IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.reference_codes code WHERE code.organization_id = v_payroll_organization_id
          AND code.code_type = 'role_code' AND code.code = v_rule.role_code AND code.is_active
      ) THEN
        RAISE EXCEPTION 'Choose an active payroll role';
      END IF;
    END IF;
    IF p_asset_id IS NOT NULL THEN
      SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id AND organization_id = v_org FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Asset is not owned by this operating organisation'; END IF;
      IF v_asset.status IN ('retired', 'lost')
        AND (p_action = 'create' OR p_asset_id IS DISTINCT FROM v_old.asset_id) THEN
        RAISE EXCEPTION 'A retired or lost asset cannot be newly selected';
      END IF;
    END IF;
    v_rule.asset_id := p_asset_id;
    PERFORM public._rate_card_lock_place_scope(v_org, v_card.client_organization_id,
      v_rule.site_id, v_rule.zone_id);
    PERFORM public._rate_card_lock_service_scope(v_rule);
    v_rule.rate_group := coalesce(p_rate_group, CASE WHEN p_action = 'update' THEN v_old.rate_group END,
      public._rate_card_group(v_rule.service_type, v_rule.job_type, v_rule.rate_type));
    IF v_rule.rate_group NOT IN ('Labour', 'Response', 'Travel', 'Equipment & hire', 'Other') THEN
      RAISE EXCEPTION 'Unsupported rate group';
    END IF;
    IF p_action = 'create' THEN
      INSERT INTO public.rate_rules(organization_id, rule_kind, name, rate_type, amount, pay_code, gl_account,
        role_code, region_code, service_type, module_key, job_code, job_type, client_org_id, site_id,
        zone_id, vehicle_type, distance_min_km, distance_max_km, outside_area, day_category,
        effective_from, effective_to, priority, active, created_by, updated_by, client_request_id,
        staff_id, rate_card_version_id, rate_line_key, rate_group, asset_id, rate_card_line_enabled)
      VALUES (v_rule.organization_id, v_rule.rule_kind, v_rule.name, v_rule.rate_type, v_rule.amount,
        v_rule.pay_code, v_rule.gl_account, v_rule.role_code, v_rule.region_code, v_rule.service_type,
        v_rule.module_key, v_rule.job_code, v_rule.job_type, v_rule.client_org_id, v_rule.site_id,
        v_rule.zone_id, v_rule.vehicle_type, v_rule.distance_min_km, v_rule.distance_max_km,
        v_rule.outside_area, v_rule.day_category, v_rule.effective_from, v_rule.effective_to,
        v_rule.priority, false, auth.uid(), auth.uid(), p_client_request_id, v_rule.staff_id,
        v_rule.rate_card_version_id, v_rule.rate_line_key, v_rule.rate_group, v_rule.asset_id, true)
      RETURNING * INTO v_rule;
    ELSE
      UPDATE public.rate_rules SET name = v_rule.name, rate_type = v_rule.rate_type, amount = v_rule.amount,
        pay_code = v_rule.pay_code, gl_account = v_rule.gl_account, role_code = v_rule.role_code,
        region_code = v_rule.region_code, service_type = v_rule.service_type, module_key = v_rule.module_key,
        job_code = v_rule.job_code, job_type = v_rule.job_type, site_id = v_rule.site_id, zone_id = v_rule.zone_id,
        vehicle_type = v_rule.vehicle_type, distance_min_km = v_rule.distance_min_km,
        distance_max_km = v_rule.distance_max_km, outside_area = v_rule.outside_area,
        day_category = v_rule.day_category, effective_from = v_rule.effective_from,
        effective_to = v_rule.effective_to, priority = v_rule.priority, updated_by = auth.uid(),
        staff_id = v_rule.staff_id, rate_group = v_rule.rate_group, asset_id = v_rule.asset_id
      WHERE id = v_rule.id RETURNING * INTO v_rule;
    END IF;
  END IF;
  DELETE FROM public._rate_card_write_context WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.txid_current() AND version_id = v_version.id;
  UPDATE public.rate_card_versions SET
    updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
    review_state = CASE WHEN review_state = 'rejected' THEN 'editing' ELSE review_state END
    WHERE id = v_version.id RETURNING * INTO v_version;
  v_result := jsonb_build_object('line', to_jsonb(v_rule), 'version', to_jsonb(v_version));
  RETURN public._rate_card_request_finish(v_org, p_client_request_id, v_operation, v_fingerprint,
    'rate_rules', v_rule.id, jsonb_build_object('version_id', v_version.id,
      'before', CASE WHEN p_action = 'create' THEN NULL ELSE to_jsonb(v_old) END,
      'after', to_jsonb(v_rule)), v_result);
END $$;
REVOKE ALL ON FUNCTION public.manage_rate_card_draft_line(uuid, uuid, timestamptz, text, uuid, text, text, numeric, text, jsonb, date, date, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_rate_card_draft_line(uuid, uuid, timestamptz, text, uuid, text, text, numeric, text, jsonb, date, date, uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public._rate_card_check_service_scopes(p_version_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_line public.rate_rules%ROWTYPE;
BEGIN
  FOR v_line IN
    SELECT * FROM public.rate_rules line
    WHERE line.rate_card_version_id = p_version_id
      AND coalesce(line.rate_card_line_enabled, line.active)
      AND line.service_type IS NOT NULL
    ORDER BY line.service_type, line.id
  LOOP
    PERFORM public._rate_card_lock_service_scope(v_line);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public._rate_card_check_service_scopes(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._rate_card_check_place_scopes(
  p_version_id uuid, p_organization_id uuid, p_client_organization_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_line public.rate_rules%ROWTYPE;
BEGIN
  FOR v_line IN
    SELECT * FROM public.rate_rules line
    WHERE line.rate_card_version_id = p_version_id
      AND coalesce(line.rate_card_line_enabled, line.active)
      AND (line.site_id IS NOT NULL OR line.zone_id IS NOT NULL)
    ORDER BY line.site_id, line.zone_id, line.id
  LOOP
    PERFORM public._rate_card_lock_place_scope(p_organization_id, p_client_organization_id,
      v_line.site_id, v_line.zone_id);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public._rate_card_check_place_scopes(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._rate_card_check_chronology(
  p_rate_card_id uuid, p_base_version_id uuid, p_new_start date
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_previous public.rate_card_versions%ROWTYPE;
BEGIN
  IF p_new_start IS NULL THEN RAISE EXCEPTION 'A version effective start is required'; END IF;
  SELECT * INTO v_previous FROM public.rate_card_versions
    WHERE rate_card_id = p_rate_card_id AND status = 'approved';
  IF v_previous.id IS DISTINCT FROM p_base_version_id THEN
    RAISE EXCEPTION 'Approved rate-card version changed since the draft started';
  END IF;
  IF v_previous.effective_from IS NOT NULL AND p_new_start <= v_previous.effective_from THEN
    RAISE EXCEPTION 'A new version must start after the previous version';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rate_card_versions older
    WHERE older.rate_card_id = p_rate_card_id AND older.status = 'superseded'
      AND (older.effective_to IS NULL OR older.effective_to >= p_new_start
        OR (older.effective_from IS NOT NULL AND older.effective_from >= p_new_start))
  ) THEN
    RAISE EXCEPTION 'Version dates overlap an earlier approved version';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._rate_card_check_chronology(uuid, uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_rate_card_version(
  p_client_request_id uuid, p_version_id uuid, p_effective_from date, p_change_note text,
  p_expected_updated_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_card public.rate_cards%ROWTYPE;
  v_version public.rate_card_versions%ROWTYPE;
  v_before jsonb;
  v_result jsonb;
  v_fingerprint jsonb := jsonb_build_object('version_id', p_version_id,
    'effective_from', p_effective_from, 'change_note', p_change_note, 'expected_updated_at', p_expected_updated_at);
BEGIN
  SELECT c.organization_id INTO v_org FROM public.rate_card_versions v
    JOIN public.rate_cards c ON c.id = v.rate_card_id WHERE v.id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rate-card draft not found'; END IF;
  v_result := public._rate_card_request_begin(v_org, p_client_request_id, 'rate_card_version_submitted', v_fingerprint);
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  SELECT c.* INTO v_card FROM public.rate_cards c JOIN public.rate_card_versions v ON v.rate_card_id = c.id
    WHERE v.id = p_version_id FOR UPDATE OF c;
  SELECT * INTO v_version FROM public.rate_card_versions WHERE id = p_version_id FOR UPDATE;
  PERFORM public._rate_card_lock_actor_authority(v_org);
  IF NOT v_card.active OR v_version.status <> 'draft' OR v_version.review_state = 'submitted' THEN
    RAISE EXCEPTION 'An editable draft is required for submission';
  END IF;
  IF p_expected_updated_at IS NULL OR v_version.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Rate-card draft changed since it was opened';
  END IF;
  IF nullif(btrim(p_change_note), '') IS NULL OR length(btrim(p_change_note)) > 2000 THEN
    RAISE EXCEPTION 'A change note is required for submission';
  END IF;
  PERFORM public._rate_card_check_chronology(v_card.id, v_version.base_version_id, p_effective_from);
  PERFORM public._rate_card_check_service_scopes(v_version.id);
  PERFORM public._rate_card_check_place_scopes(v_version.id, v_org, v_card.client_organization_id);
  v_before := to_jsonb(v_version);
  UPDATE public.rate_card_versions SET effective_from = p_effective_from, effective_to = NULL,
    change_note = btrim(p_change_note), review_state = 'submitted',
    submitted_by = auth.uid(), submitted_at = clock_timestamp(),
    decided_by = NULL, decided_at = NULL, decision_reason = NULL,
    updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE id = v_version.id RETURNING * INTO v_version;
  v_result := jsonb_build_object('version', to_jsonb(v_version));
  RETURN public._rate_card_request_finish(v_org, p_client_request_id, 'rate_card_version_submitted',
    v_fingerprint, 'rate_card_versions', v_version.id,
    jsonb_build_object('before', v_before, 'after', to_jsonb(v_version)), v_result);
END $$;
REVOKE ALL ON FUNCTION public.submit_rate_card_version(uuid, uuid, date, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_rate_card_version(uuid, uuid, date, text, timestamptz)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_rate_card_version(
  p_client_request_id uuid, p_version_id uuid, p_decision text, p_reason text,
  p_expected_updated_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_initial_submitter uuid;
  v_card public.rate_cards%ROWTYPE;
  v_version public.rate_card_versions%ROWTYPE;
  v_previous public.rate_card_versions%ROWTYPE;
  v_before jsonb;
  v_result jsonb;
  v_self_exception boolean := false;
  v_operation text := CASE p_decision WHEN 'approve' THEN 'rate_card_version_approved'
    WHEN 'reject' THEN 'rate_card_version_rejected' ELSE 'rate_card_version_decision' END;
  v_fingerprint jsonb := jsonb_build_object('version_id', p_version_id,
    'decision', p_decision, 'reason', p_reason, 'expected_updated_at', p_expected_updated_at);
BEGIN
  SELECT c.organization_id, v.submitted_by INTO v_org, v_initial_submitter
    FROM public.rate_card_versions v JOIN public.rate_cards c ON c.id = v.rate_card_id WHERE v.id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rate-card draft not found'; END IF;
  v_result := public._rate_card_request_begin(v_org, p_client_request_id, v_operation, v_fingerprint);
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  IF p_decision NOT IN ('approve', 'reject') OR p_decision IS NULL THEN
    RAISE EXCEPTION 'Choose approve or reject';
  END IF;
  IF nullif(btrim(p_reason), '') IS NULL OR length(btrim(p_reason)) > 2000 THEN
    RAISE EXCEPTION 'A decision reason is required';
  END IF;
  IF p_decision = 'approve' AND v_initial_submitter = auth.uid() THEN
    -- Freeze every input to the two reviewed predicates until this transaction
    -- commits. NOWAIT refuses uncertain concurrent authority changes.
    LOCK TABLE public.organizations, public.service_agreements,
      public.staff_branch_authorisations, public.user_profiles IN SHARE MODE NOWAIT;
    IF NOT coalesce(public.user_can_operate_organization(v_org), false)
      OR NOT coalesce(public.is_admin_for_org(v_org), false) THEN
      RAISE EXCEPTION 'Active authorized operating branch finance administrator required' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT c.* INTO v_card FROM public.rate_cards c JOIN public.rate_card_versions v ON v.rate_card_id = c.id
    WHERE v.id = p_version_id FOR UPDATE OF c;
  SELECT * INTO v_version FROM public.rate_card_versions WHERE id = p_version_id FOR UPDATE;
  PERFORM public._rate_card_lock_actor_authority(v_org);
  IF NOT v_card.active OR v_version.status <> 'draft' OR v_version.review_state <> 'submitted'
    OR v_version.submitted_by IS NULL OR v_version.submitted_at IS NULL THEN
    RAISE EXCEPTION 'A submitted rate-card draft is required for a decision';
  END IF;
  IF p_expected_updated_at IS NULL OR v_version.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Rate-card draft changed since it was opened';
  END IF;
  v_before := to_jsonb(v_version);
  IF p_decision = 'approve' THEN
    IF v_version.submitted_by = auth.uid() THEN
      IF v_initial_submitter IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Submission changed; reload before self-approval';
      END IF;
      IF public._rate_card_other_finance_exists(v_org, auth.uid()) THEN
        RAISE EXCEPTION 'Another authorized finance user must approve this submission';
      END IF;
      v_self_exception := true;
    END IF;
    PERFORM public._rate_card_check_chronology(v_card.id, v_version.base_version_id, v_version.effective_from);
    PERFORM public._rate_card_check_service_scopes(v_version.id);
    PERFORM public._rate_card_check_place_scopes(v_version.id, v_org, v_card.client_organization_id);
    SELECT * INTO v_previous FROM public.rate_card_versions
      WHERE rate_card_id = v_card.id AND status = 'approved' FOR UPDATE;
    IF v_previous.id IS NOT NULL THEN
      UPDATE public.rate_card_versions SET status = 'superseded',
        effective_to = CASE WHEN effective_to IS NULL OR effective_to >= v_version.effective_from
          THEN v_version.effective_from - 1 ELSE effective_to END,
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE id = v_previous.id RETURNING * INTO v_previous;
    END IF;
    UPDATE public.rate_card_versions SET status = 'approved', review_state = 'approved',
      approved_by = auth.uid(), approved_at = clock_timestamp(),
      decided_by = auth.uid(), decided_at = clock_timestamp(), decision_reason = btrim(p_reason),
      updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      WHERE id = v_version.id RETURNING * INTO v_version;
  ELSE
    UPDATE public.rate_card_versions SET review_state = 'rejected',
      decided_by = auth.uid(), decided_at = clock_timestamp(), decision_reason = btrim(p_reason),
      updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      WHERE id = v_version.id RETURNING * INTO v_version;
  END IF;
  v_result := jsonb_build_object('version', to_jsonb(v_version), 'previous_version_id', v_previous.id,
    'self_approval_exception', v_self_exception);
  RETURN public._rate_card_request_finish(v_org, p_client_request_id, v_operation, v_fingerprint,
    'rate_card_versions', v_version.id, jsonb_build_object('before', v_before, 'after', to_jsonb(v_version),
      'previous_version_id', v_previous.id, 'self_approval_exception', v_self_exception), v_result);
END $$;
REVOKE ALL ON FUNCTION public.decide_rate_card_version(uuid, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_rate_card_version(uuid, uuid, text, text, timestamptz)
  TO authenticated;

COMMENT ON COLUMN public.rate_rules.rate_card_line_enabled IS
  'Intended enabled state within a card version; NULL on legacy or unversioned rows means active. Draft and newly approved rows stay active=false for the legacy resolver until the Task 3 card-aware cut-over.';
COMMENT ON COLUMN public.rate_card_versions.base_version_id IS
  'Approved predecessor captured when the draft was started; approval rejects a changed predecessor.';
COMMENT ON FUNCTION public.manage_rate_card(uuid, uuid, text, uuid, text, text, uuid, boolean, uuid, timestamptz, uuid, text) IS
  'Provider finance card creation, default compare-and-swap and agreement compare-and-swap. For agreement links expected_previous_card_id is the agreement selection; for default changes it is the client default.';
COMMENT ON FUNCTION public.manage_rate_card_draft_line(uuid, uuid, timestamptz, text, uuid, text, text, numeric, text, jsonb, date, date, uuid) IS
  'Edit a draft line under an explicit version revision; omitted scope keys preserve the copied line dimensions.';

COMMIT;