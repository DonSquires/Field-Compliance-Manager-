-- Dispatch place site-entry: one server-side resolve-or-create for the places a
-- dispatch job points at, used by both the work place (intake) and the
-- harmed-party place (complainant). Seed of the canonical site-entry pipeline
-- (docs/REBUILD_PLAN.md §3.1/§3.3; LOCATION_HOUSE_MODEL: resolve-or-create the
-- house first; GEOFENCE_PRINCIPLES: a provisional centre is truthful, loud, and
-- never authoritative).
--
-- Additive: a new internal helper; `set_dispatch_job_harmed_party` re-issued with
-- two optional coordinates (old signature dropped to avoid PostgREST overload
-- ambiguity — every existing call still matches) and a tightened site check;
-- `create_dispatch_intake_job` re-issued on the helper with an identical
-- signature and return shape. No policy or table changed.

-- ── 1. Resolve-or-create the site facet (and its house) for a dispatch place ─
CREATE OR REPLACE FUNCTION public.resolve_or_create_dispatch_place_site(
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_name text,
  p_address text,
  p_lat double precision,
  p_lng double precision,
  p_actor uuid DEFAULT auth.uid()
) RETURNS TABLE(site_id uuid, location_id uuid, site_created boolean, house_action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_address text := nullif(trim(coalesce(p_address, '')), '');
  v_name text := coalesce(nullif(trim(coalesce(p_name, '')), ''), nullif(trim(coalesce(p_address, '')), ''));
  v_key text;
  v_site public.client_sites%rowtype;
  v_house_id uuid;
  v_house_action text;
  v_signals jsonb := NULL;
  v_ownership text := 'resolved';
BEGIN
  IF p_client_organization_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_client_organization_id) THEN
    RAISE EXCEPTION 'Place owner organisation not found';
  END IF;
  IF v_address IS NULL OR char_length(v_address) < 4 OR char_length(v_address) > 500 THEN RAISE EXCEPTION 'A complete place address is required'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Resolve the place address before recording it'; END IF;
  v_key := regexp_replace(lower(v_address), '[^a-z0-9]+', '', 'g');

  -- House first (LOCATION_HOUSE_MODEL). Same key normalisation as manage_crm_location and the site facet.
  SELECT h.id INTO v_house_id FROM public.locations h WHERE h.organization_id = p_client_organization_id AND h.address_match_key = v_key ORDER BY h.created_at LIMIT 1;
  IF v_house_id IS NOT NULL THEN
    v_house_action := 'existing_house';
  ELSIF EXISTS (SELECT 1 FROM public.locations h WHERE h.address_match_key = v_key) THEN
    -- A house at this address exists under another organisation: never jump ownership, never fork the
    -- house. The facet is created without a house and flagged for human review (loud, non-blocking).
    v_house_action := 'other_org_house';
    v_ownership := 'needs_review';
    v_signals := jsonb_build_object('house_conflict', 'other_org_house', 'address_match_key', v_key, 'flagged_at', now());
  ELSE
    INSERT INTO public.locations (organization_id, name, address, address_match_key, created_by)
    VALUES (p_client_organization_id, v_name, v_address, v_key, p_actor) RETURNING id INTO v_house_id;
    v_house_action := 'created_house';
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_provider_organization_id, p_actor, 'dispatch_place_house_created', 'locations', v_house_id,
      jsonb_build_object('owner_organization_id', p_client_organization_id, 'address_match_key', v_key));
  END IF;

  SELECT * INTO v_site FROM public.client_sites cs
  WHERE cs.client_organization_id = p_client_organization_id AND cs.address_match_key = v_key
  ORDER BY cs.active DESC, cs.created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_site.location_id IS NULL AND v_house_id IS NOT NULL THEN
      UPDATE public.client_sites SET location_id = v_house_id WHERE id = v_site.id;
    END IF;
    RETURN QUERY SELECT v_site.id, COALESCE(v_site.location_id, v_house_id), false, v_house_action;
    RETURN;
  END IF;

  INSERT INTO public.client_sites (client_organization_id, organization_id, location_id, name, address, address_match_key, site_type, active,
    site_origin, boundary_status, boundary_verification, center_point, ownership_status, ownership_signals)
  VALUES (p_client_organization_id, p_provider_organization_id, v_house_id, v_name, v_address, v_key, 'other', true,
    'adhoc', 'provisional', 'unverified', ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326), v_ownership, v_signals)
  RETURNING * INTO v_site;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_provider_organization_id, p_actor, 'dispatch_place_site_created', 'client_sites', v_site.id,
    jsonb_build_object('owner_organization_id', p_client_organization_id, 'address_match_key', v_key, 'house_action', v_house_action,
      'location_id', v_house_id, 'boundary_status', 'provisional', 'boundary_verification', 'unverified', 'center_source', 'resolved_address'));
  RETURN QUERY SELECT v_site.id, v_house_id, true, v_house_action;
