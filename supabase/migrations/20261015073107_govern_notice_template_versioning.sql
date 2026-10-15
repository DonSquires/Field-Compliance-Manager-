ALTER TABLE public.notice_templates
  ADD COLUMN IF NOT EXISTS client_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS notice_templates_org_client_request_unique
  ON public.notice_templates (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notice_templates_one_active_version
  ON public.notice_templates (organization_id, module_key, notice_type)
  WHERE is_active;

DROP POLICY IF EXISTS notice_templates_insert ON public.notice_templates;
DROP POLICY IF EXISTS notice_templates_update ON public.notice_templates;
REVOKE INSERT, UPDATE, DELETE ON public.notice_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notice_templates TO authenticated;

DROP FUNCTION IF EXISTS public.manage_notice_template(
  uuid, text, text, text, text, text, text, text, numeric, text, text, text, boolean
);

CREATE OR REPLACE FUNCTION public.manage_notice_template(
  p_organization_id uuid,
  p_client_request_id uuid,
  p_module_key text,
  p_notice_type text,
  p_body_html text,
  p_expected_current_id uuid DEFAULT NULL,
  p_expected_current_version integer DEFAULT NULL,
  p_issuing_authority text DEFAULT NULL,
  p_authorising_act text DEFAULT NULL,
  p_authorising_section text DEFAULT NULL,
  p_bylaw_reference text DEFAULT NULL,
  p_fine_amount numeric DEFAULT NULL,
  p_payment_url text DEFAULT NULL,
  p_footer_text text DEFAULT NULL,
  p_source_document_url text DEFAULT NULL,
  p_bob_extracted boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_current public.notice_templates%rowtype;
  v_saved public.notice_templates%rowtype;
  v_version integer;
  v_body text := nullif(trim(coalesce(p_body_html, '')), '');
  v_authority text := nullif(trim(coalesce(p_issuing_authority, '')), '');
  v_act text := nullif(trim(coalesce(p_authorising_act, '')), '');
  v_source text := nullif(trim(coalesce(p_source_document_url, '')), '');
  v_receipt jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organization administrator required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;
  IF p_module_key NOT IN ('freedom_camping', 'parking_enforcement', 'noise_control', 'smoke_complaints', 'biosecurity') THEN
    RAISE EXCEPTION 'Unsupported enforcement module';
  END IF;
  IF p_notice_type NOT IN ('written_warning', 'notice_to_vacate', 'infringement', 'end', 'seizure') THEN
    RAISE EXCEPTION 'Unsupported notice type';
  END IF;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'Template body is required';
  END IF;
  IF length(v_body) > 100000 THEN
    RAISE EXCEPTION 'Template body is too long';
  END IF;
  IF v_authority IS NULL OR v_act IS NULL THEN
    RAISE EXCEPTION 'Issuing authority and authorising Act are required';
  END IF;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Source document location is required';
  END IF;
  IF p_fine_amount IS NOT NULL AND p_fine_amount < 0 THEN
    RAISE EXCEPTION 'Fine amount cannot be negative';
  END IF;
  IF v_body ~* '<\s*(script|iframe|object|embed)\b'
     OR v_body ~* 'javascript\s*:'
     OR v_body ~* '\son[a-z]+\s*=' THEN
    RAISE EXCEPTION 'Template body contains unsafe HTML';
  END IF;

  SELECT *
  INTO v_saved
  FROM public.notice_templates
  WHERE organization_id = p_organization_id
    AND client_request_id = p_client_request_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'template', to_jsonb(v_saved),
      'request_id', p_client_request_id,
      'replayed', true
    );
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_organization_id::text || ':' || p_module_key || ':' || p_notice_type,
      0
    )
  );

  SELECT *
  INTO v_saved
  FROM public.notice_templates
  WHERE organization_id = p_organization_id
    AND client_request_id = p_client_request_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'template', to_jsonb(v_saved),
      'request_id', p_client_request_id,
      'replayed', true
    );
  END IF;

  SELECT *
  INTO v_current
  FROM public.notice_templates
  WHERE organization_id = p_organization_id
    AND module_key = p_module_key
    AND notice_type = p_notice_type
    AND is_active
  FOR UPDATE;

  IF v_current.id IS NULL THEN
    IF p_expected_current_id IS NOT NULL OR p_expected_current_version IS NOT NULL THEN
      RAISE EXCEPTION 'Notice template changed since it was opened';
    END IF;
    v_version := 1;
  ELSE
    IF p_expected_current_id IS NULL
       OR p_expected_current_version IS NULL
       OR v_current.id IS DISTINCT FROM p_expected_current_id
       OR v_current.version IS DISTINCT FROM p_expected_current_version THEN
      RAISE EXCEPTION 'Notice template changed since it was opened';
    END IF;
    v_version := v_current.version + 1;
  END IF;

  IF v_current.id IS NOT NULL THEN
    UPDATE public.notice_templates
    SET is_active = false,
        updated_at = clock_timestamp()
    WHERE id = v_current.id;
  END IF;

  INSERT INTO public.notice_templates (
    organization_id,
    client_request_id,
    module_key,
    notice_type,
    version,
    is_active,
    issuing_authority,
    authorising_act,
    authorising_section,
    bylaw_reference,
    body_html,
    fine_amount,
    payment_url,
    footer_text,
    source_document_url,
    bob_extracted,
    created_by,
    updated_at
  )
  VALUES (
    p_organization_id,
    p_client_request_id,
    p_module_key,
    p_notice_type,
    v_version,
    true,
    v_authority,
    v_act,
    nullif(trim(coalesce(p_authorising_section, '')), ''),
    nullif(trim(coalesce(p_bylaw_reference, '')), ''),
    v_body,
    p_fine_amount,
    nullif(trim(coalesce(p_payment_url, '')), ''),
    nullif(trim(coalesce(p_footer_text, '')), ''),
    v_source,
    coalesce(p_bob_extracted, false),
    v_actor,
    clock_timestamp()
  )
  RETURNING * INTO v_saved;

  v_receipt := jsonb_build_object(
    'template', to_jsonb(v_saved),
    'request_id', p_client_request_id,
    'replayed', false
  );

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
    'notice_template_version_created',
    'notice_templates',
    v_saved.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'previous', CASE WHEN v_current.id IS NULL THEN NULL ELSE to_jsonb(v_current) END,
      'resulting', to_jsonb(v_saved),
      'receipt', v_receipt
    )
  );

  RETURN v_receipt;
END;
$$;

COMMENT ON FUNCTION public.manage_notice_template(
  uuid, uuid, text, text, text, uuid, integer, text, text, text, text, numeric, text, text, text, boolean
) IS
  'Creates a replay-safe, optimistic, immutable notice-template version for an authorised organisation administrator. The prior active version is retained as history.';

REVOKE ALL ON FUNCTION public.manage_notice_template(
  uuid, uuid, text, text, text, uuid, integer, text, text, text, text, numeric, text, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_notice_template(
  uuid, uuid, text, text, text, uuid, integer, text, text, text, text, numeric, text, text, text, boolean
) TO postgres, authenticated, service_role;