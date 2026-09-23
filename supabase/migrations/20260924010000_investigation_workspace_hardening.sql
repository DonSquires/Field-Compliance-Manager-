-- Hardens the investigation workspace per docs/DEEP_BUILD_AUDIT_2026-09-08.md
-- (High: link_investigation_entity accepts unvalidated entity references;
-- create_investigation's lead_user_id is unvalidated) and applies the tiered
-- access already ratified for sensitive records elsewhere in this build
-- (person_permits/person_permits_fieldwork: admin-only base table + a
-- redacted view for ordinary staff). Written building out the investigation
-- system for R&M's real trespass-dispute data (Post/Carr, Brooklyn Rd).

-- 1. New investigation_type: neighbour/land-access trespass disputes are a
-- real, recurring category (Wrattens) that doesn't fit the existing values.
ALTER TABLE public.investigations DROP CONSTRAINT investigations_type_check;
ALTER TABLE public.investigations ADD CONSTRAINT investigations_type_check
  CHECK (investigation_type IN ('incident','compliance','enforcement','safety','biosecurity','noise','smoke','parking','welfare','trespass','other'));

-- 2. Harden create_investigation: validate lead_user_id belongs to the same org.
CREATE OR REPLACE FUNCTION public.create_investigation(
  p_organization_id uuid,
  p_client_request_id uuid,
  p_reference text,
  p_title text,
  p_investigation_type text DEFAULT 'other',
  p_priority text DEFAULT 'medium',
  p_summary text DEFAULT NULL,
  p_lead_user_id uuid DEFAULT NULL
) RETURNS public.investigations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_item public.investigations%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Active organization administrator required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF nullif(trim(p_reference),'') IS NULL OR nullif(trim(p_title),'') IS NULL THEN RAISE EXCEPTION 'Investigation reference and title are required'; END IF;
  IF p_lead_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_profiles WHERE id = p_lead_user_id AND organization_id = p_organization_id
  ) THEN RAISE EXCEPTION 'lead_user_id must be a user_profiles member of this organization'; END IF;
  SELECT * INTO v_item FROM public.investigations WHERE organization_id=p_organization_id AND investigation_reference=trim(p_reference) FOR UPDATE;
  IF FOUND THEN RETURN v_item; END IF;
  INSERT INTO public.investigations (organization_id, investigation_reference, title, investigation_type, priority, summary, lead_user_id, created_by)
  VALUES (p_organization_id, trim(p_reference), trim(p_title), p_investigation_type, p_priority, nullif(trim(p_summary),''), p_lead_user_id, v_actor)
  RETURNING * INTO v_item;
  INSERT INTO public.investigation_events (investigation_id, organization_id, event_type, description, created_by)
  VALUES (v_item.id, p_organization_id, 'investigation_opened', 'Investigation opened', v_actor);
  RETURN v_item;
END;
$$;

