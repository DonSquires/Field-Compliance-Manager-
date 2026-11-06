BEGIN;

-- This lane stores original, unverified source photos, not court-sealed or
-- client-published derivatives. The existing external-evidence trigger applies.
CREATE TABLE public.officer_record_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  officer_id uuid NOT NULL REFERENCES public.user_profiles(id),
  field_report_id uuid REFERENCES public.officer_field_reports(id),
  incident_id uuid REFERENCES public.incidents(id),
  shift_id uuid REFERENCES public.shifts(id),
  evidence_id uuid NOT NULL UNIQUE REFERENCES public.evidence_items(id),
  storage_path text NOT NULL UNIQUE,
  sha256_hash text NOT NULL CHECK (sha256_hash ~ '^[0-9a-f]{64}$'),
  original_name text NOT NULL,
  selected_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(field_report_id, incident_id) = 1),
  UNIQUE (field_report_id, sha256_hash),
  UNIQUE (incident_id, sha256_hash)
);
CREATE INDEX officer_record_photos_org ON public.officer_record_photos(organization_id);
CREATE INDEX officer_record_photos_officer ON public.officer_record_photos(officer_id);
CREATE INDEX officer_record_photos_shift ON public.officer_record_photos(shift_id);
ALTER TABLE public.officer_record_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.officer_record_photos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.officer_record_photos TO authenticated;

CREATE FUNCTION public.officer_photo_target_context(p_record_kind text, p_record_id uuid)
RETURNS TABLE(organization_id uuid, shift_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_shift uuid;
BEGIN
  IF v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles p WHERE p.id = v_user AND p.deactivated_at IS NULL
  ) THEN RAISE EXCEPTION 'Photo target is unavailable'; END IF;
  IF p_record_kind = 'field_report' THEN
    SELECT r.organization_id, r.shift_id INTO v_org, v_shift
    FROM public.officer_field_reports r
    JOIN public.user_profiles p ON p.id = v_user AND p.organization_id = r.organization_id
    WHERE r.id = p_record_id AND r.officer_id = v_user;
  ELSIF p_record_kind = 'incident' THEN
    SELECT i.organization_id, j.shift_id INTO v_org, v_shift
    FROM public.incidents i
    JOIN public.user_profiles p ON p.id = v_user AND p.organization_id = i.organization_id
    LEFT JOIN public.dispatch_jobs j ON j.id = i.dispatch_job_id
      AND j.organization_id = i.organization_id
    WHERE i.id = p_record_id AND i.officer_user_id = v_user
      AND (i.dispatch_job_id IS NULL OR j.id IS NOT NULL);
  END IF;
  IF v_org IS NULL OR NOT public.org_access_allowed(v_org) THEN
    RAISE EXCEPTION 'Photo target is unavailable';
  END IF;
  IF v_shift IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.shifts s WHERE s.id = v_shift
      AND s.organization_id = v_org AND s.officer_user_id = v_user
  ) THEN RAISE EXCEPTION 'Photo shift context is unavailable'; END IF;
  RETURN QUERY SELECT v_org, v_shift;
