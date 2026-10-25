-- Extra works orders and dispatch billing basis (owner ruling 2026-10-25).
--
-- A client can ask the provider for work outside the contracted scope. That
-- work is "Extra": billed on top of the fixed contract price. It is not a
-- variation (a variation changes the contract itself). Extra work is either:
--   * a one-off dispatch job marked Extra, or
--   * temporary / ongoing work authorised by an Extra works order that sits
--     under the base service agreement until it is ended.
-- The order sits under the base agreement because every covered place belongs
-- to exactly one agreement (validate_dispatch_job_service_agreement); a second
-- agreement for the same places is not possible and would split the record.

CREATE TABLE public.agreement_extra_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id),
  reference text NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  scope text NOT NULL CHECK (char_length(btrim(scope)) BETWEEN 10 AND 4000),
  authority_kind text NOT NULL CHECK (authority_kind IN ('written', 'purchase_order', 'verbal', 'standing_instruction')),
  authority_reference text CHECK (authority_reference IS NULL OR char_length(authority_reference) <= 200),
  charge_code text,
  rate_note text CHECK (rate_note IS NULL OR char_length(rate_note) <= 500),
  starts_on date NOT NULL,
  ends_on date,
  review_on date,
  end_reason text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agreement_extra_work_orders_reference_key UNIQUE (service_agreement_id, reference),
  CONSTRAINT agreement_extra_work_orders_end_after_start CHECK (ends_on IS NULL OR ends_on >= starts_on - 1),
  CONSTRAINT agreement_extra_work_orders_review_in_term CHECK (review_on IS NULL OR (review_on >= starts_on AND (ends_on IS NULL OR review_on <= ends_on))),
  CONSTRAINT agreement_extra_work_orders_verbal_needs_reference CHECK (authority_kind <> 'verbal' OR authority_reference IS NOT NULL)
);
COMMENT ON TABLE public.agreement_extra_work_orders IS 'Temporary or ongoing work a client authorised outside the contracted scope of a service agreement. Billed as Extra; not a variation (the base contract is unchanged). Written only through manage_agreement_extra_work_order. Owner ruling 2026-10-25.';
COMMENT ON COLUMN public.agreement_extra_work_orders.authority_kind IS 'How the client authorised the work: written (email/letter), purchase_order, verbal (authority_reference must record who/when), standing_instruction.';
COMMENT ON COLUMN public.agreement_extra_work_orders.charge_code IS 'Optional default charge code from the provider catalog (reference_codes code_type charge_code).';
COMMENT ON COLUMN public.agreement_extra_work_orders.ends_on IS 'Last day in force. NULL = ongoing until ended. ends_on = starts_on - 1 means cancelled before it took effect.';

CREATE INDEX agreement_extra_work_orders_agreement_idx ON public.agreement_extra_work_orders(service_agreement_id, starts_on DESC);
CREATE INDEX agreement_extra_work_orders_org_idx ON public.agreement_extra_work_orders(organization_id);

ALTER TABLE public.agreement_extra_work_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agreement_extra_work_orders FROM anon, authenticated;
GRANT SELECT ON public.agreement_extra_work_orders TO authenticated;
CREATE POLICY agreement_extra_work_orders_provider_read ON public.agreement_extra_work_orders
  FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id));

ALTER TABLE public.dispatch_jobs
  ADD COLUMN billing_basis text,
  ADD COLUMN extra_work_order_id uuid REFERENCES public.agreement_extra_work_orders(id),
  ADD COLUMN billing_basis_set_at timestamptz,
  ADD COLUMN billing_basis_set_by uuid,
  ADD CONSTRAINT dispatch_jobs_billing_basis_check CHECK (billing_basis IS NULL OR billing_basis IN ('contract', 'extra')),
  ADD CONSTRAINT dispatch_jobs_extra_order_is_extra CHECK (extra_work_order_id IS NULL OR billing_basis = 'extra');
