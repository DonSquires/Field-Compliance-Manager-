-- Shared profile images are not Tier-0 registry attributes. Disclosure follows
-- existing organisation custody or a caller-visible observation of the vehicle.
CREATE TABLE public.vehicle_profile_photos (
  canonical_vehicle_id uuid PRIMARY KEY REFERENCES public.canonical_vehicles(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  storage_path text NOT NULL UNIQUE,
  sha256_hash text NOT NULL CHECK (sha256_hash ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid NOT NULL REFERENCES public.user_profiles(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.vehicle_profile_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vehicle_profile_photos FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.vehicle_profile_photos TO authenticated;
CREATE POLICY vehicle_profile_photos_select ON public.vehicle_profile_photos
FOR SELECT TO authenticated USING (
  public.org_access_allowed(organization_id)
  OR EXISTS (
    SELECT 1 FROM public.observations o
    WHERE o.canonical_vehicle_id = vehicle_profile_photos.canonical_vehicle_id
  )
);
COMMENT ON TABLE public.vehicle_profile_photos IS
  'Human-designated shared vehicle profile photo. Private storage; disclosure through existing org custody or caller-RLS observation access. Replacement paths/hashes retained in audit, original objects retained. Not enforcement evidence or identity proof.';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('vehicle-profile-photos', 'vehicle-profile-photos', false, 5242880,
  ARRAY['image/jpeg','image/png','image/webp']);

CREATE POLICY vehicle_profile_photo_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'vehicle-profile-photos'
  AND (storage.foldername(name))[2] = auth.uid()::text
  AND CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN public.is_admin_for_org(((storage.foldername(name))[1])::uuid)
    ELSE false END
);
CREATE POLICY vehicle_profile_photo_select ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'vehicle-profile-photos'
  AND EXISTS (SELECT 1 FROM public.vehicle_profile_photos p WHERE p.storage_path = name)
);

-- Observations are an existing registry membership source (get_identity_registry).
-- Include them in both sides of the same writer's related/shared test.
CREATE OR REPLACE FUNCTION public.manage_identity_vehicle(p_organization_id uuid, p_vehicle_id uuid, p_plate text, p_fields jsonb, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_plate text := public.normalize_plate_number(p_plate);
  v_vehicle_id uuid := p_vehicle_id;
  v_year integer;
  v_note text := nullif(trim(p_fields->>'notes'), '');
  v_vehicle public.canonical_vehicles%rowtype;
  v_existing boolean := false;
  v_related boolean := false;
  v_shared boolean := false;
  v_changes_global_facts boolean := false;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Identity registry administrator access required'; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  IF v_plate IS NULL OR length(v_plate) > 10 THEN RAISE EXCEPTION 'Enter a valid plate'; END IF;
  IF nullif(p_fields->>'year', '') IS NOT NULL THEN
    v_year := (p_fields->>'year')::integer;
    IF v_year NOT BETWEEN 1886 AND extract(year FROM current_date)::integer + 1 THEN RAISE EXCEPTION 'Enter a valid vehicle year'; END IF;
  END IF;
  IF v_vehicle_id IS NULL THEN
    SELECT * INTO v_vehicle FROM public.canonical_vehicles WHERE plate_number = v_plate FOR UPDATE;
    v_existing := v_vehicle.id IS NOT NULL;
    IF NOT v_existing THEN
      v_vehicle_id := public.ensure_canonical_vehicle(v_plate, p_fields->>'make', p_fields->>'model', p_fields->>'colour',
        'organization_identity_registry', p_organization_id::text || ':' || v_plate, clock_timestamp());
      SELECT * INTO v_vehicle FROM public.canonical_vehicles WHERE id = v_vehicle_id FOR UPDATE;
    ELSE
      v_vehicle_id := v_vehicle.id;
    END IF;
  ELSE
    SELECT * INTO v_vehicle FROM public.canonical_vehicles WHERE id = v_vehicle_id AND plate_number = v_plate FOR UPDATE;
    v_existing := true;
  END IF;
  IF v_vehicle.id IS NULL THEN RAISE EXCEPTION 'Canonical vehicle does not match this plate'; END IF;
  v_related := v_vehicle.org_notes ? p_organization_id::text
    OR EXISTS (SELECT 1 FROM public.canonical_vehicle_links link WHERE link.canonical_vehicle_id = v_vehicle_id AND link.metadata->>'organization_id' = p_organization_id::text)
    OR EXISTS (SELECT 1 FROM public.cctv_entity_observations observation WHERE observation.canonical_vehicle_id = v_vehicle_id AND observation.organization_id = p_organization_id)
    OR EXISTS (SELECT 1 FROM public.observations observation WHERE observation.canonical_vehicle_id = v_vehicle_id AND observation.organization_id = p_organization_id);
  IF p_vehicle_id IS NOT NULL AND NOT v_related AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Vehicle is outside this organization'; END IF;
  v_shared := jsonb_object_length(v_vehicle.org_notes - p_organization_id::text) > 0
    OR EXISTS (SELECT 1 FROM public.canonical_vehicle_links link WHERE link.canonical_vehicle_id = v_vehicle_id
      AND link.metadata ? 'organization_id' AND link.metadata->>'organization_id' <> p_organization_id::text)
    OR EXISTS (SELECT 1 FROM public.cctv_entity_observations observation WHERE observation.canonical_vehicle_id = v_vehicle_id AND observation.organization_id <> p_organization_id)
    OR EXISTS (SELECT 1 FROM public.observations observation WHERE observation.canonical_vehicle_id = v_vehicle_id AND observation.organization_id <> p_organization_id);
  v_changes_global_facts :=
    (nullif(trim(p_fields->>'make'), '') IS NOT NULL AND nullif(trim(p_fields->>'make'), '') IS DISTINCT FROM v_vehicle.make)
    OR (nullif(trim(p_fields->>'model'), '') IS NOT NULL AND nullif(trim(p_fields->>'model'), '') IS DISTINCT FROM v_vehicle.model)
    OR (v_year IS NOT NULL AND v_year IS DISTINCT FROM v_vehicle.year)
    OR (nullif(trim(p_fields->>'colour'), '') IS NOT NULL AND nullif(trim(p_fields->>'colour'), '') IS DISTINCT FROM v_vehicle.colour)
    OR (nullif(trim(p_fields->>'body_type'), '') IS NOT NULL AND nullif(trim(p_fields->>'body_type'), '') IS DISTINCT FROM v_vehicle.body_type)
    OR (nullif(p_fields->>'rego_expiry', '') IS NOT NULL AND (p_fields->>'rego_expiry')::date IS DISTINCT FROM v_vehicle.rego_expiry)
    OR (nullif(p_fields->>'wof_expiry', '') IS NOT NULL AND (p_fields->>'wof_expiry')::date IS DISTINCT FROM v_vehicle.wof_expiry)
    OR (nullif(p_fields->>'cof_expiry', '') IS NOT NULL AND (p_fields->>'cof_expiry')::date IS DISTINCT FROM v_vehicle.cof_expiry);
  IF v_existing AND (v_shared OR NOT v_related) AND v_changes_global_facts AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Shared canonical vehicle facts require grand master review; organization notes can still be updated';
  END IF;
  UPDATE public.canonical_vehicles SET
    make = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(trim(p_fields->>'make'), ''), make) ELSE make END,
    model = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(trim(p_fields->>'model'), ''), model) ELSE model END,
    year = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(v_year, year) ELSE year END,
    colour = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(trim(p_fields->>'colour'), ''), colour) ELSE colour END,
    body_type = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(trim(p_fields->>'body_type'), ''), body_type) ELSE body_type END,
    rego_expiry = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(p_fields->>'rego_expiry', '')::date, rego_expiry) ELSE rego_expiry END,
    wof_expiry = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(p_fields->>'wof_expiry', '')::date, wof_expiry) ELSE wof_expiry END,
    cof_expiry = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(p_fields->>'cof_expiry', '')::date, cof_expiry) ELSE cof_expiry END,
    org_notes = CASE WHEN v_note IS NULL THEN org_notes - p_organization_id::text
      ELSE jsonb_set(org_notes, ARRAY[p_organization_id::text], jsonb_build_object('text', v_note, 'updated_at', clock_timestamp(), 'updated_by', v_actor), true) END,
    compliance_source = CASE WHEN NOT v_existing OR (v_changes_global_facts AND (public.is_grand_master() OR (v_related AND NOT v_shared))) THEN 'manual' ELSE compliance_source END,
    compliance_checked_at = CASE WHEN NOT v_existing OR (v_changes_global_facts AND (public.is_grand_master() OR (v_related AND NOT v_shared))) THEN clock_timestamp() ELSE compliance_checked_at END,
    updated_at = clock_timestamp()
  WHERE id = v_vehicle_id;
  INSERT INTO public.canonical_vehicle_links (canonical_vehicle_id, source_system, source_table, source_key, metadata)
  VALUES (v_vehicle_id, 'manual_identity_registry', 'organizations', p_organization_id::text || ':' || v_plate,
    jsonb_build_object('organization_id', p_organization_id, 'updated_by', v_actor))
  ON CONFLICT (source_system, source_table, source_key) DO UPDATE SET metadata = excluded.metadata;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'identity_vehicle_upserted', 'canonical_vehicles', v_vehicle_id,
    jsonb_build_object('plate', v_plate, 'reason', trim(p_reason), 'fields', array(SELECT jsonb_object_keys(p_fields))));
  RETURN jsonb_build_object('vehicle_id', v_vehicle_id, 'plate_number', v_plate);
