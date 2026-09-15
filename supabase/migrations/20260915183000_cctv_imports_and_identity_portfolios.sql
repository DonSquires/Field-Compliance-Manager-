-- CCTV intake and identity portfolios (owner direction 2026-09-15; docs/canon/LOCATION_HOUSE_MODEL.md
-- for the place rules this leans on).
--
--   * cctv_imports: one row per camera folder / SD-card import, anchored to a registry place FIRST.
--     SD cards carry no GPS and a watermark is a hint, never the place. The place is the org's house
--     (locations) and optionally its site/zone facet; the registry identity is denormalised so
--     portfolios can be searched across organisations later.
--   * cctv_device_events: the camera's own motion timeline (TAPO snapshot filenames carry start/end
--     epochs) so the review console has activation marks before any inference has run.
--   * cctv_entity_observations joins the canonical spine (canonical_people / canonical_vehicles /
--     canonical_places), gains quality, species, appearance and vector columns, and a PORTFOLIO:
--     observations cluster provisionally by similarity (portfolio_key); identity is set only by a
--     human review action, and a first acceptance creates the canonical record when none exists.
--   * Nothing here writes identity from a model score alone (table comment kept: similarity remains
--     provisional until a human review link is accepted).

-- ───────────────────────────── 1. imports: place first ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.cctv_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  canonical_place_id uuid NOT NULL REFERENCES public.canonical_places(id) ON DELETE RESTRICT,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  zone_id uuid REFERENCES public.location_zones(id) ON DELETE RESTRICT,
  camera_label text NOT NULL CHECK (length(trim(camera_label)) BETWEEN 1 AND 120),
  camera_key text NOT NULL,
  source_device_kind text NOT NULL DEFAULT 'unknown'
    CHECK (source_device_kind IN ('tapo', 'dahua', 'hikvision', 'reolink', 'generic_folder', 'single_file', 'unknown')),
  source_timezone text NOT NULL DEFAULT 'Pacific/Auckland',
  source_root_label text,
  watermark_location_hint text,
  source_manifest jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_manifest) = 'array'),
  video_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  snapshot_count integer NOT NULL DEFAULT 0,
  bytes_total bigint NOT NULL DEFAULT 0,
  recorded_from timestamptz,
  recorded_to timestamptz,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'uploading', 'registered', 'processing', 'review_ready', 'archived', 'failed')),
  notes text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (recorded_to IS NULL OR recorded_from IS NULL OR recorded_to >= recorded_from)
);
COMMENT ON TABLE public.cctv_imports IS
  'One camera folder / SD-card import. Anchored to a house (locations) and its registry place before any file is accepted; the watermark text is a hint only.';
CREATE INDEX IF NOT EXISTS cctv_imports_org_idx ON public.cctv_imports (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cctv_imports_place_idx ON public.cctv_imports (canonical_place_id, recorded_from DESC);
CREATE INDEX IF NOT EXISTS cctv_imports_house_idx ON public.cctv_imports (location_id);

-- The import's place comes from the house; facets must be that house's own facets.
CREATE OR REPLACE FUNCTION public.tg_cctv_imports_place()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_house public.locations%rowtype; v_slug text;
BEGIN
  SELECT * INTO v_house FROM public.locations WHERE id = NEW.location_id;
  IF v_house.id IS NULL THEN RAISE EXCEPTION 'CCTV import needs an existing location house'; END IF;
  NEW.canonical_place_id := v_house.canonical_place_id;
  IF NEW.site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id = NEW.site_id AND s.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'CCTV import site is not a facet of the chosen house';
  END IF;
  IF NEW.zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.location_zones z WHERE z.id = NEW.zone_id AND z.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'CCTV import zone is not a facet of the chosen house';
  END IF;
  NEW.camera_label := trim(NEW.camera_label);
  v_slug := trim(both '-' from regexp_replace(lower(NEW.camera_label), '[^a-z0-9]+', '-', 'g'));
  NEW.camera_key := left(NEW.location_id::text, 8) || ':' || coalesce(nullif(v_slug, ''), 'camera');
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zz_cctv_imports_place ON public.cctv_imports;
CREATE TRIGGER zz_cctv_imports_place BEFORE INSERT OR UPDATE ON public.cctv_imports
  FOR EACH ROW EXECUTE FUNCTION public.tg_cctv_imports_place();

ALTER TABLE public.cctv_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_imports_select ON public.cctv_imports;
-- Visible to the operating organisation and to the organisation that holds the place (the harmed party reads).
CREATE POLICY cctv_imports_select ON public.cctv_imports FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id)
         OR EXISTS (SELECT 1 FROM public.locations l WHERE l.id = location_id AND public.org_access_allowed(l.organization_id)));
REVOKE ALL ON public.cctv_imports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cctv_imports TO authenticated;
GRANT ALL ON public.cctv_imports TO service_role;

ALTER TABLE public.evidence_items
  ADD COLUMN IF NOT EXISTS cctv_import_id uuid REFERENCES public.cctv_imports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS evidence_items_cctv_import_idx ON public.evidence_items (cctv_import_id) WHERE cctv_import_id IS NOT NULL;
