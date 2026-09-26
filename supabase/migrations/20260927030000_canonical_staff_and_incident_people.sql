-- Converge staff and incident-involved people on canonical_people.
-- Officers may record identity only in an assigned live incident; administrators retain evidence approval.

CREATE UNIQUE INDEX IF NOT EXISTS person_records_staff_projection_uidx
ON public.person_records ((metadata->>'staff_profile_id'))
WHERE metadata ? 'staff_profile_id';

CREATE OR REPLACE FUNCTION public.ensure_canonical_person_for_staff(p_staff_profile_id uuid)
RETURNS TABLE(canonical_person_id uuid, person_record_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_staff public.staff_profiles%rowtype;
  v_name text;
  v_person_id uuid;
  v_canonical_id uuid;
BEGIN
  SELECT * INTO v_staff FROM public.staff_profiles WHERE id=p_staff_profile_id;
  IF v_staff.id IS NULL THEN RAISE EXCEPTION 'Staff profile not found'; END IF;
  SELECT link.canonical_person_id INTO v_canonical_id FROM public.canonical_person_links link
  WHERE link.source_table='staff_profiles' AND link.source_id=v_staff.id LIMIT 1;
  SELECT record.id INTO v_person_id FROM public.person_records record
  WHERE record.metadata->>'staff_profile_id'=v_staff.id::text LIMIT 1;
  IF v_person_id IS NULL THEN
    SELECT nullif(trim(profile.display_name),'') INTO v_name FROM public.user_profiles profile WHERE profile.id=coalesce(v_staff.user_id,v_staff.id);
    INSERT INTO public.person_records(organization_id,display_name,review_state,metadata)
    VALUES(v_staff.organization_id,coalesce(v_name,v_staff.employee_number,'Staff member'),'manual_review_required',
      jsonb_build_object('profile_details',jsonb_strip_nulls(jsonb_build_object('category','Staff member','staff_profile_id',v_staff.id,'user_id',v_staff.user_id)),
        'created_from','staff_profiles','staff_profile_id',v_staff.id))
    ON CONFLICT ((metadata->>'staff_profile_id')) WHERE metadata ? 'staff_profile_id' DO UPDATE SET organization_id=excluded.organization_id
    RETURNING id INTO v_person_id;
  END IF;
  IF v_canonical_id IS NULL THEN v_canonical_id:=public.ensure_canonical_person_for_record(v_person_id); END IF;
  INSERT INTO public.canonical_person_links(canonical_person_id,source_table,source_id,organization_id,link_kind,metadata)
  VALUES(v_canonical_id,'staff_profiles',v_staff.id,v_staff.organization_id,'projection',jsonb_build_object('person_record_id',v_person_id,'user_id',v_staff.user_id))
  ON CONFLICT (source_table,source_id) DO UPDATE SET canonical_person_id=excluded.canonical_person_id,organization_id=excluded.organization_id,metadata=excluded.metadata;
  RETURN QUERY SELECT v_canonical_id,v_person_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_canonical_person_for_staff(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_canonical_person_for_staff(uuid) TO postgres,service_role;

DO $$ DECLARE staff record; BEGIN
  FOR staff IN SELECT id FROM public.staff_profiles LOOP PERFORM public.ensure_canonical_person_for_staff(staff.id); END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.incident_person_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  canonical_person_id uuid NOT NULL REFERENCES public.canonical_people(id) ON DELETE RESTRICT,
  person_record_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  staff_profile_id uuid REFERENCES public.staff_profiles(id) ON DELETE SET NULL,
  identity_document_id uuid REFERENCES public.person_identity_documents(id) ON DELETE SET NULL,
  involvement_role text NOT NULL CHECK (involvement_role IN ('subject','reporting_party','witness','affected_person','staff_involved','other')),
  source_kind text NOT NULL CHECK (source_kind IN ('stated_identity','identity_document','staff_profile','cctv_observation','manual_link')),
  notes text,
  recorded_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(incident_id,canonical_person_id,involvement_role)
);
CREATE INDEX IF NOT EXISTS incident_person_links_person_idx ON public.incident_person_links(canonical_person_id,created_at DESC);
CREATE INDEX IF NOT EXISTS incident_person_links_incident_idx ON public.incident_person_links(incident_id,created_at);
ALTER TABLE public.incident_person_links ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_record_incident_person(p_incident_id uuid,p_actor uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.incidents incident
    JOIN public.user_profiles profile ON profile.id=p_actor AND profile.deactivated_at IS NULL
    WHERE incident.id=p_incident_id AND incident.status IN ('open','in_review','escalated')
      AND (public.is_admin_for_org(incident.organization_id)
        OR (profile.role IN ('officer','admin_officer') AND incident.officer_user_id=p_actor))
  )
$$;
REVOKE ALL ON FUNCTION public.can_record_incident_person(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.can_record_incident_person(uuid,uuid) TO authenticated,service_role;

DROP POLICY IF EXISTS incident_person_links_select ON public.incident_person_links;
CREATE POLICY incident_person_links_select ON public.incident_person_links FOR SELECT TO authenticated
USING (public.can_record_incident_person(incident_id));
REVOKE ALL ON TABLE public.incident_person_links FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.incident_person_links TO authenticated;
GRANT ALL ON TABLE public.incident_person_links TO service_role;

CREATE OR REPLACE FUNCTION public.record_incident_person_identity(
  p_incident_id uuid,
  p_involvement_role text,
  p_notes text,
  p_person_record_id uuid DEFAULT NULL,
  p_staff_profile_id uuid DEFAULT NULL,
  p_display_name text DEFAULT NULL,
  p_identity_document_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_incident public.incidents%rowtype;
  v_person_id uuid:=p_person_record_id;
  v_canonical_id uuid;
  v_link public.incident_person_links%rowtype;
  v_source text;
BEGIN
  SELECT * INTO v_incident FROM public.incidents WHERE id=p_incident_id FOR UPDATE;
  IF v_incident.id IS NULL THEN RAISE EXCEPTION 'Incident not found'; END IF;
  IF v_actor IS NULL OR NOT public.can_record_incident_person(v_incident.id,v_actor) THEN RAISE EXCEPTION 'Only the assigned officer or an administrator can record a person for this incident'; END IF;
  IF p_involvement_role NOT IN ('subject','reporting_party','witness','affected_person','staff_involved','other') THEN RAISE EXCEPTION 'Choose a valid involvement role'; END IF;
  IF coalesce(trim(p_notes),'')='' THEN RAISE EXCEPTION 'Record how the identity was obtained'; END IF;
  IF p_person_record_id IS NOT NULL AND p_staff_profile_id IS NOT NULL THEN RAISE EXCEPTION 'Choose either a person record or a staff profile'; END IF;
  IF p_identity_document_id IS NOT NULL AND NOT public.is_admin_for_org(v_incident.organization_id) THEN RAISE EXCEPTION 'Only an administrator can link approved identity evidence'; END IF;

  IF p_staff_profile_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.staff_profiles WHERE id=p_staff_profile_id AND organization_id=v_incident.organization_id) THEN RAISE EXCEPTION 'Staff profile is outside the incident organization'; END IF;
    SELECT ensured.canonical_person_id,ensured.person_record_id INTO v_canonical_id,v_person_id FROM public.ensure_canonical_person_for_staff(p_staff_profile_id) ensured;
    v_source:='staff_profile';
  ELSIF v_person_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.person_records WHERE id=v_person_id AND organization_id=v_incident.organization_id) THEN RAISE EXCEPTION 'Person record is outside the incident organization'; END IF;
    v_canonical_id:=public.ensure_canonical_person_for_record(v_person_id);
    v_source:='manual_link';
  ELSE
    IF nullif(trim(p_display_name),'') IS NULL THEN RAISE EXCEPTION 'Enter the name stated or shown on the identity document'; END IF;
    INSERT INTO public.person_records(organization_id,display_name,review_state,metadata)
    VALUES(v_incident.organization_id,trim(p_display_name),'manual_review_required',jsonb_build_object(
      'profile_details',jsonb_build_object('category','Incident identity'),
      'created_from','incident_identity_capture','incident_id',v_incident.id,'recorded_by',v_actor)) RETURNING id INTO v_person_id;
    v_canonical_id:=public.ensure_canonical_person_for_record(v_person_id);
    v_source:='stated_identity';
  END IF;

  IF p_identity_document_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.person_identity_documents document
    WHERE document.id=p_identity_document_id AND document.organization_id=v_incident.organization_id
      AND document.person_record_id=v_person_id AND document.review_state='approved'
  ) THEN RAISE EXCEPTION 'Approved identity evidence for this person is required'; END IF;
  IF p_identity_document_id IS NOT NULL THEN v_source:='identity_document'; END IF;

  INSERT INTO public.incident_person_links(organization_id,incident_id,canonical_person_id,person_record_id,staff_profile_id,identity_document_id,involvement_role,source_kind,notes,recorded_by)
  VALUES(v_incident.organization_id,v_incident.id,v_canonical_id,v_person_id,p_staff_profile_id,p_identity_document_id,p_involvement_role,v_source,trim(p_notes),v_actor)
  ON CONFLICT(incident_id,canonical_person_id,involvement_role) DO UPDATE SET
    person_record_id=coalesce(excluded.person_record_id,incident_person_links.person_record_id),
    staff_profile_id=coalesce(excluded.staff_profile_id,incident_person_links.staff_profile_id),
    identity_document_id=coalesce(excluded.identity_document_id,incident_person_links.identity_document_id),
    source_kind=excluded.source_kind,notes=excluded.notes,recorded_by=excluded.recorded_by,updated_at=clock_timestamp()
  RETURNING * INTO v_link;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_incident.organization_id,v_actor,'incident_person_identity_recorded','incident_person_links',v_link.id,jsonb_build_object(
    'incident_id',v_incident.id,'canonical_person_id',v_canonical_id,'person_record_id',v_person_id,
    'staff_profile_id',p_staff_profile_id,'identity_document_id',p_identity_document_id,
    'involvement_role',p_involvement_role,'source_kind',v_source));
  RETURN jsonb_build_object('incident_person_link_id',v_link.id,'incident_id',v_incident.id,
    'canonical_person_id',v_canonical_id,'person_record_id',v_person_id,'staff_profile_id',p_staff_profile_id,
    'review_state',(SELECT review_state FROM public.person_records WHERE id=v_person_id));