END;
$$;
REVOKE ALL ON FUNCTION public.officer_photo_target_context(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.officer_photo_target_context(text,uuid) TO authenticated;

CREATE FUNCTION public.officer_photo_path_allowed(p_path text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_org uuid;
BEGIN
  IF p_path IS NULL OR p_path !~ '^org/[0-9a-f-]{36}/officer-photos/(field_report|incident)/[0-9a-f-]{36}/[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;
  SELECT c.organization_id INTO v_org FROM public.officer_photo_target_context(
    split_part(p_path,'/',4), split_part(p_path,'/',5)::uuid
  ) c;
  RETURN v_org = split_part(p_path,'/',2)::uuid;
EXCEPTION WHEN invalid_text_representation OR raise_exception THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.officer_photo_path_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.officer_photo_path_allowed(text) TO authenticated;

CREATE POLICY officer_record_photos_self_read ON public.officer_record_photos
FOR SELECT TO authenticated USING (
  public.officer_photo_path_allowed(storage_path)
);

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('officer-record-photos','officer-record-photos',false,15728640,
  ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif']);
CREATE POLICY officer_record_photos_upload ON storage.objects
FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'officer-record-photos' AND owner_id = (SELECT auth.uid())::text
  AND public.officer_photo_path_allowed(name)
);
CREATE POLICY officer_record_photos_read ON storage.objects
FOR SELECT TO authenticated USING (
  bucket_id = 'officer-record-photos' AND public.officer_photo_path_allowed(name)
);
-- Restrictive guards also constrain any broader, pre-existing storage policies.
CREATE POLICY officer_record_photos_target_guard ON storage.objects AS RESTRICTIVE
FOR ALL TO authenticated USING (
  bucket_id <> 'officer-record-photos' OR public.officer_photo_path_allowed(name)
) WITH CHECK (
  bucket_id <> 'officer-record-photos' OR (
    owner_id = (SELECT auth.uid())::text AND public.officer_photo_path_allowed(name)
  )
);
CREATE POLICY officer_record_photos_no_overwrite ON storage.objects AS RESTRICTIVE
FOR UPDATE TO authenticated USING (bucket_id <> 'officer-record-photos')
WITH CHECK (bucket_id <> 'officer-record-photos');
CREATE POLICY officer_record_photos_no_delete ON storage.objects AS RESTRICTIVE
FOR DELETE TO authenticated USING (bucket_id <> 'officer-record-photos');
CREATE POLICY officer_record_photos_metadata_guard ON public.evidence_items AS RESTRICTIVE
FOR SELECT TO authenticated USING (
  metadata->>'source' IS DISTINCT FROM 'officer_photo_attachment'
  OR public.officer_photo_path_allowed(storage_path)
);

CREATE FUNCTION public.attach_officer_record_photo(
  p_record_kind text, p_record_id uuid, p_sha256 text,
  p_original_name text, p_selected_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_shift uuid;
  v_path text;
  v_object storage.objects%rowtype;
  v_photo public.officer_record_photos%rowtype;
  v_evidence uuid;
BEGIN
  SELECT c.organization_id,c.shift_id INTO v_org,v_shift
    FROM public.officer_photo_target_context(p_record_kind,p_record_id) c;
  -- Keep the authorization context from being reassigned during registration.
  PERFORM 1 FROM public.user_profiles WHERE id = v_user FOR SHARE;
  IF p_record_kind = 'field_report' THEN
    PERFORM 1 FROM public.officer_field_reports WHERE id = p_record_id FOR SHARE;
  ELSE
    PERFORM 1 FROM public.incidents WHERE id = p_record_id FOR SHARE;
    PERFORM 1 FROM public.dispatch_jobs WHERE id = (
      SELECT dispatch_job_id FROM public.incidents WHERE id = p_record_id
    ) FOR SHARE;
  END IF;
  SELECT c.organization_id,c.shift_id INTO v_org,v_shift
    FROM public.officer_photo_target_context(p_record_kind,p_record_id) c;
  IF v_shift IS NOT NULL THEN
    PERFORM 1 FROM public.shifts WHERE id = v_shift FOR SHARE;
    PERFORM public.officer_photo_target_context(p_record_kind,p_record_id);
  END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR p_selected_at IS NULL OR p_selected_at > clock_timestamp() + interval '5 minutes'
    OR nullif(btrim(p_original_name),'') IS NULL OR length(p_original_name) > 255 THEN
    RAISE EXCEPTION 'Photo provenance is invalid';
  END IF;
  v_path := 'org/' || v_org || '/officer-photos/' || p_record_kind || '/' || p_record_id || '/' || p_sha256;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_path,0));
  SELECT * INTO v_photo FROM public.officer_record_photos WHERE storage_path = v_path;
  IF v_photo.id IS NOT NULL AND v_photo.shift_id IS DISTINCT FROM v_shift THEN
    RAISE EXCEPTION 'This original photo belongs to an earlier shift context; contact operations rather than replacing it';
  END IF;
  IF v_photo.id IS NULL THEN
    SELECT * INTO v_object FROM storage.objects
      WHERE bucket_id = 'officer-record-photos' AND name = v_path;
    IF v_object.id IS NULL OR coalesce(v_object.owner_id,'') <> v_user::text
      OR coalesce(v_object.metadata->>'mimetype','') NOT IN ('image/jpeg','image/png','image/webp','image/heic','image/heif')
      OR coalesce((v_object.metadata->>'size')::bigint,0) NOT BETWEEN 1 AND 15728640 THEN
      RAISE EXCEPTION 'The original photo upload was not confirmed';
    END IF;
    INSERT INTO public.evidence_items(
      organization_id,module_key,evidence_kind,storage_path,captured_by_user_id,
      captured_at,sha256_hash,is_court_ready,retention_class,metadata
    ) VALUES (
      v_org,'record_review','photo',v_path,v_user,p_selected_at,p_sha256,false,'policy_defined',
      jsonb_build_object('provenance','external','source','officer_photo_attachment',
        'storage_bucket','officer-record-photos','record_kind',p_record_kind,'record_id',p_record_id,
        'shift_id',v_shift,'original_name',p_original_name,'raw_sha256',p_sha256,
        'selected_at',p_selected_at,'capture_time_verified',false,
        'privacy_review_status','pending','client_publish_allowed',false)
    ) RETURNING id INTO v_evidence;
    INSERT INTO public.officer_record_photos(
      organization_id,officer_id,field_report_id,incident_id,shift_id,evidence_id,
      storage_path,sha256_hash,original_name,selected_at
    ) VALUES (
      v_org,v_user,CASE WHEN p_record_kind='field_report' THEN p_record_id END,
      CASE WHEN p_record_kind='incident' THEN p_record_id END,v_shift,v_evidence,
      v_path,p_sha256,p_original_name,p_selected_at
    ) RETURNING * INTO v_photo;
    INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_org,v_user,'officer_record_photo_attached','evidence_items',v_evidence,
      jsonb_build_object('record_kind',p_record_kind,'record_id',p_record_id,'shift_id',v_shift,
        'sha256',p_sha256,'privacy_review_status','pending'));
  END IF;
  RETURN jsonb_build_object('attachment_id',v_photo.id,'evidence_id',v_photo.evidence_id,
    'record_kind',p_record_kind,'record_id',p_record_id,'organization_id',v_photo.organization_id,
    'shift_id',v_photo.shift_id,'sha256',v_photo.sha256_hash,'storage_path',v_photo.storage_path,
    'privacy_review_status','pending');
END;
$$;
REVOKE ALL ON FUNCTION public.attach_officer_record_photo(text,uuid,text,text,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_officer_record_photo(text,uuid,text,text,timestamptz) TO authenticated;

COMMENT ON TABLE public.officer_record_photos IS
  'Officer-owned source-photo links to exact reports/incidents. Private, unverified and pending privacy/Oracle review; never a client-publication grant.';
COMMIT;