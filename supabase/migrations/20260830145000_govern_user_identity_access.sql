alter table public.user_profiles add column if not exists updated_at timestamptz not null default now();
drop trigger if exists trg_touch_user_profiles on public.user_profiles;
create trigger trg_touch_user_profiles before update on public.user_profiles for each row execute function public.tg_touch_updated_at();

create function public.log_user_management_action(p_organization_id uuid,p_target_user_id uuid,p_action_type text,p_performed_by uuid,p_old_value jsonb default null,p_new_value jsonb default null,p_metadata jsonb default null)
returns uuid language plpgsql volatile security definer set search_path=public as $$
declare v_id uuid;
begin
  if p_organization_id is null or p_target_user_id is null or p_action_type is null or p_performed_by is null then raise exception 'Complete audit provenance is required';end if;
  insert into public.user_management_audit(target_user_id,action_type,performed_by,old_value,new_value,metadata)
  values(p_target_user_id,p_action_type,p_performed_by,p_old_value,p_new_value,coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object('organization_id',p_organization_id)) returning id into v_id;
  return v_id;
end;$$;

create function public.identity_role_level(p_role text) returns integer language sql immutable set search_path=public as $$
  select case p_role when 'grand_master' then 6 when 'master' then 5 when 'admin' then 4 when 'admin_officer' then 4 when 'officer' then 2 when 'scan_operator' then 2 when 'nzscv_monitor' then 1 when 'client_admin' then 1 when 'client_officer' then 1 when 'client_viewer' then 1 else 0 end;
$$;

