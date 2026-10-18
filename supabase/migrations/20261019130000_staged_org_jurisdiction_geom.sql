-- Large service areas could not be saved. R & M Security's approved 23-council
-- boundary (Stats NZ, ~17 MB / ~608k vertices) failed in set_org_jurisdiction_geom
-- with "canceling statement due to statement timeout": PostgREST requests run
-- under authenticator's 8s statement_timeout, and a function-level
-- statement_timeout cannot extend an already-running statement.
--
-- The geometry is the L1 operating bound (GEOFENCE_PRINCIPLES), so it is not
-- simplified to fit. Instead the executor stages one council per request into
-- a service-only accumulator, then commits the union through the same write
-- path (organization update + versioned history) as set_org_jurisdiction_geom.
--
-- Also closes a write hole: set_org_jurisdiction_geom is SECURITY DEFINER with
-- no caller check and was executable by PUBLIC/anon/authenticated. Its only
-- callers are service-role edge functions.

CREATE TABLE IF NOT EXISTS public.org_jurisdiction_geom_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  geom public.geometry(MultiPolygon, 4326),
  part_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour'
);
COMMENT ON TABLE public.org_jurisdiction_geom_stages IS 'Service-only scratch accumulator for unioning large organisation jurisdictions one part per request (stage_org_jurisdiction_part -> commit_org_jurisdiction_stage). Not a boundary of record; rows are deleted on commit and expire after an hour.';
CREATE INDEX IF NOT EXISTS org_jurisdiction_geom_stages_expires_idx ON public.org_jurisdiction_geom_stages (expires_at);
ALTER TABLE public.org_jurisdiction_geom_stages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.org_jurisdiction_geom_stages FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.org_jurisdiction_geom_stages TO service_role;

-- Shared write: validate, update organizations.jurisdiction_geom, version history, return area (m^2).
CREATE OR REPLACE FUNCTION public._write_org_jurisdiction_geom(
  p_org_id uuid, p_geom public.geometry, p_boundary_source text, p_changed_by uuid, p_changed_via text
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_geom    geometry;
  v_area_m2 numeric;
  v_source  text;
  v_via     text;
BEGIN
  IF p_geom IS NULL THEN
    RAISE EXCEPTION 'Could not build geometry from supplied GeoJSON';
  END IF;
  v_geom := st_multi(st_setsrid(st_makevalid(p_geom), 4326));
  IF st_isempty(v_geom) THEN
    RAISE EXCEPTION 'Geometry is empty after ST_MakeValid + ST_Union';
  END IF;
  IF NOT st_isvalid(v_geom) THEN
    RAISE EXCEPTION 'Geometry is still invalid after ST_MakeValid: %', st_isvalidreason(v_geom);
  END IF;

  v_area_m2 := st_area(v_geom::geography);

  UPDATE public.organizations SET jurisdiction_geom = v_geom WHERE id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization % not found', p_org_id;
  END IF;

  -- P1: loud, explicit provenance when the caller supplies none.
  v_source := COALESCE(NULLIF(TRIM(p_boundary_source), ''), 'UNKNOWN_SOURCE');
  v_via := CASE
    WHEN p_changed_via IN ('governed_proposal', 'direct_edit', 'reconciliation', 'refresh', 'verification', 'backfill')
    THEN p_changed_via
    ELSE 'governed_proposal'
  END;

  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source,
    verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    'organization', p_org_id, v_geom, v_source,
    'unverified', NULL, NULL,
    p_changed_by, v_via, 'Jurisdiction geometry set via set_org_jurisdiction_geom',
    public._gbh_next_version('organization', p_org_id)
  );

  RETURN v_area_m2;
END;
$function$;