COMMENT ON COLUMN public.dispatch_jobs.billing_basis IS 'contract = inside the fixed contract price; extra = outside contracted scope, billed on top. NULL = not yet classified. Set only through set_dispatch_job_billing_basis (audited).';
COMMENT ON COLUMN public.dispatch_jobs.extra_work_order_id IS 'The Extra works order that authorises this job, when the Extra work is part of temporary/ongoing authorised work rather than a one-off.';
CREATE INDEX dispatch_jobs_extra_work_order_idx ON public.dispatch_jobs(extra_work_order_id) WHERE extra_work_order_id IS NOT NULL;

-- Charge lines inherit the job's basis when the financials resolver writes them,
-- so finance can separate Extra from contracted work without re-reading the job.
ALTER TABLE public.dispatch_job_charge_lines
  ADD COLUMN billing_basis text,
  ADD COLUMN extra_work_order_id uuid REFERENCES public.agreement_extra_work_orders(id),
  ADD CONSTRAINT dispatch_job_charge_lines_billing_basis_check CHECK (billing_basis IS NULL OR billing_basis IN ('contract', 'extra'));
COMMENT ON COLUMN public.dispatch_job_charge_lines.billing_basis IS 'Copied from dispatch_jobs.billing_basis when the line is written and kept in step by set_dispatch_job_billing_basis until invoiced. NULL = job not yet classified.';

CREATE FUNCTION public.inherit_dispatch_charge_line_billing_basis()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  SELECT j.billing_basis, j.extra_work_order_id INTO NEW.billing_basis, NEW.extra_work_order_id
  FROM public.dispatch_jobs j WHERE j.id = NEW.source_dispatch_id;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.inherit_dispatch_charge_line_billing_basis() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_inherit_dispatch_charge_line_billing_basis
  BEFORE INSERT ON public.dispatch_job_charge_lines
  FOR EACH ROW EXECUTE FUNCTION public.inherit_dispatch_charge_line_billing_basis();

-- dispatch_jobs has a broad org-member UPDATE policy; the billing columns must
-- only move through the audited RPC.
CREATE FUNCTION public.guard_dispatch_job_billing_basis()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(current_setting('fcm.dispatch_billing_rpc', true), '') = 'on' AND current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.billing_basis IS NOT NULL OR NEW.extra_work_order_id IS NOT NULL OR NEW.billing_basis_set_at IS NOT NULL OR NEW.billing_basis_set_by IS NOT NULL THEN
      RAISE EXCEPTION 'Dispatch billing basis is set through set_dispatch_job_billing_basis';
    END IF;
  ELSIF NEW.billing_basis IS DISTINCT FROM OLD.billing_basis
     OR NEW.extra_work_order_id IS DISTINCT FROM OLD.extra_work_order_id
     OR NEW.billing_basis_set_at IS DISTINCT FROM OLD.billing_basis_set_at
     OR NEW.billing_basis_set_by IS DISTINCT FROM OLD.billing_basis_set_by THEN
    RAISE EXCEPTION 'Dispatch billing basis is set through set_dispatch_job_billing_basis';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_dispatch_job_billing_basis() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_guard_dispatch_job_billing_basis
  BEFORE INSERT OR UPDATE ON public.dispatch_jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_dispatch_job_billing_basis();

