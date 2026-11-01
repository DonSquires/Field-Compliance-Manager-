-- manage_identity_vehicle cleared this organisation's vehicle note whenever p_fields omitted "notes".
-- Every other field already keeps its stored value when omitted, so the note now does the same:
-- omitted = keep, present but empty = clear, present with text = set.
-- Data-loss paths this closes:
--   * review_nzta_mvr_owner_evidence passes '{}' and review_nzta_mvr_identity_evidence strips null notes,
--     so approving NZTA evidence silently erased the organisation's vehicle note;
--   * in-app Bob's confirmed "register vehicle" step (PR #277) re-checks the plate and then calls this with
--     p_vehicle_id NULL; if another administrator registered the plate in between, the call matched the
--     existing vehicle and erased its note. Registration is now note-preserving under the row lock.
-- The identity records workspace always sends "notes" ('' or text), so its clear/set behaviour is unchanged.
-- Body otherwise identical to the live catalog definition; existing grants are kept by CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION "public"."manage_identity_vehicle"(p_organization_id uuid, p_vehicle_id uuid, p_plate text, p_fields jsonb, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
    org_notes = CASE WHEN NOT coalesce(p_fields ? 'notes', false) THEN org_notes
      WHEN v_note IS NULL THEN org_notes - p_organization_id::text
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

COMMENT ON FUNCTION public.manage_identity_vehicle(uuid, uuid, text, jsonb, text) IS
  'Organisation identity-registry vehicle upsert with audit. Omitted p_fields keys (including notes) keep their stored values; notes present but empty clears this organisation''s note. Shared canonical facts on vehicles seen by other organisations require grand master review.';