-- 3. Harden link_investigation_entity: verify the entity actually exists and,
-- for org-scoped entity types, belongs to the same organization as the
-- investigation. canonical_people/canonical_vehicles are the shared
-- cross-org identity spine (docs/ENTERPRISE_COSTING_AND_PNL_DESIGN.md) so
-- only existence is checked for those two, not org match.
CREATE OR REPLACE FUNCTION public.link_investigation_entity(
  p_investigation_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_link_role text,
  p_link_reason text
) RETURNS public.investigation_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_item public.investigations%rowtype; v_link public.investigation_links%rowtype; v_exists boolean;
BEGIN
  SELECT * INTO v_item FROM public.investigations WHERE id=p_investigation_id FOR UPDATE;
  IF NOT FOUND OR v_actor IS NULL OR NOT public.is_admin_for_org(v_item.organization_id) THEN RAISE EXCEPTION 'Investigation access denied'; END IF;
  IF nullif(trim(p_link_reason),'') IS NULL THEN RAISE EXCEPTION 'Link reason is required'; END IF;

  v_exists := CASE p_entity_type
    WHEN 'field_report' THEN EXISTS (SELECT 1 FROM public.officer_field_reports WHERE id = p_entity_id AND organization_id = v_item.organization_id)
    WHEN 'incident' THEN EXISTS (SELECT 1 FROM public.incidents WHERE id = p_entity_id AND organization_id = v_item.organization_id)
    WHEN 'observation' THEN EXISTS (SELECT 1 FROM public.observations WHERE id = p_entity_id AND organization_id = v_item.organization_id)
    WHEN 'evidence' THEN EXISTS (SELECT 1 FROM public.evidence_items WHERE id = p_entity_id AND organization_id = v_item.organization_id)
    WHEN 'site' THEN EXISTS (SELECT 1 FROM public.client_sites WHERE id = p_entity_id AND organization_id = v_item.organization_id)
    WHEN 'zone' THEN EXISTS (SELECT 1 FROM public.location_zones WHERE id = p_entity_id AND organization_id = v_item.organization_id)
    WHEN 'dispatch_job' THEN EXISTS (SELECT 1 FROM public.dispatch_jobs WHERE id = p_entity_id AND organization_id = v_item.organization_id)
    WHEN 'person' THEN EXISTS (SELECT 1 FROM public.canonical_people WHERE id = p_entity_id)
    WHEN 'vehicle' THEN EXISTS (SELECT 1 FROM public.canonical_vehicles WHERE id = p_entity_id)
    ELSE false
  END;
  IF NOT v_exists THEN RAISE EXCEPTION 'Entity % % not found in this organization', p_entity_type, p_entity_id; END IF;

  SELECT * INTO v_link FROM public.investigation_links WHERE investigation_id=p_investigation_id AND entity_type=p_entity_type AND entity_id=p_entity_id;
  IF FOUND THEN RETURN v_link; END IF;
  INSERT INTO public.investigation_links (investigation_id, organization_id, entity_type, entity_id, link_role, link_reason, linked_by)
  VALUES (p_investigation_id, v_item.organization_id, p_entity_type, p_entity_id, p_link_role, trim(p_link_reason), v_actor)
  RETURNING * INTO v_link;
  IF p_entity_type='field_report' THEN UPDATE public.officer_field_reports SET investigation_id=p_investigation_id WHERE id=p_entity_id AND organization_id=v_item.organization_id; END IF;
  IF p_entity_type='incident' THEN UPDATE public.incidents SET investigation_id=p_investigation_id WHERE id=p_entity_id AND organization_id=v_item.organization_id; END IF;
  INSERT INTO public.investigation_events (investigation_id, organization_id, event_type, description, source_table, source_id, created_by)
  VALUES (p_investigation_id, v_item.organization_id, 'entity_linked', p_entity_type || ' linked: ' || trim(p_link_reason), p_entity_type, p_entity_id, v_actor);
  RETURN v_link;
END;
$$;

-- 4. Tiered read access (matches person_permits/person_permits_fieldwork):
-- base tables become admin-or-assigned-lead only; a redacted view exposes
-- existence/status/type/dates to ordinary org-access staff without the
-- narrative fields (summary, resolution_notes, event descriptions, link
-- reasons) that carry third-party PII, alleged-threat quotes, and Police
-- liaison detail (real content: Wrattens' Post/Carr disputes).
DROP POLICY IF EXISTS investigations_select ON public.investigations;
CREATE POLICY investigations_admin_or_lead_select ON public.investigations FOR SELECT
  USING (public.is_admin_for_org(organization_id) OR lead_user_id = auth.uid());

DROP POLICY IF EXISTS investigation_events_select ON public.investigation_events;
CREATE POLICY investigation_events_admin_or_lead_select ON public.investigation_events FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.investigations i
    WHERE i.id = investigation_events.investigation_id
      AND (public.is_admin_for_org(i.organization_id) OR i.lead_user_id = auth.uid())
  ));

DROP POLICY IF EXISTS investigation_links_select ON public.investigation_links;
CREATE POLICY investigation_links_admin_or_lead_select ON public.investigation_links FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.investigations i
    WHERE i.id = investigation_links.investigation_id
      AND (public.is_admin_for_org(i.organization_id) OR i.lead_user_id = auth.uid())
  ));

-- Definer view (owner bypasses the admin-or-lead base policy above): applies
-- its own org_access_allowed scoping, same pattern as person_permits_fieldwork.
CREATE OR REPLACE VIEW public.investigations_summary AS
SELECT
  i.id,
  i.organization_id,
  i.investigation_reference,
  i.title,
  i.investigation_type,
  i.status,
  i.priority,
  i.legal_hold,
  i.lead_user_id,
  i.opened_at,
  i.resolved_at,
  i.closed_at
FROM public.investigations i
WHERE public.org_access_allowed(i.organization_id);

REVOKE ALL ON public.investigations_summary FROM PUBLIC, anon;
GRANT SELECT ON public.investigations_summary TO authenticated, service_role;
COMMENT ON VIEW public.investigations_summary IS 'Org-visible investigation existence/status projection: excludes summary, resolution_notes and the event/link timeline (third-party PII, alleged-conduct narrative, Police liaison detail) which stay admin-or-assigned-lead only on the base tables.';

REVOKE ALL ON FUNCTION public.create_investigation(uuid,uuid,text,text,text,text,text,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_investigation(uuid,uuid,text,text,text,text,text,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.link_investigation_entity(uuid,text,uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.link_investigation_entity(uuid,text,uuid,text,text) TO authenticated, service_role;