-- Same signature and behaviour as before; now delegates the write.
CREATE OR REPLACE FUNCTION public.set_org_jurisdiction_geom(
  p_org_id uuid, p_polygons jsonb, p_boundary_source text DEFAULT NULL::text,
  p_changed_by uuid DEFAULT NULL::uuid, p_changed_via text DEFAULT 'governed_proposal'::text
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_geom geometry;
BEGIN
  IF p_polygons IS NULL OR jsonb_typeof(p_polygons) <> 'array' OR jsonb_array_length(p_polygons) = 0 THEN
    RAISE EXCEPTION 'p_polygons must be a non-empty JSON array of GeoJSON geometries';
  END IF;
  SELECT st_union(st_makevalid(st_geomfromgeojson(elem.value)))
    INTO v_geom
    FROM jsonb_array_elements(p_polygons) AS elem;
  RETURN public._write_org_jurisdiction_geom(p_org_id, v_geom, p_boundary_source, p_changed_by, p_changed_via);
END;
$function$;

-- Union one GeoJSON polygon into a stage. Pass p_stage_id NULL to open a new stage.
CREATE OR REPLACE FUNCTION public.stage_org_jurisdiction_part(p_stage_id uuid, p_org_id uuid, p_polygon jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stage public.org_jurisdiction_geom_stages;
  v_part  geometry;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'Organization is required';
  END IF;
  IF p_polygon IS NULL OR jsonb_typeof(p_polygon) <> 'object' THEN
    RAISE EXCEPTION 'p_polygon must be one GeoJSON geometry object';
  END IF;
  v_part := st_collectionextract(st_makevalid(st_setsrid(st_geomfromgeojson(p_polygon), 4326)), 3);
  IF v_part IS NULL OR st_isempty(v_part) THEN
    RAISE EXCEPTION 'Jurisdiction part has no polygon area';
  END IF;

  DELETE FROM public.org_jurisdiction_geom_stages WHERE expires_at < now();

  IF p_stage_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org_id) THEN
      RAISE EXCEPTION 'Organization % not found', p_org_id;
    END IF;
    INSERT INTO public.org_jurisdiction_geom_stages (organization_id, geom, part_count)
    VALUES (p_org_id, st_multi(v_part), 1)
    RETURNING * INTO v_stage;
    RETURN v_stage.id;
  END IF;

  SELECT * INTO v_stage FROM public.org_jurisdiction_geom_stages WHERE id = p_stage_id FOR UPDATE;
  IF NOT FOUND OR v_stage.expires_at < now() THEN
    RAISE EXCEPTION 'Jurisdiction stage % not found or expired', p_stage_id;
  END IF;
  IF v_stage.organization_id <> p_org_id THEN
    RAISE EXCEPTION 'Jurisdiction stage belongs to a different organization';
  END IF;

  UPDATE public.org_jurisdiction_geom_stages
     SET geom = st_multi(st_collectionextract(st_union(geom, v_part), 3)),
         part_count = part_count + 1
   WHERE id = v_stage.id;
  RETURN v_stage.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.commit_org_jurisdiction_stage(
  p_stage_id uuid, p_org_id uuid, p_expected_parts integer, p_boundary_source text DEFAULT NULL::text,
  p_changed_by uuid DEFAULT NULL::uuid, p_changed_via text DEFAULT 'governed_proposal'::text
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stage public.org_jurisdiction_geom_stages;
  v_area  numeric;
BEGIN
  SELECT * INTO v_stage FROM public.org_jurisdiction_geom_stages WHERE id = p_stage_id FOR UPDATE;
  IF NOT FOUND OR v_stage.expires_at < now() THEN
    RAISE EXCEPTION 'Jurisdiction stage % not found or expired', p_stage_id;
  END IF;
  IF v_stage.organization_id <> p_org_id THEN
    RAISE EXCEPTION 'Jurisdiction stage belongs to a different organization';
  END IF;
  -- Never commit a partial service area.
  IF p_expected_parts IS NULL OR v_stage.part_count <> p_expected_parts THEN
    RAISE EXCEPTION 'Jurisdiction stage has % of % parts', v_stage.part_count, p_expected_parts;
  END IF;
  v_area := public._write_org_jurisdiction_geom(p_org_id, v_stage.geom, p_boundary_source, p_changed_by, p_changed_via);
  DELETE FROM public.org_jurisdiction_geom_stages WHERE id = v_stage.id;
  RETURN v_area;
END;
$function$;

REVOKE ALL ON FUNCTION public._write_org_jurisdiction_geom(uuid, public.geometry, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_org_jurisdiction_geom(uuid, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stage_org_jurisdiction_part(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_org_jurisdiction_stage(uuid, uuid, integer, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._write_org_jurisdiction_geom(uuid, public.geometry, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_org_jurisdiction_geom(uuid, jsonb, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.stage_org_jurisdiction_part(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_org_jurisdiction_stage(uuid, uuid, integer, text, uuid, text) TO service_role;