END;
$$;
REVOKE ALL ON FUNCTION public.record_incident_person_identity(uuid,text,text,uuid,uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_incident_person_identity(uuid,text,text,uuid,uuid,text,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_incident_people(p_incident_id uuid)
RETURNS TABLE(link_id uuid,canonical_person_id uuid,person_record_id uuid,staff_profile_id uuid,display_name text,involvement_role text,source_kind text,review_state text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_record_incident_person(p_incident_id,auth.uid()) THEN RAISE EXCEPTION 'Incident person access denied'; END IF;
  RETURN QUERY SELECT link.id,link.canonical_person_id,link.person_record_id,link.staff_profile_id,
    coalesce(person.display_name,profile.display_name,'Unnamed person'),link.involvement_role,link.source_kind,person.review_state,link.created_at
  FROM public.incident_person_links link
  LEFT JOIN public.person_records person ON person.id=link.person_record_id
  LEFT JOIN public.staff_profiles staff ON staff.id=link.staff_profile_id
  LEFT JOIN public.user_profiles profile ON profile.id=coalesce(staff.user_id,staff.id)
  WHERE link.incident_id=p_incident_id ORDER BY link.created_at;
END;
$$;
REVOKE ALL ON FUNCTION public.get_incident_people(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_incident_people(uuid) TO authenticated,service_role;

COMMENT ON TABLE public.incident_person_links IS 'Tenant-scoped incident involvement linked to canonical_people; supports staff and non-staff without duplicating identity truth.';
COMMENT ON FUNCTION public.record_incident_person_identity(uuid,text,text,uuid,uuid,text,uuid) IS 'Assigned-officer/admin path to record a stated, known, staff, or approved-document identity in an active incident. New identities remain manual-review-required.';