CREATE FUNCTION public.manage_agreement_extra_work_order(
  p_client_request_id uuid,
  p_agreement_id uuid,
  p_action text,
  p_order_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_scope text DEFAULT NULL,
  p_authority_kind text DEFAULT NULL,
  p_authority_reference text DEFAULT NULL,
  p_charge_code text DEFAULT NULL,
  p_rate_note text DEFAULT NULL,
  p_starts_on date DEFAULT NULL,
  p_ends_on date DEFAULT NULL,
  p_review_on date DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_order public.agreement_extra_work_orders%rowtype;
  v_receipt public.audit_log%rowtype;
  v_before jsonb;
  v_next integer;
  v_code text := nullif(btrim(p_charge_code), '');
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('create', 'update', 'end') THEN RAISE EXCEPTION 'Unsupported Extra works action'; END IF;

  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;
  IF v_agreement.agreement_type <> 'operational' THEN
    RAISE EXCEPTION 'Extra works orders belong to operational agreements';
  END IF;

  SELECT * INTO v_receipt FROM public.audit_log a
  WHERE a.organization_id = v_agreement.provider_organization_id
    AND a.target_table = 'agreement_extra_work_orders'
    AND a.metadata->>'client_request_id' = p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt.metadata->>'agreement_id' <> p_agreement_id::text OR v_receipt.metadata->>'request_action' <> p_action THEN
      RAISE EXCEPTION 'client_request_id was already used for another Extra works command';
    END IF;
    SELECT * INTO v_order FROM public.agreement_extra_work_orders WHERE id = v_receipt.target_id;
    RETURN to_jsonb(v_order) || jsonb_build_object('replayed', true);
  END IF;

  IF p_action IN ('update', 'end') THEN
    SELECT * INTO v_order FROM public.agreement_extra_work_orders
    WHERE id = p_order_id AND service_agreement_id = v_agreement.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Extra works order not found'; END IF;
    IF p_expected_updated_at IS NULL OR v_order.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'This Extra works order changed since it was opened. Reload and try again.';
    END IF;
    IF v_order.ends_on IS NOT NULL AND v_order.ends_on < current_date THEN
      RAISE EXCEPTION 'This Extra works order has ended and can no longer be changed';
    END IF;
    v_before := to_jsonb(v_order);
  END IF;

  IF p_action = 'end' THEN
    IF p_ends_on IS NULL THEN RAISE EXCEPTION 'Give the last day the Extra work is authorised'; END IF;
    IF p_ends_on < v_order.starts_on - 1 THEN
      RAISE EXCEPTION 'The order cannot end before it started (%). To cancel one that never took effect, end it the day before it started.', to_char(v_order.starts_on, 'DD Mon YYYY');
    END IF;
    IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
      RAISE EXCEPTION 'Say why the Extra work is ending (3 to 500 characters)';
    END IF;
    UPDATE public.agreement_extra_work_orders
    SET ends_on = p_ends_on,
        review_on = CASE WHEN review_on IS NOT NULL AND review_on > p_ends_on THEN NULL ELSE review_on END,
        end_reason = btrim(p_reason), updated_by = v_actor, updated_at = clock_timestamp()
    WHERE id = v_order.id RETURNING * INTO v_order;
  ELSE
    IF char_length(btrim(coalesce(p_title, ''))) NOT BETWEEN 3 AND 160 THEN RAISE EXCEPTION 'Give the Extra work a short title (3 to 160 characters)'; END IF;
    IF char_length(btrim(coalesce(p_scope, ''))) NOT BETWEEN 10 AND 4000 THEN RAISE EXCEPTION 'Describe what the client asked for that is outside the contract (at least 10 characters)'; END IF;
    IF p_authority_kind IS NULL OR p_authority_kind NOT IN ('written', 'purchase_order', 'verbal', 'standing_instruction') THEN RAISE EXCEPTION 'Record how the client authorised this work'; END IF;
    IF p_authority_kind = 'verbal' AND nullif(btrim(p_authority_reference), '') IS NULL THEN RAISE EXCEPTION 'Verbal authority needs a note of who authorised it and when'; END IF;
    IF p_starts_on IS NULL THEN RAISE EXCEPTION 'Give the date the Extra work starts'; END IF;
    IF v_agreement.starts_on IS NOT NULL AND p_starts_on < v_agreement.starts_on THEN RAISE EXCEPTION 'Extra work cannot start before the agreement (%)', to_char(v_agreement.starts_on, 'DD Mon YYYY'); END IF;
    IF v_agreement.ends_on IS NOT NULL AND p_starts_on > v_agreement.ends_on THEN RAISE EXCEPTION 'The agreement ends on %; Extra work must start inside it', to_char(v_agreement.ends_on, 'DD Mon YYYY'); END IF;
    IF p_ends_on IS NOT NULL AND p_ends_on < p_starts_on THEN RAISE EXCEPTION 'The end date must be on or after the start date'; END IF;
    IF v_agreement.ends_on IS NOT NULL AND p_ends_on IS NOT NULL AND p_ends_on > v_agreement.ends_on THEN RAISE EXCEPTION 'Extra work cannot run past the agreement end (%)', to_char(v_agreement.ends_on, 'DD Mon YYYY'); END IF;
    IF p_review_on IS NOT NULL AND (p_review_on < p_starts_on OR (p_ends_on IS NOT NULL AND p_review_on > p_ends_on)) THEN RAISE EXCEPTION 'The review date must fall inside the Extra work term'; END IF;
    IF v_code IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.reference_codes rc
      WHERE rc.organization_id = v_agreement.provider_organization_id AND rc.code_type = 'charge_code' AND rc.code = v_code AND rc.is_active
    ) THEN RAISE EXCEPTION 'Charge code % is not in this organisation''s active catalog', v_code; END IF;

    IF p_action = 'create' THEN
      SELECT coalesce(max(nullif(substring(reference FROM '^EW-(\d+)$'), '')::integer), 0) + 1 INTO v_next
      FROM public.agreement_extra_work_orders WHERE service_agreement_id = v_agreement.id;
      INSERT INTO public.agreement_extra_work_orders(
        organization_id, service_agreement_id, reference, title, scope, authority_kind, authority_reference,
        charge_code, rate_note, starts_on, ends_on, review_on, created_by)
      VALUES (
        v_agreement.provider_organization_id, v_agreement.id, 'EW-' || lpad(v_next::text, 3, '0'), btrim(p_title), btrim(p_scope),
        p_authority_kind, nullif(btrim(p_authority_reference), ''), v_code, nullif(btrim(p_rate_note), ''),
        p_starts_on, p_ends_on, p_review_on, v_actor)
      RETURNING * INTO v_order;
    ELSE
      IF p_starts_on <> v_order.starts_on AND v_order.starts_on <= current_date AND EXISTS (
        SELECT 1 FROM public.dispatch_jobs j WHERE j.extra_work_order_id = v_order.id
      ) THEN RAISE EXCEPTION 'Jobs are already billed under this order; its start date cannot move'; END IF;
      UPDATE public.agreement_extra_work_orders
      SET title = btrim(p_title), scope = btrim(p_scope), authority_kind = p_authority_kind,
          authority_reference = nullif(btrim(p_authority_reference), ''), charge_code = v_code,
          rate_note = nullif(btrim(p_rate_note), ''), starts_on = p_starts_on, ends_on = p_ends_on,
          review_on = p_review_on, updated_by = v_actor, updated_at = clock_timestamp()
      WHERE id = v_order.id RETURNING * INTO v_order;
    END IF;
  END IF;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_agreement.provider_organization_id, v_actor, 'agreement_extra_work_order_' || p_action, 'agreement_extra_work_orders', v_order.id,
    jsonb_strip_nulls(jsonb_build_object(
      'client_request_id', p_client_request_id, 'request_action', p_action, 'agreement_id', v_agreement.id,
      'client_organization_id', v_agreement.client_organization_id, 'reference', v_order.reference,
      'reason', nullif(btrim(p_reason), ''), 'before', v_before, 'after', to_jsonb(v_order))));
  RETURN to_jsonb(v_order) || jsonb_build_object('replayed', false);
