DROP POLICY IF EXISTS staff_documents_private_select ON storage.objects;
CREATE POLICY staff_documents_private_select
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'staff-documents'
  AND EXISTS (
    SELECT 1
    FROM public.staff_documents document
    WHERE document.storage_path = storage.objects.name
      AND array_length(storage.foldername(storage.objects.name), 1) >= 3
      AND (storage.foldername(storage.objects.name))[1] = document.organization_id::text
      AND (storage.foldername(storage.objects.name))[2] = 'staff'
      AND (storage.foldername(storage.objects.name))[3] = document.staff_id::text
      AND (
        document.client_request_id IS NULL
        OR (
          array_length(storage.foldername(storage.objects.name), 1) = 4
          AND (storage.foldername(storage.objects.name))[4] = document.client_request_id::text
        )
      )
      AND public.is_admin_for_org(document.organization_id)
  )
);

DROP POLICY IF EXISTS staff_documents_private_delete_orphan ON storage.objects;
CREATE POLICY staff_documents_private_delete_orphan
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'staff-documents'
  AND array_length(storage.foldername(name), 1) = 4
  AND (storage.foldername(name))[2] = 'staff'
  AND EXISTS (
    SELECT 1
    FROM public.staff_profiles staff
    WHERE staff.id::text = (storage.foldername(name))[3]
      AND staff.organization_id::text = (storage.foldername(name))[1]
      AND public.is_admin_for_org(staff.organization_id)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.staff_documents document
    WHERE document.storage_path = storage.objects.name
  )
);

CREATE OR REPLACE FUNCTION public.manage_staff_onboarding_evidence(
  p_client_request_id uuid,
  p_staff_id uuid,
  p_action text,
  p_skill_name text DEFAULT NULL,
  p_skill_category text DEFAULT NULL,
  p_proficiency_level text DEFAULT NULL,
  p_reports_to_user_id uuid DEFAULT NULL,
  p_training_name text DEFAULT NULL,
  p_document_type text DEFAULT NULL,
  p_file_name text DEFAULT NULL,
  p_storage_path text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_user_id uuid;
  v_id uuid;
  v_note text := nullif(trim(coalesce(p_notes, '')), '');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT sp.* INTO v_staff FROM public.staff_profiles sp WHERE sp.id = p_staff_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff profile not found'; END IF;
  IF NOT public.is_admin_for_org(v_staff.organization_id) THEN RAISE EXCEPTION 'Active HR administrator required'; END IF;
  v_user_id := coalesce(v_staff.user_id, v_staff.id);

  IF p_action = 'add_skill' THEN
    IF nullif(trim(coalesce(p_skill_name, '')), '') IS NULL THEN RAISE EXCEPTION 'Skill name is required'; END IF;
    IF p_skill_category NOT IN ('enforcement','technical','medical','language','driving','equipment','other') THEN RAISE EXCEPTION 'Unsupported skill category'; END IF;
    IF p_proficiency_level NOT IN ('basic','competent','proficient','expert') THEN RAISE EXCEPTION 'Unsupported proficiency level'; END IF;
    INSERT INTO public.staff_skills(staff_id, organization_id, skill_name, skill_category, proficiency_level, notes)
    VALUES(v_staff.id, v_staff.organization_id, trim(p_skill_name), p_skill_category, p_proficiency_level, v_note)
    RETURNING id INTO v_id;
  ELSIF p_action = 'assign_line_manager' THEN
    IF p_reports_to_user_id IS NULL OR p_reports_to_user_id = v_user_id THEN RAISE EXCEPTION 'A different line manager is required'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.user_profiles u WHERE u.id = p_reports_to_user_id AND u.organization_id = v_staff.organization_id AND u.deactivated_at IS NULL) THEN RAISE EXCEPTION 'Line manager must be an active organization member'; END IF;
    UPDATE public.staff_reporting SET effective_to = current_date - 1
    WHERE user_id = v_user_id AND scope_org_id = v_staff.organization_id AND relationship_type = 'line_manager' AND effective_to IS NULL;
    INSERT INTO public.staff_reporting(user_id, reports_to_user_id, scope_org_id, relationship_type, set_by, notes)
    VALUES(v_user_id, p_reports_to_user_id, v_staff.organization_id, 'line_manager', v_actor, v_note)
    RETURNING id INTO v_id;
  ELSIF p_action = 'record_induction' THEN
    IF nullif(trim(coalesce(p_training_name, '')), '') IS NULL THEN RAISE EXCEPTION 'Induction name is required'; END IF;
    INSERT INTO public.staff_training_records(organization_id, staff_id, officer_id, training_name, training_type, completed_date, passed, notes, recorded_by)
    VALUES(v_staff.organization_id, v_staff.id, v_user_id, trim(p_training_name), 'induction', current_date, true, v_note, v_actor)
    RETURNING id INTO v_id;
  ELSIF p_action = 'record_document' THEN
    RAISE EXCEPTION 'Staff documents must be uploaded through record_staff_document_upload';
  ELSE
    RAISE EXCEPTION 'Unsupported staff onboarding evidence action';
  END IF;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(v_staff.organization_id, v_actor, 'staff_onboarding_evidence_recorded', 'staff_profiles', v_staff.id,
    jsonb_build_object('action', p_action, 'evidence_id', v_id, 'client_request_id', p_client_request_id));
  RETURN jsonb_build_object('staff_id', v_staff.id, 'action', p_action, 'evidence_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.manage_staff_onboarding_evidence(uuid,uuid,text,text,text,text,uuid,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_staff_onboarding_evidence(uuid,uuid,text,text,text,text,uuid,text,text,text,text,text)
  TO authenticated, service_role;
