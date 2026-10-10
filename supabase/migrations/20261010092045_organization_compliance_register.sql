BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS trading_name text,
  ADD COLUMN IF NOT EXISTS registered_office text,
  ADD COLUMN IF NOT EXISTS postal_address text,
  ADD COLUMN IF NOT EXISTS website_url text,
  ADD COLUMN IF NOT EXISTS corporate_profile_source text,
  ADD COLUMN IF NOT EXISTS corporate_profile_verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS corporate_profile_verified_by uuid REFERENCES public.user_profiles(id),
  ADD COLUMN IF NOT EXISTS corporate_profile_verified_at timestamptz;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_corporate_profile_verification_status_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_corporate_profile_verification_status_check
  CHECK (corporate_profile_verification_status IN ('unverified', 'verified', 'rejected'));

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_corporate_profile_verification_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_corporate_profile_verification_check
  CHECK (
    corporate_profile_verification_status <> 'verified'
    OR (
      corporate_profile_verified_by IS NOT NULL
      AND corporate_profile_verified_at IS NOT NULL
      AND nullif(trim(coalesce(corporate_profile_source, '')), '') IS NOT NULL
    )
  );

CREATE TABLE public.organization_compliance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (
    record_type IN (
      'company_licence',
      'insurance',
      'policy',
      'prequalification',
      'registration',
      'certification',
      'other'
    )
  ),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  reference_number text,
  issuer text,
  effective_date date,
  expiry_date date,
  coverage_amount numeric(14,2),
  currency text NOT NULL DEFAULT 'NZD' CHECK (currency ~ '^[A-Z]{3}$'),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (
    verification_status IN ('unverified', 'verified', 'rejected')
  ),
  verified_by uuid REFERENCES public.user_profiles(id),
  verified_at timestamptz,
  review_notes text,
  evidence_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  source_name text NOT NULL CHECK (length(trim(source_name)) BETWEEN 2 AND 500),
  source_as_of date NOT NULL,
  source_notes text,
  replaces_record_id uuid REFERENCES public.organization_compliance_records(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'cancelled')),
  client_request_id uuid,
  created_by uuid REFERENCES public.user_profiles(id),
  updated_by uuid REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_date IS NULL OR expiry_date IS NULL OR expiry_date >= effective_date),
  CHECK (coverage_amount IS NULL OR coverage_amount >= 0),
  CHECK (
    verification_status <> 'verified'
    OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)
  )
);

CREATE INDEX organization_compliance_records_org_idx
  ON public.organization_compliance_records(organization_id, status, expiry_date);

CREATE INDEX organization_compliance_records_expiry_idx
  ON public.organization_compliance_records(expiry_date)
  WHERE status = 'current' AND expiry_date IS NOT NULL;