END;
$function$;
COMMENT ON FUNCTION public.manage_agreement_extra_work_order(uuid, uuid, text, uuid, timestamptz, text, text, text, text, text, text, date, date, date, text) IS 'Provider administrator creates, updates or ends an Extra works order (authorised work outside the contracted scope; not a variation). Idempotent by client_request_id; optimistic concurrency by updated_at; audited with before/after.';
REVOKE ALL ON FUNCTION public.manage_agreement_extra_work_order(uuid, uuid, text, uuid, timestamptz, text, text, text, text, text, text, date, date, date, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_agreement_extra_work_order(uuid, uuid, text, uuid, timestamptz, text, text, text, text, text, text, date, date, date, text) TO authenticated, service_role;

CREATE FUNCTION public.set_dispatch_job_billing_basis(
  p_job_id uuid,
  p_billing_basis text,
  p_extra_work_order_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_job public.dispatch_jobs%rowtype;
  v_order public.agreement_extra_work_orders%rowtype;
  v_job_day date;
BEGIN
  SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_job.organization_id) THEN
    RAISE EXCEPTION 'Not authorised to classify dispatch jobs for this organisation';
  END IF;
  IF p_billing_basis IS NULL OR p_billing_basis NOT IN ('contract', 'extra') THEN
    RAISE EXCEPTION 'Billing basis must be contract or extra';
  END IF;
  IF p_extra_work_order_id IS NOT NULL AND p_billing_basis <> 'extra' THEN
    RAISE EXCEPTION 'Only Extra jobs can sit under an Extra works order';
  END IF;
  IF v_job.billing_basis IS NOT NULL
     AND (v_job.billing_basis IS DISTINCT FROM p_billing_basis OR v_job.extra_work_order_id IS DISTINCT FROM p_extra_work_order_id)
     AND char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Say why the billing basis is changing (3 to 500 characters)';
  END IF;
  IF v_job.billing_basis IS NOT DISTINCT FROM p_billing_basis AND v_job.extra_work_order_id IS NOT DISTINCT FROM p_extra_work_order_id THEN
    RETURN jsonb_build_object('job_id', v_job.id, 'billing_basis', v_job.billing_basis, 'extra_work_order_id', v_job.extra_work_order_id, 'changed', false);
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_job_charge_lines l WHERE l.source_dispatch_id = v_job.id AND l.invoice_line_item_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This job is already invoiced; correct the billing basis through a credit note, not here';
  END IF;

  IF p_extra_work_order_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.agreement_extra_work_orders WHERE id = p_extra_work_order_id;
    IF NOT FOUND OR v_order.service_agreement_id IS DISTINCT FROM v_job.service_agreement_id THEN
      RAISE EXCEPTION 'The Extra works order must belong to the same service agreement as the job';
    END IF;
    v_job_day := (v_job.created_at AT TIME ZONE 'Pacific/Auckland')::date;
    IF v_job_day < v_order.starts_on OR (v_order.ends_on IS NOT NULL AND v_job_day > v_order.ends_on) THEN
      RAISE EXCEPTION 'Extra works order % was not in force on %', v_order.reference, to_char(v_job_day, 'DD Mon YYYY');
    END IF;
  END IF;

  PERFORM set_config('fcm.dispatch_billing_rpc', 'on', true);
  UPDATE public.dispatch_jobs
  SET billing_basis = p_billing_basis, extra_work_order_id = p_extra_work_order_id,
      billing_basis_set_at = clock_timestamp(), billing_basis_set_by = v_actor
  WHERE id = v_job.id;
  UPDATE public.dispatch_job_charge_lines
  SET billing_basis = p_billing_basis, extra_work_order_id = p_extra_work_order_id
  WHERE source_dispatch_id = v_job.id;
  PERFORM set_config('fcm.dispatch_billing_rpc', 'off', true);

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_job.organization_id, v_actor, 'dispatch_job_billing_basis_set', 'dispatch_jobs', v_job.id,
    jsonb_strip_nulls(jsonb_build_object(
      'service_agreement_id', v_job.service_agreement_id, 'reason', nullif(btrim(p_reason), ''),
      'before', jsonb_build_object('billing_basis', v_job.billing_basis, 'extra_work_order_id', v_job.extra_work_order_id),
      'after', jsonb_build_object('billing_basis', p_billing_basis, 'extra_work_order_id', p_extra_work_order_id, 'extra_work_order_reference', v_order.reference))));
  RETURN jsonb_build_object('job_id', v_job.id, 'billing_basis', p_billing_basis, 'extra_work_order_id', p_extra_work_order_id, 'extra_work_order_reference', v_order.reference, 'changed', true);
END;
$function$;
COMMENT ON FUNCTION public.set_dispatch_job_billing_basis(uuid, text, uuid, text) IS 'Dispatcher (provider administrator) marks a dispatch job as contracted work or Extra, optionally under an in-force Extra works order of the same agreement. Reason required to change an existing classification; audited.';
REVOKE ALL ON FUNCTION public.set_dispatch_job_billing_basis(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_dispatch_job_billing_basis(uuid, text, uuid, text) TO authenticated, service_role;