create function public.manage_user_identity_access(p_user_id uuid,p_expected_updated_at timestamptz,p_action text,p_display_name text default null,p_phone text default null,p_role text default null,p_preset_id uuid default null,p_assignment_id uuid default null,p_grant_id uuid default null,p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare v_actor public.user_profiles%rowtype;v_target public.user_profiles%rowtype;v_preset public.access_presets%rowtype;v_assignment public.preset_assignments%rowtype;v_grant public.staff_area_grants%rowtype;v_reason text:=nullif(trim(coalesce(p_reason,'')),'');v_old_identity jsonb;
begin
  select p.* into v_actor from public.user_profiles p where p.id=auth.uid() and p.deactivated_at is null;
  if not found or v_actor.role not in('grand_master','master','admin') then raise exception 'Active identity administrator required';end if;
  select p.* into v_target from public.user_profiles p where p.id=p_user_id for update;if not found then raise exception 'User profile not found';end if;
  if v_actor.role<>'grand_master' and v_target.organization_id<>v_actor.organization_id then raise exception 'User is outside your organization';end if;
  if public.identity_role_level(v_target.role)>public.identity_role_level(v_actor.role) then raise exception 'Cannot manage a user above your authority';end if;
  if p_expected_updated_at is not null and v_target.updated_at<>p_expected_updated_at then raise exception 'User identity changed since it was opened';end if;
  if v_reason is null then raise exception 'A change reason is required';end if;

  if p_action='update_identity' then
    if nullif(trim(coalesce(p_display_name,'')),'') is null then raise exception 'Display name is required';end if;
    if p_role not in('grand_master','master','admin','admin_officer','nzscv_monitor','officer','scan_operator','client_admin','client_officer','client_viewer') then raise exception 'Unsupported user role';end if;
    if public.identity_role_level(p_role)>public.identity_role_level(v_actor.role) then raise exception 'Cannot assign a role above your authority';end if;
    if v_target.id=v_actor.id and p_role<>v_target.role then raise exception 'You cannot change your own role';end if;
    v_old_identity:=jsonb_build_object('display_name',v_target.display_name,'phone',v_target.phone,'role',v_target.role);
    update public.user_profiles set display_name=trim(p_display_name),phone=nullif(trim(coalesce(p_phone,'')),''),role=p_role where id=v_target.id returning * into v_target;
    perform public.log_user_management_action(v_target.organization_id,v_target.id,'user_identity_updated',v_actor.id,v_old_identity,jsonb_build_object('display_name',v_target.display_name,'phone',v_target.phone,'role',v_target.role),jsonb_build_object('reason',v_reason));
  elsif p_action='set_preset' then
    if v_target.id=v_actor.id then raise exception 'You cannot change your own access preset';end if;
    if v_target.role not in('grand_master','master','admin','admin_officer') then raise exception 'Access presets apply to administration roles';end if;
    select p.* into v_preset from public.access_presets p where p.id=p_preset_id and (p.organization_id is null or p.organization_id=v_target.organization_id);if not found then raise exception 'Access preset is not available for this organization';end if;
    update public.preset_assignments set status='ended',updated_at=clock_timestamp() where user_id=v_target.id and scope_org_id=v_target.organization_id and status='active';
    insert into public.preset_assignments(user_id,preset_id,scope_org_id,status,assigned_by) values(v_target.id,v_preset.id,v_target.organization_id,'active',v_actor.id)
    on conflict(user_id,preset_id,scope_org_id) do update set status='active',assigned_by=excluded.assigned_by,updated_at=clock_timestamp() returning * into v_assignment;
    perform public.log_user_management_action(v_target.organization_id,v_target.id,'access_preset_assigned',v_actor.id,null,jsonb_build_object('preset_id',v_preset.id,'preset_key',v_preset.key),jsonb_build_object('reason',v_reason));
  elsif p_action='clear_preset' then
    if v_target.id=v_actor.id then raise exception 'You cannot change your own access preset';end if;
    update public.preset_assignments set status='ended',updated_at=clock_timestamp() where id=p_assignment_id and user_id=v_target.id and scope_org_id=v_target.organization_id and status='active' returning * into v_assignment;
    if not found then raise exception 'Active preset assignment not found';end if;
    perform public.log_user_management_action(v_target.organization_id,v_target.id,'access_preset_ended',v_actor.id,jsonb_build_object('assignment_id',v_assignment.id,'preset_id',v_assignment.preset_id),null,jsonb_build_object('reason',v_reason));
  elsif p_action='end_grant' then
    if v_target.id=v_actor.id then raise exception 'You cannot end your own direct access grant';end if;
    update public.staff_area_grants set status='ended',updated_at=clock_timestamp() where id=p_grant_id and user_id=v_target.id and scope_org_id=v_target.organization_id and status='active' returning * into v_grant;
    if not found then raise exception 'Active direct grant not found';end if;
    perform public.log_user_management_action(v_target.organization_id,v_target.id,'direct_access_grant_ended',v_actor.id,jsonb_build_object('grant_id',v_grant.id,'area',v_grant.area,'level',v_grant.level),null,jsonb_build_object('reason',v_reason));
  else raise exception 'Unsupported identity access action';end if;
  return jsonb_build_object('user_id',v_target.id,'display_name',v_target.display_name,'role',v_target.role,'updated_at',v_target.updated_at,'action',p_action,'assignment_id',v_assignment.id,'grant_id',v_grant.id);
end;$$;

create function public.get_user_spine_readiness(p_organization_id uuid)
returns table(user_id uuid,identity_status text,employment_status text,access_status text,credential_status text,work_status text,blockers text[],next_action text)
language plpgsql stable security definer set search_path=public as $$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to assess users';end if;
  return query select u.id,
    case when u.deactivated_at is not null then 'deactivated' when u.email is null or u.display_name is null then 'incomplete' else 'active' end,
    case when u.role in('officer','admin_officer') and sp.id is null then 'missing' when sp.id is null then 'not_applicable' when sp.end_date is not null and sp.end_date<current_date then 'ended' else 'current' end,
    case when u.role in('grand_master','master','admin','admin_officer') and not exists(select 1 from public.preset_assignments pa where pa.user_id=u.id and pa.scope_org_id=u.organization_id and pa.status='active') then 'missing_preset' else 'role_scoped' end,
    case when u.role in('officer','admin_officer') and sp.id is not null and not exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and c.verified and(c.expiry_date is null or c.expiry_date>=current_date)) then 'missing_valid' when u.role in('officer','admin_officer') then 'current' else 'not_applicable' end,
    case when u.role in('officer','admin_officer') and coalesce(sp.work_ready,false) then 'ready' when u.role in('officer','admin_officer') then 'blocked' else 'not_applicable' end,
    array_remove(array[case when u.deactivated_at is not null then 'Reactivate the identity before assigning work' end,case when u.display_name is null or u.email is null then 'Complete the identity profile' end,case when u.role in('officer','admin_officer') and sp.id is null then 'Create the employment profile' end,case when u.role in('grand_master','master','admin','admin_officer') and not exists(select 1 from public.preset_assignments pa where pa.user_id=u.id and pa.scope_org_id=u.organization_id and pa.status='active') then 'Assign an access preset' end,case when u.role in('officer','admin_officer') and sp.id is not null and not exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and c.verified and(c.expiry_date is null or c.expiry_date>=current_date)) then 'Verify a current credential' end,case when u.role in('officer','admin_officer') and sp.id is not null and not sp.work_ready then 'Complete work-readiness review' end],null),
    case when u.deactivated_at is not null then 'Reactivate identity' when u.display_name is null or u.email is null then 'Complete identity profile' when u.role in('officer','admin_officer') and sp.id is null then 'Create employment profile' when u.role in('grand_master','master','admin','admin_officer') and not exists(select 1 from public.preset_assignments pa where pa.user_id=u.id and pa.scope_org_id=u.organization_id and pa.status='active') then 'Assign access preset' when u.role in('officer','admin_officer') and sp.id is not null and not exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and c.verified and(c.expiry_date is null or c.expiry_date>=current_date)) then 'Verify credential' when u.role in('officer','admin_officer') and sp.id is not null and not sp.work_ready then 'Review work readiness' else 'Ready for assigned responsibilities' end
  from public.user_profiles u left join public.staff_profiles sp on sp.user_id=u.id or sp.id=u.id where u.organization_id=p_organization_id order by u.display_name nulls last,u.email;
end;$$;

drop policy if exists user_profiles_insert on public.user_profiles;
drop policy if exists user_profiles_update on public.user_profiles;
drop policy if exists preset_assignments_write on public.preset_assignments;
drop policy if exists area_grants_write on public.staff_area_grants;
revoke insert,update,delete,truncate on public.user_profiles from public,anon,authenticated;
revoke insert,update,delete,truncate on public.preset_assignments from public,anon,authenticated;
revoke insert,update,delete,truncate on public.staff_area_grants from public,anon,authenticated;
revoke insert,update,delete,truncate on public.user_management_audit from public,anon,authenticated;
revoke all on function public.log_user_management_action(uuid,uuid,text,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.log_user_management_action(uuid,uuid,text,uuid,jsonb,jsonb,jsonb) to service_role;
revoke all on function public.identity_role_level(text) from public,anon,authenticated;
grant execute on function public.identity_role_level(text) to service_role;
revoke all on function public.manage_user_identity_access(uuid,timestamptz,text,text,text,text,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.manage_user_identity_access(uuid,timestamptz,text,text,text,text,uuid,uuid,uuid,text) to authenticated,service_role;
revoke all on function public.get_user_spine_readiness(uuid) from public,anon,authenticated;
grant execute on function public.get_user_spine_readiness(uuid) to authenticated,service_role;