-- One evidence row per source file inside an import (re-registering the same file is idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS evidence_items_cctv_import_source_ref_uq
  ON public.evidence_items (cctv_import_id, (metadata->>'source_ref')) WHERE cctv_import_id IS NOT NULL;

-- ───────────────────────────── 2. the camera's own timeline ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.cctv_device_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cctv_import_id uuid NOT NULL REFERENCES public.cctv_imports(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('device_snapshot', 'device_index', 'inference')),
  source_ref text NOT NULL,
  event_start_at timestamptz NOT NULL,
  event_end_at timestamptz,
  severity text NOT NULL DEFAULT 'motion' CHECK (severity IN ('motion', 'detection', 'alert')),
  thumbnail_path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (cctv_import_id, source, source_ref),
  CHECK (event_end_at IS NULL OR event_end_at >= event_start_at)
);
COMMENT ON TABLE public.cctv_device_events IS
  'Motion/activity intervals the camera itself recorded (snapshot or index files) or inference produced, per import. Timeline marks, not evidence.';
CREATE INDEX IF NOT EXISTS cctv_device_events_timeline_idx ON public.cctv_device_events (cctv_import_id, event_start_at);
ALTER TABLE public.cctv_device_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_device_events_select ON public.cctv_device_events;
CREATE POLICY cctv_device_events_select ON public.cctv_device_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cctv_imports i WHERE i.id = cctv_import_id));
REVOKE ALL ON public.cctv_device_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cctv_device_events TO authenticated;
GRANT ALL ON public.cctv_device_events TO service_role;

-- ───────────────────────────── 3. entity observations on the canonical spine ─────────────────────────────
ALTER TABLE public.cctv_entity_observations
  DROP CONSTRAINT IF EXISTS cctv_entity_observations_canonical_person_id_fkey,
  DROP CONSTRAINT IF EXISTS cctv_entity_observations_canonical_vehicle_id_fkey;
