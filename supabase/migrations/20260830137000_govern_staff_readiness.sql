alter table public.staff_profiles add column if not exists work_ready_reviewed_by uuid references public.user_profiles(id) on delete set null,add column if not exists work_ready_reviewed_at timestamptz,add column if not exists work_ready_review_notes text;

drop policy if exists staff_profiles_update on public.staff_profiles;
revoke insert,update,delete on public.staff_profiles from public,anon,authenticated;

create function public.get_staff_readiness_assessment(p_organization_id uuid)
returns table(staff_id uuid,user_id uuid,work_ready boolean,identity_status text,employment_status text,credential_status text,training_status text,blockers text[]) language plpgsql stable security definer set search_path=public as $$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to assess staff readiness';end if;
  return query
  select sp.id,sp.user_id,sp.work_ready,
    case when up.id is null then 'unlinked' when up.deactivated_at is not null then 'deactivated' when up.role not in('officer','admin_officer') then 'not_field_role' else 'active' end,
    case when sp.start_date is not null and sp.start_date>current_date then 'not_started' when sp.end_date is not null and sp.end_date<current_date then 'ended' else 'current' end,
    case when up.role not in('officer','admin_officer') then 'not_applicable' when not exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and c.verified and (c.expiry_date is null or c.expiry_date>=current_date)) then 'missing_valid' when exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and (not c.verified or (c.expiry_date is not null and c.expiry_date<current_date))) then 'attention' else 'current' end,
    case when exists(select 1 from public.staff_training_records tr where tr.staff_id=sp.id and (tr.passed=false or (tr.expiry_date is not null and tr.expiry_date<current_date))) then 'attention' else 'clear' end,
    array_remove(array[
      case when up.id is null then 'Identity is not linked' when up.deactivated_at is not null then 'User access is deactivated' when up.role not in('officer','admin_officer') then 'User is not assigned a field role' end,
      case when sp.start_date is not null and sp.start_date>current_date then 'Employment has not started' when sp.end_date is not null and sp.end_date<current_date then 'Employment has ended' end,
      case when up.role in('officer','admin_officer') and not exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and c.verified and (c.expiry_date is null or c.expiry_date>=current_date)) then 'No verified current credential' end
    ],null)::text[]
  from public.staff_profiles sp left join public.user_profiles up on up.id=sp.user_id where sp.organization_id=p_organization_id;
end;$$;

create function public.set_staff_work_readiness(p_staff_id uuid,p_expected_work_ready boolean,p_work_ready boolean,p_review_notes text)
returns public.staff_profiles language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_staff public.staff_profiles%rowtype;v_assessment record;v_notes text:=nullif(trim(coalesce(p_review_notes,'')),'');
begin
  select sp.* into v_staff from public.staff_profiles sp where sp.id=p_staff_id for update;if not found then raise exception 'Staff profile not found';end if;
  if not public.is_admin_for_org(v_staff.organization_id) then raise exception 'Not authorised to change staff readiness';end if;
  if v_staff.work_ready<>p_expected_work_ready then raise exception 'Staff readiness changed from expected state';end if;
  if v_staff.work_ready=p_work_ready then raise exception 'Staff readiness is already in the requested state';end if;
  if v_notes is null then raise exception 'Readiness review notes are required';end if;
  if p_work_ready then
    select * into v_assessment from public.get_staff_readiness_assessment(v_staff.organization_id) a where a.staff_id=v_staff.id;
    if coalesce(array_length(v_assessment.blockers,1),0)>0 then raise exception 'Staff member is not work ready: %',array_to_string(v_assessment.blockers,'; ');end if;
  end if;
  update public.staff_profiles sp set work_ready=p_work_ready,work_ready_reviewed_by=v_actor,work_ready_reviewed_at=clock_timestamp(),work_ready_review_notes=v_notes where sp.id=v_staff.id returning sp.* into v_staff;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_staff.organization_id,v_actor,case when p_work_ready then 'staff_work_ready_enabled' else 'staff_work_ready_disabled' end,'staff_profiles',v_staff.id,jsonb_build_object('previous_work_ready',p_expected_work_ready,'work_ready',p_work_ready,'review_notes',v_notes));
  return v_staff;
end;$$;

revoke all on function public.get_staff_readiness_assessment(uuid),public.set_staff_work_readiness(uuid,boolean,boolean,text) from public,anon,authenticated;
grant execute on function public.get_staff_readiness_assessment(uuid),public.set_staff_work_readiness(uuid,boolean,boolean,text) to authenticated,service_role;