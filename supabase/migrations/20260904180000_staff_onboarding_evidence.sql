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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_user_id uuid;
  v_id uuid;
  v_note text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select sp.* into v_staff from public.staff_profiles sp where sp.id = p_staff_id for update;
  if not found then raise exception 'Staff profile not found'; end if;
  if not public.is_admin_for_org(v_staff.organization_id) then raise exception 'Active HR administrator required'; end if;
  v_user_id := coalesce(v_staff.user_id, v_staff.id);

  if p_action = 'add_skill' then
    if nullif(trim(coalesce(p_skill_name, '')), '') is null then raise exception 'Skill name is required'; end if;
    if p_skill_category not in ('enforcement','technical','medical','language','driving','equipment','other') then raise exception 'Unsupported skill category'; end if;
    if p_proficiency_level not in ('basic','competent','proficient','expert') then raise exception 'Unsupported proficiency level'; end if;
    insert into public.staff_skills(staff_id, organization_id, skill_name, skill_category, proficiency_level, notes)
    values(v_staff.id, v_staff.organization_id, trim(p_skill_name), p_skill_category, p_proficiency_level, v_note)
    returning id into v_id;
  elsif p_action = 'assign_line_manager' then
    if p_reports_to_user_id is null or p_reports_to_user_id = v_user_id then raise exception 'A different line manager is required'; end if;
    if not exists(select 1 from public.user_profiles u where u.id = p_reports_to_user_id and u.organization_id = v_staff.organization_id and u.deactivated_at is null) then raise exception 'Line manager must be an active organization member'; end if;
    update public.staff_reporting set effective_to = current_date - 1
    where user_id = v_user_id and scope_org_id = v_staff.organization_id and relationship_type = 'line_manager' and effective_to is null;
    insert into public.staff_reporting(user_id, reports_to_user_id, scope_org_id, relationship_type, set_by, notes)
    values(v_user_id, p_reports_to_user_id, v_staff.organization_id, 'line_manager', v_actor, v_note)
    returning id into v_id;
  elsif p_action = 'record_induction' then
    if nullif(trim(coalesce(p_training_name, '')), '') is null then raise exception 'Induction name is required'; end if;
    insert into public.staff_training_records(organization_id, staff_id, officer_id, training_name, training_type, completed_date, passed, notes, recorded_by)
    values(v_staff.organization_id, v_staff.id, v_user_id, trim(p_training_name), 'induction', current_date, true, v_note, v_actor)
    returning id into v_id;
  elsif p_action = 'record_document' then
    if p_document_type not in ('credential_evidence','contract','certificate','policy_acknowledgement','other') then raise exception 'Unsupported document type'; end if;
    if nullif(trim(coalesce(p_file_name, '')), '') is null or nullif(trim(coalesce(p_storage_path, '')), '') is null then raise exception 'File name and storage path are required'; end if;
    insert into public.staff_documents(staff_id, organization_id, document_type, file_name, storage_path, notes, uploaded_by)
    values(v_staff.id, v_staff.organization_id, p_document_type, trim(p_file_name), trim(p_storage_path), v_note, v_actor)
    returning id into v_id;
  else
    raise exception 'Unsupported staff onboarding evidence action';
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values(v_staff.organization_id, v_actor, 'staff_onboarding_evidence_recorded', 'staff_profiles', v_staff.id,
    jsonb_build_object('action', p_action, 'evidence_id', v_id, 'client_request_id', p_client_request_id));
  return jsonb_build_object('staff_id', v_staff.id, 'action', p_action, 'evidence_id', v_id);
end;
$$;

REVOKE ALL ON FUNCTION public.manage_staff_onboarding_evidence(uuid,uuid,text,text,text,text,uuid,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_staff_onboarding_evidence(uuid,uuid,text,text,text,text,uuid,text,text,text,text,text) TO authenticated, service_role;
