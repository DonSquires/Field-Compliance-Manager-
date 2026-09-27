-- Prevent duplicate CCTV photo/video uploads and duplicate inference review by reserving each
-- organization + evidence kind + SHA-256 before bytes are sent. Historical duplicates remain preserved.

CREATE INDEX IF NOT EXISTS evidence_items_cctv_media_hash_idx
ON public.evidence_items(organization_id,evidence_kind,lower(sha256_hash),captured_at)
WHERE evidence_kind IN('video','photo') AND sha256_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.cctv_media_upload_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  evidence_kind text NOT NULL CHECK(evidence_kind IN('video','photo')),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  cctv_import_id uuid NOT NULL REFERENCES public.cctv_imports(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  status text NOT NULL DEFAULT 'claimed' CHECK(status IN('claimed','registered')),
  evidence_item_id uuid REFERENCES public.evidence_items(id) ON DELETE SET NULL,
  claimed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
  registered_at timestamptz,
  UNIQUE(organization_id,evidence_kind,sha256)
);
CREATE INDEX IF NOT EXISTS cctv_media_upload_claims_import_idx ON public.cctv_media_upload_claims(cctv_import_id,claimed_at DESC);
COMMENT ON TABLE public.cctv_media_upload_claims IS 'Short-lived hash reservation made before Desktop V2 uploads CCTV bytes. One organization/kind/hash can upload at a time; registered evidence wins permanently.';

CREATE OR REPLACE FUNCTION public.find_existing_cctv_media_by_hash(p_import_id uuid,p_sha256 text,p_evidence_kind text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_import public.cctv_imports%rowtype;v_evidence public.evidence_items%rowtype;v_job_status text;v_hash text:=lower(trim(coalesce(p_sha256,'')));
BEGIN
  SELECT * INTO v_import FROM public.cctv_imports WHERE id=p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found';END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_import.organization_id) THEN RAISE EXCEPTION 'CCTV import access denied';END IF;
  IF p_evidence_kind NOT IN('video','photo') OR v_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Valid CCTV media kind and SHA-256 are required';END IF;
  SELECT evidence.* INTO v_evidence FROM public.evidence_items evidence
  WHERE evidence.organization_id=v_import.organization_id AND evidence.evidence_kind=p_evidence_kind AND lower(evidence.sha256_hash)=v_hash
  ORDER BY evidence.captured_at,evidence.id LIMIT 1;
  IF v_evidence.id IS NULL THEN RETURN jsonb_build_object('found',false);END IF;
  SELECT status INTO v_job_status FROM public.inference_jobs WHERE evidence_item_id=v_evidence.id AND domain='video_motion' ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('found',true,'evidence_item_id',v_evidence.id,'cctv_import_id',v_evidence.cctv_import_id,'storage_path',v_evidence.storage_path,'file_name',v_evidence.metadata->>'file_name','inference_status',v_job_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_cctv_media_upload(p_import_id uuid,p_sha256 text,p_evidence_kind text,p_storage_path text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_import public.cctv_imports%rowtype;v_evidence public.evidence_items%rowtype;v_claim public.cctv_media_upload_claims%rowtype;v_hash text:=lower(trim(coalesce(p_sha256,'')));v_prefix text;
BEGIN
  SELECT * INTO v_import FROM public.cctv_imports WHERE id=p_import_id FOR UPDATE;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found';END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_import.organization_id) THEN RAISE EXCEPTION 'CCTV import access denied';END IF;
  IF p_evidence_kind NOT IN('video','photo') OR v_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Valid CCTV media kind and SHA-256 are required';END IF;
  v_prefix:='org/'||v_import.organization_id::text||'/cctv/'||v_import.id::text||'/';
  IF p_storage_path IS NULL OR position(v_prefix in p_storage_path)<>1 THEN RAISE EXCEPTION 'CCTV media must be stored under %',v_prefix;END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_import.organization_id::text||':'||p_evidence_kind||':'||v_hash,0));
  SELECT evidence.* INTO v_evidence FROM public.evidence_items evidence
  WHERE evidence.organization_id=v_import.organization_id AND evidence.evidence_kind=p_evidence_kind AND lower(evidence.sha256_hash)=v_hash
  ORDER BY evidence.captured_at,evidence.id LIMIT 1;
  IF v_evidence.id IS NOT NULL THEN
    INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_import.organization_id,v_actor,'cctv_media_duplicate_reused','evidence_items',v_evidence.id,jsonb_build_object('requested_import_id',p_import_id,'existing_import_id',v_evidence.cctv_import_id,'evidence_kind',p_evidence_kind,'sha256_prefix',left(v_hash,12)));
    RETURN jsonb_build_object('action','reuse','evidence_item_id',v_evidence.id,'cctv_import_id',v_evidence.cctv_import_id,'storage_path',v_evidence.storage_path,'file_name',v_evidence.metadata->>'file_name');
  END IF;
  SELECT * INTO v_claim FROM public.cctv_media_upload_claims WHERE organization_id=v_import.organization_id AND evidence_kind=p_evidence_kind AND sha256=v_hash FOR UPDATE;
  IF v_claim.id IS NULL THEN
    INSERT INTO public.cctv_media_upload_claims(organization_id,evidence_kind,sha256,cctv_import_id,storage_path,claimed_by)
    VALUES(v_import.organization_id,p_evidence_kind,v_hash,p_import_id,p_storage_path,v_actor) RETURNING * INTO v_claim;
    RETURN jsonb_build_object('action','upload','claim_id',v_claim.id);
  END IF;
  IF v_claim.status='registered' OR v_claim.expires_at<=clock_timestamp() THEN
    UPDATE public.cctv_media_upload_claims SET cctv_import_id=p_import_id,storage_path=p_storage_path,status='claimed',evidence_item_id=NULL,claimed_by=v_actor,claimed_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 minutes',registered_at=NULL WHERE id=v_claim.id RETURNING * INTO v_claim;
    RETURN jsonb_build_object('action','upload','claim_id',v_claim.id);
  END IF;
  IF v_claim.cctv_import_id=p_import_id AND v_claim.storage_path=p_storage_path AND v_claim.claimed_by=v_actor THEN RETURN jsonb_build_object('action','upload','claim_id',v_claim.id);END IF;
  RETURN jsonb_build_object('action','pending','claim_id',v_claim.id,'retry_after',v_claim.expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_duplicate_cctv_media_hash()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.evidence_kind NOT IN('video','photo') OR NEW.sha256_hash IS NULL THEN RETURN NEW;END IF;
  NEW.sha256_hash:=lower(trim(NEW.sha256_hash));
  IF NEW.sha256_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'CCTV media SHA-256 must be lowercase hexadecimal';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':'||NEW.evidence_kind||':'||NEW.sha256_hash,0));
  IF EXISTS(SELECT 1 FROM public.evidence_items evidence WHERE evidence.organization_id=NEW.organization_id AND evidence.evidence_kind=NEW.evidence_kind AND lower(evidence.sha256_hash)=NEW.sha256_hash AND evidence.id<>NEW.id) THEN RAISE EXCEPTION 'This CCTV media is already registered in FCM';END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS prevent_duplicate_cctv_media_hash ON public.evidence_items;