END;
$function$;

CREATE FUNCTION public.update_vehicle_profile_details(
  p_organization_id uuid, p_vehicle_id uuid, p_fields jsonb, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_vehicle public.canonical_vehicles%rowtype;
  v_fields jsonb;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_fields) k
      WHERE k NOT IN ('make','model','year','colour','body_type','rego_expiry','wof_expiry','cof_expiry')) THEN
    RAISE EXCEPTION 'Unsupported vehicle profile fields';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(p_fields) entry WHERE length(entry.value) > 100) THEN
    RAISE EXCEPTION 'Vehicle profile fields must be at most 100 characters';
  END IF;
  SELECT * INTO STRICT v_vehicle FROM public.canonical_vehicles WHERE id = p_vehicle_id FOR UPDATE;
  -- Preserve notes: the existing full registry editor treats an omitted note as
  -- removal. This appearance-only surface must never erase organisation notes.
  v_fields := p_fields || jsonb_build_object('notes', v_vehicle.org_notes->p_organization_id::text->>'text');
  v_result := public.manage_identity_vehicle(p_organization_id, p_vehicle_id, v_vehicle.plate_number, v_fields, p_reason);
  UPDATE public.canonical_vehicles SET
    org_notes = v_vehicle.org_notes,
    rego_status = CASE WHEN nullif(p_fields->>'rego_expiry','') IS NOT NULL
      THEN CASE WHEN rego_expiry >= current_date THEN 'current' ELSE 'expired' END ELSE rego_status END,
    wof_status = CASE WHEN nullif(p_fields->>'wof_expiry','') IS NOT NULL
      THEN CASE WHEN wof_expiry >= current_date THEN 'current' ELSE 'expired' END ELSE wof_status END,
    cof_status = CASE WHEN nullif(p_fields->>'cof_expiry','') IS NOT NULL
      THEN CASE WHEN cof_expiry >= current_date THEN 'current' ELSE 'expired' END ELSE cof_status END
  WHERE id = p_vehicle_id;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.update_vehicle_profile_details(uuid,uuid,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_vehicle_profile_details(uuid,uuid,jsonb,text) TO authenticated;

CREATE FUNCTION public.set_vehicle_profile_photo(
  p_organization_id uuid, p_vehicle_id uuid, p_storage_path text,
  p_sha256_hash text, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_vehicle public.canonical_vehicles%rowtype;
  v_previous public.vehicle_profile_photos%rowtype;
  v_metadata jsonb;
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  IF p_sha256_hash IS NULL OR p_sha256_hash !~ '^[0-9a-f]{64}$'
    OR p_storage_path IS NULL OR p_storage_path NOT LIKE
      p_organization_id::text || '/' || v_actor::text || '/' || p_vehicle_id::text || '/%'
    OR p_storage_path !~ '/[0-9a-f-]{36}\.(jpg|png|webp)$' THEN
    RAISE EXCEPTION 'Invalid vehicle photo upload receipt';
  END IF;
  SELECT metadata INTO v_metadata FROM storage.objects
    WHERE bucket_id = 'vehicle-profile-photos' AND name = p_storage_path;
  IF v_metadata IS NULL OR coalesce(v_metadata->>'mimetype', '') NOT IN ('image/jpeg','image/png','image/webp')
    OR coalesce((v_metadata->>'size')::bigint, 0) NOT BETWEEN 1 AND 5242880 THEN
    RAISE EXCEPTION 'Upload a JPEG, PNG or WebP photo of at most 5 MB first';
  END IF;
  SELECT * INTO STRICT v_vehicle FROM public.canonical_vehicles WHERE id = p_vehicle_id FOR UPDATE;
  SELECT * INTO v_previous FROM public.vehicle_profile_photos WHERE canonical_vehicle_id = p_vehicle_id;
  IF v_previous.storage_path = p_storage_path AND v_previous.sha256_hash = p_sha256_hash THEN RETURN; END IF;
  -- Reuse the registry's administrator/relationship guard and audit path,
  -- without changing global vehicle facts or the organisation's notes.
  PERFORM public.manage_identity_vehicle(p_organization_id, p_vehicle_id, v_vehicle.plate_number,
    jsonb_build_object('notes', v_vehicle.org_notes->p_organization_id::text->>'text'), p_reason);
  UPDATE public.canonical_vehicles SET org_notes = v_vehicle.org_notes WHERE id = p_vehicle_id;
  INSERT INTO public.vehicle_profile_photos(canonical_vehicle_id,organization_id,storage_path,sha256_hash,uploaded_by)
  VALUES(p_vehicle_id,p_organization_id,p_storage_path,p_sha256_hash,v_actor)
  ON CONFLICT(canonical_vehicle_id) DO UPDATE SET organization_id=excluded.organization_id,
    storage_path=excluded.storage_path,sha256_hash=excluded.sha256_hash,
    uploaded_by=excluded.uploaded_by,updated_at=clock_timestamp();
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(p_organization_id,v_actor,'vehicle_profile_photo_set','canonical_vehicles',p_vehicle_id,
    jsonb_build_object('reason',trim(p_reason),'storage_path',p_storage_path,'sha256',p_sha256_hash,
      'previous_storage_path',v_previous.storage_path,'previous_sha256',v_previous.sha256_hash,
      'disclosure','shared_with_authorised_organisations'));
END;
$function$;
REVOKE ALL ON FUNCTION public.set_vehicle_profile_photo(uuid,uuid,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_vehicle_profile_photo(uuid,uuid,text,text,text) TO authenticated;
