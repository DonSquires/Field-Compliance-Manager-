-- CCTV enterprise inference (owner ruling 2026-11-01).
--
-- Engine v2 needs the database to do five things the live catalog cannot:
--   1. carry a human review decision forward when a clip is reprocessed, so a reviewer never re-decides the
--      same sighting and a rejected false positive never re-enters the queue;
--   2. group a parked vehicle that recurs in the same place on the same camera (resident object) instead of
--      minting a new portfolio for every clip;
--   3. govern the only permitted cloud inference (person-free, plate-masked vehicle crops) by per-organisation
--      opt-in with a receipt written before any crop leaves the platform;
--   4. let a reviewer report a sighting the engine missed, so recall is measured and not assumed;
--   5. report precision per entity kind, engine, detector and confidence band with an honest interval, so no
--      surface calls a band "calibrated" before enough human decisions exist.

-- Intersection over union of two {x, y, width, height} boxes; 0 when either box is unusable.
CREATE OR REPLACE FUNCTION public.cctv_bbox_iou(p_left jsonb, p_right jsonb)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
AS $function$
DECLARE
  lx double precision; ly double precision; lw double precision; lh double precision;
  rx double precision; ry double precision; rw double precision; rh double precision;
  overlap_w double precision; overlap_h double precision; intersection double precision;
BEGIN
  IF jsonb_typeof(p_left) IS DISTINCT FROM 'object' OR jsonb_typeof(p_right) IS DISTINCT FROM 'object' THEN RETURN 0; END IF;
  lx := (p_left->>'x')::double precision; ly := (p_left->>'y')::double precision;
  lw := (p_left->>'width')::double precision; lh := (p_left->>'height')::double precision;
  rx := (p_right->>'x')::double precision; ry := (p_right->>'y')::double precision;
  rw := (p_right->>'width')::double precision; rh := (p_right->>'height')::double precision;
  IF lx IS NULL OR ly IS NULL OR rx IS NULL OR ry IS NULL OR least(lw, lh, rw, rh) IS NULL OR least(lw, lh, rw, rh) <= 0 THEN RETURN 0; END IF;
  overlap_w := least(lx + lw, rx + rw) - greatest(lx, rx);
  overlap_h := least(ly + lh, ry + rh) - greatest(ly, ry);
  IF overlap_w <= 0 OR overlap_h <= 0 THEN RETURN 0; END IF;
  intersection := overlap_w * overlap_h;
  RETURN intersection / (lw * lh + rw * rh - intersection);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN 0;