CREATE TRIGGER prevent_duplicate_cctv_media_hash BEFORE INSERT OR UPDATE OF organization_id,evidence_kind,sha256_hash ON public.evidence_items FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_cctv_media_hash();

CREATE OR REPLACE FUNCTION public.complete_cctv_media_upload_claim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.evidence_kind IN('video','photo') AND NEW.sha256_hash IS NOT NULL THEN
    UPDATE public.cctv_media_upload_claims SET status='registered',evidence_item_id=NEW.id,registered_at=clock_timestamp(),expires_at=clock_timestamp() WHERE organization_id=NEW.organization_id AND evidence_kind=NEW.evidence_kind AND sha256=lower(NEW.sha256_hash);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS complete_cctv_media_upload_claim ON public.evidence_items;
CREATE TRIGGER complete_cctv_media_upload_claim AFTER INSERT ON public.evidence_items FOR EACH ROW EXECUTE FUNCTION public.complete_cctv_media_upload_claim();

ALTER TABLE public.cctv_media_upload_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cctv_media_upload_claims FROM PUBLIC,anon,authenticated;
GRANT ALL ON TABLE public.cctv_media_upload_claims TO service_role;
REVOKE ALL ON FUNCTION public.find_existing_cctv_media_by_hash(uuid,text,text),public.prepare_cctv_media_upload(uuid,text,text,text),public.prevent_duplicate_cctv_media_hash(),public.complete_cctv_media_upload_claim() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.find_existing_cctv_media_by_hash(uuid,text,text),public.prepare_cctv_media_upload(uuid,text,text,text) TO authenticated,service_role;

COMMENT ON FUNCTION public.find_existing_cctv_media_by_hash(uuid,text,text) IS 'Tenant-scoped pre-review hash check. Returns only an existing evidence receipt and storage path, never media content.';
COMMENT ON FUNCTION public.prepare_cctv_media_upload(uuid,text,text,text) IS 'Atomically reuses existing CCTV evidence or reserves an organization/kind/hash before Desktop V2 uploads bytes.';

UPDATE public.cctv_imports import
SET status='draft',updated_at=clock_timestamp()
WHERE import.status='uploading' AND import.video_count=0 AND import.snapshot_count=0
  AND NOT EXISTS(SELECT 1 FROM public.evidence_items evidence WHERE evidence.cctv_import_id=import.id);