END;
$$;
-- Internal seam: only the governed writers below (SECURITY DEFINER) may call it.
REVOKE ALL ON FUNCTION public.resolve_or_create_dispatch_place_site(uuid, uuid, text, text, double precision, double precision, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_or_create_dispatch_place_site(uuid, uuid, text, text, double precision, double precision, uuid) TO service_role;
COMMENT ON FUNCTION public.resolve_or_create_dispatch_place_site(uuid, uuid, text, text, double precision, double precision, uuid) IS
  'Resolve-or-create the client_sites facet (and its locations house) for a place a dispatch job points at. Dedup by address_match_key within the owner org; a house under another org is flagged needs_review, never reused or forked. Provisional centre, unverified boundary. Internal: called by create_dispatch_intake_job and set_dispatch_job_harmed_party.';

-- ── 2. Harmed-party place: address-only input becomes a real (provisional) site ─
DROP FUNCTION IF EXISTS public.set_dispatch_job_harmed_party(uuid, uuid, uuid, text, text, text, text, text, text);
CREATE OR REPLACE FUNCTION public.set_dispatch_job_harmed_party(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_harmed_party_site_id uuid DEFAULT NULL,
  p_harmed_party_address text DEFAULT NULL,
  p_party_role text DEFAULT 'complainant',
  p_display_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_harmed_party_lat double precision DEFAULT NULL,
  p_harmed_party_lng double precision DEFAULT NULL
) RETURNS TABLE(out_dispatch_job_id uuid, out_harmed_party_site_id uuid, protected_party_recorded boolean, place_created boolean, house_action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_job public.dispatch_jobs%rowtype;
  v_client_org uuid;
  v_site_id uuid := p_harmed_party_site_id;
  v_address text := nullif(trim(coalesce(p_harmed_party_address, '')), '');
  v_place record;
  v_place_created boolean := false;
  v_house_action text := NULL;
  v_has_identity boolean;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT p.organization_id, p.role INTO v_org, v_role FROM public.user_profiles p WHERE p.id = v_user AND p.deactivated_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active profile required'; END IF;
  SELECT * INTO v_job FROM public.dispatch_jobs d WHERE d.id = p_dispatch_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found'; END IF;
  IF NOT (public.is_admin_for_org(v_job.organization_id) OR (v_role = 'admin_officer' AND v_org = v_job.organization_id)) THEN
    RAISE EXCEPTION 'Dispatcher or administrator of the custodian organisation required';
  END IF;
  IF p_party_role NOT IN ('complainant', 'occupant', 'witness', 'landowner') THEN RAISE EXCEPTION 'Unsupported party role'; END IF;
  SELECT a.client_organization_id INTO v_client_org FROM public.service_agreements a WHERE a.id = v_job.service_agreement_id;

  IF v_site_id IS NOT NULL THEN
    -- The harmed-party site grants its owner the harmed-party read (W1), so it must be the job's client or the custodian.
    IF NOT EXISTS (SELECT 1 FROM public.client_sites cs WHERE cs.id = v_site_id
                   AND cs.client_organization_id IN (v_job.organization_id, COALESCE(v_client_org, v_job.organization_id))) THEN
      RAISE EXCEPTION 'Harmed-party site must belong to the job''s client or custodian organisation';
    END IF;
  ELSIF v_address IS NOT NULL AND p_harmed_party_lat IS NOT NULL AND p_harmed_party_lng IS NOT NULL THEN
    -- Address-only place resolved to coordinates: same pipeline as the work place. The platform's
    -- autolink trigger attaches every client-org site to its current agreement (that is what gives
    -- the custodian access to the place); site_origin = 'adhoc' marks it as not contracted.
    SELECT * INTO v_place FROM public.resolve_or_create_dispatch_place_site(
      v_job.organization_id, COALESCE(v_client_org, v_job.organization_id), v_address, v_address, p_harmed_party_lat, p_harmed_party_lng, v_user);
    v_site_id := v_place.site_id;
    v_place_created := v_place.site_created;
    v_house_action := v_place.house_action;
  END IF;

  UPDATE public.dispatch_jobs
  SET harmed_party_site_id = COALESCE(v_site_id, dispatch_jobs.harmed_party_site_id),
      harmed_party_address = COALESCE(v_address, dispatch_jobs.harmed_party_address)
  WHERE id = v_job.id;

  v_has_identity := nullif(trim(coalesce(p_display_name, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(p_phone, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(p_email, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(p_notes, '')), '') IS NOT NULL;
  IF v_has_identity THEN
    INSERT INTO public.dispatch_job_protected_parties (organization_id, dispatch_job_id, party_role, display_name, phone, email, notes, created_by, updated_by)
    VALUES (v_job.organization_id, v_job.id, p_party_role, nullif(trim(coalesce(p_display_name, '')), ''), nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_email, '')), ''), nullif(trim(coalesce(p_notes, '')), ''), v_user, v_user)
    ON CONFLICT (dispatch_job_id, party_role) DO UPDATE
      SET display_name = COALESCE(EXCLUDED.display_name, dispatch_job_protected_parties.display_name),
          phone = COALESCE(EXCLUDED.phone, dispatch_job_protected_parties.phone),
          email = COALESCE(EXCLUDED.email, dispatch_job_protected_parties.email),
          notes = COALESCE(EXCLUDED.notes, dispatch_job_protected_parties.notes),
          updated_by = v_user, updated_at = now();
  END IF;

  -- Audit carries the fact of the record, never the identity values.
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_job.organization_id, v_user, 'dispatch_job_harmed_party_set', 'dispatch_jobs', v_job.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'party_role', p_party_role,
      'harmed_party_site_id', v_site_id, 'identity_recorded', v_has_identity, 'place_created', v_place_created, 'house_action', v_house_action));

  RETURN QUERY SELECT v_job.id, COALESCE(v_site_id, v_job.harmed_party_site_id), v_has_identity, v_place_created, v_house_action;