END;
$function$;
COMMENT ON FUNCTION public.cctv_bbox_iou(jsonb, jsonb) IS 'Intersection over union of two CCTV {x,y,width,height} boxes. Returns 0 for missing or malformed boxes.';
REVOKE ALL ON FUNCTION public.cctv_bbox_iou(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cctv_bbox_iou(jsonb, jsonb) TO postgres, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 1. Per-organisation inference policy. Cloud inference is off unless an organisation administrator turns it
--    on with a reason; the worker reads this row and nothing else decides it.
CREATE TABLE IF NOT EXISTS public.cctv_inference_policies (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  cloud_vehicle_vlm_enabled boolean NOT NULL DEFAULT false,
  cloud_vehicle_vlm_model text,
  reason text,
  set_by uuid,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT cctv_inference_policies_model_check
    CHECK (cloud_vehicle_vlm_model IS NULL OR cloud_vehicle_vlm_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$'),
  CONSTRAINT cctv_inference_policies_reason_check
    CHECK (NOT cloud_vehicle_vlm_enabled OR nullif(trim(coalesce(reason, '')), '') IS NOT NULL)
);
COMMENT ON TABLE public.cctv_inference_policies IS 'Per-organisation CCTV inference governance. cloud_vehicle_vlm_enabled permits only person-free, plate-masked vehicle crops to a cloud vision model, each preceded by a cctv_cloud_inference_receipts row. Written only by set_cctv_inference_policy.';
ALTER TABLE public.cctv_inference_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_inference_policies_select ON public.cctv_inference_policies;
CREATE POLICY cctv_inference_policies_select ON public.cctv_inference_policies
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.cctv_inference_policies FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cctv_inference_policies TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_cctv_inference_policy(
  p_organization_id uuid,
  p_cloud_vehicle_vlm_enabled boolean,
  p_cloud_vehicle_vlm_model text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.cctv_inference_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.cctv_inference_policies%rowtype;
  v_previous public.cctv_inference_policies%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_model text := nullif(trim(coalesce(p_cloud_vehicle_vlm_model, '')), '');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT coalesce(public.is_admin_for_org(p_organization_id), false) THEN
    RAISE EXCEPTION 'Only an administrator of the organisation can set its CCTV inference policy';
  END IF;
  IF p_cloud_vehicle_vlm_enabled IS NULL THEN RAISE EXCEPTION 'Choose whether cloud vehicle hints are on or off'; END IF;
  IF p_cloud_vehicle_vlm_enabled AND v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to allow cloud vehicle hints';
  END IF;
  IF v_model IS NOT NULL AND v_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$' THEN
    RAISE EXCEPTION 'The cloud model name is not valid';
  END IF;
  SELECT * INTO v_previous FROM public.cctv_inference_policies WHERE organization_id = p_organization_id FOR UPDATE;
  INSERT INTO public.cctv_inference_policies (organization_id, cloud_vehicle_vlm_enabled, cloud_vehicle_vlm_model, reason, set_by, set_at)
  VALUES (p_organization_id, p_cloud_vehicle_vlm_enabled, v_model, v_reason, v_actor, clock_timestamp())
  ON CONFLICT (organization_id) DO UPDATE
    SET cloud_vehicle_vlm_enabled = EXCLUDED.cloud_vehicle_vlm_enabled,
        cloud_vehicle_vlm_model = EXCLUDED.cloud_vehicle_vlm_model,
        reason = EXCLUDED.reason,
        set_by = EXCLUDED.set_by,
        set_at = EXCLUDED.set_at
  RETURNING * INTO v_row;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'cctv_inference_policy_set', 'cctv_inference_policies', p_organization_id,
          jsonb_strip_nulls(jsonb_build_object(
            'cloud_vehicle_vlm_enabled', v_row.cloud_vehicle_vlm_enabled,
            'cloud_vehicle_vlm_model', v_row.cloud_vehicle_vlm_model,
            'previous_cloud_vehicle_vlm_enabled', v_previous.cloud_vehicle_vlm_enabled,
            'previous_cloud_vehicle_vlm_model', v_previous.cloud_vehicle_vlm_model,
            'reason', v_row.reason)));
  RETURN v_row;
END;
$function$;
COMMENT ON FUNCTION public.set_cctv_inference_policy(uuid, boolean, text, text) IS 'Organisation administrators only. Turns cloud vehicle make/model hints on (reason required) or off, and writes audit_log cctv_inference_policy_set.';
REVOKE ALL ON FUNCTION public.set_cctv_inference_policy(uuid, boolean, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_cctv_inference_policy(uuid, boolean, text, text) TO postgres, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Cloud inference receipts. Written by the worker before a crop is sent; a refused receipt means the crop
--    is never sent. The receipt records only the crop hash and the privacy checks, never the image.
CREATE TABLE IF NOT EXISTS public.cctv_cloud_inference_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id) ON DELETE RESTRICT,
  evidence_item_id uuid,
  source_event_id text,
  provider text NOT NULL CHECK (provider IN ('ollama_cloud')),
  purpose text NOT NULL CHECK (purpose IN ('vehicle_make_model_hint')),
  model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$'),
  crop_sha256 text NOT NULL CHECK (crop_sha256 ~ '^[0-9a-f]{64}$'),
  crop_bytes integer NOT NULL CHECK (crop_bytes BETWEEN 1 AND 10485760),
  plate_masked boolean NOT NULL CHECK (plate_masked),
  plate_boxes_masked integer NOT NULL CHECK (plate_boxes_masked >= 0),
  persons_excluded boolean NOT NULL CHECK (persons_excluded),
  policy_set_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS cctv_cloud_inference_receipts_org_idx
  ON public.cctv_cloud_inference_receipts (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cctv_cloud_inference_receipts_job_idx
  ON public.cctv_cloud_inference_receipts (inference_job_id);
COMMENT ON TABLE public.cctv_cloud_inference_receipts IS 'One row per vehicle crop sent to a cloud vision model, written before the send. Holds the crop hash and privacy checks (plates masked, no people), never the image. Written only by record_cctv_cloud_inference_receipt.';
ALTER TABLE public.cctv_cloud_inference_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_cloud_inference_receipts_select ON public.cctv_cloud_inference_receipts;
CREATE POLICY cctv_cloud_inference_receipts_select ON public.cctv_cloud_inference_receipts
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.cctv_cloud_inference_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cctv_cloud_inference_receipts TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_cctv_cloud_inference_receipt(p_job_id uuid, p_receipt jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job public.inference_jobs%rowtype;
  v_policy public.cctv_inference_policies%rowtype;
  v_model text;
  v_bytes integer;
  v_plate_boxes integer;
  v_id uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_receipt IS NULL OR jsonb_typeof(p_receipt) <> 'object' THEN RAISE EXCEPTION 'Cloud inference receipt must be a JSON object'; END IF;
  SELECT * INTO v_job FROM public.inference_jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Inference job is missing'; END IF;
  SELECT * INTO v_policy FROM public.cctv_inference_policies WHERE organization_id = v_job.organization_id;
  IF v_policy.cloud_vehicle_vlm_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'Cloud vehicle hints are not enabled for this organisation';
  END IF;
  IF p_receipt->>'provider' IS DISTINCT FROM 'ollama_cloud' THEN RAISE EXCEPTION 'Unsupported cloud inference provider'; END IF;
  IF p_receipt->>'purpose' IS DISTINCT FROM 'vehicle_make_model_hint' THEN RAISE EXCEPTION 'Unsupported cloud inference purpose'; END IF;
  IF p_receipt->'plate_masked' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Plates must be masked before a crop leaves the platform'; END IF;
  IF p_receipt->'persons_excluded' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'People must be excluded before a crop leaves the platform'; END IF;
  IF coalesce(p_receipt->>'crop_sha256', '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A SHA-256 crop hash is required'; END IF;
  v_model := nullif(trim(coalesce(p_receipt->>'model', '')), '');
  IF v_model IS NULL THEN RAISE EXCEPTION 'The cloud model is required'; END IF;
  IF v_policy.cloud_vehicle_vlm_model IS NOT NULL AND v_model <> v_policy.cloud_vehicle_vlm_model THEN
    RAISE EXCEPTION 'The cloud model is not the one this organisation allowed';
  END IF;
  IF jsonb_typeof(p_receipt->'crop_bytes') IS DISTINCT FROM 'number' OR jsonb_typeof(p_receipt->'plate_boxes_masked') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Crop size and masked plate count are required';
  END IF;
  v_bytes := (p_receipt->>'crop_bytes')::integer;
  v_plate_boxes := (p_receipt->>'plate_boxes_masked')::integer;
  INSERT INTO public.cctv_cloud_inference_receipts (
    organization_id, inference_job_id, evidence_item_id, source_event_id, provider, purpose, model,
    crop_sha256, crop_bytes, plate_masked, plate_boxes_masked, persons_excluded, policy_set_at
  ) VALUES (
    v_job.organization_id, v_job.id, v_job.evidence_item_id, left(nullif(p_receipt->>'source_event_id', ''), 200),
    'ollama_cloud', 'vehicle_make_model_hint', v_model, p_receipt->>'crop_sha256', v_bytes, true, v_plate_boxes, true,
    v_policy.set_at
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
COMMENT ON FUNCTION public.record_cctv_cloud_inference_receipt(uuid, jsonb) IS 'Service-only. Refuses unless the job organisation opted in, the model matches its policy, plates are masked and people excluded. The worker sends the crop only after this returns an id.';
REVOKE ALL ON FUNCTION public.record_cctv_cloud_inference_receipt(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_cctv_cloud_inference_receipt(uuid, jsonb) TO postgres, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Reprocessing keeps the human decision. A new unreviewed sighting that overlaps a reviewed one of the same
--    kind on the same footage (same time window, and the same place or the same plate) is superseded by it.
CREATE OR REPLACE FUNCTION public.reconcile_cctv_reviewed_observations(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new public.cctv_entity_observations%rowtype;
  v_reviewed public.cctv_entity_observations%rowtype;
  v_count integer := 0;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inference_jobs WHERE id = p_job_id) THEN
    RAISE EXCEPTION 'CCTV inference job is missing';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_job_id::text || ':reconcile-reviewed', 0));
  FOR v_new IN
    SELECT * FROM public.cctv_entity_observations
     WHERE inference_job_id = p_job_id AND review_state = 'unreviewed'
     ORDER BY observed_at, id
  LOOP
    v_reviewed.id := NULL;
    SELECT reviewed.* INTO v_reviewed
      FROM public.cctv_entity_observations reviewed
     WHERE reviewed.id <> v_new.id
       AND reviewed.organization_id = v_new.organization_id
       AND reviewed.evidence_item_id = v_new.evidence_item_id
       AND reviewed.entity_kind = v_new.entity_kind
       AND reviewed.review_state IN ('accepted', 'rejected')
       AND reviewed.observed_at <= coalesce(v_new.observed_to, v_new.observed_at) + interval '2 seconds'
       AND coalesce(reviewed.observed_to, reviewed.observed_at) >= v_new.observed_at - interval '2 seconds'
       AND (
         (v_new.candidate_plate IS NOT NULL AND reviewed.candidate_plate = v_new.candidate_plate)
         OR public.cctv_bbox_iou(reviewed.attributes->'bbox', v_new.attributes->'bbox') >= 0.3
         OR public.cctv_bbox_is_stationary(coalesce(reviewed.attributes->'last_bbox', reviewed.attributes->'bbox'), v_new.attributes->'bbox')
       )
     ORDER BY (v_new.candidate_plate IS NOT NULL AND reviewed.candidate_plate = v_new.candidate_plate) DESC,
              public.cctv_bbox_iou(reviewed.attributes->'bbox', v_new.attributes->'bbox') DESC,
              abs(extract(epoch FROM (reviewed.observed_at - v_new.observed_at))),
              reviewed.reviewed_at DESC NULLS LAST
     LIMIT 1;
    IF v_reviewed.id IS NULL THEN CONTINUE; END IF;
    UPDATE public.cctv_entity_observations
       SET review_state = 'superseded',
           review_notes = 'Reprocessed sighting; the human ' || v_reviewed.review_state || ' decision on observation ' || v_reviewed.id::text || ' stands',
           attributes = attributes || jsonb_build_object(
             'superseded_by_observation_id', v_reviewed.id,
             'human_decision_carried_from', v_reviewed.id,
             'carried_review_state', v_reviewed.review_state),
           portfolio_candidates = '[]'::jsonb,
           thumbnail = NULL
     WHERE id = v_new.id AND review_state = 'unreviewed';
    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;
  RETURN v_count;
END;
$function$;
COMMENT ON FUNCTION public.reconcile_cctv_reviewed_observations(uuid) IS 'Service-only, run after each CCTV job writes observations. Supersedes new unreviewed sightings that duplicate an accepted or rejected sighting of the same kind on the same footage (time overlap plus bbox IoU >= 0.3, stationary position, or the same plate). Reviewed rows are never changed.';
REVOKE ALL ON FUNCTION public.reconcile_cctv_reviewed_observations(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_cctv_reviewed_observations(uuid) TO postgres, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Resident objects: a vehicle parked in the same place on the same camera across clips.
CREATE TABLE IF NOT EXISTS public.cctv_resident_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  camera_key text NOT NULL,
  entity_kind text NOT NULL DEFAULT 'vehicle' CHECK (entity_kind IN ('vehicle')),
  bbox jsonb NOT NULL CHECK (jsonb_typeof(bbox) = 'object'),
  candidate_plate text,
  colour text,
  portfolio_key uuid NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  sighting_count integer NOT NULL DEFAULT 1 CHECK (sighting_count >= 1),
  anchor_observation_id uuid REFERENCES public.cctv_entity_observations(id) ON DELETE SET NULL,
  last_observation_id uuid REFERENCES public.cctv_entity_observations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX IF NOT EXISTS cctv_resident_objects_camera_idx
  ON public.cctv_resident_objects (organization_id, camera_key, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS cctv_entity_observations_resident_object_idx
  ON public.cctv_entity_observations ((attributes->>'resident_object_id'))
  WHERE attributes ? 'resident_object_id';
COMMENT ON TABLE public.cctv_resident_objects IS 'A stationary vehicle that recurs in the same position on the same camera. Its sightings share one provisional portfolio so a reviewer decides the parked car once. Written only by link_cctv_resident_vehicle_observations.';
ALTER TABLE public.cctv_resident_objects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_resident_objects_select ON public.cctv_resident_objects;
CREATE POLICY cctv_resident_objects_select ON public.cctv_resident_objects
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.cctv_resident_objects FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cctv_resident_objects TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.link_cctv_resident_vehicle_observations(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_obs public.cctv_entity_observations%rowtype;
  v_resident public.cctv_resident_objects%rowtype;
  v_camera text;
  v_colour text;
  v_end timestamptz;
  v_sightings integer;
  v_count integer := 0;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inference_jobs WHERE id = p_job_id) THEN
    RAISE EXCEPTION 'CCTV inference job is missing';
  END IF;
  FOR v_obs IN
    SELECT * FROM public.cctv_entity_observations
     WHERE inference_job_id = p_job_id
       AND entity_kind = 'vehicle'
       AND review_state = 'unreviewed'
       AND attributes->>'motion_state' = 'stationary'
       AND jsonb_typeof(attributes->'bbox') = 'object'
       AND NOT (attributes ? 'resident_object_id')
     ORDER BY observed_at, id
  LOOP
    SELECT coalesce(nullif(evidence.metadata->>'camera_key', ''), nullif(import.camera_key, ''))
      INTO v_camera
      FROM public.evidence_items evidence
      LEFT JOIN public.cctv_imports import ON import.id = v_obs.cctv_import_id
     WHERE evidence.id = v_obs.evidence_item_id;
    IF v_camera IS NULL THEN CONTINUE; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_obs.organization_id::text || ':' || v_camera || ':resident-object', 0));
    v_colour := nullif(lower(trim(coalesce(v_obs.attributes->>'colour', ''))), '');
    v_end := coalesce(v_obs.observed_to, v_obs.observed_at);
    v_resident.id := NULL;
    SELECT resident.* INTO v_resident
      FROM public.cctv_resident_objects resident
     WHERE resident.organization_id = v_obs.organization_id
       AND resident.camera_key = v_camera
       AND resident.last_seen_at >= v_obs.observed_at - interval '14 days'
       AND resident.first_seen_at <= v_end + interval '14 days'
       AND public.cctv_bbox_iou(resident.bbox, v_obs.attributes->'bbox') >= 0.6
       AND (resident.candidate_plate IS NULL OR v_obs.candidate_plate IS NULL OR resident.candidate_plate = v_obs.candidate_plate)
       AND (resident.colour IS NULL OR v_colour IS NULL OR resident.colour = v_colour)
     ORDER BY public.cctv_bbox_iou(resident.bbox, v_obs.attributes->'bbox') DESC, resident.last_seen_at DESC
     LIMIT 1
     FOR UPDATE;
    IF v_resident.id IS NULL THEN
      INSERT INTO public.cctv_resident_objects (
        organization_id, camera_key, bbox, candidate_plate, colour, portfolio_key,
        first_seen_at, last_seen_at, anchor_observation_id, last_observation_id
      ) VALUES (
        v_obs.organization_id, v_camera, v_obs.attributes->'bbox', v_obs.candidate_plate, v_colour,
        coalesce(v_obs.portfolio_key, gen_random_uuid()), v_obs.observed_at, v_end, v_obs.id, v_obs.id
      ) RETURNING * INTO v_resident;
      v_sightings := 1;
    ELSE
      -- Counted from the linked rows, not incremented, so reprocessing a clip cannot inflate the count.
      SELECT count(*) + 1 INTO v_sightings
        FROM public.cctv_entity_observations linked
       WHERE linked.organization_id = v_obs.organization_id
         AND linked.entity_kind = 'vehicle'
         AND linked.review_state <> 'superseded'
         AND linked.attributes->>'resident_object_id' = v_resident.id::text;
      UPDATE public.cctv_resident_objects
         SET first_seen_at = least(first_seen_at, v_obs.observed_at),
             last_seen_at = greatest(last_seen_at, v_end),
             candidate_plate = coalesce(candidate_plate, v_obs.candidate_plate),
             colour = coalesce(colour, v_colour),
             sighting_count = v_sightings,
             last_observation_id = v_obs.id,
             updated_at = clock_timestamp()
       WHERE id = v_resident.id
      RETURNING * INTO v_resident;
    END IF;
    UPDATE public.cctv_entity_observations
       SET portfolio_key = v_resident.portfolio_key,
           portfolio_state = CASE WHEN v_sightings > 1 AND portfolio_state = 'unmatched' THEN 'candidate' ELSE portfolio_state END,
           attributes = attributes || jsonb_strip_nulls(jsonb_build_object(
             'resident_object_id', v_resident.id,
             'resident_first_seen_at', v_resident.first_seen_at,
             'resident_sighting_count', v_sightings,
             'portfolio_key_before_resident_link', CASE WHEN portfolio_key IS DISTINCT FROM v_resident.portfolio_key THEN portfolio_key END))
     WHERE id = v_obs.id AND review_state = 'unreviewed';
    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;
  RETURN v_count;
END;
$function$;
COMMENT ON FUNCTION public.link_cctv_resident_vehicle_observations(uuid) IS 'Service-only, run after stationary coalescing. Links unreviewed stationary vehicle sightings to a resident object on the same camera (bbox IoU >= 0.6, compatible plate and colour, within 14 days) and gives them its provisional portfolio. Reviewed rows are never changed.';
REVOKE ALL ON FUNCTION public.link_cctv_resident_vehicle_observations(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_cctv_resident_vehicle_observations(uuid) TO postgres, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Missed-detection reports: the recall side of accuracy.
CREATE TABLE IF NOT EXISTS public.cctv_missed_detection_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  inference_job_id uuid REFERENCES public.inference_jobs(id) ON DELETE SET NULL,
  entity_kind text NOT NULL CHECK (entity_kind IN ('person', 'vehicle', 'animal')),
  offset_seconds numeric CHECK (offset_seconds IS NULL OR offset_seconds >= 0),
  observed_at timestamptz,
  bbox jsonb CHECK (bbox IS NULL OR jsonb_typeof(bbox) = 'object'),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  engine_version text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'confirmed_missed', 'not_missed')),
  reported_by uuid NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_notes text CHECK (resolution_notes IS NULL OR length(resolution_notes) <= 2000),
  CHECK (offset_seconds IS NOT NULL OR observed_at IS NOT NULL),
  CHECK ((state = 'open') = (resolved_at IS NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL))
);
CREATE INDEX IF NOT EXISTS cctv_missed_detection_reports_org_idx
  ON public.cctv_missed_detection_reports (organization_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS cctv_missed_detection_reports_evidence_idx
  ON public.cctv_missed_detection_reports (evidence_item_id);
COMMENT ON TABLE public.cctv_missed_detection_reports IS 'A reviewer-reported sighting the CCTV engine did not produce. Counts toward recall in cctv_accuracy_summary. Written only by report_cctv_missed_detection and resolved only by resolve_cctv_missed_detection.';
ALTER TABLE public.cctv_missed_detection_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_missed_detection_reports_select ON public.cctv_missed_detection_reports;
CREATE POLICY cctv_missed_detection_reports_select ON public.cctv_missed_detection_reports
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.cctv_missed_detection_reports FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cctv_missed_detection_reports TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.report_cctv_missed_detection(
  p_evidence_item_id uuid,
  p_entity_kind text,
  p_offset_seconds numeric DEFAULT NULL,
  p_observed_at timestamptz DEFAULT NULL,
  p_bbox jsonb DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_job uuid;
  v_engine text;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT organization_id INTO v_org FROM public.evidence_items WHERE id = p_evidence_item_id;
  IF v_org IS NULL OR NOT coalesce(public.org_access_allowed(v_org), false) THEN RAISE EXCEPTION 'CCTV review access denied'; END IF;
  IF p_entity_kind IS NULL OR p_entity_kind NOT IN ('person', 'vehicle', 'animal') THEN
    RAISE EXCEPTION 'Choose person, vehicle, or animal';
  END IF;
  IF p_offset_seconds IS NULL AND p_observed_at IS NULL THEN RAISE EXCEPTION 'Say when in the clip the sighting was missed'; END IF;
  IF p_offset_seconds IS NOT NULL AND p_offset_seconds < 0 THEN RAISE EXCEPTION 'The clip position cannot be negative'; END IF;
  IF p_bbox IS NOT NULL AND jsonb_typeof(p_bbox) <> 'object' THEN RAISE EXCEPTION 'The marked area must be a box'; END IF;
  SELECT job.id INTO v_job
    FROM public.inference_jobs job
   WHERE job.evidence_item_id = p_evidence_item_id AND job.organization_id = v_org AND job.domain = 'video_motion'
   ORDER BY job.created_at DESC
   LIMIT 1;
  IF v_job IS NOT NULL THEN
    SELECT result.result->'classification_plan'->'model_manifest'->>'engine_version' INTO v_engine
      FROM public.inference_results result
     WHERE result.inference_job_id = v_job
     ORDER BY result.created_at DESC
     LIMIT 1;
  END IF;
  INSERT INTO public.cctv_missed_detection_reports (
    organization_id, evidence_item_id, inference_job_id, entity_kind, offset_seconds, observed_at, bbox, notes,
    engine_version, reported_by
  ) VALUES (
    v_org, p_evidence_item_id, v_job, p_entity_kind, p_offset_seconds, p_observed_at, p_bbox,
    left(nullif(trim(coalesce(p_notes, '')), ''), 2000), coalesce(v_engine, 'legacy'), v_actor
  ) RETURNING id INTO v_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'cctv_missed_detection_reported', 'cctv_missed_detection_reports', v_id,
          jsonb_strip_nulls(jsonb_build_object('evidence_item_id', p_evidence_item_id, 'inference_job_id', v_job,
            'entity_kind', p_entity_kind, 'engine_version', coalesce(v_engine, 'legacy'))));
  RETURN v_id;
END;
$function$;
COMMENT ON FUNCTION public.report_cctv_missed_detection(uuid, text, numeric, timestamptz, jsonb, text) IS 'Any member with access to the footage reports a sighting the engine missed. Stamps the engine version that produced the latest result and writes audit_log cctv_missed_detection_reported.';
REVOKE ALL ON FUNCTION public.report_cctv_missed_detection(uuid, text, numeric, timestamptz, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.report_cctv_missed_detection(uuid, text, numeric, timestamptz, jsonb, text) TO postgres, authenticated, service_role;

-- An organisation administrator checks each report against the footage. Only a confirmed miss counts against
-- recall; a report found to be wrong is kept as not_missed so the history of the claim survives.
CREATE OR REPLACE FUNCTION public.resolve_cctv_missed_detection(p_report_id uuid, p_state text, p_notes text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_report public.cctv_missed_detection_reports%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_report FROM public.cctv_missed_detection_reports WHERE id = p_report_id FOR UPDATE;
  IF v_report.id IS NULL OR NOT coalesce(public.is_admin_for_org(v_report.organization_id), false) THEN
    RAISE EXCEPTION 'Only an organisation administrator can resolve a missed-detection report';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('confirmed_missed', 'not_missed') THEN
    RAISE EXCEPTION 'Resolve as confirmed_missed or not_missed';
  END IF;
  IF v_report.state <> 'open' THEN RAISE EXCEPTION 'This report was already resolved as %', v_report.state; END IF;
  UPDATE public.cctv_missed_detection_reports
     SET state = p_state,
         resolved_by = v_actor,
         resolved_at = clock_timestamp(),
         resolution_notes = left(nullif(trim(coalesce(p_notes, '')), ''), 2000)
   WHERE id = p_report_id AND state = 'open';
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_report.organization_id, v_actor, 'cctv_missed_detection_resolved', 'cctv_missed_detection_reports', p_report_id,
          jsonb_build_object('state', p_state, 'reported_by', v_report.reported_by, 'entity_kind', v_report.entity_kind,
            'engine_version', v_report.engine_version));
  RETURN p_state;
END;
$function$;
COMMENT ON FUNCTION public.resolve_cctv_missed_detection(uuid, text, text) IS 'An organisation administrator resolves an open missed-detection report as confirmed_missed or not_missed, once. Writes audit_log cctv_missed_detection_resolved.';
REVOKE ALL ON FUNCTION public.resolve_cctv_missed_detection(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_cctv_missed_detection(uuid, text, text) TO postgres, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 6. Accuracy summary: human decisions are the only ground truth. Precision uses the Wilson 95% lower bound;
--    a group is calibrated only once 30 decisions exist. Superseded duplicates are never counted twice.
CREATE OR REPLACE FUNCTION public.cctv_accuracy_summary(p_organization_id uuid, p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := coalesce(p_since, clock_timestamp() - interval '90 days');
  v_groups jsonb;
  v_missed jsonb;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR session_user IN ('postgres', 'supabase_admin')
          OR (auth.uid() IS NOT NULL AND coalesce(public.org_access_allowed(p_organization_id), false))) THEN
    RAISE EXCEPTION 'CCTV review access denied';
  END IF;
  WITH observed AS (
    SELECT o.entity_kind,
           coalesce(o.attributes->>'engine_version', 'legacy') AS engine_version,
           coalesce(o.attributes->>'detector_model', 'unreported') AS detector_model,
           coalesce(o.attributes->>'review_candidate_basis', 'unrecorded') AS review_basis,
           CASE
             WHEN o.model_confidence IS NULL THEN 'unknown'
             WHEN o.model_confidence < 0.5 THEN '0.00-0.49'
             WHEN o.model_confidence < 0.7 THEN '0.50-0.69'
             WHEN o.model_confidence < 0.85 THEN '0.70-0.84'
             ELSE '0.85-1.00'
           END AS confidence_band,
           o.review_state
      FROM public.cctv_entity_observations o
     WHERE o.organization_id = p_organization_id
       AND o.created_at >= v_since
       AND o.review_state <> 'superseded'
  ), grouped AS (
    SELECT entity_kind, engine_version, detector_model, review_basis, confidence_band,
           count(*) AS total,
           count(*) FILTER (WHERE review_state = 'accepted') AS accepted,
           count(*) FILTER (WHERE review_state = 'rejected') AS rejected,
           count(*) FILTER (WHERE review_state IN ('uncertain', 'needs_more_context')) AS inconclusive,
           count(*) FILTER (WHERE review_state = 'unreviewed') AS pending
      FROM observed
     GROUP BY entity_kind, engine_version, detector_model, review_basis, confidence_band
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'entity_kind', entity_kind,
           'engine_version', engine_version,
           'detector_model', detector_model,
           'review_basis', review_basis,
           'confidence_band', confidence_band,
           'total', total,
           'accepted', accepted,
           'rejected', rejected,
           'inconclusive', inconclusive,
           'pending', pending,
           'decided', accepted + rejected,
           'precision', CASE WHEN accepted + rejected > 0 THEN round(accepted::numeric / (accepted + rejected), 4) END,
           'precision_lower_bound', CASE WHEN accepted + rejected > 0 THEN round((
               (accepted::numeric / (accepted + rejected)) + 3.8416 / (2 * (accepted + rejected))
               - 1.96 * sqrt(((accepted::numeric / (accepted + rejected)) * (1 - accepted::numeric / (accepted + rejected))
                              + 3.8416 / (4 * (accepted + rejected))) / (accepted + rejected))
             ) / (1 + 3.8416 / (accepted + rejected)), 4) END,
           'calibrated', accepted + rejected >= 30
         ) ORDER BY entity_kind, engine_version, detector_model, review_basis, confidence_band), '[]'::jsonb)
    INTO v_groups
    FROM grouped;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'entity_kind', entity_kind,
           'engine_version', engine_version,
           'open', open,
           'confirmed_missed', confirmed_missed,
           'not_missed', not_missed
         ) ORDER BY entity_kind, engine_version), '[]'::jsonb)
    INTO v_missed
    FROM (
      SELECT entity_kind, coalesce(engine_version, 'legacy') AS engine_version,
             count(*) FILTER (WHERE state = 'open') AS open,
             count(*) FILTER (WHERE state = 'confirmed_missed') AS confirmed_missed,
             count(*) FILTER (WHERE state = 'not_missed') AS not_missed
        FROM public.cctv_missed_detection_reports
       WHERE organization_id = p_organization_id AND reported_at >= v_since
       GROUP BY entity_kind, coalesce(engine_version, 'legacy')
    ) missed;
  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'since', v_since,
    'calibration_minimum_decisions', 30,
    'groups', v_groups,
    'missed_detections', v_missed
  );
END;
$function$;
COMMENT ON FUNCTION public.cctv_accuracy_summary(uuid, timestamptz) IS 'Precision of CCTV sightings per entity kind, engine, detector, review basis and confidence band from human decisions only, with the Wilson 95% lower bound. A group is calibrated at 30 decisions. Includes reviewer-reported missed detections for recall.';
REVOKE ALL ON FUNCTION public.cctv_accuracy_summary(uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cctv_accuracy_summary(uuid, timestamptz) TO postgres, authenticated, service_role;