ALTER TABLE public.cctv_entity_observations
  ADD COLUMN IF NOT EXISTS person_record_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cctv_import_id uuid REFERENCES public.cctv_imports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS canonical_place_id uuid REFERENCES public.canonical_places(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quality_state text NOT NULL DEFAULT 'clear'
    CHECK (quality_state IN ('clear', 'glitch', 'flare', 'ir_switch', 'degraded', 'occluded')),
  ADD COLUMN IF NOT EXISTS species_confidence real CHECK (species_confidence IS NULL OR species_confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS is_pest boolean,
  ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  ADD COLUMN IF NOT EXISTS appearance_embedding jsonb CHECK (appearance_embedding IS NULL OR jsonb_typeof(appearance_embedding) = 'array'),
  ADD COLUMN IF NOT EXISTS face_vec public.vector(128),
  ADD COLUMN IF NOT EXISTS appearance_vec public.vector(256),
  ADD COLUMN IF NOT EXISTS portfolio_key uuid,
  ADD COLUMN IF NOT EXISTS portfolio_state text NOT NULL DEFAULT 'unmatched'
    CHECK (portfolio_state IN ('unmatched', 'candidate', 'linked', 'new_identity', 'rejected')),
  ADD COLUMN IF NOT EXISTS portfolio_candidates jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(portfolio_candidates) = 'array'),
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text;
ALTER TABLE public.cctv_entity_observations
  ADD CONSTRAINT cctv_entity_observations_canonical_person_id_fkey
    FOREIGN KEY (canonical_person_id) REFERENCES public.canonical_people(id) ON DELETE SET NULL,
  ADD CONSTRAINT cctv_entity_observations_canonical_vehicle_id_fkey
    FOREIGN KEY (canonical_vehicle_id) REFERENCES public.canonical_vehicles(id) ON DELETE SET NULL,
  ADD CONSTRAINT cctv_entity_observations_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES public.client_sites(id) ON DELETE SET NULL,
  ADD CONSTRAINT cctv_entity_observations_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES public.location_zones(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.cctv_entity_observations.animal_type IS 'Species label (NZ forestry pest list first: possum, stoat, ferret, weasel, rat, mouse, hedgehog, deer, pig, goat, cat, dog, rabbit, hare, wallaby, other).';
COMMENT ON COLUMN public.cctv_entity_observations.portfolio_key IS 'Provisional identity cluster: observations judged the same person/vehicle by similarity. A human review action turns a portfolio into a canonical identity.';
COMMENT ON COLUMN public.cctv_entity_observations.attributes IS 'Model attributes: vehicle make/model/colour/body_type, plate_confidence, bbox, track_id, body/clothing descriptors.';
CREATE INDEX IF NOT EXISTS cctv_entity_observations_face_vec_idx
  ON public.cctv_entity_observations USING hnsw (face_vec public.vector_cosine_ops) WHERE face_vec IS NOT NULL;
CREATE INDEX IF NOT EXISTS cctv_entity_observations_appearance_vec_idx
  ON public.cctv_entity_observations USING hnsw (appearance_vec public.vector_cosine_ops) WHERE appearance_vec IS NOT NULL;
CREATE INDEX IF NOT EXISTS cctv_entity_observations_portfolio_idx
  ON public.cctv_entity_observations (portfolio_key, observed_at DESC) WHERE portfolio_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS cctv_entity_observations_import_idx
  ON public.cctv_entity_observations (cctv_import_id, observed_at) WHERE cctv_import_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cctv_entity_observations_registry_idx
  ON public.cctv_entity_observations (canonical_place_id, observed_at DESC) WHERE canonical_place_id IS NOT NULL;

-- A model embedding (JSON number array) becomes a vector only when it has the dimensions we index.
CREATE OR REPLACE FUNCTION public.cctv_jsonb_to_vector(p_embedding jsonb, p_dims integer)
RETURNS public.vector LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
BEGIN
  IF p_embedding IS NULL OR jsonb_typeof(p_embedding) <> 'array' OR jsonb_array_length(p_embedding) <> p_dims THEN RETURN NULL; END IF;
  SELECT array_agg(t.x::real ORDER BY t.ord) INTO v_arr FROM jsonb_array_elements_text(p_embedding) WITH ORDINALITY AS t(x, ord);
  RETURN v_arr::public.vector;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

-- ───────────────────────────── 4. portfolio matching ─────────────────────────────
-- Same-or-similar search across the organisation's CCTV history: face (128-d), appearance (256-d,
-- person body or vehicle), plate (exact after normalisation, else trigram similarity for blurred or
-- partial reads). Thresholds: face 0.65, appearance 0.70, plate 0.60. Callable by the worker
-- (service role) and by a reviewer inside the organisation.
CREATE OR REPLACE FUNCTION public.find_cctv_portfolio_matches(
  p_organization_id uuid, p_entity_kind text,
  p_face_embedding jsonb DEFAULT NULL, p_appearance_embedding jsonb DEFAULT NULL, p_plate text DEFAULT NULL,
  p_exclude_observation_id uuid DEFAULT NULL, p_limit integer DEFAULT 10)
RETURNS TABLE(match_kind text, match_id uuid, observation_id uuid, portfolio_key uuid, display_name text, score real, basis text,
              last_seen_at timestamptz, canonical_place_id uuid, plate_number text, person_record_id uuid, canonical_vehicle_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_face public.vector; v_app public.vector; v_plate text; v_n integer := greatest(coalesce(p_limit, 10), 1);
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin')
     AND (auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id)) THEN
    RAISE EXCEPTION 'CCTV portfolio access denied';
  END IF;
  IF p_entity_kind NOT IN ('person', 'vehicle', 'animal') THEN RAISE EXCEPTION 'Unknown entity kind %', p_entity_kind; END IF;
  v_face := public.cctv_jsonb_to_vector(p_face_embedding, 128);
  v_app := public.cctv_jsonb_to_vector(p_appearance_embedding, 256);
  v_plate := public.normalize_plate_number(p_plate);
  RETURN QUERY
  WITH face_hits AS (
    SELECT 'observation'::text AS match_kind, o.id AS match_id, o.id AS observation_id, o.portfolio_key,
           coalesce(pr.display_name, o.candidate_label)::text AS display_name,
           (1 - (o.face_vec <=> v_face))::real AS score, 'face'::text AS basis, o.observed_at AS last_seen_at,
           o.canonical_place_id, o.candidate_plate::text AS plate_number, o.person_record_id, o.canonical_vehicle_id
    FROM public.cctv_entity_observations o
    LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
    WHERE v_face IS NOT NULL AND p_entity_kind = 'person'
      AND o.organization_id = p_organization_id AND o.entity_kind = 'person' AND o.face_vec IS NOT NULL
      AND o.review_state <> 'rejected' AND (p_exclude_observation_id IS NULL OR o.id <> p_exclude_observation_id)
    ORDER BY o.face_vec <=> v_face
    LIMIT v_n * 3
  ), legacy_face_hits AS (
    SELECT 'person_record'::text, fo.person_record_id, NULL::uuid, NULL::uuid, pr.display_name::text,
           public.face_embedding_cosine(fo.metadata->'embedding', p_face_embedding)::real, 'face_legacy'::text, fo.created_at,
           NULL::uuid, NULL::text, fo.person_record_id, NULL::uuid
    FROM public.face_observations fo
    JOIN public.person_records pr ON pr.id = fo.person_record_id
    WHERE p_face_embedding IS NOT NULL AND p_entity_kind = 'person'
      AND fo.organization_id = p_organization_id AND fo.metadata ? 'embedding'
  ), appearance_hits AS (
    SELECT 'observation'::text, o.id, o.id, o.portfolio_key,
           coalesce(cv.plate_number, pr.display_name, o.candidate_label)::text,
           (1 - (o.appearance_vec <=> v_app))::real, 'appearance'::text, o.observed_at,
           o.canonical_place_id, coalesce(cv.plate_number, o.candidate_plate)::text, o.person_record_id, o.canonical_vehicle_id
    FROM public.cctv_entity_observations o
    LEFT JOIN public.canonical_vehicles cv ON cv.id = o.canonical_vehicle_id
    LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
    WHERE v_app IS NOT NULL
      AND o.organization_id = p_organization_id AND o.entity_kind = p_entity_kind AND o.appearance_vec IS NOT NULL
      AND o.review_state <> 'rejected' AND (p_exclude_observation_id IS NULL OR o.id <> p_exclude_observation_id)
    ORDER BY o.appearance_vec <=> v_app
    LIMIT v_n * 3
  ), plate_hits AS (
    SELECT 'canonical_vehicle'::text, cv.id, NULL::uuid, NULL::uuid,
           concat_ws(' ', cv.plate_number, cv.make, cv.model, cv.colour)::text,
           (CASE WHEN cv.plate_number = v_plate THEN 1.0 ELSE extensions.similarity(cv.plate_number, v_plate) END)::real,
           (CASE WHEN cv.plate_number = v_plate THEN 'plate_exact' ELSE 'plate_similar' END)::text, cv.last_seen_at,
           NULL::uuid, cv.plate_number::text, NULL::uuid, cv.id
    FROM public.canonical_vehicles cv
    WHERE v_plate IS NOT NULL AND p_entity_kind = 'vehicle'
      AND (cv.plate_number = v_plate OR extensions.similarity(cv.plate_number, v_plate) >= 0.6)
    ORDER BY (cv.plate_number = v_plate) DESC, extensions.similarity(cv.plate_number, v_plate) DESC
    LIMIT v_n
  ), all_hits AS (
    SELECT * FROM face_hits UNION ALL SELECT * FROM legacy_face_hits
    UNION ALL SELECT * FROM appearance_hits UNION ALL SELECT * FROM plate_hits
  )
  SELECT h.match_kind, h.match_id, h.observation_id, h.portfolio_key, h.display_name, h.score, h.basis,
         h.last_seen_at, h.canonical_place_id, h.plate_number, h.person_record_id, h.canonical_vehicle_id
  FROM all_hits h
  WHERE h.score >= CASE h.basis WHEN 'face' THEN 0.65 WHEN 'face_legacy' THEN 0.65 WHEN 'appearance' THEN 0.70 ELSE 0.60 END
  ORDER BY h.score DESC, h.last_seen_at DESC NULLS LAST
  LIMIT v_n;
END $$;
REVOKE ALL ON FUNCTION public.find_cctv_portfolio_matches(uuid, text, jsonb, jsonb, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_cctv_portfolio_matches(uuid, text, jsonb, jsonb, text, uuid, integer) TO authenticated, service_role;

-- ───────────────────────────── 5. worker write: one observation per tracked entity ─────────────────────────────
-- Payload item keys: source_event_id, entity_kind (person|vehicle|animal), observed_at, observed_to,
-- candidate_label, candidate_plate, animal_type, species_confidence, is_pest, candidate_embedding (face),
-- appearance_embedding, model_confidence, quality_state, attributes (object), frame_sha256, thumbnail.
-- Place is inherited from the import behind the evidence. Portfolio: the best same-kind hit at or above
-- the auto-cluster threshold (face 0.72 / appearance 0.80) lends its portfolio_key; otherwise a new key.
-- Re-running a job refreshes model fields only while a row is still unreviewed.
CREATE OR REPLACE FUNCTION public.record_cctv_entity_observations(p_job_id uuid, p_evidence_id uuid, p_organization_id uuid, p_observations jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  observation jsonb; saved_count integer := 0; v_id uuid; v_kind text;
  v_import public.cctv_imports%rowtype; v_import_id uuid;
  v_face public.vector; v_app public.vector; v_candidates jsonb; v_key uuid; v_best_key uuid; v_best_score real; v_state text;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF jsonb_typeof(p_observations) <> 'array' THEN
    RAISE EXCEPTION 'CCTV entity observations must be an array';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
    WHERE id = p_job_id AND evidence_item_id = p_evidence_id
      AND organization_id = p_organization_id AND domain = 'video_motion'
  ) THEN
    RAISE EXCEPTION 'CCTV inference job is missing or outside the organization';
  END IF;
  SELECT e.cctv_import_id INTO v_import_id FROM public.evidence_items e WHERE e.id = p_evidence_id;
  IF v_import_id IS NOT NULL THEN SELECT * INTO v_import FROM public.cctv_imports WHERE id = v_import_id; END IF;

  FOR observation IN SELECT value FROM jsonb_array_elements(p_observations)
  LOOP
    v_kind := observation->>'entity_kind';
    IF v_kind NOT IN ('person', 'vehicle', 'animal')
       OR NULLIF(observation->>'source_event_id', '') IS NULL
       OR NULLIF(observation->>'observed_at', '') IS NULL THEN
      CONTINUE;
    END IF;
    v_face := CASE WHEN v_kind = 'person' THEN public.cctv_jsonb_to_vector(observation->'candidate_embedding', 128) END;
    v_app := public.cctv_jsonb_to_vector(observation->'appearance_embedding', 256);
    v_id := NULL;

    INSERT INTO public.cctv_entity_observations (
      organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind,
      observed_at, observed_to, cctv_import_id, location_id, canonical_place_id, site_id, zone_id,
      candidate_label, candidate_plate, animal_type, species_confidence, is_pest,
      candidate_embedding, appearance_embedding, face_vec, appearance_vec,
      model_confidence, quality_state, attributes, frame_sha256, thumbnail
    ) VALUES (
      p_organization_id, p_job_id, p_evidence_id, observation->>'source_event_id', v_kind,
      (observation->>'observed_at')::timestamptz, NULLIF(observation->>'observed_to', '')::timestamptz,
      v_import.id, v_import.location_id, v_import.canonical_place_id,
      coalesce(v_import.site_id, NULLIF(observation->>'site_id', '')::uuid), coalesce(v_import.zone_id, NULLIF(observation->>'zone_id', '')::uuid),
      NULLIF(observation->>'candidate_label', ''), NULLIF(public.normalize_plate_number(observation->>'candidate_plate'), ''),
      NULLIF(lower(observation->>'animal_type'), ''), NULLIF(observation->>'species_confidence', '')::real,
      CASE WHEN observation ? 'is_pest' THEN (observation->>'is_pest')::boolean END,
      CASE WHEN jsonb_typeof(observation->'candidate_embedding') = 'array' THEN observation->'candidate_embedding' END,
      CASE WHEN jsonb_typeof(observation->'appearance_embedding') = 'array' THEN observation->'appearance_embedding' END,
      v_face, v_app,
      NULLIF(observation->>'model_confidence', '')::real,
      CASE WHEN observation->>'quality_state' IN ('clear', 'glitch', 'flare', 'ir_switch', 'degraded', 'occluded') THEN observation->>'quality_state' ELSE 'clear' END,
      CASE WHEN jsonb_typeof(observation->'attributes') = 'object' THEN observation->'attributes' ELSE '{}'::jsonb END,
      NULLIF(observation->>'frame_sha256', ''),
      CASE WHEN observation->>'thumbnail' LIKE 'data:image/%' THEN observation->>'thumbnail' ELSE NULL END
    )
    ON CONFLICT (inference_job_id, source_event_id, entity_kind) DO UPDATE SET
      observed_to = EXCLUDED.observed_to, candidate_label = EXCLUDED.candidate_label, candidate_plate = EXCLUDED.candidate_plate,
      animal_type = EXCLUDED.animal_type, species_confidence = EXCLUDED.species_confidence, is_pest = EXCLUDED.is_pest,
      candidate_embedding = EXCLUDED.candidate_embedding, appearance_embedding = EXCLUDED.appearance_embedding,
      face_vec = EXCLUDED.face_vec, appearance_vec = EXCLUDED.appearance_vec, model_confidence = EXCLUDED.model_confidence,
      quality_state = EXCLUDED.quality_state, attributes = EXCLUDED.attributes, frame_sha256 = EXCLUDED.frame_sha256,
      thumbnail = EXCLUDED.thumbnail
    WHERE cctv_entity_observations.review_state = 'unreviewed'
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN CONTINUE; END IF;
    saved_count := saved_count + 1;

    -- Portfolio: candidates for the reviewer, and a provisional cluster key.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'match_kind', m.match_kind, 'match_id', m.match_id, 'observation_id', m.observation_id, 'portfolio_key', m.portfolio_key,
             'display_name', m.display_name, 'score', m.score, 'basis', m.basis, 'last_seen_at', m.last_seen_at,
             'plate_number', m.plate_number, 'person_record_id', m.person_record_id, 'canonical_vehicle_id', m.canonical_vehicle_id)
             ORDER BY m.score DESC), '[]'::jsonb)
      INTO v_candidates
    FROM public.find_cctv_portfolio_matches(p_organization_id, v_kind, observation->'candidate_embedding', observation->'appearance_embedding',
                                            observation->>'candidate_plate', v_id, 5) m;
    SELECT m.portfolio_key, m.score INTO v_best_key, v_best_score
    FROM public.find_cctv_portfolio_matches(p_organization_id, v_kind, observation->'candidate_embedding', observation->'appearance_embedding',
                                            NULL, v_id, 5) m
    WHERE m.match_kind = 'observation' AND m.portfolio_key IS NOT NULL
      AND m.score >= CASE m.basis WHEN 'face' THEN 0.72 ELSE 0.80 END
    ORDER BY m.score DESC LIMIT 1;
    v_key := coalesce(v_best_key, gen_random_uuid());
    v_state := CASE WHEN jsonb_array_length(v_candidates) > 0 THEN 'candidate' ELSE 'unmatched' END;
    UPDATE public.cctv_entity_observations
       SET portfolio_candidates = v_candidates,
           portfolio_key = coalesce(portfolio_key, v_key),
           portfolio_state = CASE WHEN portfolio_state IN ('linked', 'new_identity', 'rejected') THEN portfolio_state ELSE v_state END
     WHERE id = v_id;
  END LOOP;
  RETURN saved_count;