CREATE UNIQUE INDEX organization_compliance_records_request_idx
  ON public.organization_compliance_records(organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

ALTER TABLE public.organization_compliance_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_compliance_records_select
  ON public.organization_compliance_records
  FOR SELECT
  TO authenticated
  USING (
    public.org_access_allowed(organization_id)
    AND EXISTS (
      SELECT 1
      FROM public.user_profiles actor
      WHERE actor.id = (SELECT auth.uid())
        AND actor.deactivated_at IS NULL
        AND actor.role IN ('grand_master', 'master')
    )
  );

REVOKE ALL ON TABLE public.organization_compliance_records
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.organization_compliance_records TO authenticated;
GRANT ALL ON TABLE public.organization_compliance_records TO service_role;

CREATE OR REPLACE FUNCTION public.update_organization_corporate_profile(
  p_organization_id uuid,
  p_expected_updated_at timestamptz,
  p_legal_name text,
  p_trading_name text,
  p_nzbn text,
  p_company_registration_number text,
  p_corporate_status text,
  p_corporate_status_as_of date,
  p_nzbn_entity_type text,
  p_registered_office text,
  p_postal_address text,
  p_website_url text,
  p_corporate_profile_source text
)
RETURNS public.organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org public.organizations%rowtype;
  v_nzbn text := regexp_replace(coalesce(p_nzbn, ''), '[^0-9]', '', 'g');
  v_website text := nullif(trim(coalesce(p_website_url, '')), '');
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles actor
    WHERE actor.id = v_actor
      AND actor.deactivated_at IS NULL
      AND actor.role IN ('grand_master', 'master')
  ) THEN
    RAISE EXCEPTION 'Active organization master required';
  END IF;

  SELECT *
  INTO v_org
  FROM public.organizations
  WHERE id = p_organization_id
    AND parent_organization_id IS NULL
    AND organization_type IN ('owner', 'service_provider')
    AND active
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active root organization not found';
  END IF;
  IF v_org.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'Organization changed since it was opened';
  END IF;
  IF length(trim(coalesce(p_legal_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Legal name is required';
  END IF;
  IF length(v_nzbn) <> 13 THEN
    RAISE EXCEPTION 'NZBN must contain 13 digits';
  END IF;
  IF nullif(trim(coalesce(p_company_registration_number, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Company registration number is required';
  END IF;
  IF nullif(trim(coalesce(p_corporate_profile_source, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Corporate profile source is required';
  END IF;
  IF v_website IS NOT NULL AND v_website !~* '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'Website must be an HTTPS URL';
  END IF;

  UPDATE public.organizations
  SET
    legal_name = trim(p_legal_name),
    trading_name = nullif(trim(coalesce(p_trading_name, '')), ''),
    nzbn = v_nzbn,
    company_registration_number = trim(p_company_registration_number),
    corporate_status = nullif(trim(coalesce(p_corporate_status, '')), ''),
    corporate_status_as_of = p_corporate_status_as_of,
    nzbn_entity_type = nullif(trim(coalesce(p_nzbn_entity_type, '')), ''),
    registered_office = nullif(trim(coalesce(p_registered_office, '')), ''),
    postal_address = nullif(trim(coalesce(p_postal_address, '')), ''),
    website_url = v_website,
    corporate_profile_source = trim(p_corporate_profile_source),
    corporate_profile_verification_status = 'unverified',
    corporate_profile_verified_by = NULL,
    corporate_profile_verified_at = NULL,
    updated_at = clock_timestamp()
  WHERE id = v_org.id
  RETURNING * INTO v_org;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_org.id,
    v_actor,
    'organization_corporate_profile_updated',
    'organizations',
    v_org.id,
    jsonb_build_object(
      'company_registration_number', v_org.company_registration_number,
      'corporate_status', v_org.corporate_status,
      'source', v_org.corporate_profile_source
    )
  );

  RETURN v_org;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_organization_corporate_profile(
  uuid, timestamptz, text, text, text, text, text, date, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_organization_corporate_profile(
  uuid, timestamptz, text, text, text, text, text, date, text, text, text, text, text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_organization_corporate_profile(
  p_organization_id uuid,
  p_expected_updated_at timestamptz,
  p_decision text
)
RETURNS public.organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org public.organizations%rowtype;
BEGIN
  IF p_decision NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be verified or rejected';
  END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles actor
    WHERE actor.id = v_actor
      AND actor.deactivated_at IS NULL
      AND actor.role IN ('grand_master', 'master')
  ) THEN
    RAISE EXCEPTION 'Active organization master required';
  END IF;

  SELECT *
  INTO v_org
  FROM public.organizations
  WHERE id = p_organization_id
    AND parent_organization_id IS NULL
    AND active
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active root organization not found';
  END IF;
  IF v_org.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'Organization changed since it was opened';
  END IF;
  IF p_decision = 'verified' AND (
    v_org.legal_name IS NULL
    OR v_org.nzbn IS NULL
    OR v_org.company_registration_number IS NULL
    OR v_org.corporate_profile_source IS NULL
  ) THEN
    RAISE EXCEPTION 'Legal name, NZBN, company number, and source are required before verification';
  END IF;

  UPDATE public.organizations
  SET
    corporate_profile_verification_status = p_decision,
    corporate_profile_verified_by = CASE WHEN p_decision = 'verified' THEN v_actor ELSE NULL END,
    corporate_profile_verified_at = CASE WHEN p_decision = 'verified' THEN clock_timestamp() ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE id = v_org.id
  RETURNING * INTO v_org;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_org.id,
    v_actor,
    'organization_corporate_profile_reviewed',
    'organizations',
    v_org.id,
    jsonb_build_object('decision', p_decision)
  );

  RETURN v_org;
END;
$function$;

REVOKE ALL ON FUNCTION public.review_organization_corporate_profile(uuid, timestamptz, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_organization_corporate_profile(uuid, timestamptz, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_organization_compliance_record(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_record_id uuid,
  p_expected_updated_at timestamptz,
  p_record_type text,
  p_name text,
  p_reference_number text,
  p_issuer text,
  p_effective_date date,
  p_expiry_date date,
  p_coverage_amount numeric,
  p_currency text,
  p_evidence_document_id uuid,
  p_source_name text,
  p_source_as_of date,
  p_source_notes text,
  p_replaces_record_id uuid
)
RETURNS public.organization_compliance_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_record public.organization_compliance_records%rowtype;
  v_replaced public.organization_compliance_records%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles actor
    WHERE actor.id = v_actor
      AND actor.deactivated_at IS NULL
      AND actor.role IN ('grand_master', 'master')
  ) THEN
    RAISE EXCEPTION 'Active organization master required';
  END IF;
  IF p_record_type NOT IN (
    'company_licence',
    'insurance',
    'policy',
    'prequalification',
    'registration',
    'certification',
    'other'
  ) THEN
    RAISE EXCEPTION 'Unsupported compliance record type';
  END IF;
  IF length(trim(coalesce(p_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Compliance record name is required';
  END IF;
  IF length(trim(coalesce(p_source_name, ''))) < 2 OR p_source_as_of IS NULL THEN
    RAISE EXCEPTION 'Source name and source date are required';
  END IF;
  IF p_effective_date IS NOT NULL AND p_expiry_date IS NOT NULL AND p_expiry_date < p_effective_date THEN
    RAISE EXCEPTION 'Expiry date cannot precede effective date';
  END IF;
  IF p_coverage_amount IS NOT NULL AND p_coverage_amount < 0 THEN
    RAISE EXCEPTION 'Coverage amount cannot be negative';
  END IF;

  IF p_record_id IS NULL THEN
    IF p_client_request_id IS NULL THEN
      RAISE EXCEPTION 'Client request ID is required';
    END IF;

    SELECT *
    INTO v_record
    FROM public.organization_compliance_records
    WHERE organization_id = p_organization_id
      AND client_request_id = p_client_request_id;

    IF FOUND THEN
      RETURN v_record;
    END IF;

    IF p_replaces_record_id IS NOT NULL THEN
      SELECT *
      INTO v_replaced
      FROM public.organization_compliance_records
      WHERE id = p_replaces_record_id
        AND organization_id = p_organization_id
        AND status = 'current'
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Current record to replace was not found';
      END IF;
    END IF;

    INSERT INTO public.organization_compliance_records (
      organization_id,
      record_type,
      name,
      reference_number,
      issuer,
      effective_date,
      expiry_date,
      coverage_amount,
      currency,
      evidence_document_id,
      source_name,
      source_as_of,
      source_notes,
      replaces_record_id,
      client_request_id,
      created_by,
      updated_by
    )
    VALUES (
      p_organization_id,
      p_record_type,
      trim(p_name),
      nullif(trim(coalesce(p_reference_number, '')), ''),
      nullif(trim(coalesce(p_issuer, '')), ''),
      p_effective_date,
      p_expiry_date,
      p_coverage_amount,
      upper(coalesce(nullif(trim(p_currency), ''), 'NZD')),
      p_evidence_document_id,
      trim(p_source_name),
      p_source_as_of,
      nullif(trim(coalesce(p_source_notes, '')), ''),
      p_replaces_record_id,
      p_client_request_id,
      v_actor,
      v_actor
    )
    RETURNING * INTO v_record;

    IF p_replaces_record_id IS NOT NULL THEN
      UPDATE public.organization_compliance_records
      SET status = 'superseded', updated_by = v_actor, updated_at = clock_timestamp()
      WHERE id = p_replaces_record_id;
    END IF;
  ELSE
    SELECT *
    INTO v_record
    FROM public.organization_compliance_records
    WHERE id = p_record_id
      AND organization_id = p_organization_id
      AND status = 'current'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Current compliance record not found';
    END IF;
    IF v_record.updated_at <> p_expected_updated_at THEN
      RAISE EXCEPTION 'Compliance record changed since it was opened';
    END IF;

    UPDATE public.organization_compliance_records
    SET
      record_type = p_record_type,
      name = trim(p_name),
      reference_number = nullif(trim(coalesce(p_reference_number, '')), ''),
      issuer = nullif(trim(coalesce(p_issuer, '')), ''),
      effective_date = p_effective_date,
      expiry_date = p_expiry_date,
      coverage_amount = p_coverage_amount,
      currency = upper(coalesce(nullif(trim(p_currency), ''), 'NZD')),
      evidence_document_id = p_evidence_document_id,
      source_name = trim(p_source_name),
      source_as_of = p_source_as_of,
      source_notes = nullif(trim(coalesce(p_source_notes, '')), ''),
      verification_status = 'unverified',
      verified_by = NULL,
      verified_at = NULL,
      review_notes = NULL,
      updated_by = v_actor,
      updated_at = clock_timestamp()
    WHERE id = v_record.id
    RETURNING * INTO v_record;
  END IF;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    p_organization_id,
    v_actor,
    CASE WHEN p_record_id IS NULL THEN 'organization_compliance_record_created' ELSE 'organization_compliance_record_updated' END,
    'organization_compliance_records',
    v_record.id,
    jsonb_build_object(
      'record_type', v_record.record_type,
      'verification_status', v_record.verification_status,
      'expiry_date', v_record.expiry_date,
      'replaces_record_id', p_replaces_record_id
    )
  );

  RETURN v_record;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_organization_compliance_record(
  uuid, uuid, uuid, timestamptz, text, text, text, text, date, date, numeric, text, uuid, text, date, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_organization_compliance_record(
  uuid, uuid, uuid, timestamptz, text, text, text, text, date, date, numeric, text, uuid, text, date, text, uuid
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_organization_compliance_record(
  p_record_id uuid,
  p_expected_updated_at timestamptz,
  p_decision text,
  p_review_notes text DEFAULT NULL
)
RETURNS public.organization_compliance_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_record public.organization_compliance_records%rowtype;
BEGIN
  IF p_decision NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be verified or rejected';
  END IF;

  SELECT *
  INTO v_record
  FROM public.organization_compliance_records
  WHERE id = p_record_id
    AND status = 'current'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current compliance record not found';
  END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_record.organization_id) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles actor
    WHERE actor.id = v_actor
      AND actor.deactivated_at IS NULL
      AND actor.role IN ('grand_master', 'master')
  ) THEN
    RAISE EXCEPTION 'Active organization master required';
  END IF;
  IF v_record.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'Compliance record changed since it was opened';
  END IF;
  IF p_decision = 'verified' AND (
    v_record.source_name IS NULL
    OR v_record.source_as_of IS NULL
    OR (v_record.record_type IN ('company_licence', 'insurance') AND (
      v_record.reference_number IS NULL
      OR v_record.issuer IS NULL
      OR v_record.expiry_date IS NULL
    ))
  ) THEN
    RAISE EXCEPTION 'Required source, reference, issuer, or expiry evidence is missing';
  END IF;

  UPDATE public.organization_compliance_records
  SET
    verification_status = p_decision,
    verified_by = CASE WHEN p_decision = 'verified' THEN v_actor ELSE NULL END,
    verified_at = CASE WHEN p_decision = 'verified' THEN clock_timestamp() ELSE NULL END,
    review_notes = nullif(trim(coalesce(p_review_notes, '')), ''),
    updated_by = v_actor,
    updated_at = clock_timestamp()
  WHERE id = v_record.id
  RETURNING * INTO v_record;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_record.organization_id,
    v_actor,
    'organization_compliance_record_reviewed',
    'organization_compliance_records',
    v_record.id,
    jsonb_build_object(
      'record_type', v_record.record_type,
      'decision', p_decision,
      'expiry_date', v_record.expiry_date
    )
  );

  RETURN v_record;
END;
$function$;

REVOKE ALL ON FUNCTION public.review_organization_compliance_record(uuid, timestamptz, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_organization_compliance_record(uuid, timestamptz, text, text)
  TO authenticated, service_role;

COMMIT;