END;
$$;
REVOKE ALL ON FUNCTION public.set_dispatch_job_harmed_party(uuid, uuid, uuid, text, text, text, text, text, text, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_dispatch_job_harmed_party(uuid, uuid, uuid, text, text, text, text, text, text, double precision, double precision) TO authenticated, service_role;
COMMENT ON FUNCTION public.set_dispatch_job_harmed_party(uuid, uuid, uuid, text, text, text, text, text, text, double precision, double precision) IS
  'Dispatcher records the harmed-party place on the job (known site of the client/custodian, or an address resolved to coordinates which becomes a provisional site through resolve_or_create_dispatch_place_site) and the protected identity behind dispatch_job_protected_parties. Audited without identity values.';

-- ── 3. Work place intake on the same pipeline (identical signature and return) ─
CREATE OR REPLACE FUNCTION public.create_dispatch_intake_job(
  p_organization_id uuid, p_service_agreement_id uuid, p_client_request_id uuid, p_job_type text, p_priority text, p_sla_minutes integer,
  p_location_name text, p_location_address text, p_location_lat double precision, p_location_lng double precision,
  p_dispatch_resource_id uuid DEFAULT NULL, p_briefing_notes text DEFAULT NULL, p_shift_id uuid DEFAULT NULL
) RETURNS TABLE(id uuid, client_site_id uuid, created boolean, status text, sla_respond_by timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_place record;
  v_job record;
  v_client_org_id uuid;
BEGIN
  IF NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Not authorised to create dispatch jobs for this organisation'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF nullif(trim(coalesce(p_location_name, '')), '') IS NULL OR nullif(trim(coalesce(p_location_address, '')), '') IS NULL THEN RAISE EXCEPTION 'Incident location name and address are required'; END IF;
  IF p_location_lat IS NULL OR p_location_lng IS NULL OR p_location_lat NOT BETWEEN -90 AND 90 OR p_location_lng NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Resolve the incident address before dispatching'; END IF;

  SELECT agreement.client_organization_id INTO v_client_org_id FROM public.service_agreements AS agreement
  WHERE agreement.id = p_service_agreement_id AND agreement.provider_organization_id = p_organization_id;
  IF v_client_org_id IS NULL THEN RAISE EXCEPTION 'Service agreement is not available to this provider'; END IF;

  SELECT * INTO v_place FROM public.resolve_or_create_dispatch_place_site(
    p_organization_id, v_client_org_id, trim(p_location_name), trim(p_location_address), p_location_lat, p_location_lng, auth.uid());

  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status, created_by)
  VALUES (p_service_agreement_id, v_place.site_id, 'active', auth.uid()) ON CONFLICT (service_agreement_id, site_id) DO NOTHING;

  SELECT * INTO v_job FROM public.create_dispatch_job(p_organization_id, p_service_agreement_id, v_place.site_id, p_client_request_id, p_job_type, p_priority, p_sla_minutes, p_dispatch_resource_id, p_briefing_notes, p_shift_id);
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, auth.uid(), 'dispatch_intake_location_created', 'client_sites', v_place.site_id,
    jsonb_build_object('service_agreement_id', p_service_agreement_id, 'dispatch_job_id', v_job.id, 'site_created', v_place.site_created,
      'location_id', v_place.location_id, 'house_action', v_place.house_action, 'boundary_status', 'provisional'));
  RETURN QUERY SELECT v_job.id, v_place.site_id, v_job.created, v_job.status, v_job.sla_respond_by;
END;
$$;
REVOKE ALL ON FUNCTION public.create_dispatch_intake_job(uuid, uuid, uuid, text, text, integer, text, text, double precision, double precision, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_dispatch_intake_job(uuid, uuid, uuid, text, text, integer, text, text, double precision, double precision, uuid, text, uuid) TO authenticated, service_role;