END $$;
REVOKE ALL ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) TO service_role;

-- ───────────────────────────── 6. human review: identity is a decision ─────────────────────────────
-- accept | reject | link_person | new_person | link_vehicle | new_vehicle | merge_portfolio | accept_portfolio.
-- First acceptance creates the canonical record when none exists (vehicle by plate; person via a
-- person_records row and ensure_canonical_person_for_record). A plate-less vehicle stays a portfolio
-- until a plate is read; canonical_vehicles requires a plate.
CREATE OR REPLACE FUNCTION public.review_cctv_entity_observation(
  p_observation_id uuid, p_action text, p_target_id uuid DEFAULT NULL, p_display_name text DEFAULT NULL,
  p_plate text DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS public.cctv_entity_observations LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid(); v_obs public.cctv_entity_observations%rowtype; v_person uuid; v_vehicle uuid;
  v_plate text; v_target public.cctv_entity_observations%rowtype; v_n integer := 0;
BEGIN
  SELECT * INTO v_obs FROM public.cctv_entity_observations WHERE id = p_observation_id FOR UPDATE;
  IF v_obs.id IS NULL THEN RAISE EXCEPTION 'CCTV observation not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_obs.organization_id) THEN RAISE EXCEPTION 'CCTV review access denied'; END IF;
  IF p_action NOT IN ('accept', 'reject', 'link_person', 'new_person', 'link_vehicle', 'new_vehicle', 'merge_portfolio', 'accept_portfolio') THEN
    RAISE EXCEPTION 'Unsupported CCTV review action %', p_action;
  END IF;

  IF p_action = 'reject' THEN
    UPDATE public.cctv_entity_observations
       SET review_state = 'rejected', portfolio_state = 'rejected', reviewed_by = v_actor, reviewed_at = clock_timestamp(),
           review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'link_person' THEN
    IF v_obs.entity_kind <> 'person' THEN RAISE EXCEPTION 'Only a person observation can be linked to a person'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.person_records pr WHERE pr.id = p_target_id AND pr.organization_id = v_obs.organization_id) THEN
      RAISE EXCEPTION 'Person record is outside the organization';
    END IF;
    UPDATE public.cctv_entity_observations
       SET person_record_id = p_target_id, canonical_person_id = public.ensure_canonical_person_for_record(p_target_id),
           review_state = 'accepted', portfolio_state = 'linked', reviewed_by = v_actor, reviewed_at = clock_timestamp(),
           review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'new_person' THEN
    IF v_obs.entity_kind <> 'person' THEN RAISE EXCEPTION 'Only a person observation can create a person'; END IF;
    IF nullif(trim(coalesce(p_display_name, '')), '') IS NULL THEN RAISE EXCEPTION 'A display name is required for a new person'; END IF;
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (v_obs.organization_id, trim(p_display_name), 'draft',
            jsonb_build_object('created_from', 'cctv_entity_observation', 'observation_id', v_obs.id, 'created_by', v_actor))
    RETURNING id INTO v_person;
    UPDATE public.cctv_entity_observations
       SET person_record_id = v_person, canonical_person_id = public.ensure_canonical_person_for_record(v_person),
           review_state = 'accepted', portfolio_state = 'new_identity', reviewed_by = v_actor, reviewed_at = clock_timestamp(),
           review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'link_vehicle' THEN
    IF v_obs.entity_kind <> 'vehicle' THEN RAISE EXCEPTION 'Only a vehicle observation can be linked to a vehicle'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.canonical_vehicles cv WHERE cv.id = p_target_id) THEN RAISE EXCEPTION 'Canonical vehicle not found'; END IF;
    UPDATE public.cctv_entity_observations
       SET canonical_vehicle_id = p_target_id, review_state = 'accepted', portfolio_state = 'linked',
           reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;
    INSERT INTO public.canonical_vehicle_links (canonical_vehicle_id, source_system, source_table, source_key, metadata)
    VALUES (p_target_id, 'cctv_review', 'cctv_entity_observations', v_obs.id::text, jsonb_build_object('linked_by', v_actor, 'observed_at', v_obs.observed_at))
    ON CONFLICT (source_system, source_table, source_key) DO NOTHING;

  ELSIF p_action IN ('new_vehicle', 'accept') AND v_obs.entity_kind = 'vehicle' AND NULLIF(public.normalize_plate_number(coalesce(p_plate, v_obs.candidate_plate)), '') IS NOT NULL THEN
    v_plate := public.normalize_plate_number(coalesce(p_plate, v_obs.candidate_plate));
    v_vehicle := public.ensure_canonical_vehicle(v_plate, v_obs.attributes->>'make', v_obs.attributes->>'model', v_obs.attributes->>'colour',
                                                 'cctv_entity_observations', v_obs.id::text, v_obs.observed_at);
    IF v_vehicle IS NULL THEN RAISE EXCEPTION 'Plate % is not a valid vehicle identity', v_plate; END IF;
    UPDATE public.cctv_entity_observations
       SET candidate_plate = v_plate, canonical_vehicle_id = v_vehicle, review_state = 'accepted',
           portfolio_state = CASE WHEN p_action = 'new_vehicle' THEN 'new_identity' ELSE 'linked' END,
           reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'new_vehicle' THEN
    RAISE EXCEPTION 'A readable plate is required to create a vehicle; keep it in its portfolio until one is read';

  ELSIF p_action = 'accept' THEN
    UPDATE public.cctv_entity_observations
       SET review_state = 'accepted', reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'merge_portfolio' THEN
    SELECT * INTO v_target FROM public.cctv_entity_observations WHERE id = p_target_id AND organization_id = v_obs.organization_id;
    IF v_target.id IS NULL OR v_target.entity_kind <> v_obs.entity_kind THEN RAISE EXCEPTION 'Merge target must be an observation of the same kind in the organization'; END IF;
    IF v_target.portfolio_key IS NULL THEN
      UPDATE public.cctv_entity_observations SET portfolio_key = gen_random_uuid() WHERE id = v_target.id RETURNING * INTO v_target;
    END IF;
    UPDATE public.cctv_entity_observations
       SET portfolio_key = v_target.portfolio_key,
           portfolio_state = CASE WHEN portfolio_state IN ('linked', 'new_identity', 'rejected') THEN portfolio_state ELSE 'candidate' END
     WHERE organization_id = v_obs.organization_id AND (portfolio_key = v_obs.portfolio_key OR id = v_obs.id);
    SELECT * INTO v_obs FROM public.cctv_entity_observations WHERE id = v_obs.id;

  ELSIF p_action = 'accept_portfolio' THEN
    IF v_obs.person_record_id IS NULL AND v_obs.canonical_vehicle_id IS NULL THEN
      RAISE EXCEPTION 'Link this observation to an identity before applying it to its portfolio';
    END IF;
    UPDATE public.cctv_entity_observations o
       SET person_record_id = v_obs.person_record_id, canonical_person_id = v_obs.canonical_person_id,
           canonical_vehicle_id = v_obs.canonical_vehicle_id, candidate_plate = coalesce(o.candidate_plate, v_obs.candidate_plate),
           review_state = 'accepted', portfolio_state = 'linked', reviewed_by = v_actor, reviewed_at = clock_timestamp(),
           review_notes = coalesce(nullif(trim(p_notes), ''), 'Accepted with portfolio ' || v_obs.portfolio_key::text)
     WHERE o.organization_id = v_obs.organization_id AND o.portfolio_key = v_obs.portfolio_key
       AND o.id <> v_obs.id AND o.review_state = 'unreviewed';
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_obs.organization_id, v_actor, 'cctv_entity_observation_' || p_action, 'cctv_entity_observations', v_obs.id,
          jsonb_strip_nulls(jsonb_build_object('entity_kind', v_obs.entity_kind, 'target_id', p_target_id, 'plate', v_plate,
            'person_record_id', v_obs.person_record_id, 'canonical_vehicle_id', v_obs.canonical_vehicle_id,
            'portfolio_key', v_obs.portfolio_key, 'portfolio_rows_updated', nullif(v_n, 0))));
  RETURN v_obs;
