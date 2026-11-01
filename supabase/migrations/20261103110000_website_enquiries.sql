-- Website enquiry intake: the public R&M website hands an enquiry to FCM as a
-- lead that R&M admins review.
--
-- Path: the static website POSTs to the public edge function
-- `website-enquiry` (verify_jwt = false). The function checks the origin,
-- size, honeypot and fill time, validates the fields, hashes the client IP
-- with a server-side salt and calls submit_website_enquiry with the service
-- role. Only service_role may execute submit_website_enquiry. The provider
-- organisation is resolved here from private.platform_tenancy and is never
-- taken from the request.
--
-- Review: R&M admins read rows through RLS (grand master, or an admin with
-- reach over the provider organisation) and move them through
-- review_website_enquiry, which checks the row version, requires a note for
-- converted/closed/spam and writes an audit_log row. Converting a lead never
-- creates an organisation; the admin sets up the client in Client Portfolio.
--
-- Status flow: new -> contacted | converted | closed | spam;
-- contacted -> converted | closed | spam; closed | spam -> contacted (reopen,
-- with a note). converted is final.

CREATE TABLE IF NOT EXISTS public.website_enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  reference text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  name text NOT NULL,
  email text,
  phone text,
  organisation text,
  location text,
  services text[] NOT NULL DEFAULT '{}'::text[],
  message text NOT NULL,
  preferred_contact text NOT NULL DEFAULT 'either',
  privacy_ack boolean NOT NULL,
  source_page text,
  client_hash text,
  status text NOT NULL DEFAULT 'new',
  status_note text,
  handled_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  handled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT website_enquiries_reference_key UNIQUE (reference),
  CONSTRAINT website_enquiries_reference_format CHECK (reference ~ '^ENQ-[0-9A-F]{6}$'),
  CONSTRAINT website_enquiries_name_length CHECK (name = btrim(name) AND char_length(name) BETWEEN 2 AND 120),
  CONSTRAINT website_enquiries_email_format CHECK (
    email IS NULL OR (char_length(email) <= 200 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  CONSTRAINT website_enquiries_phone_format CHECK (
    phone IS NULL OR (char_length(phone) <= 40 AND phone ~ '^[0-9 +()-]+$' AND phone ~ '[0-9]')
  ),
  CONSTRAINT website_enquiries_contact_required CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT website_enquiries_organisation_length CHECK (organisation IS NULL OR char_length(organisation) BETWEEN 1 AND 160),
  CONSTRAINT website_enquiries_location_length CHECK (location IS NULL OR char_length(location) BETWEEN 1 AND 160),
  CONSTRAINT website_enquiries_services_allowed CHECK (
    cardinality(services) <= 11
    AND array_position(services, NULL) IS NULL
    AND services <@ ARRAY[
      'static-guarding', 'patrols-response', 'cctv-surveillance', 'raptor', 'gates-access',
      'investigations', 'forestry-rural', 'rams-permits', 'council-compliance', 'pest-control', 'other'
    ]::text[]
  ),
  CONSTRAINT website_enquiries_message_length CHECK (message = btrim(message) AND char_length(message) BETWEEN 10 AND 4000),
  CONSTRAINT website_enquiries_preferred_contact_check CHECK (preferred_contact IN ('email', 'phone', 'either')),
  CONSTRAINT website_enquiries_privacy_ack_check CHECK (privacy_ack),
  CONSTRAINT website_enquiries_source_page_length CHECK (source_page IS NULL OR char_length(source_page) BETWEEN 1 AND 200),
  CONSTRAINT website_enquiries_client_hash_format CHECK (client_hash IS NULL OR client_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT website_enquiries_status_check CHECK (status IN ('new', 'contacted', 'converted', 'closed', 'spam')),
  CONSTRAINT website_enquiries_status_note_length CHECK (status_note IS NULL OR char_length(status_note) BETWEEN 1 AND 2000),
  CONSTRAINT website_enquiries_version_positive CHECK (version >= 1)
);

COMMENT ON TABLE public.website_enquiries IS
  'Enquiries from the public R&M website. Written only by submit_website_enquiry (service role, via the website-enquiry edge function); reviewed by R&M admins through review_website_enquiry. client_hash is a salted SHA-256 of the client IP used only for rate limiting; the raw IP is never stored.';
COMMENT ON COLUMN public.website_enquiries.client_hash IS
  'Salted SHA-256 (hex) of the first x-forwarded-for address. Used for the 5 per hour limit. Never the raw IP.';

CREATE INDEX IF NOT EXISTS website_enquiries_provider_status_received_idx
  ON public.website_enquiries (provider_organization_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS website_enquiries_client_hash_received_idx
  ON public.website_enquiries (client_hash, received_at);
CREATE INDEX IF NOT EXISTS website_enquiries_handled_by_idx
  ON public.website_enquiries (handled_by) WHERE handled_by IS NOT NULL;

ALTER TABLE public.website_enquiries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.website_enquiries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.website_enquiries TO authenticated;
GRANT ALL ON TABLE public.website_enquiries TO service_role;

DROP POLICY IF EXISTS website_enquiries_select_provider_admins ON public.website_enquiries;
CREATE POLICY website_enquiries_select_provider_admins ON public.website_enquiries
  FOR SELECT TO authenticated
  USING (
    (( SELECT public.is_grand_master()))
    OR (( SELECT public.is_admin_for_org(provider_organization_id)))
  );

CREATE OR REPLACE FUNCTION public.submit_website_enquiry(
  p_name text,
  p_message text,
  p_privacy_ack boolean,
  p_client_hash text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_organisation text DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_services text[] DEFAULT NULL,
  p_preferred_contact text DEFAULT NULL,
  p_source_page text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  c_allowed_services constant text[] := ARRAY[
    'static-guarding', 'patrols-response', 'cctv-surveillance', 'raptor', 'gates-access',
    'investigations', 'forestry-rural', 'rams-permits', 'council-compliance', 'pest-control', 'other'
  ]::text[];
  v_provider uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_message text := btrim(coalesce(p_message, ''));
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_organisation text := nullif(btrim(coalesce(p_organisation, '')), '');
  v_location text := nullif(btrim(coalesce(p_location, '')), '');
  v_source_page text := nullif(btrim(coalesce(p_source_page, '')), '');
  v_preferred text := coalesce(nullif(btrim(coalesce(p_preferred_contact, '')), ''), 'either');
  v_client_hash text := lower(btrim(coalesce(p_client_hash, '')));
  v_services text[] := '{}'::text[];
  v_recent integer;
  v_id uuid;
  v_reference text;
  v_attempt integer := 0;
  v_role text;
BEGIN
  SELECT t.service_provider_organization_id
    INTO v_provider
    FROM private.platform_tenancy t
   WHERE t.singleton;
  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'Single-provider tenancy is not configured';
  END IF;

  -- Defence in depth: the edge function validates first; these checks keep
  -- the table honest if anything else ever calls this function.
  IF char_length(v_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:name';
  END IF;
  IF v_email IS NOT NULL AND (char_length(v_email) > 200 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:email';
  END IF;
  IF v_phone IS NOT NULL AND (char_length(v_phone) > 40 OR v_phone !~ '^[0-9 +()-]+$' OR v_phone !~ '[0-9]') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:phone';
  END IF;
  IF v_email IS NULL AND v_phone IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:email';
  END IF;
  IF v_organisation IS NOT NULL AND char_length(v_organisation) > 160 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:organisation';
  END IF;
  IF v_location IS NOT NULL AND char_length(v_location) > 160 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:location';
  END IF;
  IF p_services IS NOT NULL THEN
    IF array_position(p_services, NULL) IS NOT NULL OR NOT (p_services <@ c_allowed_services) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:services';
    END IF;
    SELECT coalesce(array_agg(d.service ORDER BY d.first_seen), '{}'::text[])
      INTO v_services
      FROM (
        SELECT u.service, min(u.ord) AS first_seen
          FROM unnest(p_services) WITH ORDINALITY AS u(service, ord)
         GROUP BY u.service
      ) d;
    IF cardinality(v_services) > 11 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:services';
    END IF;
  END IF;
  IF char_length(v_message) NOT BETWEEN 10 AND 4000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:message';
  END IF;
  IF v_preferred NOT IN ('email', 'phone', 'either') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:preferred_contact';
  END IF;
  IF p_privacy_ack IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:privacy_ack';
  END IF;
  IF v_source_page IS NOT NULL AND char_length(v_source_page) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:source_page';
  END IF;
  IF v_client_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_enquiry_invalid:client_hash';
  END IF;

  -- Five enquiries per client hash per rolling hour. The advisory lock
  -- serialises concurrent submissions from the same client so the count is
  -- exact. PT429 makes PostgREST answer HTTP 429.
  PERFORM pg_advisory_xact_lock(hashtext('website_enquiry:' || v_client_hash));
  SELECT count(*)
    INTO v_recent
    FROM public.website_enquiries e
   WHERE e.client_hash = v_client_hash
     AND e.received_at > clock_timestamp() - interval '1 hour';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'PT429', MESSAGE = 'website_enquiry_rate_limited',
      HINT = 'Five enquiries per hour from one client. Try again later.';
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    v_id := gen_random_uuid();
    v_reference := 'ENQ-' || upper(substr(replace(v_id::text, '-', ''), 1, 6));
    BEGIN
      INSERT INTO public.website_enquiries (
        id, provider_organization_id, reference, name, email, phone, organisation,
        location, services, message, preferred_contact, privacy_ack, source_page, client_hash
      ) VALUES (
        v_id, v_provider, v_reference, v_name, v_email, v_phone, v_organisation,
        v_location, v_services, v_message, v_preferred, true, v_source_page, v_client_hash
      );
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 5 THEN
        RAISE;
      END IF;
    END;
  END LOOP;

  -- Tell R&M admins. Role 'admin' notifications are also shown to
  -- admin_officer; masters need their own row. The body carries no personal
  -- details. A notification failure must never lose the lead.
  BEGIN
    FOREACH v_role IN ARRAY ARRAY['admin', 'master']::text[] LOOP
      PERFORM public.enqueue_notification(
        p_organization_id => v_provider,
        p_category => 'crm_client',
        p_title => 'New website enquiry ' || v_reference,
        p_body => 'Received from the R&M website. Open Website enquiries to reply.',
        p_severity => 'info',
        p_recipient_role => v_role,
        p_link_page => 'website-enquiries',
        p_link_payload => jsonb_build_object('enquiry_id', v_id, 'reference', v_reference),
        p_dedup_key => 'website_enquiry:' || v_id::text || ':' || v_role
      );
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'website enquiry % notification failed: %', v_reference, SQLERRM;
  END;

  RETURN v_reference;
END;
$function$;

COMMENT ON FUNCTION public.submit_website_enquiry(text, text, boolean, text, text, text, text, text, text[], text, text) IS
  'Service-role intake for the public website-enquiry edge function. Resolves the provider from private.platform_tenancy, re-validates every field (22023 website_enquiry_invalid:<field>), limits each client hash to 5 per hour (PT429 website_enquiry_rate_limited), inserts the enquiry, notifies R&M admins and returns the ENQ-XXXXXX reference.';
REVOKE ALL ON FUNCTION public.submit_website_enquiry(text, text, boolean, text, text, text, text, text, text[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_website_enquiry(text, text, boolean, text, text, text, text, text, text[], text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.review_website_enquiry(
  p_enquiry_id uuid,
  p_status text,
  p_note text,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_provider uuid;
  v_row public.website_enquiries%ROWTYPE;
  v_from text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to review website enquiries' USING ERRCODE = '42501';
  END IF;
  IF p_enquiry_id IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'Choose an enquiry to update' USING ERRCODE = '22023';
  END IF;
  IF v_status NOT IN ('contacted', 'converted', 'closed', 'spam') THEN
    RAISE EXCEPTION 'Choose contacted, converted, closed or spam' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 2000 THEN
    RAISE EXCEPTION 'Keep the note under 2000 characters' USING ERRCODE = '22023';
  END IF;

  SELECT e.provider_organization_id INTO v_provider
    FROM public.website_enquiries e
   WHERE e.id = p_enquiry_id;
  IF v_provider IS NULL OR NOT (public.is_grand_master() OR public.is_admin_for_org(v_provider)) THEN
    RAISE EXCEPTION 'Website enquiry not found, or you do not have access to it' USING ERRCODE = '42501';
  END IF;

  SELECT e.* INTO v_row
    FROM public.website_enquiries e
   WHERE e.id = p_enquiry_id
   FOR UPDATE;

  IF v_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'This enquiry was changed by someone else. Reload and try again.' USING ERRCODE = 'PT409';
  END IF;

  v_from := v_row.status;
  IF v_from = v_status THEN
    RAISE EXCEPTION 'This enquiry is already marked %', v_status USING ERRCODE = '22023';
  END IF;
  IF v_from = 'converted' THEN
    RAISE EXCEPTION 'A converted enquiry is final. Continue the work in Client Portfolio.' USING ERRCODE = '22023';
  END IF;
  IF v_from IN ('closed', 'spam') AND v_status <> 'contacted' THEN
    RAISE EXCEPTION 'Reopen a closed or spam enquiry as contacted first' USING ERRCODE = '22023';
  END IF;
  IF (v_status IN ('converted', 'closed', 'spam') OR v_from IN ('closed', 'spam'))
     AND (v_note IS NULL OR char_length(v_note) < 3) THEN
    RAISE EXCEPTION 'Add a short note saying why' USING ERRCODE = '22023';
  END IF;

  UPDATE public.website_enquiries e
     SET status = v_status,
         status_note = v_note,
         handled_by = v_uid,
         handled_at = clock_timestamp(),
         version = e.version + 1,
         updated_at = clock_timestamp()
   WHERE e.id = v_row.id
  RETURNING e.* INTO v_row;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_row.provider_organization_id, v_uid, 'website_enquiry_reviewed', 'website_enquiries', v_row.id,
    jsonb_strip_nulls(jsonb_build_object(
      'reference', v_row.reference,
      'from_status', v_from,
      'to_status', v_row.status,
      'note', v_note,
      'version', v_row.version
    )));

  RETURN jsonb_build_object(
    'id', v_row.id,
    'reference', v_row.reference,
    'status', v_row.status,
    'status_note', v_row.status_note,
    'version', v_row.version,
    'handled_by', v_row.handled_by,
    'handled_at', v_row.handled_at
  );
END;
$function$;

COMMENT ON FUNCTION public.review_website_enquiry(uuid, text, text, integer) IS
  'R&M admin review of a website enquiry. Requires grand master or admin reach over the provider organisation, the current row version (PT409 when stale) and a note for converted/closed/spam or a reopen. Writes audit_log action website_enquiry_reviewed.';
REVOKE ALL ON FUNCTION public.review_website_enquiry(uuid, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_website_enquiry(uuid, text, text, integer) TO authenticated, service_role;
