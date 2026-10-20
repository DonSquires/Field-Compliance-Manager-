-- Owner ruling 2026-10-20 (docs/canon/ALIGNMENT_LEDGER.md): canonical vehicle
-- appearance/expiry facts are global. Any organisation administrator may
-- correct them; every change is audited with before/after values and the
-- record shows when it was last changed and by which organisation. Identity
-- facts (plate, VIN, chassis, engine, owner) stay on their governed paths.
ALTER TABLE public.canonical_vehicles
  ADD COLUMN IF NOT EXISTS details_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS details_updated_by_org_id uuid REFERENCES public.organizations(id),
  ADD COLUMN IF NOT EXISTS details_updated_by uuid REFERENCES public.user_profiles(id);
COMMENT ON COLUMN public.canonical_vehicles.details_updated_at IS
  'When a human last corrected the shared vehicle profile facts (make/model/year/colour/body/expiries). Audit before/after in audit_log action vehicle_profile_details_updated.';
COMMENT ON COLUMN public.canonical_vehicles.details_updated_by_org_id IS
  'Organisation whose administrator last corrected the shared vehicle profile facts.';

CREATE OR REPLACE VIEW public.canonical_vehicle_public AS
 SELECT v.id,
    v.plate_number,
    v.make,
    v.model,
    v.year,
    v.colour,
    v.body_type,
    v.fuel_type,
    v.rego_status,
    v.rego_expiry,
    v.wof_status,
    v.wof_expiry,
    v.cof_status,
    v.cof_expiry,
    v.homeless_status,
    v.last_seen_at,
    v.created_at,
    v.updated_at,
    v.external_data_source_name,
    v.external_data_source_url,
    v.external_data_source_location,
    v.external_data_source_checked_at,
    v.details_updated_at,
    (SELECT o.name FROM public.organizations o WHERE o.id = v.details_updated_by_org_id) AS details_updated_by_org_name
   FROM public.canonical_vehicles v;
COMMENT ON VIEW public.canonical_vehicle_public IS
  'Platform-wide Tier 0 plate attributes, credential-free source attribution and the organisation/time of the last human profile correction. Excludes owner identity, welfare notes, provider payload metadata and authorization references.';

CREATE OR REPLACE FUNCTION public.update_vehicle_profile_details(
  p_organization_id uuid, p_vehicle_id uuid, p_fields jsonb, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_before public.canonical_vehicles%rowtype;
  v_after public.canonical_vehicles%rowtype;
  v_year integer;
  v_changed jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_fields) k
      WHERE k NOT IN ('make','model','year','colour','body_type','rego_expiry','wof_expiry','cof_expiry')) THEN
    RAISE EXCEPTION 'Unsupported vehicle profile fields';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(p_fields) entry WHERE length(entry.value) > 100) THEN
    RAISE EXCEPTION 'Vehicle profile fields must be at most 100 characters';
  END IF;
  IF nullif(p_fields->>'year', '') IS NOT NULL THEN
    v_year := (p_fields->>'year')::integer;
    IF v_year NOT BETWEEN 1886 AND extract(year FROM current_date)::integer + 1 THEN RAISE EXCEPTION 'Enter a valid vehicle year'; END IF;
  END IF;

  SELECT * INTO v_before FROM public.canonical_vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF v_before.id IS NULL THEN RAISE EXCEPTION 'Canonical vehicle not found'; END IF;

  UPDATE public.canonical_vehicles SET
    make = coalesce(nullif(trim(p_fields->>'make'), ''), make),
    model = coalesce(nullif(trim(p_fields->>'model'), ''), model),
    year = coalesce(v_year, year),
    colour = coalesce(nullif(trim(p_fields->>'colour'), ''), colour),
    body_type = coalesce(nullif(trim(p_fields->>'body_type'), ''), body_type),
    rego_expiry = coalesce(nullif(p_fields->>'rego_expiry', '')::date, rego_expiry),
    wof_expiry = coalesce(nullif(p_fields->>'wof_expiry', '')::date, wof_expiry),
    cof_expiry = coalesce(nullif(p_fields->>'cof_expiry', '')::date, cof_expiry)
  WHERE id = p_vehicle_id
  RETURNING * INTO v_after;

  FOREACH v_key IN ARRAY ARRAY['make','model','year','colour','body_type','rego_expiry','wof_expiry','cof_expiry'] LOOP
    IF (to_jsonb(v_before)->v_key) IS DISTINCT FROM (to_jsonb(v_after)->v_key) THEN
      v_changed := v_changed || jsonb_build_object(v_key, jsonb_build_object('before', to_jsonb(v_before)->v_key, 'after', to_jsonb(v_after)->v_key));
    END IF;
  END LOOP;
  IF v_changed = '{}'::jsonb THEN
    RETURN jsonb_build_object('vehicle_id', p_vehicle_id, 'plate_number', v_before.plate_number, 'changed', false);
  END IF;

  UPDATE public.canonical_vehicles SET
    rego_status = CASE WHEN v_changed ? 'rego_expiry' THEN CASE WHEN rego_expiry >= current_date THEN 'current' ELSE 'expired' END ELSE rego_status END,
    wof_status = CASE WHEN v_changed ? 'wof_expiry' THEN CASE WHEN wof_expiry >= current_date THEN 'current' ELSE 'expired' END ELSE wof_status END,
    cof_status = CASE WHEN v_changed ? 'cof_expiry' THEN CASE WHEN cof_expiry >= current_date THEN 'current' ELSE 'expired' END ELSE cof_status END,
    compliance_source = 'manual',
    compliance_checked_at = clock_timestamp(),
    details_updated_at = clock_timestamp(),
    details_updated_by_org_id = p_organization_id,
    details_updated_by = v_actor,
    updated_at = clock_timestamp()
  WHERE id = p_vehicle_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'vehicle_profile_details_updated', 'canonical_vehicles', p_vehicle_id,
    jsonb_build_object('plate', v_before.plate_number, 'reason', trim(p_reason), 'changes', v_changed,
      'scope', 'shared_canonical_vehicle'));
  RETURN jsonb_build_object('vehicle_id', p_vehicle_id, 'plate_number', v_before.plate_number, 'changed', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.update_vehicle_profile_details(uuid,uuid,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_vehicle_profile_details(uuid,uuid,jsonb,text) TO authenticated;
COMMENT ON FUNCTION public.update_vehicle_profile_details(uuid,uuid,jsonb,text) IS
  'Any organisation administrator may correct shared canonical vehicle profile facts (owner ruling 2026-10-20). Audits before/after values and stamps details_updated_at/by org. Does not touch plate, identifiers, owner or organisation notes.';

CREATE OR REPLACE FUNCTION public.set_vehicle_profile_photo(
  p_organization_id uuid, p_vehicle_id uuid, p_storage_path text,
  p_sha256_hash text, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
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
  PERFORM 1 FROM public.canonical_vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical vehicle not found'; END IF;
  SELECT * INTO v_previous FROM public.vehicle_profile_photos WHERE canonical_vehicle_id = p_vehicle_id;
  IF v_previous.storage_path = p_storage_path AND v_previous.sha256_hash = p_sha256_hash THEN RETURN; END IF;
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