END $$;
REVOKE ALL ON FUNCTION public.review_cctv_entity_observation(uuid, text, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_cctv_entity_observation(uuid, text, uuid, text, text, text) TO authenticated, service_role;

-- ───────────────────────────── 7. intake RPCs (browser path) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.create_cctv_import(
  p_organization_id uuid, p_location_id uuid, p_camera_label text,
  p_site_id uuid DEFAULT NULL, p_zone_id uuid DEFAULT NULL, p_source_device_kind text DEFAULT 'unknown',
  p_source_timezone text DEFAULT 'Pacific/Auckland', p_source_root_label text DEFAULT NULL,
  p_watermark_location_hint text DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS public.cctv_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_house_org uuid; v_row public.cctv_imports%rowtype; v_tz_probe timestamp;
BEGIN
  IF v_actor IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN RAISE EXCEPTION 'CCTV import access denied'; END IF;
  SELECT organization_id INTO v_house_org FROM public.locations WHERE id = p_location_id;
  IF v_house_org IS NULL THEN RAISE EXCEPTION 'Choose the location before importing camera files'; END IF;
  IF NOT public.org_access_allowed(v_house_org) THEN RAISE EXCEPTION 'No access to the chosen location'; END IF;
  BEGIN
    v_tz_probe := now() AT TIME ZONE coalesce(p_source_timezone, 'Pacific/Auckland');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Unknown time zone %', p_source_timezone;
  END;
  INSERT INTO public.cctv_imports (organization_id, location_id, canonical_place_id, site_id, zone_id, camera_label, camera_key,
                                   source_device_kind, source_timezone, source_root_label, watermark_location_hint, notes, created_by)
  SELECT p_organization_id, p_location_id, l.canonical_place_id, p_site_id, p_zone_id, p_camera_label, 'pending',
         coalesce(nullif(p_source_device_kind, ''), 'unknown'), coalesce(nullif(p_source_timezone, ''), 'Pacific/Auckland'),
         nullif(trim(p_source_root_label), ''), nullif(trim(p_watermark_location_hint), ''), nullif(trim(p_notes), ''),
         (SELECT up.id FROM public.user_profiles up WHERE up.id = v_actor)
  FROM public.locations l WHERE l.id = p_location_id
  RETURNING * INTO v_row;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'cctv_import_created', 'cctv_imports', v_row.id,
          jsonb_build_object('location_id', p_location_id, 'canonical_place_id', v_row.canonical_place_id, 'camera_key', v_row.camera_key, 'device', v_row.source_device_kind));
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION public.create_cctv_import(uuid, uuid, text, uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_cctv_import(uuid, uuid, text, uuid, uuid, text, text, text, text, text) TO authenticated, service_role;

-- Manifest item keys: name, relative_path, size_bytes, kind (video|skipped_empty|snapshot|index|other), skip_reason,
-- sha256, slot_start_at, slot_end_at. Counts are derived from it; the caller never writes counts.
CREATE OR REPLACE FUNCTION public.set_cctv_import_manifest(p_import_id uuid, p_manifest jsonb, p_status text DEFAULT NULL)
RETURNS public.cctv_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.cctv_imports%rowtype;
BEGIN
  SELECT * INTO v_row FROM public.cctv_imports WHERE id = p_import_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_row.organization_id) THEN RAISE EXCEPTION 'CCTV import access denied'; END IF;
  IF jsonb_typeof(p_manifest) <> 'array' THEN RAISE EXCEPTION 'Manifest must be an array'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('draft', 'uploading', 'registered', 'processing', 'review_ready', 'archived', 'failed') THEN
    RAISE EXCEPTION 'Unknown import status %', p_status;
  END IF;
  UPDATE public.cctv_imports SET
    source_manifest = p_manifest,
    video_count = (SELECT count(*) FROM jsonb_array_elements(p_manifest) f WHERE f->>'kind' = 'video'),
    skipped_count = (SELECT count(*) FROM jsonb_array_elements(p_manifest) f WHERE f->>'kind' = 'skipped_empty'),
    snapshot_count = (SELECT count(*) FROM jsonb_array_elements(p_manifest) f WHERE f->>'kind' = 'snapshot'),
    bytes_total = (SELECT coalesce(sum((f->>'size_bytes')::bigint), 0) FROM jsonb_array_elements(p_manifest) f WHERE f->>'kind' IN ('video', 'snapshot')),
    recorded_from = (SELECT min((f->>'slot_start_at')::timestamptz) FROM jsonb_array_elements(p_manifest) f WHERE f->>'kind' = 'video' AND nullif(f->>'slot_start_at', '') IS NOT NULL),
    recorded_to = (SELECT max(coalesce((f->>'slot_end_at')::timestamptz, (f->>'slot_start_at')::timestamptz)) FROM jsonb_array_elements(p_manifest) f WHERE f->>'kind' = 'video' AND nullif(f->>'slot_start_at', '') IS NOT NULL),
    status = coalesce(p_status, status)
  WHERE id = p_import_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION public.set_cctv_import_manifest(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_cctv_import_manifest(uuid, jsonb, text) TO authenticated, service_role;

-- A video the browser has uploaded to bob-uploads/org/<org>/cctv/<import>/... becomes evidence plus a queued
-- video_motion job. Idempotent per (import, source_ref).
CREATE OR REPLACE FUNCTION public.register_cctv_import_video(
  p_import_id uuid, p_storage_path text, p_file_name text, p_file_size_bytes bigint, p_sha256 text DEFAULT NULL,
  p_recorded_start_at timestamptz DEFAULT NULL, p_recorded_end_at timestamptz DEFAULT NULL, p_source_ref text DEFAULT NULL,
  p_content_type text DEFAULT 'video/mp4')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_import public.cctv_imports%rowtype; v_prefix text; v_ref text; v_evidence uuid; v_job uuid;
BEGIN
  SELECT * INTO v_import FROM public.cctv_imports WHERE id = p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_import.organization_id) THEN RAISE EXCEPTION 'CCTV import access denied'; END IF;
  v_prefix := 'org/' || v_import.organization_id::text || '/cctv/' || v_import.id::text || '/';
  IF p_storage_path IS NULL OR position(v_prefix in p_storage_path) <> 1 THEN
    RAISE EXCEPTION 'Video must be stored under %', v_prefix;
  END IF;
  IF coalesce(p_content_type, '') NOT LIKE 'video/%' THEN RAISE EXCEPTION 'Only video files are registered for CCTV review'; END IF;
  v_ref := coalesce(nullif(trim(p_source_ref), ''), nullif(trim(p_file_name), ''), p_storage_path);

  SELECT id INTO v_evidence FROM public.evidence_items WHERE cctv_import_id = v_import.id AND metadata->>'source_ref' = v_ref;
  IF v_evidence IS NULL THEN
    INSERT INTO public.evidence_items (organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at, sha256_hash, cctv_import_id, metadata)
    VALUES (v_import.organization_id, 'cctv_review', 'video', p_storage_path, v_actor, coalesce(p_recorded_start_at, clock_timestamp()), nullif(trim(p_sha256), ''), v_import.id,
            jsonb_strip_nulls(jsonb_build_object(
              'file_name', p_file_name, 'file_type', coalesce(p_content_type, 'video/mp4'), 'file_size_bytes', p_file_size_bytes,
              'storage_bucket', 'bob-uploads', 'source_ref', v_ref, 'recorded_start_at', p_recorded_start_at, 'recorded_end_at', p_recorded_end_at,
              'cctv_import_id', v_import.id, 'camera_label', v_import.camera_label, 'camera_key', v_import.camera_key,
              'source_device_kind', v_import.source_device_kind, 'source_timezone', v_import.source_timezone,
              'location_id', v_import.location_id, 'canonical_place_id', v_import.canonical_place_id)))
    RETURNING id INTO v_evidence;
  END IF;
  SELECT id INTO v_job FROM public.inference_jobs WHERE evidence_item_id = v_evidence AND domain = 'video_motion' LIMIT 1;
  IF v_job IS NULL THEN
    INSERT INTO public.inference_jobs (organization_id, evidence_item_id, domain, status, requested_by_user_id)
    VALUES (v_import.organization_id, v_evidence, 'video_motion', 'queued', v_actor)
    RETURNING id INTO v_job;
  END IF;
  UPDATE public.cctv_imports SET status = CASE WHEN status IN ('draft', 'uploading') THEN 'registered' ELSE status END WHERE id = v_import.id;
  RETURN jsonb_build_object('evidence_item_id', v_evidence, 'inference_job_id', v_job, 'source_ref', v_ref);
END $$;
REVOKE ALL ON FUNCTION public.register_cctv_import_video(uuid, text, text, bigint, text, timestamptz, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_cctv_import_video(uuid, text, text, bigint, text, timestamptz, timestamptz, text, text) TO authenticated, service_role;

-- Event item keys: source (device_snapshot|device_index|inference), source_ref, event_start_at, event_end_at, severity, thumbnail_path, metadata.
CREATE OR REPLACE FUNCTION public.record_cctv_device_events(p_import_id uuid, p_events jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_import public.cctv_imports%rowtype; v_n integer;
BEGIN
  SELECT * INTO v_import FROM public.cctv_imports WHERE id = p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found'; END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin')
     AND (v_actor IS NULL OR NOT public.org_access_allowed(v_import.organization_id)) THEN
    RAISE EXCEPTION 'CCTV import access denied';
  END IF;
  IF jsonb_typeof(p_events) <> 'array' THEN RAISE EXCEPTION 'Events must be an array'; END IF;
  INSERT INTO public.cctv_device_events (cctv_import_id, organization_id, source, source_ref, event_start_at, event_end_at, severity, thumbnail_path, metadata)
  SELECT v_import.id, v_import.organization_id, e->>'source', e->>'source_ref', (e->>'event_start_at')::timestamptz, nullif(e->>'event_end_at', '')::timestamptz,
         coalesce(nullif(e->>'severity', ''), 'motion'), nullif(e->>'thumbnail_path', ''),
         CASE WHEN jsonb_typeof(e->'metadata') = 'object' THEN e->'metadata' ELSE '{}'::jsonb END
  FROM jsonb_array_elements(p_events) e
  WHERE e->>'source' IN ('device_snapshot', 'device_index', 'inference') AND nullif(e->>'source_ref', '') IS NOT NULL AND nullif(e->>'event_start_at', '') IS NOT NULL
    AND coalesce(nullif(e->>'severity', ''), 'motion') IN ('motion', 'detection', 'alert')
  ON CONFLICT (cctv_import_id, source, source_ref) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.record_cctv_device_events(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cctv_device_events(uuid, jsonb) TO authenticated, service_role;
